/**
 * Dedicated CV inference thread. Receives transferred ImageBitmaps from the
 * main thread, runs MediaPipe HandLandmarker (GPU delegate with CPU fallback)
 * and posts back flat landmark buffers (transferred, zero-copy).
 *
 * Keeping inference off the render thread is what protects the 60 FPS frame
 * budget — worst-case CPU inference (~25 ms) never blocks a draw call.
 */
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

// Worker global — typed loosely to avoid pulling the conflicting webworker lib
// into the DOM compilation.
const ctx = self as unknown as {
  postMessage(msg: any, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};

let landmarker: HandLandmarker | null = null;
let lastVideoTs = 0;

interface InitMsg {
  type: 'init';
  wasmBase: string;
  modelUrl: string;
  cdnModelUrl: string;
  numHands: number;
}

interface FrameMsg {
  type: 'frame';
  bitmap: ImageBitmap;
  captureTs: number;
}

async function createLandmarker(msg: InitMsg, delegate: 'GPU' | 'CPU'): Promise<HandLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase);
  // Local model first (offline installs), CDN fallback.
  let modelAssetPath = msg.modelUrl;
  try {
    const head = await fetch(msg.modelUrl, { method: 'HEAD' });
    if (!head.ok) modelAssetPath = msg.cdnModelUrl;
  } catch {
    modelAssetPath = msg.cdnModelUrl;
  }
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath, delegate },
    runningMode: 'VIDEO',
    numHands: msg.numHands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

async function init(msg: InitMsg): Promise<void> {
  try {
    try {
      landmarker = await createLandmarker(msg, 'GPU');
      ctx.postMessage({ type: 'ready', delegate: 'GPU' });
    } catch (gpuErr) {
      console.warn('[visionWorker] GPU delegate failed, falling back to CPU:', gpuErr);
      landmarker = await createLandmarker(msg, 'CPU');
      ctx.postMessage({ type: 'ready', delegate: 'CPU' });
    }
  } catch (err: any) {
    ctx.postMessage({ type: 'init-error', message: String(err?.message ?? err) });
  }
}

function onFrame(msg: FrameMsg): void {
  const { bitmap, captureTs } = msg;
  if (!landmarker) {
    bitmap.close();
    return;
  }
  const t0 = performance.now();
  // MediaPipe VIDEO mode requires monotonically increasing timestamps.
  const videoTs = Math.max(captureTs, lastVideoTs + 0.01);
  lastVideoTs = videoTs;
  let result;
  try {
    result = landmarker.detectForVideo(bitmap, videoTs);
  } catch (err) {
    bitmap.close();
    ctx.postMessage({ type: 'infer-error', message: String(err) });
    return;
  }
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();
  const inferMs = performance.now() - t0;

  const hands: { landmarks: Float32Array; handednessLabel: string; score: number }[] = [];
  const transfers: Transferable[] = [];
  const n = result.landmarks?.length ?? 0;
  for (let h = 0; h < n; h++) {
    const lms = result.landmarks[h];
    const buf = new Float32Array(63);
    for (let i = 0; i < 21; i++) {
      buf[i * 3] = lms[i].x;
      buf[i * 3 + 1] = lms[i].y;
      buf[i * 3 + 2] = lms[i].z;
    }
    const handedness = result.handedness?.[h]?.[0];
    hands.push({
      landmarks: buf,
      handednessLabel: handedness?.categoryName ?? 'Unknown',
      score: handedness?.score ?? 0.5,
    });
    transfers.push(buf.buffer);
  }
  ctx.postMessage({ type: 'hands', hands, captureTs, inferMs, width, height }, transfers);
}

ctx.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'init') void init(msg as InitMsg);
  else if (msg.type === 'frame') onFrame(msg as FrameMsg);
  else if (msg.type === 'close') {
    landmarker?.close();
    landmarker = null;
  }
};
