/**
 * One Euro Filter (Casiez et al. 2012) — the standard for low-latency,
 * jitter-free smoothing of noisy human-input signals. Adaptive: smooths hard
 * when the signal is slow (kills jitter), follows tightly when it moves fast
 * (kills lag). Used on hand landmarks and the steering signal.
 */

function smoothingFactor(cutoff: number, dt: number): number {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

export class OneEuroFilter {
  private xPrev = 0;
  private dxPrev = 0;
  private tPrev = -1;
  private initialized = false;

  constructor(
    /** Minimum cutoff frequency (Hz). Lower = smoother at rest. */
    public minCutoff = 1.2,
    /** Speed coefficient. Higher = less lag during fast motion. */
    public beta = 0.01,
    /** Cutoff for the derivative low-pass. */
    public dCutoff = 1.0,
  ) {}

  reset(): void {
    this.initialized = false;
    this.tPrev = -1;
  }

  /** t in seconds. */
  filter(x: number, t: number): number {
    if (!this.initialized || t <= this.tPrev) {
      this.initialized = true;
      this.tPrev = t;
      this.xPrev = x;
      this.dxPrev = 0;
      return x;
    }
    const dt = t - this.tPrev;
    this.tPrev = t;

    const dx = (x - this.xPrev) / dt;
    const aD = smoothingFactor(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    this.dxPrev = dxHat;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = smoothingFactor(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    return xHat;
  }

  get velocity(): number {
    return this.dxPrev;
  }
}

/** Bank of One Euro filters for a flat landmark buffer (x,y filtered; z passthrough). */
export class LandmarkFilterBank {
  private filters: OneEuroFilter[] = [];

  constructor(
    private count: number,
    private minCutoff = 1.6,
    // Tuned for normalised image coords where palm velocities peak ~1-2 u/s:
    // beta must be large enough that fast wheel turns raise the cutoff.
    private beta = 0.6,
  ) {
    for (let i = 0; i < count * 2; i++) {
      this.filters.push(new OneEuroFilter(this.minCutoff, this.beta));
    }
  }

  reset(): void {
    for (const f of this.filters) f.reset();
  }

  setParams(minCutoff: number, beta: number): void {
    for (const f of this.filters) {
      f.minCutoff = minCutoff;
      f.beta = beta;
    }
  }

  /** Filters in place into `out` (may be the same buffer as `src`). t in seconds. */
  apply(src: Float32Array, out: Float32Array, t: number): void {
    for (let i = 0; i < this.count; i++) {
      out[i * 3] = this.filters[i * 2].filter(src[i * 3], t);
      out[i * 3 + 1] = this.filters[i * 2 + 1].filter(src[i * 3 + 1], t);
      out[i * 3 + 2] = src[i * 3 + 2];
    }
  }
}
