import { beforeEach, describe, expect, it } from 'vitest';
import { GestureMapper } from '../src/input/GestureMapper';
import { GestureTrainer } from '../src/input/CustomGestures';
import { CalibrationSession } from '../src/input/Calibration';
import { DEFAULT_SETTINGS } from '../src/core/Settings';
import { featureVector } from '../src/vision/HandFeatures';
import { emptyHands, makeWheelHands, makeTrackedHand } from './helpers';
import type { ControlState } from '../src/input/ControlState';

function freshMapper(custom = []) {
  return new GestureMapper(
    structuredClone(DEFAULT_SETTINGS.control),
    structuredClone(DEFAULT_SETTINGS.calibration),
    custom,
  );
}

/** Run the mapper at ~60 Hz until filters/slew converge. */
function converge(mapper: GestureMapper, makeFrame: (ts: number) => any, frames = 90): ControlState {
  let out!: ControlState;
  for (let i = 0; i < frames; i++) {
    const ts = i * (1000 / 60);
    out = mapper.update(makeFrame(ts), ts);
  }
  return out;
}

describe('GestureMapper — steering', () => {
  let mapper: GestureMapper;
  beforeEach(() => (mapper = freshMapper()));

  it('wheel level → zero steer (dead-zone)', () => {
    const out = converge(mapper, (ts) => makeWheelHands(0.02, 'grip', 'grip', ts));
    expect(Math.abs(out.steer)).toBeLessThan(0.02);
    expect(out.gesture.wheelEngaged).toBe(true);
  });

  // NB: steer is the NEGATED wheel angle — the car turns the way the user turns
  // the wheel (fixes the reported left-input → right-turn inversion). So a
  // positive makeWheelHands() angle yields negative steer and vice-versa.
  it('wheel rotation maps proportionally to steer (corrected sign)', () => {
    const out = converge(mapper, (ts) => makeWheelHands(0.5, 'grip', 'grip', ts));
    const mag = 0.5 / DEFAULT_SETTINGS.calibration.maxLockAngle; // ≈0.38 before dead-zone
    expect(out.steer).toBeLessThan(-(mag - 0.12)); // negative, proportional
    expect(out.steer).toBeGreaterThan(-(mag + 0.12));
  });

  it('opposite wheel rotation flips steer sign', () => {
    const out = converge(mapper, (ts) => makeWheelHands(-0.6, 'grip', 'grip', ts));
    expect(out.steer).toBeGreaterThan(0.3);
  });

  it('full lock clamps at ±1', () => {
    const out = converge(mapper, (ts) => makeWheelHands(1.45, 'grip', 'grip', ts));
    expect(out.steer).toBeLessThan(-0.9);
    expect(out.steer).toBeGreaterThanOrEqual(-1);
  });

  it('sensitivity setting scales the response', () => {
    mapper.settings.steerSensitivity = 2;
    const out = converge(mapper, (ts) => makeWheelHands(0.45, 'grip', 'grip', ts));
    expect(out.steer).toBeLessThan(-0.55);
  });

  it('hands lost → steering coasts back to centre instead of snapping', () => {
    converge(mapper, (ts) => makeWheelHands(0.8, 'grip', 'grip', ts));
    let out!: ControlState;
    let firstFrameAfterLoss = Infinity;
    for (let i = 0; i < 90; i++) {
      const ts = (90 + i) * (1000 / 60);
      out = mapper.update(emptyHands(ts), ts);
      if (i === 0) firstFrameAfterLoss = Math.abs(out.steer);
    }
    expect(firstFrameAfterLoss).toBeGreaterThan(0.2); // no snap on the first frame
    expect(Math.abs(out.steer)).toBeLessThan(0.15);   // decayed ~1.5 s later
  });

  it('steering output is slew-limited (no teleporting wheel)', () => {
    converge(mapper, (ts) => makeWheelHands(-1.2, 'grip', 'grip', ts), 60);
    const before = mapper.update(makeWheelHands(-1.2, 'grip', 'grip', 1000), 1000).steer;
    const after = mapper.update(makeWheelHands(1.2, 'grip', 'grip', 1016), 1016).steer;
    expect(Math.abs(after - before)).toBeLessThan(0.12); // ≤ slew*dt
  });
});

describe('GestureMapper — gestures to controls', () => {
  let mapper: GestureMapper;
  beforeEach(() => (mapper = freshMapper()));

  it('single fist → throttle (gas), no brake', () => {
    const out = converge(mapper, (ts) => makeWheelHands(0, 'fist', 'grip', ts));
    expect(out.throttle).toBeGreaterThanOrEqual(0.85);
    expect(out.reverse).toBe(false);
    expect(out.brake).toBe(0);
  });

  it('BOTH fists → full throttle', () => {
    const out = converge(mapper, (ts) => makeWheelHands(0, 'fist', 'fist', ts));
    expect(out.throttle).toBe(1);
    expect(out.brake).toBe(0);
  });

  it('thumb-up → reverse request with throttle', () => {
    const out = converge(mapper, (ts) => makeWheelHands(0, 'grip', 'thumbUp', ts));
    expect(out.reverse).toBe(true);
    expect(out.throttle).toBeGreaterThan(0.15);
  });

  it('single thumb-down → strong brake', () => {
    const out = converge(mapper, (ts) => makeWheelHands(0, 'grip', 'thumbDown', ts));
    expect(out.brake).toBeGreaterThanOrEqual(0.85);
    expect(out.throttle).toBe(0);
    expect(out.handbrake).toBe(false);
  });

  it('BOTH thumbs-down → maximum brake', () => {
    const out = converge(mapper, (ts) => makeWheelHands(0, 'thumbDown', 'thumbDown', ts));
    expect(out.brake).toBe(1);
  });

  it('thumb-down + hard wheel tilt → drift (handbrake), not full brake', () => {
    const out = converge(mapper, (ts) => makeWheelHands(0.95, 'thumbDown', 'grip', ts));
    expect(out.handbrake).toBe(true);
    expect(out.brake).toBeLessThan(0.5);
    expect(Math.abs(out.steer)).toBeGreaterThan(0.45);
  });

  it('peace sign → nitro', () => {
    const out = converge(mapper, (ts) => makeWheelHands(0, 'grip', 'peace', ts));
    expect(out.nitro).toBe(true);
  });

  it('open palm held 2 s → pause fires exactly once', () => {
    let fired = 0;
    for (let i = 0; i < 200; i++) {
      const ts = i * (1000 / 60);
      const out = mapper.update(makeWheelHands(0, 'open', 'open', ts), ts);
      if (out.pauseFired) fired++;
    }
    expect(fired).toBe(1);
  });

  it('open palms disengage the wheel (no steering while pausing)', () => {
    const out = converge(mapper, (ts) => makeWheelHands(0.8, 'open', 'open', ts));
    expect(out.gesture.wheelEngaged).toBe(false);
    expect(Math.abs(out.steer)).toBeLessThan(0.1);
  });
});

describe('Custom gesture training', () => {
  it('trains a centroid from consistent samples and matches live', () => {
    const trainer = new GestureTrainer();
    for (let i = 0; i < 45; i++) {
      const hand = makeTrackedHand('point', 'right', 0.5 + (i % 5) * 0.001, 0.5);
      trainer.addSample(featureVector(hand.features));
    }
    const sample = trainer.build('nitro', 'custom-point');
    expect(sample).not.toBeNull();
    expect(sample!.threshold).toBeGreaterThanOrEqual(0.86);

    const mapper = freshMapper();
    mapper.customGestures = [sample!];
    const out = converge(mapper, (ts) => makeWheelHands(0, 'grip', 'point', ts));
    expect(out.gesture.customActive).toBe('custom-point');
    expect(out.nitro).toBe(true); // custom replaces the default peace binding
  });

  it('rejects inconsistent training data', () => {
    const trainer = new GestureTrainer();
    const poses = ['open', 'fist', 'peace', 'point', 'thumbUp'] as const;
    for (let i = 0; i < 45; i++) {
      const hand = makeTrackedHand(poses[i % poses.length], 'right', 0.5, 0.5);
      trainer.addSample(featureVector(hand.features));
    }
    expect(trainer.build('nitro', 'bad')).toBeNull();
  });

  it('a custom PAUSE gesture fires once per activation, not every held frame', () => {
    // Regression: a held custom-pause pose used to set pauseFired every frame,
    // which oscillated pause/resume because the mapper is polled in both the
    // racing and paused update loops.
    const trainer = new GestureTrainer();
    for (let i = 0; i < 45; i++) {
      const hand = makeTrackedHand('point', 'right', 0.5 + (i % 5) * 0.001, 0.5);
      trainer.addSample(featureVector(hand.features));
    }
    const sample = trainer.build('pause', 'custom-pause')!;
    const mapper = freshMapper();
    mapper.customGestures = [sample];

    // Hold the pose for 60 frames → exactly one pause edge.
    let firedWhileHeld = 0;
    for (let i = 0; i < 60; i++) {
      const ts = i * (1000 / 60);
      const out = mapper.update(makeWheelHands(0, 'grip', 'point', ts), ts);
      if (out.pauseFired) firedWhileHeld++;
    }
    expect(firedWhileHeld).toBe(1);

    // Release (grip both), then re-form the pose → it re-arms and fires again.
    for (let i = 60; i < 80; i++) {
      const ts = i * (1000 / 60);
      mapper.update(makeWheelHands(0, 'grip', 'grip', ts), ts);
    }
    let firedSecond = 0;
    for (let i = 80; i < 130; i++) {
      const ts = i * (1000 / 60);
      const out = mapper.update(makeWheelHands(0, 'grip', 'point', ts), ts);
      if (out.pauseFired) firedSecond++;
    }
    expect(firedSecond).toBe(1);
  });
});

describe('CalibrationSession', () => {
  it('captures neutral, lock range and thumb range end-to-end', () => {
    const session = new CalibrationSession(structuredClone(DEFAULT_SETTINGS.calibration));
    const dt = 1 / 30;

    // Step 1: neutral at a slightly tilted natural grip (+0.1 rad)
    while (session.step === 'neutral') session.feed(makeWheelHands(0.1, 'grip', 'grip'), dt);
    expect(session.step).toBe('lock');

    // Step 2: sweep to ±1.0 rad
    let t = 0;
    while (session.step === 'lock') {
      const angle = 0.1 + Math.sin(t * 2) * 1.0;
      session.feed(makeWheelHands(angle, 'grip', 'grip'), dt);
      t += dt;
    }
    expect(session.step).toBe('throttle');

    // Step 3: thumb-down sweep via hand rotation
    t = 0;
    let done = false;
    while (!done && t < 10) {
      const hands = makeWheelHands(0, 'grip', 'grip');
      const rot = Math.sin(t * 1.5) * 0.3;
      hands.right = makeTrackedHand('thumbDown', 'right', 0.35, 0.55, { rotation: rot });
      done = session.feed(hands, dt);
      t += dt;
    }
    expect(done).toBe(true);

    const result = session.getResult();
    expect(result.neutralAngle).toBeCloseTo(0.1, 1);
    expect(result.maxLockAngle).toBeGreaterThan(0.6);
    expect(result.maxLockAngle).toBeLessThan(1.1);
    expect(result.throttleMaxAngle).toBeGreaterThan(result.throttleMinAngle);
    expect(result.calibratedAt).toBeGreaterThan(0);
  });
});
