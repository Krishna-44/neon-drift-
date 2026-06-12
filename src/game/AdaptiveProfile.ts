/**
 * Adaptive AI: observes the player's driving during a race (steering
 * smoothness, throttle aggression, off-tracks, collisions, consistency) and
 * maintains a persistent skill profile. The profile feeds:
 *   - rubber-band strength & AI difficulty suggestion for the next race
 *   - automatic assist tuning (steering smoothing, stability) when enabled
 */
import { clamp, clamp01, lerp, RollingStats } from '../core/MathUtils';
import type { AdaptiveProfile } from '../core/Settings';
import type { AIDifficulty } from '../ai/AIDriver';

export class RaceObserver {
  private steerPrev = 0;
  private jerk = new RollingStats(600);
  private throttleSum = 0;
  private samples = 0;
  offTrackCount = 0;
  collisionCount = 0;
  private offTrackLatch = false;

  /** Call each physics tick with the player's inputs/state. */
  sample(steer: number, throttle: number, onTrack: boolean, collided: boolean, dt: number): void {
    const steerRate = (steer - this.steerPrev) / Math.max(dt, 1e-4);
    this.steerPrev = steer;
    this.jerk.push(Math.abs(steerRate));
    this.throttleSum += throttle;
    this.samples++;

    if (!onTrack && !this.offTrackLatch) {
      this.offTrackLatch = true;
      this.offTrackCount++;
    } else if (onTrack) {
      this.offTrackLatch = false;
    }
    if (collided) this.collisionCount++;
  }

  finalize(opts: {
    position: number;
    fieldSize: number;
    laps: number;
    lapTimesMs: number[];
  }) {
    const meanJerk = this.jerk.mean; // steering rate magnitude, ~0.5 smooth … 4+ erratic
    const smoothness = clamp(100 - meanJerk * 22, 0, 100);
    const aggression = clamp((this.throttleSum / Math.max(this.samples, 1)) * 130, 0, 100);

    // Lap consistency: std/mean of lap times (lower = better).
    let consistency = 50;
    if (opts.lapTimesMs.length >= 2) {
      const mean = opts.lapTimesMs.reduce((s, v) => s + v, 0) / opts.lapTimesMs.length;
      const std = Math.sqrt(opts.lapTimesMs.reduce((s, v) => s + (v - mean) ** 2, 0) / opts.lapTimesMs.length);
      consistency = clamp(100 - (std / mean) * 600, 0, 100);
    }

    const positionScore = clamp01((opts.fieldSize - opts.position) / Math.max(opts.fieldSize - 1, 1)) * 100;
    const offTrackPenalty = clamp((this.offTrackCount / Math.max(opts.laps, 1)) * 7, 0, 30);
    const collisionPenalty = clamp((this.collisionCount / Math.max(opts.laps, 1)) * 4, 0, 20);

    const skill = clamp(
      positionScore * 0.45 + smoothness * 0.2 + consistency * 0.2 + 15 - offTrackPenalty - collisionPenalty,
      0,
      100,
    );
    return { skill, smoothness, aggression, consistency };
  }
}

/** Merge a finished race into the persistent profile (EMA). */
export function updateProfile(profile: AdaptiveProfile, race: ReturnType<RaceObserver['finalize']>): AdaptiveProfile {
  const a = profile.races === 0 ? 1 : 0.35;
  return {
    ...profile,
    skill: lerp(profile.skill, race.skill, a),
    smoothness: lerp(profile.smoothness, race.smoothness, a),
    aggression: lerp(profile.aggression, race.aggression, a),
    races: profile.races + 1,
  };
}

export function suggestDifficulty(profile: AdaptiveProfile): AIDifficulty {
  if (profile.skill < 38) return 'rookie';
  if (profile.skill < 68) return 'racer';
  return 'pro';
}

/**
 * Auto-assist tuning: erratic steering → more smoothing; clean drivers get a
 * rawer, faster wheel. Returns settings patches (applied when adaptiveAssists
 * is enabled).
 */
export function suggestAssists(profile: AdaptiveProfile): {
  steerSmoothing: number;
  stabilityAssist: boolean;
  counterSteerAssist: boolean;
} {
  const smoothing = clamp(0.65 - (profile.smoothness / 100) * 0.4, 0.2, 0.65);
  return {
    steerSmoothing: +smoothing.toFixed(2),
    stabilityAssist: profile.skill < 55,
    counterSteerAssist: profile.skill < 75,
  };
}
