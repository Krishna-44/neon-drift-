/**
 * Arcade-sim vehicle dynamics: planar rigid body with a slip-angle tire model.
 *
 * Real physics under the hood — bicycle model with per-axle slip angles,
 * saturating lateral tire forces (tanh ≈ simplified Pacejka), longitudinal
 * weight transfer that modulates grip, traction-limited drive force, handbrake
 * rear-grip reduction (drifting), aero drag, rolling resistance and slope
 * gravity — but tuned for confident arcade handling.
 *
 * Conventions (right-handed, y-up world; physics on the x/z plane):
 *   heading θ:  forward = (sin θ, cos θ),  right = (cos θ, −sin θ)
 *   body frame: vx = forward speed (m/s), vy = rightward slide speed
 *   yaw rate r: positive = turning right;  steer input + = right
 *
 * Pure TypeScript, deterministic, no engine dependencies — unit tested and
 * reusable headless (server-side sim / multiplayer reconciliation).
 */
import { clamp, clamp01, lerp } from '../core/MathUtils';
import type { CarInputs } from '../input/ControlState';

export interface CarSpec {
  mass: number;          // kg
  inertiaYaw: number;    // kg·m²
  cgToFront: number;     // m (a)
  cgToRear: number;      // m (b)
  cgHeight: number;      // m
  engineForce: number;   // N at low speed
  brakeForce: number;    // N
  maxSpeed: number;      // m/s (soft top speed, drag-limited feel)
  maxReverseSpeed: number;
  tireGrip: number;      // μ lateral/longitudinal base
  corneringStiffness: number; // tanh steepness per rad
  maxSteerLock: number;  // rad at standstill
  highSpeedSteerLock: number; // rad at ≥40 m/s
  steerRate: number;     // rad/s actuator speed
  /** Additive boost thrust (N) — applied AFTER the traction clamp so nitro
   *  punches even when the tires are already saturated (arcade rocket). */
  nitroThrust: number;
  nitroSpeedMul: number;
  dragCoeff: number;     // N per (m/s)²
  rollingResist: number; // N per (m/s)
}

export const DEFAULT_SPEC: CarSpec = {
  mass: 1250,
  inertiaYaw: 1950,
  cgToFront: 1.25,
  cgToRear: 1.45,
  cgHeight: 0.5,
  engineForce: 10200,
  brakeForce: 15500,
  maxSpeed: 58,          // ≈ 209 km/h
  maxReverseSpeed: 11,
  tireGrip: 1.12,
  corneringStiffness: 7.5,
  maxSteerLock: 0.55,
  highSpeedSteerLock: 0.18,
  steerRate: 3.8,
  nitroThrust: 5200,
  nitroSpeedMul: 1.22,
  dragCoeff: 0.82,
  rollingResist: 15,
};

/** Per-step environment info supplied by the track (1,1,0 = clean asphalt). */
export interface SurfaceSample {
  grip: number;     // multiplier on tire μ
  drag: number;     // multiplier on rolling resistance (sand, grass…)
  gradeSin: number; // sin(slope) along car forward; + = uphill
}

export const FLAT_SURFACE: SurfaceSample = { grip: 1, drag: 1, gradeSin: 0 };

export interface AssistConfig {
  stability: boolean;
  counterSteer: boolean;
}

export interface VehicleState {
  x: number;
  z: number;
  heading: number;
  vx: number;
  vy: number;
  yawRate: number;
  steerAngle: number;   // actuated steering at the tires (rad)
  gear: 'D' | 'R';
  gearIndex: number;    // virtual gearbox 1..6 for HUD/audio
  rpm: number;          // 0..1 normalised
  nitroTank: number;    // 0..1
  nitroActive: boolean;
  drifting: boolean;
  wheelspin: boolean;
  slipFront: number;    // rad
  slipRear: number;     // rad
  skidIntensity: number; // 0..1 (audio/particles)
  speedKmh: number;
  /** Longitudinal accel (smoothed, for weight transfer + camera). */
  accelSmoothed: number;
  driftScore: number;
  airborne: boolean;    // reserved for jumps; always false on current tracks
}

const GRAVITY = 9.81;
const LOW_SPEED_BLEND = 3.0;     // m/s — below this, blend to kinematic steering
const DRIFT_ENTER = 0.16;        // rad rear slip
const DRIFT_EXIT = 0.1;
const NITRO_DRAIN = 0.27;        // /s
const NITRO_REGEN = 0.045;
const NITRO_REGEN_DRIFT = 0.13;
const GEAR_SPEEDS = [0, 9, 17, 26, 36, 47, 60]; // m/s upshift points (virtual)

export class VehicleDynamics {
  state: VehicleState;
  /** Set true for one step by collisions — adds a yaw disturbance + skid audio. */
  lastCollisionImpulse = 0;

  constructor(
    public spec: CarSpec = DEFAULT_SPEC,
    public assists: AssistConfig = { stability: true, counterSteer: true },
  ) {
    this.state = {
      x: 0, z: 0, heading: 0,
      vx: 0, vy: 0, yawRate: 0,
      steerAngle: 0,
      gear: 'D', gearIndex: 1, rpm: 0.2,
      nitroTank: 1, nitroActive: false,
      drifting: false, wheelspin: false,
      slipFront: 0, slipRear: 0, skidIntensity: 0,
      speedKmh: 0, accelSmoothed: 0, driftScore: 0,
      airborne: false,
    };
  }

  teleport(x: number, z: number, heading: number): void {
    const s = this.state;
    s.x = x; s.z = z; s.heading = heading;
    s.vx = 0; s.vy = 0; s.yawRate = 0; s.steerAngle = 0;
    s.gear = 'D'; s.drifting = false; s.accelSmoothed = 0;
  }

  step(inputs: CarInputs, surface: SurfaceSample, dt: number): void {
    const s = this.state;
    const p = this.spec;

    // ---------------------------------------------------------- gear logic
    let throttle = inputs.throttle;
    let brake = inputs.brake;
    if (inputs.reverse && s.gear === 'D') {
      if (s.vx < 2.5) {
        s.gear = 'R';
      } else {
        // Reverse request at speed = brake until slow enough to engage R.
        brake = Math.max(brake, Math.max(throttle, 0.6));
        throttle = 0;
      }
    } else if (!inputs.reverse && s.gear === 'R' && throttle > 0) {
      if (s.vx > -2.5) {
        s.gear = 'D';
      } else {
        // Forward request while reversing fast = brake first, then shift.
        brake = Math.max(brake, Math.max(throttle, 0.6));
        throttle = 0;
      }
    }

    // ---------------------------------------------------------- steering actuator
    const speedAbs = Math.abs(s.vx);
    const lock = lerp(p.maxSteerLock, p.highSpeedSteerLock, clamp01(speedAbs / 40));
    let steerTarget = clamp(inputs.steer, -1, 1) * lock;
    // Counter-steer assist: bleed in opposite lock proportional to rear slip.
    if (this.assists.counterSteer && s.drifting && speedAbs > 6) {
      steerTarget += clamp(-s.slipRear * 0.55, -0.22, 0.22);
      steerTarget = clamp(steerTarget, -p.maxSteerLock, p.maxSteerLock);
    }
    const dSteer = clamp(steerTarget - s.steerAngle, -p.steerRate * dt, p.steerRate * dt);
    s.steerAngle += dSteer;

    // ---------------------------------------------------------- nitro
    if (inputs.nitro && s.nitroTank > (s.nitroActive ? 0.02 : 0.15) && s.gear === 'D') {
      s.nitroActive = true;
      s.nitroTank = Math.max(0, s.nitroTank - NITRO_DRAIN * dt);
    } else {
      s.nitroActive = false;
      const regen = s.drifting ? NITRO_REGEN_DRIFT : NITRO_REGEN;
      s.nitroTank = Math.min(1, s.nitroTank + regen * dt);
    }

    // ---------------------------------------------------------- loads (weight transfer)
    const L = p.cgToFront + p.cgToRear;
    const transfer = clamp((s.accelSmoothed * p.cgHeight * p.mass) / L, -p.mass * GRAVITY * 0.3, p.mass * GRAVITY * 0.3);
    const fzFront = Math.max((p.mass * GRAVITY * p.cgToRear) / L - transfer, p.mass * GRAVITY * 0.12);
    const fzRear = Math.max((p.mass * GRAVITY * p.cgToFront) / L + transfer, p.mass * GRAVITY * 0.12);

    const gripF = p.tireGrip * surface.grip;
    const gripR = p.tireGrip * surface.grip * (inputs.handbrake ? 0.42 : 1);

    // ---------------------------------------------------------- slip angles & lateral forces
    const vxSafe = Math.max(Math.abs(s.vx), 0.6) * Math.sign(s.vx || 1);
    const slipF = Math.atan2(s.vy + p.cgToFront * s.yawRate, Math.abs(vxSafe)) - s.steerAngle * Math.sign(s.vx >= 0 ? 1 : -1);
    const slipR = Math.atan2(s.vy - p.cgToRear * s.yawRate, Math.abs(vxSafe));
    s.slipFront = slipF;
    s.slipRear = slipR;

    let fyFront = -gripF * fzFront * Math.tanh(p.corneringStiffness * slipF);
    let fyRear = -gripR * fzRear * Math.tanh(p.corneringStiffness * slipR);

    // Low-speed fade: lateral slip forces are meaningless when crawling.
    const latFade = clamp01(speedAbs / LOW_SPEED_BLEND);
    fyFront *= latFade;
    fyRear *= latFade;

    // ---------------------------------------------------------- longitudinal forces
    const dir = s.gear === 'R' ? -1 : 1;
    // Engine taper reaches zero ABOVE spec.maxSpeed so the drag equilibrium
    // lands ≈ maxSpeed (taper at maxSpeed exactly would cap well below it).
    const vmax = 1.15 * (s.nitroActive ? p.nitroSpeedMul : 1) * (s.gear === 'R' ? p.maxReverseSpeed : p.maxSpeed);
    const speedRatio = clamp01(Math.abs(s.vx) / vmax);
    let driveForce = throttle * p.engineForce * (1 - speedRatio ** 3) * dir * (s.gear === 'R' ? 0.5 : 1);

    // Traction limit on the (driven) rear axle; nitro thrust bypasses it.
    const tractionCap = gripR * fzRear * 1.15;
    s.wheelspin = Math.abs(driveForce) > tractionCap;
    driveForce = clamp(driveForce, -tractionCap, tractionCap);
    if (s.nitroActive) driveForce += p.nitroThrust * dir;

    const brakeForce = -Math.sign(s.vx) * brake * p.brakeForce * clamp01(Math.abs(s.vx) / 0.5);
    const handbrakeDrag = inputs.handbrake ? -Math.sign(s.vx) * 0.35 * p.brakeForce * clamp01(Math.abs(s.vx) / 2) : 0;
    const drag = -p.dragCoeff * s.vx * Math.abs(s.vx);
    const rolling = -p.rollingResist * s.vx * surface.drag;
    const slope = -p.mass * GRAVITY * surface.gradeSin;

    const fx = driveForce + brakeForce + handbrakeDrag + drag + rolling + slope;

    // ---------------------------------------------------------- integrate body frame
    const ax = fx / p.mass + s.yawRate * s.vy;
    const ay = (fyFront + fyRear) / p.mass - s.yawRate * s.vx;
    s.vx += ax * dt;
    s.vy += ay * dt;

    // Yaw dynamics, blended with kinematic steering at low speed.
    let yawAccel = (p.cgToFront * fyFront - p.cgToRear * fyRear) / p.inertiaYaw;
    // Natural yaw damping (tire scrub) — much stronger with stability assist.
    yawAccel -= s.yawRate * (this.assists.stability ? 1.6 : 0.45);
    s.yawRate += yawAccel * dt;
    const rKin = (s.vx * Math.tan(s.steerAngle)) / L;
    const kinBlend = 1 - latFade; // 1 at standstill → pure kinematic
    s.yawRate = lerp(s.yawRate, rKin, kinBlend * clamp01(dt * 12));
    s.vy = lerp(s.vy, 0, kinBlend * clamp01(dt * 10));

    // Hard-stop creep: parked car stays parked.
    if (Math.abs(s.vx) < 0.12 && throttle === 0 && (brake > 0 || Math.abs(s.vx) < 0.04)) {
      s.vx = 0;
      s.vy *= 0.8;
    }
    // Reverse gear speed cap.
    if (s.gear === 'R') s.vx = clamp(s.vx, -p.maxReverseSpeed, p.maxSpeed);

    s.heading += s.yawRate * dt;
    const sinH = Math.sin(s.heading);
    const cosH = Math.cos(s.heading);
    // world velocity = vx·forward + vy·right
    s.x += (s.vx * sinH + s.vy * cosH) * dt;
    s.z += (s.vx * cosH - s.vy * sinH) * dt;

    // ---------------------------------------------------------- derived state
    s.accelSmoothed = lerp(s.accelSmoothed, ax, clamp01(dt * 6));
    s.speedKmh = Math.abs(s.vx) * 3.6;

    // drift detection with hysteresis
    const slipAbs = Math.abs(slipR);
    if (!s.drifting && slipAbs > DRIFT_ENTER && speedAbs > 8) s.drifting = true;
    else if (s.drifting && (slipAbs < DRIFT_EXIT || speedAbs < 5)) s.drifting = false;
    if (s.drifting) s.driftScore += slipAbs * speedAbs * dt * 2;

    s.skidIntensity = clamp01(
      Math.max(
        s.drifting ? 0.45 + slipAbs * 1.6 : 0,
        s.wheelspin ? 0.5 : 0,
        brake > 0.7 && speedAbs > 12 ? 0.55 : 0,
        Math.abs(slipF) > 0.18 && speedAbs > 10 ? 0.4 : 0,
      ),
    );

    // virtual gearbox + rpm (audio/HUD)
    if (s.gear === 'R') {
      s.gearIndex = 0;
      s.rpm = clamp01(Math.abs(s.vx) / p.maxReverseSpeed) * 0.7 + 0.2;
    } else {
      let gi = 1;
      for (let g = 1; g < GEAR_SPEEDS.length; g++) {
        if (Math.abs(s.vx) >= GEAR_SPEEDS[g]) gi = Math.min(g + 1, 6);
      }
      s.gearIndex = gi;
      const lo = GEAR_SPEEDS[gi - 1];
      const hi = GEAR_SPEEDS[Math.min(gi, GEAR_SPEEDS.length - 1)] + 2;
      const band = clamp01((Math.abs(s.vx) - lo) / Math.max(hi - lo, 1));
      s.rpm = clamp01(0.25 + band * 0.75 + (throttle > 0.1 ? 0.05 : 0) + (s.wheelspin ? 0.2 : 0));
    }

    this.lastCollisionImpulse = 0; // consumed each step; collisions re-set it
  }
}
