/**
 * Calibration session logic (pure — the wizard UI renders its progress).
 *
 * Steps:
 *  1. neutral  — hold the wheel relaxed: captures centre angle + hand span
 *  2. lock     — turn to comfortable full left & right: captures max lock
 *  3. throttle — thumb-down sweep: captures the user's thumb angle range
 */
import { clamp, wrapAngle } from '../core/MathUtils';
import type { CalibrationData } from '../core/Settings';
import type { HandsState } from '../vision/HandTypes';

export type CalibrationStep = 'neutral' | 'lock' | 'throttle' | 'done';

const NEUTRAL_SECONDS = 2.5;
const LOCK_SECONDS = 6;
const THROTTLE_SECONDS = 5;

export class CalibrationSession {
  step: CalibrationStep = 'neutral';
  progress = 0;
  /** Live wheel angle for UI feedback (rad). */
  liveAngle = 0;
  message = 'Hold the invisible wheel with both hands, relaxed and level.';

  private elapsed = 0;
  private angleSinSum = 0;
  private angleCosSum = 0;
  private spanSum = 0;
  private samples = 0;
  private maxLeft = 0;
  private maxRight = 0;
  private thumbMin = Infinity;
  private thumbMax = -Infinity;
  private result: CalibrationData;

  constructor(base: CalibrationData) {
    this.result = { ...base };
  }

  /** Feed tracker output each frame. Returns true when the whole session completes. */
  feed(hands: HandsState, dt: number): boolean {
    const left = hands.left;
    const right = hands.right;

    switch (this.step) {
      case 'neutral': {
        if (!left || !right) {
          this.message = 'Show BOTH hands to the camera, like holding a wheel.';
          return false;
        }
        const angle = wheelAngle(hands);
        this.liveAngle = angle;
        this.angleSinSum += Math.sin(angle);
        this.angleCosSum += Math.cos(angle);
        const span = Math.hypot(
          (1 - right.features.palmX) - (1 - left.features.palmX),
          right.features.palmY - left.features.palmY,
        );
        this.spanSum += span;
        this.samples++;
        this.elapsed += dt;
        this.progress = clamp(this.elapsed / NEUTRAL_SECONDS, 0, 1);
        this.message = 'Hold steady… capturing your neutral wheel position.';
        if (this.elapsed >= NEUTRAL_SECONDS && this.samples > 10) {
          this.result.neutralAngle = Math.atan2(this.angleSinSum / this.samples, this.angleCosSum / this.samples);
          this.result.neutralSpan = this.spanSum / this.samples;
          this.next('lock', 'Now turn the wheel FULL LEFT, then FULL RIGHT — as far as feels comfortable.');
        }
        return false;
      }
      case 'lock': {
        if (left && right) {
          const rel = wrapAngle(wheelAngle(hands) - this.result.neutralAngle);
          this.liveAngle = rel;
          if (rel < 0) this.maxLeft = Math.max(this.maxLeft, -rel);
          else this.maxRight = Math.max(this.maxRight, rel);
        }
        this.elapsed += dt;
        this.progress = clamp(this.elapsed / LOCK_SECONDS, 0, 1);
        if (this.elapsed >= LOCK_SECONDS) {
          const lock = Math.min(this.maxLeft, this.maxRight);
          // Sane bounds: 25°..110°; use 90% of reach so full lock is comfortable.
          this.result.maxLockAngle = clamp(lock * 0.9, (25 * Math.PI) / 180, (110 * Math.PI) / 180);
          this.next('throttle', 'Make a fist and point your THUMB DOWN. Sweep it from slightly down to fully down.');
        }
        return false;
      }
      case 'throttle': {
        const hand = right?.pose === 'thumbDown' ? right : left?.pose === 'thumbDown' ? left : null;
        if (hand) {
          const a = hand.features.thumbDownAngle;
          this.thumbMin = Math.min(this.thumbMin, a);
          this.thumbMax = Math.max(this.thumbMax, a);
          this.elapsed += dt;
        } else {
          this.message = 'Thumb down over a closed fist — like a "thumbs down".';
        }
        this.progress = clamp(this.elapsed / THROTTLE_SECONDS, 0, 1);
        if (this.elapsed >= THROTTLE_SECONDS) {
          if (isFinite(this.thumbMin) && this.thumbMax - this.thumbMin > 0.12) {
            this.result.throttleMinAngle = clamp(this.thumbMin + 0.05, 0.05, 1.2);
            this.result.throttleMaxAngle = clamp(this.thumbMax - 0.05, this.result.throttleMinAngle + 0.15, 1.5);
          }
          this.result.calibratedAt = Date.now();
          this.step = 'done';
          this.progress = 1;
          this.message = 'Calibration complete — settings saved.';
          return true;
        }
        return false;
      }
      case 'done':
        return true;
    }
  }

  private next(step: CalibrationStep, message: string): void {
    this.step = step;
    this.message = message;
    this.elapsed = 0;
    this.progress = 0;
  }

  getResult(): CalibrationData {
    return { ...this.result };
  }
}

/** Wheel angle from a HandsState in user space (shared with GestureMapper math). */
export function wheelAngle(hands: HandsState): number {
  const l = hands.left!;
  const r = hands.right!;
  const lx = 1 - l.features.palmX;
  const rx = 1 - r.features.palmX;
  return Math.atan2(r.features.palmY - l.features.palmY, rx - lx);
}
