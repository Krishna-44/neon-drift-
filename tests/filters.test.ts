import { describe, expect, it } from 'vitest';
import { OneEuroFilter, LandmarkFilterBank } from '../src/vision/OneEuro';
import { clamp, damp, deadZone, expoCurve, moveToward, RollingStats, seededRandom, wrapAngle } from '../src/core/MathUtils';

describe('OneEuroFilter', () => {
  it('passes a constant signal through unchanged', () => {
    const f = new OneEuroFilter();
    let out = 0;
    for (let i = 0; i < 100; i++) out = f.filter(5, i / 60);
    expect(out).toBeCloseTo(5, 5);
  });

  it('reduces jitter on a noisy stationary signal', () => {
    const rng = seededRandom(7);
    const f = new OneEuroFilter(1.0, 0.005);
    const rawDeltas: number[] = [];
    const filtDeltas: number[] = [];
    let prevRaw = 0;
    let prevFilt = 0;
    for (let i = 0; i < 300; i++) {
      const raw = 0.5 + (rng() - 0.5) * 0.05;
      const filt = f.filter(raw, i / 60);
      if (i > 10) {
        rawDeltas.push(Math.abs(raw - prevRaw));
        filtDeltas.push(Math.abs(filt - prevFilt));
      }
      prevRaw = raw;
      prevFilt = filt;
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(filtDeltas)).toBeLessThan(mean(rawDeltas) * 0.35); // ≥65 % jitter reduction
  });

  it('velocity adaptation cuts lag on fast motion vs a plain low-pass', () => {
    const adaptive = new OneEuroFilter(1.0, 2.0);
    const plain = new OneEuroFilter(1.0, 0.0);
    let outA = 0;
    let outP = 0;
    // fast ramp: 0→1 in 0.25 s @ 240 Hz
    for (let i = 0; i <= 60; i++) {
      const t = i / 240;
      const x = Math.min(t / 0.25, 1);
      outA = adaptive.filter(x, t);
      outP = plain.filter(x, t);
    }
    expect(outA).toBeGreaterThan(0.85); // adaptive: <15 % lag at sweep end
    expect(outA).toBeGreaterThan(outP + 0.1); // and clearly beats the static filter
  });

  it('filter bank smooths whole landmark buffers in place', () => {
    const bank = new LandmarkFilterBank(21);
    const rng = seededRandom(3);
    const src = new Float32Array(63);
    const out = new Float32Array(63);
    for (let frame = 0; frame < 60; frame++) {
      for (let i = 0; i < 21; i++) {
        src[i * 3] = 0.5 + (rng() - 0.5) * 0.02;
        src[i * 3 + 1] = 0.5 + (rng() - 0.5) * 0.02;
      }
      bank.apply(src, out, frame / 30);
    }
    expect(Math.abs(out[0] - 0.5)).toBeLessThan(0.01);
  });
});

describe('math utils', () => {
  it('clamp / moveToward / damp behave', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(moveToward(0, 1, 0.25)).toBe(0.25);
    expect(moveToward(0.9, 1, 0.25)).toBe(1);
    const d = damp(0, 10, 0.1, 0.1);
    expect(d).toBeCloseTo(5, 5); // one half-life closes half the gap
  });

  it('deadZone rescales beyond the zone', () => {
    expect(deadZone(0.05, 0.1)).toBe(0);
    expect(deadZone(-0.05, 0.1)).toBe(0);
    expect(deadZone(1, 0.1)).toBeCloseTo(1, 5);
    expect(deadZone(0.55, 0.1)).toBeCloseTo(0.5, 5);
  });

  it('expoCurve keeps endpoints and softens the centre', () => {
    expect(expoCurve(1, 0.3)).toBeCloseTo(1, 5);
    expect(expoCurve(-1, 0.3)).toBeCloseTo(-1, 5);
    expect(Math.abs(expoCurve(0.5, 0.3))).toBeLessThan(0.5);
  });

  it('wrapAngle stays in (-PI, PI]', () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 5);
    expect(wrapAngle(-Math.PI * 2.5)).toBeCloseTo(-Math.PI * 0.5, 5);
  });

  it('RollingStats window math', () => {
    const r = new RollingStats(4);
    [1, 2, 3, 4, 5].forEach((v) => r.push(v)); // 1 evicted
    expect(r.mean).toBeCloseTo(3.5, 5);
    expect(r.max).toBe(5);
    expect(r.std).toBeGreaterThan(0);
  });

  it('seededRandom is deterministic', () => {
    const a = seededRandom(99);
    const b = seededRandom(99);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });
});
