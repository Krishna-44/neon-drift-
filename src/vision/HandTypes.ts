/**
 * Shared hand-tracking types and MediaPipe landmark topology.
 * Landmarks are stored as flat Float32Array(63): [x0,y0,z0, x1,y1,z1, ...]
 * with x,y in normalised image coordinates (0..1, y down).
 */

// MediaPipe Hands 21-landmark indices
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

/** Bone pairs for skeleton overlay drawing. */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],            // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],            // index
  [5, 9], [9, 10], [10, 11], [11, 12],       // middle
  [9, 13], [13, 14], [14, 15], [15, 16],     // ring
  [13, 17], [17, 18], [18, 19], [19, 20],    // pinky
  [0, 17],                                    // palm edge
];

export type HandPose =
  | 'none'
  | 'open'       // open palm (pause hold)
  | 'fist'       // brake / drift combo
  | 'thumbUp'    // reverse
  | 'thumbDown'  // throttle
  | 'peace'      // nitro
  | 'point'      // menu cursor
  | 'grip';      // relaxed wheel grip (default driving pose)

/** Role on the virtual steering wheel, assigned by screen position. */
export type HandRole = 'left' | 'right';

export interface RawHand {
  /** Flat landmark buffer, length 63. */
  landmarks: Float32Array;
  /** MediaPipe handedness label confidence-weighted ('Left' | 'Right'). */
  handednessLabel: string;
  score: number;
}

export interface RawHandsFrame {
  hands: RawHand[];
  /** performance.now() when the camera frame was captured. */
  captureTs: number;
  /** Inference duration in ms (worker-measured). */
  inferMs: number;
  /** Source frame size used for inference. */
  width: number;
  height: number;
}

/** Per-finger derived features (rotation-invariant where possible). */
export interface HandFeatures {
  /** dist(wrist, middleMCP) in normalised units — scale reference. */
  handSize: number;
  palmX: number;
  palmY: number;
  /** Curl per finger: 0 = fully extended, 1 = fully curled. [index,middle,ring,pinky] */
  curls: [number, number, number, number];
  /** Booleans derived with hysteresis-friendly margins. */
  extended: [boolean, boolean, boolean, boolean];
  curled: [boolean, boolean, boolean, boolean];
  thumbExtended: boolean;
  /** Vertical direction of thumb: +1 up, -1 down (image space), 0 = horizontal. */
  thumbVertical: number;
  /** Thumb angle below horizontal in radians (positive = pointing down). */
  thumbDownAngle: number;
  /** Normalised pinch distance thumbTip<->indexTip (in handSize units). */
  pinchDist: number;
  pinching: boolean;
  /** Hand roll angle: wrist→middleMCP vector vs vertical (rad, signed). */
  rollAngle: number;
}

export interface TrackedHand {
  role: HandRole;
  landmarks: Float32Array; // smoothed
  features: HandFeatures;
  pose: HandPose;
  poseConfidence: number; // 0..1 temporal confidence
  score: number;          // detection score with occlusion decay
  /** Palm velocity in normalised units/s (for prediction). */
  velX: number;
  velY: number;
  lastSeenTs: number;
  /** True if this state is extrapolated (hand currently occluded). */
  coasting: boolean;
}

export interface HandsState {
  left: TrackedHand | null;
  right: TrackedHand | null;
  captureTs: number;
  inferMs: number;
  /** Number of physical hands seen this frame (before occlusion-coasting). */
  liveCount: number;
}

export function lmX(buf: Float32Array, i: number): number {
  return buf[i * 3];
}
export function lmY(buf: Float32Array, i: number): number {
  return buf[i * 3 + 1];
}

export function lmDist(buf: Float32Array, a: number, b: number): number {
  const dx = buf[a * 3] - buf[b * 3];
  const dy = buf[a * 3 + 1] - buf[b * 3 + 1];
  return Math.hypot(dx, dy);
}
