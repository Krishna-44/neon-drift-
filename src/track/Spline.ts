/**
 * Closed Catmull-Rom track spline with arc-length parameterisation.
 * Provides position/tangent/curvature/height lookups by distance s, plus
 * world→track-local (s, t) projection used by physics, AI and race progress.
 * Pure math — no three.js (the mesh builder consumes the same samples).
 */
import { clamp } from '../core/MathUtils';

export interface SplineSample {
  x: number;
  z: number;
  y: number;
  tanX: number;
  tanZ: number;
  /** Signed curvature 1/m; positive = curving right (matches steer +). */
  curvature: number;
  s: number;
}

export interface Projection {
  s: number;
  /** Lateral offset, metres; positive = right of centreline. */
  t: number;
  /** Index of the nearest sample (search hint). */
  index: number;
}

export class TrackSpline {
  readonly samples: SplineSample[] = [];
  readonly length: number;
  private readonly spacing: number;

  constructor(
    controlPoints: ReadonlyArray<readonly [number, number]>,
    heightFn: (sNorm: number) => number = () => 0,
    targetSpacing = 2,
  ) {
    if (controlPoints.length < 4) throw new Error('TrackSpline needs ≥4 control points');
    const n = controlPoints.length;

    // Pass 1: dense sampling of the closed Catmull-Rom curve.
    const dense: { x: number; z: number }[] = [];
    const SUBDIV = 24;
    for (let i = 0; i < n; i++) {
      const p0 = controlPoints[(i - 1 + n) % n];
      const p1 = controlPoints[i];
      const p2 = controlPoints[(i + 1) % n];
      const p3 = controlPoints[(i + 2) % n];
      for (let j = 0; j < SUBDIV; j++) {
        const u = j / SUBDIV;
        dense.push({
          x: catmullRom(p0[0], p1[0], p2[0], p3[0], u),
          z: catmullRom(p0[1], p1[1], p2[1], p3[1], u),
        });
      }
    }

    // Pass 2: resample at uniform arc length.
    let total = 0;
    const cum: number[] = [0];
    for (let i = 1; i <= dense.length; i++) {
      const a = dense[i - 1];
      const b = dense[i % dense.length];
      total += Math.hypot(b.x - a.x, b.z - a.z);
      cum.push(total);
    }
    this.length = total;
    const count = Math.max(64, Math.round(total / targetSpacing));
    this.spacing = total / count;

    let di = 0;
    for (let i = 0; i < count; i++) {
      const target = i * this.spacing;
      while (di < dense.length - 1 && cum[di + 1] < target) di++;
      const segLen = Math.max(cum[di + 1] - cum[di], 1e-6);
      const u = (target - cum[di]) / segLen;
      const a = dense[di];
      const b = dense[(di + 1) % dense.length];
      this.samples.push({
        x: a.x + (b.x - a.x) * u,
        z: a.z + (b.z - a.z) * u,
        y: 0,
        tanX: 0,
        tanZ: 0,
        curvature: 0,
        s: target,
      });
    }

    // Pass 3: heights, tangents (3D-aware in plan view), curvature.
    const m = this.samples.length;
    for (let i = 0; i < m; i++) {
      this.samples[i].y = heightFn(i / m);
    }
    for (let i = 0; i < m; i++) {
      const prev = this.samples[(i - 1 + m) % m];
      const next = this.samples[(i + 1) % m];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const len = Math.hypot(tx, tz) || 1;
      this.samples[i].tanX = tx / len;
      this.samples[i].tanZ = tz / len;
    }
    for (let i = 0; i < m; i++) {
      const cur = this.samples[i];
      const next = this.samples[(i + 1) % m];
      // right(f) = (fz, −fx); κ = dot(t_next, right_cur) / ds
      const rightX = cur.tanZ;
      const rightZ = -cur.tanX;
      cur.curvature = (next.tanX * rightX + next.tanZ * rightZ) / this.spacing;
    }
    // Light curvature smoothing (3-tap) — racing line + AI speed planning use it.
    const smoothed = this.samples.map((s, i) => {
      const a = this.samples[(i - 1 + m) % m].curvature;
      const b = s.curvature;
      const c = this.samples[(i + 1) % m].curvature;
      return (a + b * 2 + c) / 4;
    });
    for (let i = 0; i < m; i++) this.samples[i].curvature = smoothed[i];
  }

  wrap(s: number): number {
    s = s % this.length;
    return s < 0 ? s + this.length : s;
  }

  private indexAt(s: number): number {
    return Math.floor(this.wrap(s) / this.spacing) % this.samples.length;
  }

  sampleAt(s: number): SplineSample {
    return this.samples[this.indexAt(s)];
  }

  /** Interpolated centreline position at distance s. */
  posAt(s: number): { x: number; z: number; y: number } {
    const m = this.samples.length;
    const sw = this.wrap(s);
    const fi = sw / this.spacing;
    const i0 = Math.floor(fi) % m;
    const i1 = (i0 + 1) % m;
    const u = fi - Math.floor(fi);
    const a = this.samples[i0];
    const b = this.samples[i1];
    return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, y: a.y + (b.y - a.y) * u };
  }

  tangentAt(s: number): { x: number; z: number } {
    const smp = this.sampleAt(s);
    return { x: smp.tanX, z: smp.tanZ };
  }

  curvatureAt(s: number): number {
    return this.sampleAt(s).curvature;
  }

  heightAt(s: number): number {
    return this.posAt(s).y;
  }

  /** sin(slope) along +s at distance s (for slope gravity). */
  gradeSinAt(s: number): number {
    const h1 = this.heightAt(s - 2);
    const h2 = this.heightAt(s + 2);
    return clamp((h2 - h1) / 4, -0.25, 0.25);
  }

  /** Max |curvature| over a window ahead — AI braking-point planning. */
  maxCurvatureAhead(s: number, distance: number, step = 4): number {
    let maxK = 0;
    for (let d = 0; d <= distance; d += step) {
      maxK = Math.max(maxK, Math.abs(this.curvatureAt(s + d)));
    }
    return maxK;
  }

  /**
   * Project a world point to track-local (s, t).
   * Uses a windowed search around `hintS` (cars move continuously) with a
   * full-scan fallback when the hint is stale or missing.
   */
  project(x: number, z: number, hintS?: number): Projection {
    const m = this.samples.length;
    let bestI = 0;
    let bestD = Infinity;

    const consider = (i: number) => {
      const sm = this.samples[i];
      const d = (sm.x - x) ** 2 + (sm.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    };

    if (hintS !== undefined) {
      const center = this.indexAt(hintS);
      const windowN = Math.min(Math.ceil(40 / this.spacing), m >> 1); // ±40 m
      for (let o = -windowN; o <= windowN; o++) consider((center + o + m) % m);
      // Hint too stale → full scan.
      if (Math.sqrt(bestD) > 30) {
        bestD = Infinity;
        for (let i = 0; i < m; i++) consider(i);
      }
    } else {
      for (let i = 0; i < m; i++) consider(i);
    }

    const sm = this.samples[bestI];
    // Refine along the local tangent.
    const dx = x - sm.x;
    const dz = z - sm.z;
    const along = dx * sm.tanX + dz * sm.tanZ;
    const rightX = sm.tanZ;
    const rightZ = -sm.tanX;
    const t = dx * rightX + dz * rightZ;
    return { s: this.wrap(sm.s + along), t, index: bestI };
  }
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}
