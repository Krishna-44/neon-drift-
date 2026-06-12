/**
 * Engine-agnostic math helpers. Pure TypeScript — no three.js imports here so
 * the physics/AI/gesture core stays portable (headless sim, server, tests).
 */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp: where v sits between a..b, clamped to [0,1]. */
export function unlerp(a: number, b: number, v: number): number {
  return a === b ? 0 : clamp01((v - a) / (b - a));
}

export function remap(v: number, inA: number, inB: number, outA: number, outB: number): number {
  return lerp(outA, outB, unlerp(inA, inB, v));
}

/**
 * Frame-rate independent exponential smoothing.
 * `halfLife` = seconds for the value to close half the gap to the target.
 */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (halfLife <= 0) return target;
  return lerp(current, target, 1 - Math.pow(0.5, dt / halfLife));
}

/** Move `current` toward `target` by at most `maxDelta` (slew-rate limiter). */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wrap angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  if (a <= -Math.PI) a += TAU;
  return a;
}

/** Shortest signed difference between two angles (rad). */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Symmetric dead-zone: input in [-1,1], output rescaled so dz..1 maps to 0..1. */
export function deadZone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

/** Expo response curve: k=0 linear, k→1 softer center, preserves sign and ±1 endpoints. */
export function expoCurve(v: number, k: number): number {
  return Math.sign(v) * Math.abs(v) ** (1 + 2 * k);
}

export interface Vec2 {
  x: number;
  y: number;
}

export function v2(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.hypot(dx, dy);
}

/** Rolling statistics over a fixed window (used by profiler + adaptive AI). */
export class RollingStats {
  private buf: Float32Array;
  private idx = 0;
  private count = 0;

  constructor(size = 120) {
    this.buf = new Float32Array(size);
  }

  push(v: number): void {
    this.buf[this.idx] = v;
    this.idx = (this.idx + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count++;
  }

  get mean(): number {
    if (this.count === 0) return 0;
    let s = 0;
    for (let i = 0; i < this.count; i++) s += this.buf[i];
    return s / this.count;
  }

  get max(): number {
    let m = -Infinity;
    for (let i = 0; i < this.count; i++) m = Math.max(m, this.buf[i]);
    return this.count ? m : 0;
  }

  get std(): number {
    if (this.count < 2) return 0;
    const m = this.mean;
    let s = 0;
    for (let i = 0; i < this.count; i++) s += (this.buf[i] - m) ** 2;
    return Math.sqrt(s / (this.count - 1));
  }

  get n(): number {
    return this.count;
  }

  reset(): void {
    this.idx = 0;
    this.count = 0;
  }
}

/** Deterministic PRNG (mulberry32) — reproducible track prop scatter & tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
