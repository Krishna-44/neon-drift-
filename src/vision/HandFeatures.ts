/**
 * Derives rotation-invariant per-hand features from raw landmarks.
 * Pure functions — fully unit-tested against synthetic pose templates.
 */
import { HandFeatures, LM, lmDist, lmX, lmY } from './HandTypes';

// Finger landmark index groups: [mcp, pip, dip, tip]
const FINGERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_DIP, LM.INDEX_TIP],
  [LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_DIP, LM.MIDDLE_TIP],
  [LM.RING_MCP, LM.RING_PIP, LM.RING_DIP, LM.RING_TIP],
  [LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_DIP, LM.PINKY_TIP],
];

// Extension ratio thresholds: dist(tip,wrist) / dist(pip,wrist).
// Extended fingers measure ~1.25-1.45, curled ~0.5-0.85.
const EXTENDED_RATIO = 1.15;
const CURLED_RATIO = 0.95;
// Thumb: dist(thumbTip, pinkyMCP) in handSize units. Across palm ≈ 0.2-0.5, out ≈ 0.9-1.5.
const THUMB_EXTENDED_DIST = 0.7;
const PINCH_THRESHOLD = 0.32;

export function extractFeatures(buf: Float32Array): HandFeatures {
  const handSize = Math.max(lmDist(buf, LM.WRIST, LM.MIDDLE_MCP), 1e-4);

  // Palm centre: average of wrist + index/middle/ring MCPs (stable under finger motion).
  const palmX = (lmX(buf, LM.WRIST) + lmX(buf, LM.INDEX_MCP) + lmX(buf, LM.MIDDLE_MCP) + lmX(buf, LM.RING_MCP)) / 4;
  const palmY = (lmY(buf, LM.WRIST) + lmY(buf, LM.INDEX_MCP) + lmY(buf, LM.MIDDLE_MCP) + lmY(buf, LM.RING_MCP)) / 4;

  const curls: [number, number, number, number] = [0, 0, 0, 0];
  const extended: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  const curled: [boolean, boolean, boolean, boolean] = [false, false, false, false];

  for (let f = 0; f < 4; f++) {
    const [, pip, , tip] = FINGERS[f];
    const tipDist = lmDist(buf, tip, LM.WRIST);
    const pipDist = Math.max(lmDist(buf, pip, LM.WRIST), 1e-4);
    const ratio = tipDist / pipDist;
    // 0 = extended (ratio>=1.35), 1 = curled (ratio<=0.75)
    const curl = ratio >= 1.35 ? 0 : ratio <= 0.75 ? 1 : (1.35 - ratio) / 0.6;
    curls[f] = curl;
    extended[f] = ratio > EXTENDED_RATIO;
    curled[f] = ratio < CURLED_RATIO;
  }

  // Thumb
  const thumbDist = lmDist(buf, LM.THUMB_TIP, LM.PINKY_MCP) / handSize;
  const thumbExtended = thumbDist > THUMB_EXTENDED_DIST;
  const tdx = lmX(buf, LM.THUMB_TIP) - lmX(buf, LM.THUMB_MCP);
  const tdy = lmY(buf, LM.THUMB_TIP) - lmY(buf, LM.THUMB_MCP);
  const tlen = Math.max(Math.hypot(tdx, tdy), 1e-4);
  // Image y grows downward → up = negative dy.
  const thumbVertical = -tdy / tlen;
  // Angle below horizontal (positive when pointing down).
  const thumbDownAngle = Math.atan2(tdy, Math.abs(tdx));

  const pinchDist = lmDist(buf, LM.THUMB_TIP, LM.INDEX_TIP) / handSize;

  // Roll: orientation of the palm axis (wrist → middleMCP) relative to "up".
  const rdx = lmX(buf, LM.MIDDLE_MCP) - lmX(buf, LM.WRIST);
  const rdy = lmY(buf, LM.MIDDLE_MCP) - lmY(buf, LM.WRIST);
  const rollAngle = Math.atan2(rdx, -rdy); // 0 when fingers point straight up

  return {
    handSize,
    palmX,
    palmY,
    curls,
    extended,
    curled,
    thumbExtended,
    thumbVertical,
    thumbDownAngle,
    pinchDist,
    pinching: pinchDist < PINCH_THRESHOLD,
    rollAngle,
  };
}

/**
 * Compact normalised descriptor for custom-gesture training (cosine matching).
 * Mirrors the live features so trained centroids transfer across sessions.
 */
export function featureVector(f: HandFeatures): number[] {
  return [
    f.curls[0],
    f.curls[1],
    f.curls[2],
    f.curls[3],
    f.thumbExtended ? 1 : 0,
    (f.thumbVertical + 1) / 2,
    Math.min(f.pinchDist, 2) / 2,
    Math.min(Math.abs(f.rollAngle) / Math.PI, 1),
  ];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
