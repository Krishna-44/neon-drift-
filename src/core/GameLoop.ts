/**
 * Fixed-timestep simulation loop with render interpolation.
 *
 * Physics steps at a constant PHYSICS_HZ regardless of display refresh, which
 * keeps vehicle dynamics deterministic (testable!) and stable at any FPS.
 * Rendering runs on requestAnimationFrame and receives an interpolation alpha
 * so visuals stay smooth between physics ticks.
 */

export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;
const MAX_FRAME_DELTA = 0.25; // clamp huge pauses (tab switch) — avoids spiral of death

export interface LoopCallbacks {
  /** Fixed-step simulation update. Called 0..N times per frame. */
  fixedUpdate: (dt: number, elapsed: number) => void;
  /** Per-frame update (UI, camera). alpha = interpolation factor [0,1). */
  frameUpdate: (frameDt: number, alpha: number, elapsed: number) => void;
  /** Render the frame. */
  render: (alpha: number) => void;
}

export class GameLoop {
  private rafId = 0;
  private running = false;
  private lastTime = 0;
  private accumulator = 0;
  private elapsed = 0;
  /** Time scale (1 = realtime; used by replay slow-mo). */
  timeScale = 1;

  constructor(private cb: LoopCallbacks) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    const tick = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(tick);
      let frameDt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      if (frameDt > MAX_FRAME_DELTA) frameDt = MAX_FRAME_DELTA;
      frameDt *= this.timeScale;

      this.accumulator += frameDt;
      let steps = 0;
      // Hard cap on catch-up steps so slow frames degrade gracefully
      // instead of cascading (frame drop prevention).
      while (this.accumulator >= PHYSICS_DT && steps < 8) {
        this.cb.fixedUpdate(PHYSICS_DT, this.elapsed);
        this.elapsed += PHYSICS_DT;
        this.accumulator -= PHYSICS_DT;
        steps++;
      }
      if (steps === 8) this.accumulator = 0; // shed debt after a stall

      const alpha = this.accumulator / PHYSICS_DT;
      this.cb.frameUpdate(frameDt, alpha, this.elapsed);
      this.cb.render(alpha);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }
}
