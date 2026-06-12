/**
 * Headless end-to-end race: wires the REAL pipeline — synthetic hands →
 * features → classifier → gesture mapper → vehicle dynamics → track physics →
 * race director — and asserts a full race runs to completion with the ghost
 * driver, plus a player-vs-AI sanity race. This is the "the whole game
 * actually plays" guarantee, runnable in CI with no browser.
 */
import { describe, expect, it } from 'vitest';
import { SyntheticHandSource } from '../src/vision/SyntheticHands';
import { extractFeatures } from '../src/vision/HandFeatures';
import { classifyPose, GestureStabilizer } from '../src/vision/GestureClassifier';
import { LandmarkFilterBank } from '../src/vision/OneEuro';
import { GestureMapper } from '../src/input/GestureMapper';
import { DEFAULT_SETTINGS } from '../src/core/Settings';
import { VehicleDynamics } from '../src/physics/VehicleDynamics';
import { TrackSpline } from '../src/track/Spline';
import { TrackPhysics } from '../src/physics/TrackPhysics';
import { AIDriver, AI_PRESETS } from '../src/ai/AIDriver';
import { RaceDirector } from '../src/ai/RaceDirector';
import { trackById } from '../src/track/TrackData';
import type { HandRole, HandsState, TrackedHand } from '../src/vision/HandTypes';
import type { RawHandsFrame } from '../src/vision/HandTypes';

/** Mini version of HandTracker's association + smoothing for headless use. */
function buildHandsState(frame: RawHandsFrame, banks: Record<HandRole, LandmarkFilterBank>, stabs: Record<HandRole, GestureStabilizer>): HandsState {
  const t = frame.captureTs / 1000;
  const sorted = [...frame.hands].sort((a, b) => palmX(a.landmarks) - palmX(b.landmarks));
  const assign: Partial<Record<HandRole, Float32Array>> = {};
  if (sorted.length >= 2) {
    assign.right = sorted[0].landmarks; // user right = image left
    assign.left = sorted[sorted.length - 1].landmarks;
  }
  const make = (role: HandRole): TrackedHand | null => {
    const raw = assign[role];
    if (!raw) return null;
    const sm = new Float32Array(63);
    banks[role].apply(raw, sm, t);
    const features = extractFeatures(sm);
    const pose = stabs[role].push(classifyPose(features));
    return { role, landmarks: sm, features, pose, poseConfidence: stabs[role].confidence, score: 0.95, velX: 0, velY: 0, lastSeenTs: frame.captureTs, coasting: false };
  };
  return { left: make('left'), right: make('right'), captureTs: frame.captureTs, inferMs: 0, liveCount: sorted.length };
}

function palmX(buf: Float32Array): number {
  return (buf[0] + buf[5 * 3] + buf[9 * 3] + buf[13 * 3]) / 4;
}

describe('end-to-end gesture → drive pipeline', () => {
  it('synthetic ghost driver produces real throttle + steering through the full stack', () => {
    const source = new SyntheticHandSource();
    const banks = { left: new LandmarkFilterBank(21), right: new LandmarkFilterBank(21) };
    const stabs = { left: new GestureStabilizer(), right: new GestureStabilizer() };
    const mapper = new GestureMapper(structuredClone(DEFAULT_SETTINGS.control), structuredClone(DEFAULT_SETTINGS.calibration));
    const dyn = new VehicleDynamics();

    let maxThrottle = 0;
    let sawSteerLeft = false;
    let sawSteerRight = false;
    let sawNitro = false;
    let sawBrake = false;

    const DT = 1 / 60;
    for (let i = 0; i < 60 * 22; i++) {
      // synthetic source runs at its own cadence; sample every frame
      const ts = i * (1000 / 60);
      const frame = source.frameAt(ts / 1000, ts);
      const hands = buildHandsState(frame, banks, stabs);
      const control = mapper.update(hands, ts);
      dyn.step(control, { grip: 1, drag: 1, gradeSin: 0 }, DT);
      maxThrottle = Math.max(maxThrottle, control.throttle);
      if (control.steer < -0.15) sawSteerLeft = true;
      if (control.steer > 0.15) sawSteerRight = true;
      if (control.nitro) sawNitro = true;
      if (control.brake > 0.5) sawBrake = true;
    }

    // The scripted demo accelerates, slaloms both ways, brakes, nitros, drifts.
    expect(maxThrottle).toBeGreaterThan(0.6);
    expect(sawSteerLeft).toBe(true);
    expect(sawSteerRight).toBe(true);
    expect(sawNitro).toBe(true);
    expect(sawBrake).toBe(true);
    // Car actually went somewhere.
    expect(Math.hypot(dyn.state.x, dyn.state.z)).toBeGreaterThan(20);
    expect(Number.isFinite(dyn.state.heading)).toBe(true);
  });

  it('runs a full player(synthetic)+AI race to completion on the city track', () => {
    const def = trackById('city');
    const spline = new TrackSpline(def.controlPoints, def.heightFn);
    const tp = new TrackPhysics(spline, def);
    const director = new RaceDirector(spline, 1);

    const source = new SyntheticHandSource();
    const banks = { left: new LandmarkFilterBank(21), right: new LandmarkFilterBank(21) };
    const stabs = { left: new GestureStabilizer(), right: new GestureStabilizer() };
    const mapper = new GestureMapper(structuredClone(DEFAULT_SETTINGS.control), structuredClone(DEFAULT_SETTINGS.calibration));

    // 1 gesture player + 3 AI.
    const cars = [0, 1, 2, 3].map((i) => {
      const dyn = new VehicleDynamics();
      const start = spline.posAt(-i * 6);
      const tan = spline.tangentAt(-i * 6);
      dyn.teleport(start.x, start.z, Math.atan2(tan.x, tan.z));
      const isPlayer = i === 0;
      director.addRacer(isPlayer ? 'player' : `ai${i}`, isPlayer, spline.wrap(-i * 6));
      return {
        id: isPlayer ? 'player' : `ai${i}`,
        isPlayer,
        dyn,
        driver: isPlayer ? null : new AIDriver(spline, def.halfWidth, AI_PRESETS.racer, i * 0.2),
        s: spline.wrap(-i * 6),
        t: 0,
      };
    });
    director.start();

    const DT = 1 / 120;
    let raceTime = 0;
    let steps = 0;
    const maxSteps = 120 * 240; // 4 min cap
    while (!director.allFinished && steps < maxSteps) {
      // gesture input for the player (forced throttle so the ghost commits)
      const ts = raceTime * 1000;
      const frame = source.frameAt(raceTime, ts);
      const hands = buildHandsState(frame, banks, stabs);
      const playerControl = mapper.update(hands, ts);

      for (const car of cars) {
        let inputs;
        if (car.isPlayer) {
          inputs = { ...playerControl, throttle: Math.max(playerControl.throttle, 0.85), brake: 0, handbrake: false, reverse: false };
        } else {
          inputs = car.driver!.update(DT, car.dyn.state, car.s, car.t, [], 0, raceTime);
        }
        const surf = tp.sample(car.dyn.state.x, car.dyn.state.z, car.dyn.state.heading, car.s).surface;
        car.dyn.step(inputs, surf, DT);
        const info = tp.sample(car.dyn.state.x, car.dyn.state.z, car.dyn.state.heading, car.s);
        tp.resolveBounds(car.dyn, info);
        car.s = info.s;
        car.t = info.t;
        director.updateRacer(car.id, info.s, DT);
      }
      director.tick(DT * 1000);
      raceTime += DT;
      steps++;
    }

    expect(director.allFinished).toBe(true);
    const standings = director.standings;
    expect(standings.length).toBe(4);
    // everyone completed exactly one lap with a finite finish time
    for (const r of standings) {
      expect(r.finished).toBe(true);
      expect(r.finishTimeMs).toBeGreaterThan(10_000);
    }
    // positions are a strict 1..4 permutation
    expect([...standings].map((r) => r.position).sort()).toEqual([1, 2, 3, 4]);
  }, 30_000);
});
