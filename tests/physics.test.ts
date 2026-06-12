import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEC, FLAT_SURFACE, VehicleDynamics } from '../src/physics/VehicleDynamics';
import { neutralInputs } from '../src/input/ControlState';
import { seededRandom } from '../src/core/MathUtils';

const DT = 1 / 120;

function drive(dyn: VehicleDynamics, inputs: Partial<ReturnType<typeof neutralInputs>>, seconds: number) {
  const full = { ...neutralInputs(), ...inputs };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) dyn.step(full, FLAT_SURFACE, DT);
}

describe('VehicleDynamics — longitudinal', () => {
  it('accelerates hard from standstill and reaches highway speed', () => {
    const dyn = new VehicleDynamics();
    drive(dyn, { throttle: 1 }, 5);
    expect(dyn.state.vx).toBeGreaterThan(30); // >108 km/h in 5 s (arcade-fast)
    expect(dyn.state.vx).toBeLessThan(DEFAULT_SPEC.maxSpeed);
  });

  it('top speed saturates near spec.maxSpeed', () => {
    const dyn = new VehicleDynamics();
    drive(dyn, { throttle: 1 }, 40);
    expect(dyn.state.vx).toBeGreaterThan(DEFAULT_SPEC.maxSpeed * 0.85);
    expect(dyn.state.vx).toBeLessThanOrEqual(DEFAULT_SPEC.maxSpeed * 1.02);
  });

  it('nitro raises both acceleration and top speed', () => {
    const a = new VehicleDynamics();
    const b = new VehicleDynamics();
    drive(a, { throttle: 1 }, 10);
    drive(b, { throttle: 1, nitro: true }, 10);
    expect(b.state.vx).toBeGreaterThan(a.state.vx + 3);
    expect(b.state.nitroTank).toBeLessThan(1);
  });

  it('brakes to a stop and stays parked (no creep oscillation)', () => {
    const dyn = new VehicleDynamics();
    drive(dyn, { throttle: 1 }, 4);
    drive(dyn, { brake: 1 }, 4);
    expect(Math.abs(dyn.state.vx)).toBeLessThan(0.05);
    drive(dyn, {}, 2);
    expect(Math.abs(dyn.state.vx)).toBeLessThan(0.05);
  });

  it('braking outperforms coasting', () => {
    const coast = new VehicleDynamics();
    const brake = new VehicleDynamics();
    drive(coast, { throttle: 1 }, 4);
    drive(brake, { throttle: 1 }, 4);
    drive(coast, {}, 1.5);
    drive(brake, { brake: 1 }, 1.5);
    expect(brake.state.vx).toBeLessThan(coast.state.vx * 0.45);
  });

  it('reverse gear engages when slow and is speed-capped', () => {
    const dyn = new VehicleDynamics();
    drive(dyn, { reverse: true, throttle: 1 }, 6);
    expect(dyn.state.gear).toBe('R');
    expect(dyn.state.vx).toBeLessThan(0);
    expect(Math.abs(dyn.state.vx)).toBeLessThanOrEqual(DEFAULT_SPEC.maxReverseSpeed + 0.5);
    // throttle forward → back to D
    drive(dyn, { throttle: 1 }, 3);
    expect(dyn.state.gear).toBe('D');
    expect(dyn.state.vx).toBeGreaterThan(5);
  });

  it('uphill slope slows the car', () => {
    const flat = new VehicleDynamics();
    const hill = new VehicleDynamics();
    const inputs = { ...neutralInputs(), throttle: 1 };
    for (let i = 0; i < 120 * 6; i++) {
      flat.step(inputs, FLAT_SURFACE, DT);
      hill.step(inputs, { grip: 1, drag: 1, gradeSin: 0.08 }, DT);
    }
    expect(hill.state.vx).toBeLessThan(flat.state.vx - 1);
  });
});

describe('VehicleDynamics — lateral / drift', () => {
  it('steering right turns right (positive yaw, heading increases)', () => {
    const dyn = new VehicleDynamics();
    drive(dyn, { throttle: 0.8 }, 3);
    drive(dyn, { throttle: 0.5, steer: 0.6 }, 1.5);
    expect(dyn.state.heading).toBeGreaterThan(0.15);
    expect(dyn.state.x).toBeGreaterThan(2); // moved toward +x (right of +z start)
  });

  it('holds a stable circle at moderate speed (no spin-out with assists)', () => {
    const dyn = new VehicleDynamics();
    drive(dyn, { throttle: 0.6 }, 3);
    drive(dyn, { throttle: 0.45, steer: 0.5 }, 8);
    expect(Math.abs(dyn.state.slipRear)).toBeLessThan(0.25);
    expect(dyn.state.vx).toBeGreaterThan(8);
    expect(Number.isFinite(dyn.state.heading)).toBe(true);
  });

  it('handbrake at speed with steering provokes a drift', () => {
    const dyn = new VehicleDynamics(undefined, { stability: false, counterSteer: false });
    drive(dyn, { throttle: 1 }, 4);
    // assert mid-slide (sustained no-assist handbrake eventually spins — by design)
    drive(dyn, { steer: 0.85, handbrake: true, throttle: 0.4 }, 0.55);
    expect(dyn.state.drifting).toBe(true);
    expect(Math.abs(dyn.state.slipRear)).toBeGreaterThan(0.16);
    expect(dyn.state.driftScore).toBeGreaterThan(0);
    expect(dyn.state.skidIntensity).toBeGreaterThan(0.4);
  });

  it('drift recovers after releasing the handbrake (with assists)', () => {
    const dyn = new VehicleDynamics();
    drive(dyn, { throttle: 1 }, 4);
    drive(dyn, { steer: 0.9, handbrake: true, throttle: 0.5 }, 1);
    drive(dyn, { throttle: 0.6 }, 3);
    expect(dyn.state.drifting).toBe(false);
    expect(Math.abs(dyn.state.slipRear)).toBeLessThan(0.12);
  });

  it('low-grip surface (sand) reduces cornering ability', () => {
    const tarmac = new VehicleDynamics();
    const sand = new VehicleDynamics();
    const launch = { ...neutralInputs(), throttle: 1 };
    const corner = { ...neutralInputs(), throttle: 0.4, steer: 0.7 };
    for (let i = 0; i < 120 * 3; i++) {
      tarmac.step(launch, FLAT_SURFACE, DT);
      sand.step(launch, FLAT_SURFACE, DT);
    }
    for (let i = 0; i < 120 * 2; i++) {
      tarmac.step(corner, FLAT_SURFACE, DT);
      sand.step(corner, { grip: 0.55, drag: 7, gradeSin: 0 }, DT);
    }
    expect(Math.abs(sand.state.heading)).toBeLessThan(Math.abs(tarmac.state.heading));
  });

  it('survives 60 s of random violent inputs without NaN/explosion', () => {
    const rng = seededRandom(1234);
    const dyn = new VehicleDynamics();
    for (let i = 0; i < 120 * 60; i++) {
      dyn.step(
        {
          steer: rng() * 2 - 1,
          throttle: rng(),
          brake: rng() > 0.7 ? rng() : 0,
          handbrake: rng() > 0.9,
          nitro: rng() > 0.8,
          reverse: rng() > 0.95,
        },
        FLAT_SURFACE,
        DT,
      );
    }
    const s = dyn.state;
    for (const v of [s.x, s.z, s.heading, s.vx, s.vy, s.yawRate]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(Math.abs(s.vx)).toBeLessThan(80);
    expect(Math.abs(s.vy)).toBeLessThan(40);
  });

  it('virtual gearbox climbs gears with speed and reports rpm', () => {
    const dyn = new VehicleDynamics();
    drive(dyn, { throttle: 1 }, 1);
    const lowGear = dyn.state.gearIndex;
    drive(dyn, { throttle: 1 }, 12);
    expect(dyn.state.gearIndex).toBeGreaterThan(lowGear);
    expect(dyn.state.gearIndex).toBeLessThanOrEqual(6);
    expect(dyn.state.rpm).toBeGreaterThan(0.2);
    expect(dyn.state.rpm).toBeLessThanOrEqual(1);
  });
});
