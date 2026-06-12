/**
 * Gesture training mode — record a custom hand pose and bind it to an action.
 *
 * Approach: average ~45 frames of the normalised feature vector into a
 * centroid; at runtime a pose matches when cosine similarity exceeds a
 * threshold derived from the training samples' own spread (tight, consistent
 * samples → permissive threshold; sloppy samples → strict). Pure logic;
 * persistence and UI live elsewhere.
 */
import { cosineSimilarity } from '../vision/HandFeatures';
import type { CustomGestureSample } from '../core/Settings';

export const TRAINING_FRAMES = 45;
const MIN_THRESHOLD = 0.86;
const MAX_THRESHOLD = 0.985;

export class GestureTrainer {
  private samples: number[][] = [];

  get progress(): number {
    return Math.min(this.samples.length / TRAINING_FRAMES, 1);
  }

  get isComplete(): boolean {
    return this.samples.length >= TRAINING_FRAMES;
  }

  reset(): void {
    this.samples = [];
  }

  addSample(vec: number[]): void {
    if (!this.isComplete) this.samples.push([...vec]);
  }

  /**
   * Finalise into a persistable sample. Returns null if training is
   * incomplete or the pose was too inconsistent to be reliable.
   */
  build(action: CustomGestureSample['action'], label: string): CustomGestureSample | null {
    if (!this.isComplete) return null;
    const dims = this.samples[0].length;
    const centroid = new Array(dims).fill(0);
    for (const s of this.samples) for (let i = 0; i < dims; i++) centroid[i] += s[i];
    for (let i = 0; i < dims; i++) centroid[i] /= this.samples.length;

    // Similarity of each sample to the centroid → derive threshold.
    let minSim = 1;
    let sumSim = 0;
    for (const s of this.samples) {
      const sim = cosineSimilarity(s, centroid);
      minSim = Math.min(minSim, sim);
      sumSim += sim;
    }
    const meanSim = sumSim / this.samples.length;
    if (meanSim < 0.9) return null; // user moved too much — retrain

    const threshold = Math.min(Math.max(minSim - 0.015, MIN_THRESHOLD), MAX_THRESHOLD);
    return { action, label, centroid, threshold };
  }
}

/** Quick live check used by the training UI's "test your gesture" step. */
export function matchesSample(vec: number[], sample: CustomGestureSample): boolean {
  return cosineSimilarity(vec, sample.centroid) >= sample.threshold;
}
