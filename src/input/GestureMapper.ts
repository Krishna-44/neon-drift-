/**
 * Input translation engine: HandsState → ControlState.
 *
 * Gesture map (see README for the full chart):
 *   two hands apart            → virtual wheel; line angle = steering
 *   right(or either) thumbDown → throttle (angle-proportional)
 *   thumbUp                    → reverse request (gear engages when slow)
 *   fist (near-straight wheel) → brake; BOTH fists = max brake
 *   fist + wheel past ~45%     → drift / handbrake (spec: "tilt + fist combo")
 *   peace / V                  → nitro
 *   open palm held 2 s         → pause toggle
 *
 * Implements calibration offsets, dead-zone, expo, One-Euro smoothing,
 * slew limiting, velocity prediction (latency compensation) and occlusion
 * coast-down. Pure logic — fully unit-testable, no DOM access.
 */
import { clamp, clamp01, deadZone, expoCurve, DEG2RAD, RAD2DEG, remap, wrapAngle } from '../core/MathUtils';
import { ControlState, neutralControlState } from './ControlState';
import { OneEuroFilter } from '../vision/OneEuro';
import { HoldDetector } from '../vision/GestureClassifier';
import { featureVector, cosineSimilarity } from '../vision/HandFeatures';
import type { CalibrationData, ControlSettings, CustomGestureSample } from '../core/Settings';
import type { HandsState, TrackedHand } from '../vision/HandTypes';

const PREDICT_HORIZON_S = 0.03; // extrapolate palms ~30 ms ahead (CV latency comp)
const MAX_PREDICT_S = 0.06;
const DRIFT_STEER_THRESHOLD = 0.45;
const STEER_SLEW_PER_S = 4.5; // full range in ~0.44 s
const NO_HANDS_DECAY_HALFLIFE = 0.35;
const ONE_HAND_DECAY_HALFLIFE = 0.9;
const MIN_ACTIVE_THROTTLE = 0.22; // gesture-on floor so light thumb angles still move

export class GestureMapper {
  private steerFilter = new OneEuroFilter(1.8, 0.9);
  private steer = 0;
  private pauseHold = new HoldDetector(2.0, 'open');
  private customDebounce = new Map<string, number>();
  private customActivePrev: string | null = null;
  private lastUpdateT = -1;

  constructor(
    public settings: ControlSettings,
    public calibration: CalibrationData,
    public customGestures: CustomGestureSample[] = [],
  ) {}

  reset(): void {
    this.steerFilter.reset();
    this.steer = 0;
    this.pauseHold.reset();
    this.customDebounce.clear();
    this.lastUpdateT = -1;
  }

  /**
   * @param hands  latest tracker state
   * @param now    performance.now() ms
   * @returns      full control state (steer already smoothed + slew limited)
   */
  update(hands: HandsState, now: number): ControlState {
    const out = neutralControlState();
    out.source = 'gesture';
    const t = now / 1000;
    const dt = this.lastUpdateT < 0 ? 1 / 60 : Math.min(Math.max(t - this.lastUpdateT, 1 / 240), 0.1);
    this.lastUpdateT = t;

    const left = hands.left;
    const right = hands.right;
    out.gesture.handsVisible = hands.liveCount;
    out.gesture.leftPose = left?.pose ?? 'none';
    out.gesture.rightPose = right?.pose ?? 'none';
    out.gesture.leftConfidence = left?.poseConfidence ?? 0;
    out.gesture.rightConfidence = right?.poseConfidence ?? 0;
    out.gesture.coasting = !!(left?.coasting || right?.coasting);

    // ------------------------------------------------------------- steering
    const bothHands = !!left && !!right;
    const wheelEngaged = bothHands && left.pose !== 'open' && right.pose !== 'open';
    out.gesture.wheelEngaged = wheelEngaged;

    if (wheelEngaged) {
      // User-space coords (mirror image x) with velocity prediction.
      const horizon = Math.min(PREDICT_HORIZON_S + Math.max(0, (now - hands.captureTs) / 1000), MAX_PREDICT_S);
      const lx = 1 - (left.features.palmX + left.velX * horizon);
      const ly = left.features.palmY + left.velY * horizon;
      const rx = 1 - (right.features.palmX + right.velX * horizon);
      const ry = right.features.palmY + right.velY * horizon;
      // Vector user-left-hand → user-right-hand; image y is down, so a
      // clockwise wheel turn (turn right) pitches the right hand DOWN → +angle.
      const raw = Math.atan2(ry - ly, rx - lx);
      const rel = wrapAngle(raw - this.calibration.neutralAngle);
      const norm = clamp((rel / this.calibration.maxLockAngle) * this.settings.steerSensitivity, -1, 1);
      const dzNorm = clamp((this.settings.deadZoneDeg * DEG2RAD) / this.calibration.maxLockAngle, 0, 0.4);
      const steerTarget = deadZone(norm, dzNorm);
      out.gesture.wheelAngleDeg = rel * RAD2DEG;
      // Smooth (One-Euro adapts: snappy on fast turns, calm at centre) then slew-limit.
      const smoothed = this.steerFilter.filter(steerTarget, t);
      const maxDelta = STEER_SLEW_PER_S * dt;
      this.steer = clamp(smoothed, this.steer - maxDelta, this.steer + maxDelta);
    } else {
      // Occlusion / hands-off coast-down: relax straight to centre, bypassing
      // the smoothing filter (feeding decay through it stretches the half-life).
      const halfLife = left || right ? ONE_HAND_DECAY_HALFLIFE : NO_HANDS_DECAY_HALFLIFE;
      this.steer *= Math.pow(0.5, dt / halfLife);
      if (Math.abs(this.steer) < 0.01) this.steer = 0;
      this.steerFilter.reset(); // clean re-init when the wheel re-engages (slew still caps jumps)
    }
    out.steer = clamp(this.steer, -1, 1);

    // ------------------------------------------------------------- gestures
    const throttleHands: TrackedHand[] = [];
    if (this.settings.throttleHand !== 'left' && right) throttleHands.push(right);
    if (this.settings.throttleHand !== 'right' && left) throttleHands.push(left);

    let throttle = 0;
    let reverse = false;
    for (const h of throttleHands) {
      if (h.pose === 'thumbDown') {
        const angle = clamp(h.features.thumbDownAngle, 0, Math.PI / 2);
        const raw = remap(angle, this.calibration.throttleMinAngle, this.calibration.throttleMaxAngle, MIN_ACTIVE_THROTTLE, 1);
        throttle = Math.max(throttle, expoCurve(clamp01(raw), this.settings.throttleExpo));
      } else if (h.pose === 'thumbUp') {
        reverse = true;
        const angle = clamp(-h.features.thumbDownAngle, 0, Math.PI / 2);
        const raw = remap(angle, this.calibration.throttleMinAngle, this.calibration.throttleMaxAngle, MIN_ACTIVE_THROTTLE, 0.8);
        throttle = Math.max(throttle, clamp01(raw));
      }
    }

    const leftFist = left?.pose === 'fist';
    const rightFist = right?.pose === 'fist';
    const anyFist = leftFist || rightFist;
    const steeringHard = Math.abs(out.steer) > DRIFT_STEER_THRESHOLD;

    if (anyFist && steeringHard) {
      // Spec: "hand tilt + fist combo" → drift (handbrake), light brake only.
      out.handbrake = true;
      out.brake = Math.max(out.brake, 0.25);
    } else if (leftFist && rightFist) {
      out.brake = 1;
    } else if (anyFist) {
      out.brake = Math.max(out.brake, 0.85);
    }

    // Nitro: default = peace/V on either hand; replaced by a trained custom pose if present.
    const customNitro = this.customGestures.some((g) => g.action === 'nitro');
    if (!customNitro && (left?.pose === 'peace' || right?.pose === 'peace')) out.nitro = true;

    // Custom gestures (trained centroids, cosine match + debounce).
    out.gesture.customActive = this.matchCustom(hands, now);
    if (out.gesture.customActive) {
      const action = this.customGestures.find((g) => g.label === out.gesture.customActive)?.action;
      if (action === 'nitro') out.nitro = true;
    }

    // Pause: open palm held 2 s (either hand). Cancels throttle naturally
    // (no thumb signal while palm is open).
    const palmPose = left?.pose === 'open' ? 'open' : right?.pose === 'open' ? 'open' : 'none';
    out.pauseFired = this.pauseHold.update(palmPose as any, now / 1000);
    if (out.gesture.customActive) {
      const action = this.customGestures.find((g) => g.label === out.gesture.customActive)?.action;
      if (action === 'pause') out.pauseFired = true;
    }
    out.pauseHoldProgress = this.pauseHold.progress;

    out.throttle = clamp01(throttle);
    out.reverse = reverse;
    out.brake = clamp01(out.brake);
    return out;
  }

  /** Returns the label of a matched custom gesture (debounced), else null. */
  private matchCustom(hands: HandsState, now: number): string | null {
    if (this.customGestures.length === 0) return null;
    let best: { label: string; sim: number } | null = null;
    for (const hand of [hands.left, hands.right]) {
      if (!hand || hand.coasting) continue;
      const vec = featureVector(hand.features);
      for (const g of this.customGestures) {
        const sim = cosineSimilarity(vec, g.centroid);
        // Hysteresis: stickier threshold while active.
        const active = this.customActivePrev === g.label;
        const needed = active ? g.threshold - 0.02 : g.threshold;
        if (sim >= needed && (!best || sim > best.sim)) best = { label: g.label, sim };
      }
    }
    if (!best) {
      this.customActivePrev = null;
      this.customDebounce.clear();
      return null;
    }
    const since = this.customDebounce.get(best.label) ?? now;
    if (!this.customDebounce.has(best.label)) this.customDebounce.set(best.label, now);
    if (now - since >= 100 || this.customActivePrev === best.label) {
      this.customActivePrev = best.label;
      return best.label;
    }
    return null;
  }
}
