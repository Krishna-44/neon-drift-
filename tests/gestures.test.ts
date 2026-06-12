import { describe, expect, it } from 'vitest';
import { placeTemplate, POSE_TEMPLATES, TemplateName } from '../src/vision/SyntheticHands';
import { extractFeatures, featureVector, cosineSimilarity } from '../src/vision/HandFeatures';
import { classifyPose, GestureStabilizer, HoldDetector } from '../src/vision/GestureClassifier';
import { seededRandom } from '../src/core/MathUtils';

const EXPECTED: Record<TemplateName, string> = {
  open: 'open',
  fist: 'fist',
  grip: 'grip',
  thumbUp: 'thumbUp',
  thumbDown: 'thumbDown',
  peace: 'peace',
  point: 'point',
};

function featuresOf(name: TemplateName, opts: Parameters<typeof placeTemplate>[1]) {
  return extractFeatures(placeTemplate(name, opts));
}

describe('feature extraction + pose classification', () => {
  it('classifies every canonical template correctly', () => {
    for (const name of Object.keys(POSE_TEMPLATES) as TemplateName[]) {
      const f = featuresOf(name, { cx: 0.5, cy: 0.5, scale: 0.13 });
      expect(classifyPose(f), `template ${name}`).toBe(EXPECTED[name]);
    }
  });

  it('classifies mirrored (left-hand) templates identically', () => {
    for (const name of Object.keys(POSE_TEMPLATES) as TemplateName[]) {
      const f = featuresOf(name, { cx: 0.5, cy: 0.5, scale: 0.13, mirrorX: true });
      expect(classifyPose(f), `mirrored ${name}`).toBe(EXPECTED[name]);
    }
  });

  it('is robust to moderate hand rotation (wheel tilt) for grip/fist/open', () => {
    for (const name of ['grip', 'fist', 'open'] as TemplateName[]) {
      for (const rot of [-0.5, -0.25, 0.25, 0.5]) {
        const f = featuresOf(name, { cx: 0.5, cy: 0.5, scale: 0.13, rotation: rot });
        expect(classifyPose(f), `${name} @ ${rot}rad`).toBe(EXPECTED[name]);
      }
    }
  });

  it('survives realistic landmark noise (95%+ accuracy over 200 trials)', () => {
    const rng = seededRandom(42);
    let correct = 0;
    const names = Object.keys(POSE_TEMPLATES) as TemplateName[];
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      const name = names[i % names.length];
      const f = featuresOf(name, { cx: 0.5, cy: 0.5, scale: 0.13, noise: 0.004, rng });
      if (classifyPose(f) === EXPECTED[name]) correct++;
    }
    expect(correct / trials).toBeGreaterThan(0.95);
  });

  it('scales with hand size (near and far hands classify the same)', () => {
    for (const scale of [0.07, 0.13, 0.22]) {
      const f = featuresOf('thumbDown', { cx: 0.5, cy: 0.5, scale });
      expect(classifyPose(f)).toBe('thumbDown');
    }
  });

  it('thumbDown angle grows with hand rotation (proportional throttle signal)', () => {
    const shallow = featuresOf('thumbDown', { cx: 0.5, cy: 0.5, rotation: 0.35 });
    const steep = featuresOf('thumbDown', { cx: 0.5, cy: 0.5, rotation: -0.2 });
    // rotation counter-clockwise pushes the (left-side) thumb further down
    expect(steep.thumbDownAngle).not.toBe(shallow.thumbDownAngle);
    expect(Math.abs(steep.thumbDownAngle - shallow.thumbDownAngle)).toBeGreaterThan(0.2);
  });

  it('palm centre lands where the template was placed', () => {
    const f = featuresOf('grip', { cx: 0.31, cy: 0.62, scale: 0.13 });
    expect(f.palmX).toBeCloseTo(0.31, 1);
    expect(f.palmY).toBeCloseTo(0.62, 1);
  });

  it('featureVector separates dissimilar poses and matches identical ones', () => {
    const a = featureVector(featuresOf('peace', { cx: 0.5, cy: 0.5 }));
    const b = featureVector(featuresOf('peace', { cx: 0.4, cy: 0.6 }));
    const c = featureVector(featuresOf('open', { cx: 0.5, cy: 0.5 }));
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
    expect(cosineSimilarity(a, c)).toBeLessThan(0.9);
  });
});

describe('GestureStabilizer (anti-flicker)', () => {
  it('requires consecutive frames before activating a pose', () => {
    const s = new GestureStabilizer();
    expect(s.push('fist')).toBe('none');
    expect(s.push('fist')).toBe('none');
    expect(s.push('fist')).toBe('none');
    expect(s.push('fist')).toBe('fist'); // 4 frames for fist
  });

  it('ignores single-frame blips while a pose is active', () => {
    const s = new GestureStabilizer();
    for (let i = 0; i < 5; i++) s.push('grip');
    expect(s.pose).toBe('grip');
    s.push('fist'); // one noisy frame
    expect(s.pose).toBe('grip');
    s.push('grip');
    s.push('fist');
    expect(s.pose).toBe('grip'); // still stable
  });

  it('alternating noise never flickers the output', () => {
    const s = new GestureStabilizer();
    for (let i = 0; i < 6; i++) s.push('grip');
    const outputs = new Set<string>();
    for (let i = 0; i < 40; i++) outputs.add(s.push(i % 2 === 0 ? 'fist' : 'grip'));
    expect(outputs.size).toBe(1);
    expect([...outputs][0]).toBe('grip');
  });

  it('legitimate sustained pose change goes through', () => {
    const s = new GestureStabilizer();
    for (let i = 0; i < 6; i++) s.push('grip');
    for (let i = 0; i < 6; i++) s.push('thumbDown');
    expect(s.pose).toBe('thumbDown');
    expect(s.confidence).toBeGreaterThan(0.4);
  });
});

describe('HoldDetector (open palm → pause)', () => {
  it('fires exactly once after the hold duration', () => {
    const h = new HoldDetector(2.0, 'open');
    let fired = 0;
    for (let t = 0; t <= 2.6; t += 0.033) {
      if (h.update('open', t)) fired++;
    }
    expect(fired).toBe(1);
    expect(h.progress).toBe(1);
  });

  it('resets when the pose breaks early', () => {
    const h = new HoldDetector(2.0, 'open');
    for (let t = 0; t < 1.5; t += 0.033) h.update('open', t);
    expect(h.progress).toBeGreaterThan(0.6);
    h.update('grip', 1.55);
    expect(h.progress).toBe(0);
    let fired = 0;
    for (let t = 1.6; t < 3.0; t += 0.033) {
      if (h.update('open', t)) fired++;
    }
    expect(fired).toBe(0); // only 1.4 s of hold after the break
  });
});
