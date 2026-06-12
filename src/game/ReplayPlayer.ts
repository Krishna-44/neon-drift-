/**
 * Replay playback controller. Walks a recorded TelemetryFrame timeline with
 * variable speed and interpolation, looping for the cinematic results replay.
 */
import { TelemetryFrame } from './Telemetry';

export class ReplayPlayer {
  private frames: TelemetryFrame[] = [];
  private startT = 0;
  private endT = 0;
  private cursorT = 0;
  private playing = false;
  speed = 1;
  loop = true;

  load(frames: TelemetryFrame[]): void {
    this.frames = frames;
    if (frames.length) {
      this.startT = frames[0].t;
      this.endT = frames[frames.length - 1].t;
      this.cursorT = this.startT;
    }
  }

  play(): void {
    this.playing = true;
    this.cursorT = this.startT;
  }

  pause(): void {
    this.playing = false;
  }

  get progress(): number {
    const span = this.endT - this.startT;
    return span > 0 ? (this.cursorT - this.startT) / span : 0;
  }

  update(frameDt: number): void {
    if (!this.playing || this.frames.length === 0) return;
    this.cursorT += frameDt * 1000 * this.speed;
    if (this.cursorT >= this.endT) {
      if (this.loop) this.cursorT = this.startT;
      else this.cursorT = this.endT;
    }
  }

  /** Interpolated frame at the current cursor. */
  currentFrame(): TelemetryFrame | null {
    if (this.frames.length === 0) return null;
    return interpolate(this.frames, this.cursorT);
  }
}

function interpolate(frames: TelemetryFrame[], t: number): TelemetryFrame {
  if (t <= frames[0].t) return frames[0];
  if (t >= frames[frames.length - 1].t) return frames[frames.length - 1];
  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = frames[lo];
  const b = frames[hi];
  const u = (t - a.t) / Math.max(b.t - a.t, 1e-3);
  const cars = a.cars.map((ca) => {
    const cb = b.cars.find((c) => c.id === ca.id) ?? ca;
    let dh = (cb.heading - ca.heading) % (Math.PI * 2);
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    return {
      ...ca,
      x: ca.x + (cb.x - ca.x) * u,
      z: ca.z + (cb.z - ca.z) * u,
      y: ca.y + (cb.y - ca.y) * u,
      heading: ca.heading + dh * u,
      speedKmh: ca.speedKmh + (cb.speedKmh - ca.speedKmh) * u,
      steerAngle: ca.steerAngle + (cb.steerAngle - ca.steerAngle) * u,
    };
  });
  return { t, cars };
}
