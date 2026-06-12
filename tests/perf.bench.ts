/**
 * Performance benchmarks for the hot per-frame paths. These quantify the CPU
 * budget the real-time loop consumes (everything here runs every physics tick
 * or CV frame), proving there's ample headroom under the 16.6 ms frame budget
 * even before the GPU does any drawing.
 *
 * Run: npm run bench
 */
import { bench, describe } from 'vitest';
import { SyntheticHandSource } from '../src/vision/SyntheticHands';
import { extractFeatures, featureVector } from '../src/vision/HandFeatures';
import { classifyPose, GestureStabilizer } from '../src/vision/GestureClassifier';
import { LandmarkFilterBank } from '../src/vision/OneEuro';
import { GestureMapper } from '../src/input/GestureMapper';
import { DEFAULT_SETTINGS } from '../src/core/Settings';
import { VehicleDynamics, FLAT_SURFACE } from '../src/physics/VehicleDynamics';
import { TrackSpline } from '../src/track/Spline';
import { TrackPhysics, resolveCarContacts } from '../src/physics/TrackPhysics';
import { AIDriver, AI_PRESETS } from '../src/ai/AIDriver';
import { trackById } from '../src/track/TrackData';
import { neutralInputs } from '../src/input/ControlState';

const source = new SyntheticHandSource();
const frame = source.frameAt(5.2, 5200);
const buf = frame.hands[0].landmarks;

describe('CV per-frame', () => {
  bench('extractFeatures (1 hand)', () => {
    extractFeatures(buf);
  });

  const feats = extractFeatures(buf);
  bench('classifyPose', () => {
    classifyPose(feats);
  });

  bench('featureVector', () => {
    featureVector(feats);
  });

  const bank = new LandmarkFilterBank(21);
  let t = 0;
  bench('OneEuro landmark smoothing (21 pts)', () => {
    t += 1 / 30;
    bank.apply(buf, buf, t);
  });

  const stab = new GestureStabilizer();
  bench('gesture stabilizer push', () => {
    stab.push('grip');
  });
});

describe('input mapping per-frame', () => {
  const mapper = new GestureMapper(structuredClone(DEFAULT_SETTINGS.control), structuredClone(DEFAULT_SETTINGS.calibration));
  // Build a HandsState once.
  const banks = { left: new LandmarkFilterBank(21), right: new LandmarkFilterBank(21) };
  const sm = new Float32Array(63);
  banks.left.apply(frame.hands[0].landmarks, sm, 0.1);
  const hands = {
    left: { role: 'left' as const, landmarks: sm, features: extractFeatures(sm), pose: 'grip' as const, poseConfidence: 1, score: 0.9, velX: 0, velY: 0, lastSeenTs: 0, coasting: false },
    right: { role: 'right' as const, landmarks: sm, features: extractFeatures(sm), pose: 'thumbDown' as const, poseConfidence: 1, score: 0.9, velX: 0, velY: 0, lastSeenTs: 0, coasting: false },
    captureTs: 0,
    inferMs: 0,
    liveCount: 2,
  };
  let ts = 0;
  bench('GestureMapper.update (full)', () => {
    ts += 16.6;
    mapper.update(hands, ts);
  });
});

describe('physics per-tick', () => {
  const dyn = new VehicleDynamics();
  const inputs = { ...neutralInputs(), throttle: 1, steer: 0.4 };
  bench('VehicleDynamics.step (1 car)', () => {
    dyn.step(inputs, FLAT_SURFACE, 1 / 120);
  });

  // Full field: 8 cars + AI + track sampling + collisions
  const def = trackById('city');
  const spline = new TrackSpline(def.controlPoints, def.heightFn);
  const tp = new TrackPhysics(spline, def);
  const cars = Array.from({ length: 8 }, (_, i) => {
    const d = new VehicleDynamics();
    const p = spline.posAt(i * 12);
    d.teleport(p.x, p.z, 0);
    d.state.vx = 30;
    return d;
  });
  const drivers = cars.map((_, i) => new AIDriver(spline, def.halfWidth, AI_PRESETS.racer, i * 0.1));
  const sList = cars.map((_, i) => i * 12);
  bench('full field tick: 8 cars + AI + track + collisions', () => {
    for (let i = 0; i < cars.length; i++) {
      const info = tp.sample(cars[i].state.x, cars[i].state.z, cars[i].state.heading, sList[i]);
      const inp = drivers[i].update(1 / 120, cars[i].state, info.s, info.t, [], 0, 10);
      cars[i].step(inp, info.surface, 1 / 120);
      tp.resolveBounds(cars[i], info);
      sList[i] = info.s;
    }
    resolveCarContacts(cars);
  });
});

describe('track build (per race load)', () => {
  const def = trackById('mountain');
  bench('TrackSpline construction', () => {
    new TrackSpline(def.controlPoints, def.heightFn);
  });

  const spline = new TrackSpline(def.controlPoints, def.heightFn);
  bench('spline.project (windowed)', () => {
    spline.project(40, 40, 100);
  });

  bench('AIDriver racing-line precompute', () => {
    new AIDriver(spline, def.halfWidth, AI_PRESETS.pro, 0.5);
  });
});
