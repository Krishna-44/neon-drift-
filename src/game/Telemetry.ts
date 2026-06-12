/**
 * Telemetry frame schema + replay ring buffer.
 *
 * One compact frame per physics snapshot captures everything needed to (a)
 * drive the spectator/telemetry feed and (b) reconstruct a cinematic replay.
 * The replay buffer is a fixed-size ring (bounded memory — no leak over a long
 * race) sampled at a lower rate than physics and interpolated on playback.
 */

export interface CarTelemetry {
  id: string;
  isPlayer: boolean;
  x: number;
  z: number;
  y: number;
  heading: number;
  speedKmh: number;
  rpm: number;
  gear: number;
  nitro: number;
  nitroActive: boolean;
  drifting: boolean;
  skid: number;
  steerAngle: number;
  accel: number;
  position: number;
  lap: number;
}

export interface TelemetryFrame {
  t: number; // race time ms
  cars: CarTelemetry[];
}

const REPLAY_HZ = 30;
const REPLAY_SECONDS = 90; // rolling window kept in memory

export class ReplayBuffer {
  private frames: TelemetryFrame[] = [];
  private capacity = REPLAY_HZ * REPLAY_SECONDS;
  private head = 0;
  private filled = false;
  private accum = 0;
  private interval = 1 / REPLAY_HZ;

  reset(): void {
    this.frames = [];
    this.head = 0;
    this.filled = false;
    this.accum = 0;
  }

  /** Feed a frame each physics step; internally decimates to REPLAY_HZ. */
  record(frame: TelemetryFrame, dt: number): void {
    this.accum += dt;
    if (this.accum < this.interval) return;
    this.accum -= this.interval;
    // deep-ish clone (cars array is small, fixed)
    const snap: TelemetryFrame = { t: frame.t, cars: frame.cars.map((c) => ({ ...c })) };
    if (this.frames.length < this.capacity) {
      this.frames.push(snap);
    } else {
      this.frames[this.head] = snap;
      this.filled = true;
    }
    this.head = (this.head + 1) % this.capacity;
  }

  /** Ordered list oldest→newest. */
  toArray(): TelemetryFrame[] {
    if (!this.filled) return this.frames.slice();
    return [...this.frames.slice(this.head), ...this.frames.slice(0, this.head)];
  }

  get durationMs(): number {
    const arr = this.toArray();
    return arr.length ? arr[arr.length - 1].t - arr[0].t : 0;
  }

  /** Interpolated frame at race-time ms (for smooth scrubbed playback). */
  sampleAt(timeMs: number): TelemetryFrame | null {
    const arr = this.toArray();
    if (arr.length === 0) return null;
    if (timeMs <= arr[0].t) return arr[0];
    if (timeMs >= arr[arr.length - 1].t) return arr[arr.length - 1];
    // binary search
    let lo = 0;
    let hi = arr.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= timeMs) lo = mid;
      else hi = mid;
    }
    const a = arr[lo];
    const b = arr[hi];
    const u = (timeMs - a.t) / Math.max(b.t - a.t, 1e-3);
    const cars: CarTelemetry[] = a.cars.map((ca) => {
      const cb = b.cars.find((c) => c.id === ca.id) ?? ca;
      return {
        ...ca,
        x: ca.x + (cb.x - ca.x) * u,
        z: ca.z + (cb.z - ca.z) * u,
        y: ca.y + (cb.y - ca.y) * u,
        heading: ca.heading + shortestAngle(ca.heading, cb.heading) * u,
        speedKmh: ca.speedKmh + (cb.speedKmh - ca.speedKmh) * u,
        steerAngle: ca.steerAngle + (cb.steerAngle - ca.steerAngle) * u,
      };
    });
    return { t: timeMs, cars };
  }
}

function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
