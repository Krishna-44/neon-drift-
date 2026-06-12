/**
 * Lightweight runtime profiler: frame time, FPS, CV inference time/rate and
 * end-to-end input latency (webcam frame timestamp → control application).
 * Zero allocations in the hot path; everything is ring-buffered.
 */
import { RollingStats } from './MathUtils';

export class Profiler {
  readonly frameMs = new RollingStats(120);
  readonly physicsMs = new RollingStats(120);
  readonly cvInferMs = new RollingStats(60);
  readonly inputLatencyMs = new RollingStats(60);

  private lastFrameStart = 0;
  private frames = 0;
  private fpsWindowStart = 0;
  private _fps = 0;
  private cvFrames = 0;
  private cvWindowStart = 0;
  private _cvFps = 0;

  frameStart(): void {
    const now = performance.now();
    if (this.lastFrameStart > 0) this.frameMs.push(now - this.lastFrameStart);
    this.lastFrameStart = now;

    this.frames++;
    if (now - this.fpsWindowStart >= 1000) {
      this._fps = (this.frames * 1000) / (now - this.fpsWindowStart);
      this.frames = 0;
      this.fpsWindowStart = now;
    }
  }

  markPhysics(ms: number): void {
    this.physicsMs.push(ms);
  }

  markCvInference(ms: number): void {
    this.cvInferMs.push(ms);
    this.cvFrames++;
    const now = performance.now();
    if (now - this.cvWindowStart >= 1000) {
      this._cvFps = (this.cvFrames * 1000) / (now - this.cvWindowStart);
      this.cvFrames = 0;
      this.cvWindowStart = now;
    }
  }

  /** captureTs = performance.now() at webcam frame grab; called when controls land. */
  markInputApplied(captureTs: number): void {
    this.inputLatencyMs.push(performance.now() - captureTs);
  }

  get fps(): number {
    return this._fps;
  }

  get cvFps(): number {
    return this._cvFps;
  }

  snapshot() {
    return {
      fps: Math.round(this._fps),
      frameMs: +this.frameMs.mean.toFixed(2),
      frameMsMax: +this.frameMs.max.toFixed(2),
      physicsMs: +this.physicsMs.mean.toFixed(3),
      cvFps: Math.round(this._cvFps),
      cvInferMs: +this.cvInferMs.mean.toFixed(1),
      inputLatencyMs: +this.inputLatencyMs.mean.toFixed(0),
    };
  }
}
