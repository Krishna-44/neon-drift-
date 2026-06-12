/**
 * Adaptive quality governor. Watches the rolling frame time and steps an
 * effective-quality ladder down when the GPU can't hold the target FPS, and
 * back up when there's headroom — keeping gameplay smooth on weak laptops
 * without a settings trip. Hysteresis + cooldown prevent oscillation.
 */
import { Profiler } from './Profiler';

export interface QualityActuator {
  setPixelRatio(r: number): void;
  setBloom(on: boolean): void;
  setParticles(on: boolean): void;
}

interface QualityTier {
  pixelRatio: number;
  bloom: boolean;
  particles: boolean;
  label: string;
}

// Highest → lowest. Index 0 is best.
const TIERS: QualityTier[] = [
  { pixelRatio: 1.0, bloom: true, particles: true, label: 'Ultra' },
  { pixelRatio: 0.85, bloom: true, particles: true, label: 'High' },
  { pixelRatio: 0.75, bloom: true, particles: true, label: 'Medium' },
  { pixelRatio: 0.66, bloom: false, particles: true, label: 'Low' },
  { pixelRatio: 0.55, bloom: false, particles: false, label: 'Potato' },
];

export class PerfGovernor {
  private tier: number;
  private cooldown = 0;
  private goodStreak = 0;
  private badStreak = 0;
  enabled = true;

  constructor(
    private actuator: QualityActuator,
    private profiler: Profiler,
    startQuality: 'low' | 'medium' | 'high' = 'medium',
    private maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2),
    private targetMs = 1000 / 60,
  ) {
    this.tier = startQuality === 'high' ? 0 : startQuality === 'medium' ? 2 : 3;
    this.apply();
  }

  get currentLabel(): string {
    return TIERS[this.tier].label;
  }

  private apply(): void {
    const t = TIERS[this.tier];
    this.actuator.setPixelRatio(Math.min(t.pixelRatio, 1) * this.maxPixelRatio);
    this.actuator.setBloom(t.bloom);
    this.actuator.setParticles(t.particles);
  }

  /** Call once per rendered frame. */
  update(frameDt: number): void {
    if (!this.enabled) return;
    this.cooldown -= frameDt;
    if (this.cooldown > 0) return;

    const avg = this.profiler.frameMs.mean;
    if (avg <= 0 || this.profiler.frameMs.n < 30) return;

    // Downgrade if we're consistently over budget (15 % slack).
    if (avg > this.targetMs * 1.15) {
      this.badStreak++;
      this.goodStreak = 0;
      if (this.badStreak >= 3 && this.tier < TIERS.length - 1) {
        this.tier++;
        this.apply();
        this.cooldown = 2.5;
        this.badStreak = 0;
      }
    } else if (avg < this.targetMs * 0.7) {
      // Plenty of headroom → consider upgrading (slower, more conservative).
      this.goodStreak++;
      this.badStreak = 0;
      if (this.goodStreak >= 8 && this.tier > 0) {
        this.tier--;
        this.apply();
        this.cooldown = 4;
        this.goodStreak = 0;
      }
    } else {
      this.badStreak = 0;
      this.goodStreak = 0;
    }
  }

  /** Manual override from the settings menu. */
  setQuality(q: 'low' | 'medium' | 'high'): void {
    this.tier = q === 'high' ? 0 : q === 'medium' ? 2 : 3;
    this.apply();
    this.cooldown = 3;
  }
}
