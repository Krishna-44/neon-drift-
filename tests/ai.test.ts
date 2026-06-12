import { describe, expect, it } from 'vitest';
import { AIDriver, AI_PRESETS } from '../src/ai/AIDriver';
import { RaceDirector } from '../src/ai/RaceDirector';
import { TrackSpline } from '../src/track/Spline';
import { TrackPhysics } from '../src/physics/TrackPhysics';
import { VehicleDynamics } from '../src/physics/VehicleDynamics';
import { trackById } from '../src/track/TrackData';
import { RaceObserver, suggestAssists, suggestDifficulty, updateProfile } from '../src/game/AdaptiveProfile';
import { DEFAULT_SETTINGS } from '../src/core/Settings';

const DT = 1 / 120;

/**
 * Full-stack integration sim: an AI car on the real desert track using the
 * real physics. The strongest "the game actually drives" guarantee we can
 * get headlessly.
 */
function simulateAILap(trackId: string, difficulty: keyof typeof AI_PRESETS, maxSeconds = 180) {
  const def = trackById(trackId);
  const spline = new TrackSpline(def.controlPoints, def.heightFn);
  const tp = new TrackPhysics(spline, def);
  const ai = new AIDriver(spline, def.halfWidth, AI_PRESETS[difficulty], 0.5);
  const dyn = new VehicleDynamics();

  const start = spline.posAt(0);
  const tan = spline.tangentAt(0);
  dyn.teleport(start.x, start.z, Math.atan2(tan.x, tan.z));

  const director = new RaceDirector(spline, 1);
  director.addRacer('ai', false, 0);
  director.start();

  let s = 0;
  let offTrackTime = 0;
  let raceTime = 0;
  const finished = () => director.racers.get('ai')!.finished;

  let steps = 0;
  const maxSteps = maxSeconds * 120;
  while (!finished() && steps < maxSteps) {
    const info = tp.sample(dyn.state.x, dyn.state.z, dyn.state.heading, s);
    s = info.s;
    if (!info.onTrack) offTrackTime += DT;
    const inputs = ai.update(DT, dyn.state, info.s, info.t, [], 0, raceTime);
    dyn.step(inputs, info.surface, DT);
    tp.resolveBounds(dyn, tp.sample(dyn.state.x, dyn.state.z, dyn.state.heading, s));
    director.updateRacer('ai', info.s, DT);
    director.tick(DT * 1000);
    raceTime += DT;
    steps++;
  }
  return { finished: finished(), lapMs: director.racers.get('ai')!.lapTimes[0] ?? Infinity, offTrackTime, trackLen: spline.length };
}

describe('AIDriver — full lap integration sim', () => {
  it('racer AI completes a clean lap of DUNE RUSH', () => {
    const r = simulateAILap('desert', 'racer');
    expect(r.finished).toBe(true);
    expect(r.lapMs).toBeGreaterThan(20_000);
    expect(r.lapMs).toBeLessThan(150_000);
    expect(r.offTrackTime).toBeLessThan(6);
  }, 30_000);

  it('racer AI completes the tight NEON DISTRICT without getting stuck', () => {
    const r = simulateAILap('city', 'racer');
    expect(r.finished).toBe(true);
    expect(r.offTrackTime).toBeLessThan(8);
  }, 30_000);

  it('pro AI is faster than rookie AI on the same track', () => {
    const pro = simulateAILap('highway', 'pro');
    const rookie = simulateAILap('highway', 'rookie');
    expect(pro.finished).toBe(true);
    expect(rookie.finished).toBe(true);
    expect(pro.lapMs).toBeLessThan(rookie.lapMs * 0.92);
  }, 60_000);

  it('mountain hairpins: AI survives SAKURA PASS', () => {
    const r = simulateAILap('mountain', 'racer');
    expect(r.finished).toBe(true);
  }, 30_000);
});

describe('RaceDirector', () => {
  function makeDirector(laps = 2) {
    const def = trackById('city');
    const spline = new TrackSpline(def.controlPoints, def.heightFn);
    const d = new RaceDirector(spline, laps);
    return { d, L: spline.length };
  }

  it('counts a lap only after all checkpoints in order', () => {
    const { d, L } = makeDirector(2);
    d.addRacer('p', true, 0);
    d.start();
    let laps = 0;
    // sweep forward through the whole lap
    for (let s = 0; s <= L * 1.05; s += 5) {
      d.updateRacer('p', s % L, 0.05);
      d.tick(50);
    }
    const r = d.racers.get('p')!;
    laps = r.lap;
    expect(laps).toBe(2);
    expect(r.lapTimes.length).toBe(1);
  });

  it('rejects a lap when checkpoints are skipped (shortcut)', () => {
    const { d, L } = makeDirector(2);
    d.addRacer('cheat', true, 0);
    d.start();
    // jump from 10% straight to 95%, then cross the line
    d.updateRacer('cheat', L * 0.1, 0.1);
    d.updateRacer('cheat', L * 0.95, 0.1);
    d.updateRacer('cheat', L * 0.02, 0.1);
    expect(d.racers.get('cheat')!.lap).toBe(1); // no lap granted
  });

  it('standings order by progress and flag the finisher', () => {
    const { d, L } = makeDirector(1);
    d.addRacer('fast', false, 0);
    d.addRacer('slow', true, 0);
    d.start();
    for (let s = 0; s <= L * 1.02; s += 4) {
      d.updateRacer('fast', s % L, 0.04);
      d.updateRacer('slow', (s * 0.5) % L, 0.04);
      d.tick(40);
    }
    const standings = d.standings;
    expect(standings[0].id).toBe('fast');
    expect(standings[0].finished).toBe(true);
    expect(standings[1].id).toBe('slow');
    expect(d.playerProgress()!.position).toBe(2);
  });

  it('flags wrong-way driving and clears it', () => {
    const { d, L } = makeDirector(1);
    d.addRacer('p', true, 0);
    d.start();
    let wrongFlag = false;
    const events: boolean[] = [];
    (d as any).events = { onWrongWay: (_r: any, w: boolean) => events.push((wrongFlag = w)) };
    let s = L * 0.5;
    for (let i = 0; i < 60; i++) {
      s -= 1.2;
      d.updateRacer('p', s, 0.05);
    }
    expect(wrongFlag).toBe(true);
    for (let i = 0; i < 80; i++) {
      s += 1.5;
      d.updateRacer('p', s, 0.05);
    }
    expect(wrongFlag).toBe(false);
  });
});

describe('Adaptive profile', () => {
  it('smooth clean winners gain skill; messy drivers lose it', () => {
    const clean = new RaceObserver();
    const messy = new RaceObserver();
    for (let i = 0; i < 1000; i++) {
      clean.sample(Math.sin(i / 60) * 0.4, 0.8, true, false, DT);
      messy.sample(Math.sin(i * 1.7) * (i % 2 ? 1 : -1), 1, i % 13 === 0, i % 211 === 0, DT);
    }
    const cleanRes = clean.finalize({ position: 1, fieldSize: 6, laps: 3, lapTimesMs: [61000, 60500, 60800] });
    const messyRes = messy.finalize({ position: 6, fieldSize: 6, laps: 3, lapTimesMs: [80000, 95000, 70000] });
    expect(cleanRes.skill).toBeGreaterThan(60);
    expect(messyRes.skill).toBeLessThan(35);
    expect(cleanRes.smoothness).toBeGreaterThan(messyRes.smoothness);
  });

  it('profile EMA, difficulty + assist suggestions respond to skill', () => {
    let profile = structuredClone(DEFAULT_SETTINGS.adaptive);
    profile = updateProfile(profile, { skill: 85, smoothness: 80, aggression: 70, consistency: 75 });
    expect(profile.races).toBe(1);
    expect(profile.skill).toBeGreaterThan(70);
    expect(suggestDifficulty(profile)).toBe('pro');
    const assists = suggestAssists(profile);
    expect(assists.stabilityAssist).toBe(false);
    expect(assists.steerSmoothing).toBeLessThan(0.45);

    let weak = structuredClone(DEFAULT_SETTINGS.adaptive);
    weak = updateProfile(weak, { skill: 12, smoothness: 20, aggression: 90, consistency: 30 });
    expect(suggestDifficulty(weak)).toBe('rookie');
    expect(suggestAssists(weak).stabilityAssist).toBe(true);
  });
});
