import { describe, expect, it } from 'vitest';
import { TrackSpline } from '../src/track/Spline';
import { TRACKS, trackById } from '../src/track/TrackData';
import { TrackPhysics, resolveCarContacts } from '../src/physics/TrackPhysics';
import { VehicleDynamics, FLAT_SURFACE } from '../src/physics/VehicleDynamics';
import { neutralInputs } from '../src/input/ControlState';

const SQUARE: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [100, 0], [100, 100], [0, 100],
];

describe('TrackSpline', () => {
  it('builds a closed loop with monotonic arc length', () => {
    const sp = new TrackSpline(SQUARE);
    expect(sp.length).toBeGreaterThan(300); // rounded square perimeter
    expect(sp.length).toBeLessThan(480);
    for (let i = 1; i < sp.samples.length; i++) {
      expect(sp.samples[i].s).toBeGreaterThan(sp.samples[i - 1].s);
    }
  });

  it('posAt wraps around the loop', () => {
    const sp = new TrackSpline(SQUARE);
    const a = sp.posAt(0);
    const b = sp.posAt(sp.length);
    expect(a.x).toBeCloseTo(b.x, 4);
    expect(a.z).toBeCloseTo(b.z, 4);
  });

  it('tangents are unit length', () => {
    const sp = new TrackSpline(SQUARE);
    for (const s of [0, 50, 123, 200]) {
      const t = sp.tangentAt(s);
      expect(Math.hypot(t.x, t.z)).toBeCloseTo(1, 3);
    }
  });

  it('projection recovers (s, t) for points offset from the centreline', () => {
    const sp = new TrackSpline(SQUARE);
    for (const s of [10, 80, 160, 250]) {
      const c = sp.posAt(s);
      const tan = sp.tangentAt(s);
      // place a point 3 m to the RIGHT of the centreline
      const px = c.x + tan.z * 3;
      const pz = c.z - tan.x * 3;
      const proj = sp.project(px, pz, s);
      expect(Math.abs(proj.t - 3)).toBeLessThan(0.6);
      let ds = Math.abs(proj.s - s);
      ds = Math.min(ds, sp.length - ds);
      expect(ds).toBeLessThan(3);
    }
  });

  it('windowed projection with hint matches full scan', () => {
    const sp = new TrackSpline(SQUARE);
    const c = sp.posAt(120);
    const hinted = sp.project(c.x + 1, c.z + 1, 118);
    const full = sp.project(c.x + 1, c.z + 1);
    expect(Math.abs(hinted.s - full.s)).toBeLessThan(2.5);
  });

  it('a circular track has uniform positive-or-negative curvature', () => {
    const circle: [number, number][] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      circle.push([Math.cos(a) * 50, Math.sin(a) * 50]);
    }
    const sp = new TrackSpline(circle);
    const ks = [0.2, 0.4, 0.6, 0.8].map((f) => sp.curvatureAt(sp.length * f));
    const sign = Math.sign(ks[0]);
    for (const k of ks) {
      expect(Math.sign(k)).toBe(sign);
      expect(Math.abs(k)).toBeGreaterThan(1 / 80);
      expect(Math.abs(k)).toBeLessThan(1 / 30);
    }
  });

  it('all four shipped tracks build with sane lengths', () => {
    for (const def of TRACKS) {
      const sp = new TrackSpline(def.controlPoints, def.heightFn);
      expect(sp.length, def.id).toBeGreaterThan(500);
      expect(sp.length, def.id).toBeLessThan(3000);
      // height profile is bounded
      for (let f = 0; f < 1; f += 0.05) {
        expect(Math.abs(sp.heightAt(sp.length * f)), def.id).toBeLessThan(30);
      }
    }
  });
});

describe('TrackPhysics — surfaces & walls', () => {
  it('on-track sample returns clean asphalt; off-track returns the def surface', () => {
    const def = trackById('desert');
    const sp = new TrackSpline(def.controlPoints, def.heightFn);
    const tp = new TrackPhysics(sp, def);
    const c = sp.posAt(100);
    const tan = sp.tangentAt(100);
    const heading = Math.atan2(tan.x, tan.z);

    const on = tp.sample(c.x, c.z, heading, 100);
    expect(on.onTrack).toBe(true);
    expect(on.surface.grip).toBe(1);

    const offX = c.x + tan.z * (def.halfWidth + 4);
    const offZ = c.z - tan.x * (def.halfWidth + 4);
    const off = tp.sample(offX, offZ, heading, 100);
    expect(off.onTrack).toBe(false);
    expect(off.surface.grip).toBe(def.offTrack.grip);
    expect(off.surface.drag).toBe(def.offTrack.drag);
  });

  it('walls clamp the car and kill outward velocity', () => {
    const def = trackById('city');
    const sp = new TrackSpline(def.controlPoints, def.heightFn);
    const tp = new TrackPhysics(sp, def);

    const dyn = new VehicleDynamics();
    const c = sp.posAt(50);
    const tan = sp.tangentAt(50);
    // heading: diagonal into the right wall
    const trackHeading = Math.atan2(tan.x, tan.z);
    dyn.teleport(c.x, c.z, trackHeading + 0.5);
    dyn.state.vx = 20;

    let hit = null;
    for (let i = 0; i < 240 && !hit; i++) {
      dyn.step({ ...neutralInputs(), throttle: 0.5 }, FLAT_SURFACE, 1 / 120);
      const info = tp.sample(dyn.state.x, dyn.state.z, dyn.state.heading, 50);
      hit = tp.resolveBounds(dyn, info);
    }
    expect(hit).not.toBeNull();
    expect(hit!.impulse).toBeGreaterThan(0.5);
    const after = tp.sample(dyn.state.x, dyn.state.z, dyn.state.heading, 50);
    expect(Math.abs(after.t)).toBeLessThanOrEqual(def.halfWidth);
  });

  it('car-vs-car contact separates and exchanges momentum', () => {
    const a = new VehicleDynamics();
    const b = new VehicleDynamics();
    a.teleport(0, 0, 0);
    b.teleport(0, 2.0, 0); // directly ahead, overlapping radius
    a.state.vx = 15; // a drives into b
    b.state.vx = 2;

    const hits = resolveCarContacts([a, b]);
    expect(hits.length).toBe(1);
    expect(b.state.vx).toBeGreaterThan(2);   // shunted forward
    expect(a.state.vx).toBeLessThan(15);     // slowed
    const dist = Math.hypot(b.state.x - a.state.x, b.state.z - a.state.z);
    expect(dist).toBeGreaterThanOrEqual(2.9 - 0.01);
  });
});
