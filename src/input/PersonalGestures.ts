/**
 * Personalised driving-gesture classifier.
 *
 * The guided setup records the user's OWN pose for each driving action (relax,
 * throttle, brake, reverse, nitro) as an averaged feature centroid. At runtime
 * we classify a live hand by nearest centroid using a WEIGHTED distance — plain
 * cosine similarity can't separate thumb-up from thumb-down (they differ in a
 * single feature), so the thumb-direction and thumb-extension dims are weighted
 * heavily. An explicit "idle" class prevents a relaxed hand from falsely firing
 * an action (nearest-centroid otherwise always picks *something*).
 */
import { featureVector } from '../vision/HandFeatures';
import type { HandFeatures } from '../vision/HandTypes';

export type DriveAction = 'idle' | 'throttle' | 'brake' | 'reverse' | 'nitro';

export const DRIVE_ACTIONS: DriveAction[] = ['idle', 'throttle', 'brake', 'reverse', 'nitro'];

export interface DriveCentroid {
  action: DriveAction;
  centroid: number[];
}

export interface DrivingGestureSet {
  trained: boolean;
  classes: DriveCentroid[];
  trainedAt: number; // epoch ms
}

export function emptyDrivingSet(): DrivingGestureSet {
  return { trained: false, classes: [], trainedAt: 0 };
}

// featureVector dims: [curl0..3, thumbExtended, (thumbVert+1)/2, pinch/2, |roll|/PI]
// Emphasise finger curls (peace vs fist), thumb extension (fist vs thumb poses)
// and thumb vertical (thumb-up vs thumb-down). De-emphasise roll/pinch (noisy).
const WEIGHTS = [1.5, 1.5, 1.5, 1.5, 2.2, 3.2, 0.4, 0.3];
const ACCEPT_DISTANCE = 1.15; // beyond this from every centroid → 'none'

function weightedDistance(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length, WEIGHTS.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] - b[i]) * WEIGHTS[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Average a list of feature vectors into a centroid. */
export function centroidOf(samples: number[][]): number[] {
  if (samples.length === 0) return [];
  const dims = samples[0].length;
  const c = new Array(dims).fill(0);
  for (const s of samples) for (let i = 0; i < dims; i++) c[i] += s[i];
  for (let i = 0; i < dims; i++) c[i] /= samples.length;
  return c;
}

export class PersonalGestureClassifier {
  constructor(private set: DrivingGestureSet) {}

  get isTrained(): boolean {
    return this.set.trained && this.set.classes.length >= 2;
  }

  /** Classify a hand's pose into a driving action (or 'idle' when nothing matches). */
  classify(features: HandFeatures): { action: DriveAction; distance: number } {
    if (!this.isTrained) return { action: 'idle', distance: Infinity };
    const vec = featureVector(features);
    let best: DriveAction = 'idle';
    let bestDist = Infinity;
    for (const c of this.set.classes) {
      const d = weightedDistance(vec, c.centroid);
      if (d < bestDist) {
        bestDist = d;
        best = c.action;
      }
    }
    // Too far from every trained pose → treat as idle (no action).
    if (bestDist > ACCEPT_DISTANCE) return { action: 'idle', distance: bestDist };
    return { action: best, distance: bestDist };
  }
}
