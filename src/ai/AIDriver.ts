/**
 * AI opponent driver.
 *
 * Lateral control is a Stanley controller (crosstrack + heading error +
 * curvature feedforward, yaw-rate-error damping) over a precomputed racing
 * line — the standard, stable path tracker. Longitudinal control plans corner
 * speeds from curvature with a braking horizon. A small state machine reverses
 * out when wedged against a wall. Rubber-band balancing scales target speed,
 * never physics — AI cars run the exact same VehicleDynamics as the player.
 */
import { clamp, clamp01, lerp, wrapAngle } from '../core/MathUtils';
import { TrackSpline } from '../track/Spline';
import { neutralInputs, type CarInputs } from '../input/ControlState';
import { DEFAULT_SPEC, type VehicleState } from '../physics/VehicleDynamics';

export type AIDifficulty = 'rookie' | 'racer' | 'pro';

export interface AIConfig {
  /** Peak cornering accel budget m/s² the planner assumes. */
  latAccelMax: number;
  /** Top-speed multiplier vs car spec. */
  speedMul: number;
  /** Rubber-band strength 0..1. */
  rubberBand: number;
  /** Lateral aggression for overtakes. */
  aggression: number;
  /** Reaction delay at race start (s). */
  reactionDelay: number;
}

export const AI_PRESETS: Record<AIDifficulty, AIConfig> = {
  rookie: { latAccelMax: 5.8, speedMul: 0.74, rubberBand: 0.85, aggression: 0.4, reactionDelay: 0.55 },
  racer: { latAccelMax: 7.0, speedMul: 0.88, rubberBand: 0.55, aggression: 0.7, reactionDelay: 0.35 },
  pro: { latAccelMax: 8.2, speedMul: 1.0, rubberBand: 0.2, aggression: 1.0, reactionDelay: 0.2 },
};

export interface AIPeer {
  s: number;
  t: number;
  speed: number;
}

const WHEELBASE = DEFAULT_SPEC.cgToFront + DEFAULT_SPEC.cgToRear;

export class AIDriver {
  private line: Float32Array;
  private nitroUntil = 0;
  private nitroCooldownUntil = 0;
  private avoidT = 0;
  private mode: 'race' | 'reverse' = 'race';
  private modeTimer = 0;
  private stuckTimer = 0;

  constructor(
    private spline: TrackSpline,
    private halfWidth: number,
    public config: AIConfig,
    private personalSeed = 0.5,
  ) {
    this.line = this.computeRacingLine();
    const variation = 0.97 + this.personalSeed * 0.06; // ±3 % personal pace
    this.config = { ...config, speedMul: config.speedMul * variation };
  }

  /** Curvature-proportional offset toward corner insides, heavily smoothed. */
  private computeRacingLine(): Float32Array {
    const n = this.spline.samples.length;
    const raw = new Float32Array(n);
    const maxOffset = Math.max(this.halfWidth - 2.8, 0.5);
    for (let i = 0; i < n; i++) {
      const k = this.spline.samples[i].curvature;
      raw[i] = clamp(k * 90, -1, 1) * maxOffset;
    }
    const out = new Float32Array(n);
    const win = Math.min(20, n >> 2);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let o = -win; o <= win; o++) sum += raw[(i + o + n) % n];
      out[i] = sum / (win * 2 + 1);
    }
    return out;
  }

  private lineOffsetAt(s: number): number {
    const n = this.line.length;
    const idx = Math.floor((this.spline.wrap(s) / this.spline.length) * n) % n;
    return this.line[idx];
  }

  reset(): void {
    this.nitroUntil = 0;
    this.nitroCooldownUntil = 0;
    this.avoidT = 0;
    this.mode = 'race';
    this.modeTimer = 0;
    this.stuckTimer = 0;
  }

  update(
    dt: number,
    state: VehicleState,
    selfS: number,
    selfT: number,
    peers: AIPeer[],
    playerGapS: number,
    raceTime: number,
  ): CarInputs {
    const inputs = neutralInputs();
    if (raceTime < this.config.reactionDelay) return inputs;

    const v = Math.max(state.vx, 0.1);
    const tan = this.spline.tangentAt(selfS);
    const trackHeading = Math.atan2(tan.x, tan.z);
    const headingErr = wrapAngle(state.heading - trackHeading);

    // ----------------------------------------------------- stuck / reverse-out
    if (Math.abs(state.vx) < 1.2 && raceTime > this.config.reactionDelay + 2) {
      this.stuckTimer += dt;
    } else {
      this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
    }
    if (this.mode === 'race' && this.stuckTimer > 1.2) {
      this.mode = 'reverse';
      this.modeTimer = 0;
    }
    if (this.mode === 'reverse') {
      this.modeTimer += dt;
      inputs.reverse = true;
      inputs.throttle = 0.8;
      // Reversing with δ>0 swings the nose left → reduces positive heading error.
      inputs.steer = clamp(headingErr * 1.4, -1, 1);
      if (this.modeTimer > 2.2 || (Math.abs(headingErr) < 0.45 && Math.abs(selfT) < this.halfWidth)) {
        this.mode = 'race';
        this.stuckTimer = 0;
      }
      return inputs;
    }

    // Rolling backwards out of control → brake to a stop first.
    if (state.vx < -2) {
      inputs.brake = 1;
      return inputs;
    }

    // Facing badly wrong (spun) but still rolling: simple point-at-track recovery.
    if (Math.abs(headingErr) > 1.2) {
      inputs.steer = clamp(-headingErr * 1.5, -1, 1);
      inputs.throttle = 0.5;
      return inputs;
    }

    // ----------------------------------------------------------- avoidance
    let desiredShift = 0;
    let throttleScale = 1;
    for (const p of peers) {
      let gap = this.spline.wrap(p.s - selfS);
      if (gap > this.spline.length / 2) gap -= this.spline.length;
      if (gap > 0.5 && gap < 16 && p.speed < v + 3) {
        const lateral = p.t - selfT;
        if (Math.abs(lateral) < 2.6) {
          const side = p.t > 0 ? -1 : 1;
          desiredShift = side * (2.8 + this.config.aggression * 1.2);
          if (gap < 7 && p.speed < v - 1) throttleScale = 0.55;
        }
      }
    }
    this.avoidT = lerp(this.avoidT, desiredShift, clamp01(dt * 2.2));

    // ----------------------------------------------- lateral: Stanley control
    const lookS = selfS + clamp(v * 0.3, 4, 18);
    const kLine = this.spline.curvatureAt(lookS);
    const targetT = clamp(
      this.lineOffsetAt(selfS) + this.avoidT,
      -(this.halfWidth - 1.2),
      this.halfWidth - 1.2,
    );
    // Line direction = track tangent + line drift dT/ds.
    const dTds = (this.lineOffsetAt(selfS + 8) - this.lineOffsetAt(selfS - 8)) / 16;
    const psiLine = Math.atan(dTds);
    const headingToLine = wrapAngle(headingErr - psiLine);

    const crosstrack = selfT - targetT; // +ve = right of the line
    const lock = lerp(DEFAULT_SPEC.maxSteerLock, DEFAULT_SPEC.highSpeedSteerLock, clamp01(v / 40));
    const deltaFF = WHEELBASE * kLine;
    const deltaCross = -Math.atan2(1.1 * crosstrack, Math.max(v, 5)); // right of line → steer left
    const deltaHeading = -0.9 * headingToLine;
    const rTarget = v * kLine;
    const deltaDamp = -0.12 * (state.yawRate - rTarget);
    const delta = clamp(deltaFF + deltaCross + deltaHeading + deltaDamp, -lock, lock);
    inputs.steer = clamp(delta / lock, -1, 1);

    // ------------------------------------------------------- speed planning
    // Braking horizon: full distance needed from current speed at ~6.5 m/s²
    // (a 58 m/s car needs >200 m — capping short means wall-assisted braking).
    const planDist = clamp((v * v) / (2 * 6.5) + 18, 30, 290);
    const kMax = this.spline.maxCurvatureAhead(selfS + 4, planDist);
    const vCorner = Math.sqrt((this.config.latAccelMax * 0.92) / Math.max(kMax, 1e-4));

    const band = clamp(playerGapS / 220, -1, 1) * 0.1 * this.config.rubberBand;
    const vTop = 58 * this.config.speedMul * (1 + band);
    let vTarget = Math.min(vCorner, vTop);
    if (Math.abs(selfT) > this.halfWidth) vTarget = Math.min(vTarget, 13); // rejoin calmly

    const dv = vTarget - state.vx;
    if (dv > 0) {
      inputs.throttle = clamp01(dv * 0.45 + 0.25) * throttleScale;
    } else if (dv < -1.5) {
      inputs.brake = clamp01(-dv * 0.22);
    }

    // Traction management: lift while the rear slides.
    if (Math.abs(state.slipRear) > 0.13) {
      inputs.throttle *= 0.25;
      inputs.brake = 0;
    }

    // ------------------------------------------------------------- nitro
    if (raceTime < this.nitroUntil) {
      inputs.nitro = true;
    } else if (
      raceTime > this.nitroCooldownUntil &&
      state.nitroTank > 0.55 &&
      kMax < 0.012 &&
      Math.abs(state.slipRear) < 0.08 &&
      vTarget > state.vx + 2 &&
      playerGapS > -60
    ) {
      this.nitroUntil = raceTime + 1.4;
      this.nitroCooldownUntil = raceTime + 5 + this.personalSeed * 4;
      inputs.nitro = true;
    }

    return inputs;
  }
}
