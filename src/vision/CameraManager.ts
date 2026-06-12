/**
 * Webcam input layer: auto-detection, FPS stabilisation, dynamic capture
 * scaling, low-light detection, hot-unplug recovery.
 *
 * Produces ImageBitmaps (cheap, GPU-backed, transferable to the CV worker)
 * at a paced cadence with at most one frame in flight — back-pressure from
 * the tracker naturally drops frames instead of queueing latency.
 */
import { EventBus } from '../core/EventBus';

export interface CameraEvents extends Record<string, unknown> {
  status: { state: 'starting' | 'active' | 'denied' | 'unavailable' | 'lost'; message: string };
  lowLight: { isLow: boolean; luma: number };
  devices: { list: { id: string; label: string }[] };
}

export interface CapturedFrame {
  bitmap: ImageBitmap;
  captureTs: number;
  width: number;
  height: number;
}

const TARGET_WIDTH = 640;
const TARGET_HEIGHT = 480;
const LOW_LIGHT_LUMA = 52; // 0..255

export class CameraManager {
  readonly events = new EventBus<CameraEvents>();
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private running = false;
  private inFlight = false;
  private frameCb: ((frame: CapturedFrame) => Promise<void>) | null = null;
  private lumaCanvas: HTMLCanvasElement;
  private lumaCtx: CanvasRenderingContext2D | null;
  private lumaCounter = 0;
  private boostCanvas: HTMLCanvasElement;
  private boostCtx: CanvasRenderingContext2D | null;
  private lowLight = false;
  /** Capture scale ladder for dynamic resolution (1 → 0.75 → 0.5). */
  processScale = 1;
  private rvfcHandle = 0;
  private rafHandle = 0;
  private lastCaptureTs = 0;
  /** Minimum interval between processed frames (ms) — CV pacing, not display. */
  minFrameIntervalMs = 1000 / 32;

  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.lumaCanvas = document.createElement('canvas');
    this.lumaCanvas.width = 16;
    this.lumaCanvas.height = 12;
    this.lumaCtx = this.lumaCanvas.getContext('2d', { willReadFrequently: true });
    this.boostCanvas = document.createElement('canvas');
    this.boostCtx = this.boostCanvas.getContext('2d');
  }

  get isActive(): boolean {
    return this.running && !!this.stream;
  }

  get isLowLight(): boolean {
    return this.lowLight;
  }

  async listDevices(): Promise<{ id: string; label: string }[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
      this.events.emit('devices', { list: cams });
      return cams;
    } catch {
      return [];
    }
  }

  async start(deviceId?: string): Promise<boolean> {
    this.stop();
    this.events.emit('status', { state: 'starting', message: 'Requesting camera…' });
    if (!navigator.mediaDevices?.getUserMedia) {
      this.events.emit('status', { state: 'unavailable', message: 'No camera API in this environment' });
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: TARGET_WIDTH },
          height: { ideal: TARGET_HEIGHT },
          frameRate: { ideal: 30, max: 60 },
          facingMode: 'user',
        },
      });
    } catch (err: any) {
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      this.events.emit('status', {
        state: denied ? 'denied' : 'unavailable',
        message: denied ? 'Camera permission denied' : `No camera found (${err?.name ?? 'error'})`,
      });
      return false;
    }

    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch {
      /* autoplay block — will start on first user interaction */
    }

    // Recover from hot-unplug.
    const track = this.stream.getVideoTracks()[0];
    track.onended = () => {
      this.events.emit('status', { state: 'lost', message: 'Camera disconnected — reconnecting…' });
      this.scheduleReacquire();
    };

    this.running = true;
    this.events.emit('status', { state: 'active', message: 'Camera active' });
    this.pump();
    void this.listDevices(); // labels become available post-permission
    return true;
  }

  private reacquireTimer = 0;
  private scheduleReacquire(): void {
    clearTimeout(this.reacquireTimer);
    this.reacquireTimer = window.setTimeout(() => {
      if (!this.running) return;
      void this.start();
    }, 1500);
  }

  /** Register the single consumer (HandTracker). */
  onFrame(cb: (frame: CapturedFrame) => Promise<void>): void {
    this.frameCb = cb;
  }

  private pump(): void {
    const process = async () => {
      if (!this.running || !this.frameCb || this.inFlight) return;
      const now = performance.now();
      if (now - this.lastCaptureTs < this.minFrameIntervalMs) return;
      if (this.video.readyState < 2 || this.video.videoWidth === 0) return;
      this.lastCaptureTs = now;
      this.inFlight = true;
      try {
        this.lumaCheck();
        const w = Math.round(this.video.videoWidth * this.processScale);
        const h = Math.round(this.video.videoHeight * this.processScale);
        let source: CanvasImageSource = this.video;
        // Low-light boost: cheap GPU canvas filter before inference.
        if (this.lowLight && this.boostCtx) {
          this.boostCanvas.width = w;
          this.boostCanvas.height = h;
          this.boostCtx.filter = 'brightness(1.6) contrast(1.25)';
          this.boostCtx.drawImage(this.video, 0, 0, w, h);
          source = this.boostCanvas;
        }
        const bitmap = await createImageBitmap(source, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: 'low',
        });
        await this.frameCb({ bitmap, captureTs: now, width: w, height: h });
      } catch {
        /* transient decode failure — skip frame */
      } finally {
        this.inFlight = false;
      }
    };

    // Prefer requestVideoFrameCallback (fires exactly per camera frame).
    const useRvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    const loop = () => {
      if (!this.running) return;
      void process();
      if (useRvfc) {
        this.rvfcHandle = (this.video as any).requestVideoFrameCallback(loop);
      } else {
        this.rafHandle = requestAnimationFrame(loop);
      }
    };
    loop();
  }

  /** Sampled every ~30 frames; emits transitions only. */
  private lumaCheck(): void {
    if (++this.lumaCounter % 30 !== 0 || !this.lumaCtx) return;
    try {
      this.lumaCtx.drawImage(this.video, 0, 0, 16, 12);
      const data = this.lumaCtx.getImageData(0, 0, 16, 12).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      const luma = sum / (data.length / 4);
      const isLow = luma < LOW_LIGHT_LUMA;
      if (isLow !== this.lowLight) {
        this.lowLight = isLow;
        this.events.emit('lowLight', { isLow, luma });
      }
    } catch {
      /* canvas tainted/not ready */
    }
  }

  /** Called by HandTracker with measured inference time → adapts capture scale. */
  reportInferenceMs(ms: number): void {
    if (ms > 34 && this.processScale > 0.5) {
      this.processScale = this.processScale > 0.75 ? 0.75 : 0.5;
    } else if (ms < 14 && this.processScale < 1) {
      this.processScale = this.processScale < 0.75 ? 0.75 : 1;
    }
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.reacquireTimer);
    if (this.rvfcHandle && 'cancelVideoFrameCallback' in HTMLVideoElement.prototype) {
      (this.video as any).cancelVideoFrameCallback(this.rvfcHandle);
    }
    cancelAnimationFrame(this.rafHandle);
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
  }
}
