/**
 * Pose classification + temporal stabilisation.
 *
 * classifyPose() is a stateless rule cascade over rotation-invariant features.
 * GestureStabilizer adds the temporal layer the spec demands: a pose must
 * persist N frames to activate and M frames to release (hysteresis), with a
 * confidence score from a sliding vote window — this is what prevents control
 * flicker and gesture misfires.
 */
import { HandFeatures } from './HandTypes';
import type { HandPose } from './HandTypes';

const THUMB_VERTICAL_MIN = 0.55;

export function classifyPose(f: HandFeatures): HandPose {
  const extCount = f.extended.filter(Boolean).length;
  const curlCount = f.curled.filter(Boolean).length;
  const allCurled = curlCount === 4;

  // Open palm: all four fingers extended (thumb state irrelevant).
  if (extCount === 4) return 'open';

  // Peace / V: exactly index+middle extended, ring+pinky curled.
  if (f.extended[0] && f.extended[1] && f.curled[2] && f.curled[3]) return 'peace';

  // Point: index only.
  if (f.extended[0] && f.curled[1] && f.curled[2] && f.curled[3]) return 'point';

  if (allCurled) {
    if (f.thumbExtended) {
      if (f.thumbVertical > THUMB_VERTICAL_MIN) return 'thumbUp';
      if (f.thumbVertical < -THUMB_VERTICAL_MIN) return 'thumbDown';
      // Thumb out sideways over a fist — treat as grip (wheel hold).
      return 'grip';
    }
    return 'fist';
  }

  // Anything else (half-curled fingers) = relaxed wheel grip.
  return 'grip';
}

interface StabilizerOptions {
  /** Consecutive frames required to activate a pose. */
  activateFrames?: Partial<Record<HandPose, number>>;
  /** Frames of disagreement required to release the active pose. */
  releaseFrames?: number;
  /** Vote window for the confidence score. */
  windowSize?: number;
}

const DEFAULT_ACTIVATE: Record<HandPose, number> = {
  none: 1,
  open: 3,
  fist: 4,   // brake — slightly stricter to avoid loose-grip false positives
  thumbUp: 3,
  thumbDown: 2, // throttle — favour responsiveness
  peace: 3,
  point: 3,
  grip: 2,
};

export class GestureStabilizer {
  private active: HandPose = 'none';
  private candidate: HandPose = 'none';
  private candidateStreak = 0;
  private disagreeStreak = 0;
  private window: HandPose[] = [];
  private readonly releaseFrames: number;
  private readonly windowSize: number;
  private readonly activate: Record<HandPose, number>;

  constructor(opts: StabilizerOptions = {}) {
    this.releaseFrames = opts.releaseFrames ?? 3;
    this.windowSize = opts.windowSize ?? 10;
    this.activate = { ...DEFAULT_ACTIVATE, ...(opts.activateFrames ?? {}) };
  }

  reset(): void {
    this.active = 'none';
    this.candidate = 'none';
    this.candidateStreak = 0;
    this.disagreeStreak = 0;
    this.window.length = 0;
  }

  get pose(): HandPose {
    return this.active;
  }

  /** Confidence = share of recent frames agreeing with the active pose. */
  get confidence(): number {
    if (this.window.length === 0) return 0;
    let agree = 0;
    for (const p of this.window) if (p === this.active) agree++;
    return agree / this.window.length;
  }

  push(raw: HandPose): HandPose {
    this.window.push(raw);
    if (this.window.length > this.windowSize) this.window.shift();

    if (raw === this.active) {
      this.disagreeStreak = 0;
      this.candidate = raw;
      this.candidateStreak = 0;
      return this.active;
    }

    // Raw disagrees with active.
    this.disagreeStreak++;
    if (raw === this.candidate) {
      this.candidateStreak++;
    } else {
      this.candidate = raw;
      this.candidateStreak = 1;
    }

    const needed = this.activate[this.candidate] ?? 3;
    if (this.candidateStreak >= needed && this.disagreeStreak >= this.releaseFrames) {
      this.active = this.candidate;
      this.candidateStreak = 0;
      this.disagreeStreak = 0;
    }
    return this.active;
  }
}

/**
 * Timed-hold detector (open palm → pause). Emits progress 0..1 and fires once
 * when the hold completes; re-arms after the pose is released.
 */
export class HoldDetector {
  private heldSince = -1;
  private fired = false;
  progress = 0;

  constructor(
    private readonly holdSeconds = 2.0,
    private readonly pose: HandPose = 'open',
  ) {}

  reset(): void {
    this.heldSince = -1;
    this.fired = false;
    this.progress = 0;
  }

  /** Returns true exactly once when the hold completes. */
  update(currentPose: HandPose, now: number): boolean {
    if (currentPose !== this.pose) {
      this.heldSince = -1;
      this.fired = false;
      this.progress = 0;
      return false;
    }
    if (this.heldSince < 0) this.heldSince = now;
    this.progress = Math.min((now - this.heldSince) / this.holdSeconds, 1);
    if (this.progress >= 1 && !this.fired) {
      this.fired = true;
      return true;
    }
    return false;
  }
}
