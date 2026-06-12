/**
 * Hand tracking engine orchestrator.
 *
 * Pipeline: CameraManager frames → worker inference (GPU→CPU fallback, or
 * inline main-thread fallback if workers are unavailable) → role association
 * (user-space left/right by screen position — robust against MediaPipe's
 * mirrored handedness labels) → One-Euro smoothing → feature extraction →
 * pose classification with temporal hysteresis → HandsState.
 *
 * Also hosts the SyntheticHandSource ("demo mode"): the same downstream path
 * driven by scripted landmarks, used for the attract mode and for headless
 * integration testing without a webcam.
 */
import { EventBus } from '../core/EventBus';
import { CameraManager, CapturedFrame } from './CameraManager';
import { extractFeatures } from './HandFeatures';
import { classifyPose, GestureStabilizer } from './GestureClassifier';
import { LandmarkFilterBank } from './OneEuro';
import { SyntheticHandSource } from './SyntheticHands';
import { HandRole, HandsState, RawHand, RawHandsFrame, TrackedHand } from './HandTypes';

export type TrackerMode = 'idle' | 'camera' | 'synthetic';

export interface TrackerEvents extends Record<string, unknown> {
  state: { hands: HandsState };
  status: { phase: 'loading' | 'ready' | 'error' | 'fallback-inline' | 'fallback-cpu'; message: string };
}

const OCCLUSION_HOLD_MS = 600;
const MIN_HAND_SIZE = 0.045; // rejects background hands (too small/far)
const MIN_SCORE = 0.4;

interface RoleState {
  filters: LandmarkFilterBank;
  stabilizer: GestureStabilizer;
  smoothed: Float32Array;
  tracked: TrackedHand | null;
  prevPalmX: number;
  prevPalmY: number;
  prevTs: number;
}

function newRoleState(): RoleState {
  return {
    filters: new LandmarkFilterBank(21),
    stabilizer: new GestureStabilizer(),
    smoothed: new Float32Array(63),
    tracked: null,
    prevPalmX: 0,
    prevPalmY: 0,
    prevTs: 0,
  };
}

export class HandTracker {
  readonly events = new EventBus<TrackerEvents>();
  mode: TrackerMode = 'idle';
  delegate = '—';

  private worker: Worker | null = null;
  private workerReady = false;
  private inlineLandmarker: any = null; // lazy-loaded fallback
  private inlineLastTs = 0;
  private roles: Record<HandRole, RoleState> = { left: newRoleState(), right: newRoleState() };
  private lastState: HandsState = { left: null, right: null, captureTs: 0, inferMs: 0, liveCount: 0 };
  private pendingResolve: (() => void) | null = null;
  private synthetic: SyntheticHandSource | null = null;
  private syntheticTimer = 0;
  private syntheticStart = 0;
  private lastResultTs = 0;
  private watchdogTimer = 0;
  private disposed = false;

  constructor(private camera: CameraManager) {
    camera.onFrame((frame) => this.onCameraFrame(frame));
  }

  get state(): HandsState {
    return this.lastState;
  }

  // -------------------------------------------------------------- lifecycle

  async startCamera(deviceId?: string): Promise<boolean> {
    this.stopSynthetic();
    this.events.emit('status', { phase: 'loading', message: 'Loading hand tracking model…' });
    await this.ensureInference();
    const ok = await this.camera.start(deviceId);
    if (ok) {
      this.mode = 'camera';
      this.armWatchdog();
    }
    return ok;
  }

  startSynthetic(): void {
    this.camera.stop();
    this.stopSynthetic();
    this.mode = 'synthetic';
    this.synthetic = new SyntheticHandSource();
    this.syntheticStart = performance.now();
    this.events.emit('status', { phase: 'ready', message: 'Demo mode (synthetic hands)' });
    this.syntheticTimer = window.setInterval(() => {
      const now = performance.now();
      const frame = this.synthetic!.frameAt((now - this.syntheticStart) / 1000, now);
      this.processResults(frame);
    }, 33);
  }

  private stopSynthetic(): void {
    clearInterval(this.syntheticTimer);
    this.synthetic = null;
  }

  stop(): void {
    this.mode = 'idle';
    this.stopSynthetic();
    this.camera.stop();
    clearTimeout(this.watchdogTimer);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.worker?.postMessage({ type: 'close' });
    this.worker?.terminate();
    this.worker = null;
    this.inlineLandmarker?.close?.();
    this.inlineLandmarker = null;
  }

  // -------------------------------------------------------------- inference

  private modelUrls() {
    const base = new URL(import.meta.env.BASE_URL, document.baseURI).href;
    return {
      wasmBase: new URL('mediapipe/wasm', base).href,
      modelUrl: new URL('models/hand_landmarker.task', base).href,
      cdnModelUrl:
        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    };
  }

  private async ensureInference(): Promise<void> {
    if (this.workerReady || this.inlineLandmarker) return;
    const urls = this.modelUrls();
    // Try the dedicated worker first (separate CV thread).
    try {
      await this.initWorker(urls);
      return;
    } catch (err) {
      console.warn('[HandTracker] worker init failed → inline fallback:', err);
      this.events.emit('status', { phase: 'fallback-inline', message: 'CV worker unavailable — running inline' });
    }
    await this.initInline(urls);
  }

  private initWorker(urls: ReturnType<HandTracker['modelUrls']>): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('worker init timeout (20s)'));
        }
      }, 20000);
      try {
        this.worker = new Worker(new URL('./visionWorker.ts', import.meta.url), { type: 'module' });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }
      this.worker.onerror = (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`worker error: ${e.message}`));
        }
      };
      this.worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === 'ready') {
          this.workerReady = true;
          this.delegate = `worker/${msg.delegate}`;
          if (msg.delegate === 'CPU') {
            this.events.emit('status', { phase: 'fallback-cpu', message: 'GPU delegate unavailable — CPU inference' });
          } else {
            this.events.emit('status', { phase: 'ready', message: 'Hand tracking ready (GPU)' });
          }
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve();
          }
        } else if (msg.type === 'init-error') {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(msg.message));
          }
        } else if (msg.type === 'hands') {
          this.processResults(msg as RawHandsFrame);
          this.pendingResolve?.();
          this.pendingResolve = null;
        } else if (msg.type === 'infer-error') {
          console.warn('[HandTracker] inference error:', msg.message);
          this.pendingResolve?.();
          this.pendingResolve = null;
        }
      };
      this.worker.postMessage({ type: 'init', ...urls, numHands: 2 });
    });
  }

  private async initInline(urls: ReturnType<HandTracker['modelUrls']>): Promise<void> {
    const vision = await import('@mediapipe/tasks-vision');
    const fileset = await vision.FilesetResolver.forVisionTasks(urls.wasmBase);
    let modelAssetPath = urls.modelUrl;
    try {
      const head = await fetch(urls.modelUrl, { method: 'HEAD' });
      if (!head.ok) modelAssetPath = urls.cdnModelUrl;
    } catch {
      modelAssetPath = urls.cdnModelUrl;
    }
    const make = (delegate: 'GPU' | 'CPU') =>
      vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    try {
      this.inlineLandmarker = await make('GPU');
      this.delegate = 'inline/GPU';
    } catch {
      this.inlineLandmarker = await make('CPU');
      this.delegate = 'inline/CPU';
    }
    this.events.emit('status', { phase: 'ready', message: `Hand tracking ready (${this.delegate})` });
  }

  private async onCameraFrame(frame: CapturedFrame): Promise<void> {
    if (this.disposed || this.mode !== 'camera') {
      frame.bitmap.close();
      return;
    }
    if (this.workerReady && this.worker) {
      await new Promise<void>((resolve) => {
        this.pendingResolve = resolve;
        this.worker!.postMessage(
          { type: 'frame', bitmap: frame.bitmap, captureTs: frame.captureTs },
          [frame.bitmap],
        );
      });
      return;
    }
    if (this.inlineLandmarker) {
      const t0 = performance.now();
      const videoTs = Math.max(frame.captureTs, this.inlineLastTs + 0.01);
      this.inlineLastTs = videoTs;
      try {
        const result = this.inlineLandmarker.detectForVideo(frame.bitmap, videoTs);
        const inferMs = performance.now() - t0;
        const hands: RawHand[] = (result.landmarks ?? []).map((lms: any[], h: number) => {
          const buf = new Float32Array(63);
          for (let i = 0; i < 21; i++) {
            buf[i * 3] = lms[i].x;
            buf[i * 3 + 1] = lms[i].y;
            buf[i * 3 + 2] = lms[i].z;
          }
          return {
            landmarks: buf,
            handednessLabel: result.handedness?.[h]?.[0]?.categoryName ?? 'Unknown',
            score: result.handedness?.[h]?.[0]?.score ?? 0.5,
          };
        });
        this.processResults({
          hands,
          captureTs: frame.captureTs,
          inferMs,
          width: frame.bitmap.width,
          height: frame.bitmap.height,
        });
      } finally {
        frame.bitmap.close();
      }
      return;
    }
    frame.bitmap.close();
  }

  // ----------------------------------------------------- association + state

  private processResults(frame: RawHandsFrame): void {
    this.lastResultTs = performance.now();
    const now = frame.captureTs;
    const t = now / 1000;

    // Noise resistance: drop low-confidence or far-away (tiny) hands.
    const usable = frame.hands.filter((h) => {
      if (h.score < MIN_SCORE) return false;
      const dx = h.landmarks[0] - h.landmarks[9 * 3];
      const dy = h.landmarks[1] - h.landmarks[9 * 3 + 1];
      return Math.hypot(dx, dy) >= MIN_HAND_SIZE;
    });

    // Role assignment in USER space. Raw webcam images are unmirrored, so the
    // user's RIGHT hand appears on the image LEFT (small x).
    const byX = [...usable].sort((a, b) => palmXOf(a) - palmXOf(b));
    const assignment = new Map<HandRole, RawHand>();
    if (byX.length >= 2) {
      assignment.set('right', byX[0]);
      assignment.set('left', byX[byX.length - 1]);
    } else if (byX.length === 1) {
      const px = palmXOf(byX[0]);
      const lt = this.roles.left.tracked;
      const rt = this.roles.right.tracked;
      if (lt && rt) {
        const dl = Math.abs(px - lt.features.palmX);
        const dr = Math.abs(px - rt.features.palmX);
        assignment.set(dl < dr ? 'left' : 'right', byX[0]);
      } else if (lt) assignment.set('left', byX[0]);
      else if (rt) assignment.set('right', byX[0]);
      else assignment.set(px < 0.5 ? 'right' : 'left', byX[0]);
    }

    for (const role of ['left', 'right'] as HandRole[]) {
      const rs = this.roles[role];
      const raw = assignment.get(role);
      if (raw) {
        rs.filters.apply(raw.landmarks, rs.smoothed, t);
        const features = extractFeatures(rs.smoothed);
        const pose = rs.stabilizer.push(classifyPose(features));
        // Palm velocity (EMA) for latency-compensating prediction.
        let velX = 0;
        let velY = 0;
        if (rs.prevTs > 0 && now > rs.prevTs) {
          const dt = (now - rs.prevTs) / 1000;
          const ix = (features.palmX - rs.prevPalmX) / dt;
          const iy = (features.palmY - rs.prevPalmY) / dt;
          velX = (rs.tracked?.velX ?? 0) * 0.7 + ix * 0.3;
          velY = (rs.tracked?.velY ?? 0) * 0.7 + iy * 0.3;
        }
        rs.prevPalmX = features.palmX;
        rs.prevPalmY = features.palmY;
        rs.prevTs = now;
        rs.tracked = {
          role,
          landmarks: rs.smoothed,
          features,
          pose,
          poseConfidence: rs.stabilizer.confidence,
          score: raw.score,
          velX,
          velY,
          lastSeenTs: now,
          coasting: false,
        };
      } else if (rs.tracked) {
        // Temporary occlusion: hold the last state with decaying confidence.
        const age = now - rs.tracked.lastSeenTs;
        if (age > OCCLUSION_HOLD_MS) {
          rs.tracked = null;
          rs.filters.reset();
          rs.stabilizer.reset();
          rs.prevTs = 0;
        } else {
          rs.tracked.coasting = true;
          rs.tracked.score *= Math.exp(-age / 1200);
        }
      }
    }

    this.camera.reportInferenceMs(frame.inferMs);
    this.lastState = {
      left: this.roles.left.tracked,
      right: this.roles.right.tracked,
      captureTs: frame.captureTs,
      inferMs: frame.inferMs,
      liveCount: usable.length,
    };
    this.events.emit('state', { hands: this.lastState });
  }

  /** Tune landmark smoothing from the user's steering-smoothing setting (0..1). */
  setSmoothing(amount: number): void {
    // amount 0 → cutoff 2.6 (snappy); amount 1 → cutoff 0.8 (heavy).
    const minCutoff = 2.6 - amount * 1.8;
    const beta = 0.8 - amount * 0.5;
    this.roles.left.filters.setParams(minCutoff, beta);
    this.roles.right.filters.setParams(minCutoff, beta);
  }

  private armWatchdog(): void {
    clearTimeout(this.watchdogTimer);
    const check = () => {
      if (this.disposed || this.mode !== 'camera') return;
      const silent = performance.now() - this.lastResultTs;
      if (this.lastResultTs > 0 && silent > 4000 && this.workerReady) {
        // Worker wedged (rare driver/WASM faults) → terminate and go inline.
        console.warn('[HandTracker] CV worker silent for 4s — switching to inline inference');
        this.worker?.terminate();
        this.worker = null;
        this.workerReady = false;
        this.pendingResolve?.();
        this.pendingResolve = null;
        this.events.emit('status', { phase: 'fallback-inline', message: 'CV worker stalled — inline fallback' });
        void this.initInline(this.modelUrls());
      }
      this.watchdogTimer = window.setTimeout(check, 2000);
    };
    this.watchdogTimer = window.setTimeout(check, 2000);
  }
}

function palmXOf(h: RawHand): number {
  // Palm centre x: wrist + index/middle/ring MCPs (indices 0, 5, 9, 13).
  return (h.landmarks[0] + h.landmarks[5 * 3] + h.landmarks[9 * 3] + h.landmarks[13 * 3]) / 4;
}
