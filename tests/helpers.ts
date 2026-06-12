/**
 * Shared test fixtures: builds TrackedHand/HandsState objects from the same
 * synthetic pose templates the demo mode uses, so unit tests exercise the
 * real geometry path (templates → features → classifier → mapper).
 */
import { placeTemplate, TemplateName } from '../src/vision/SyntheticHands';
import { extractFeatures } from '../src/vision/HandFeatures';
import { classifyPose } from '../src/vision/GestureClassifier';
import type { HandsState, HandRole, TrackedHand } from '../src/vision/HandTypes';

export function makeTrackedHand(
  pose: TemplateName,
  role: HandRole,
  cxImage: number,
  cyImage: number,
  opts: { rotation?: number; ts?: number; velX?: number; velY?: number } = {},
): TrackedHand {
  const landmarks = placeTemplate(pose, {
    cx: cxImage,
    cy: cyImage,
    rotation: opts.rotation ?? 0,
    mirrorX: role === 'left', // left hand is a mirrored template, like real hands
  });
  const features = extractFeatures(landmarks);
  return {
    role,
    landmarks,
    features,
    pose: classifyPose(features),
    poseConfidence: 1,
    score: 0.95,
    velX: opts.velX ?? 0,
    velY: opts.velY ?? 0,
    lastSeenTs: opts.ts ?? 0,
    coasting: false,
  };
}

/**
 * Build a two-hand wheel state at a USER-SPACE wheel angle (radians,
 * positive = turning right). User space: x grows to the user's right,
 * y down — image x is mirrored back when placing the templates.
 */
export function makeWheelHands(
  angleUser: number,
  leftPose: TemplateName = 'grip',
  rightPose: TemplateName = 'grip',
  ts = 0,
  radius = 0.21,
): HandsState {
  const cxU = 0.5;
  const cy = 0.55;
  // user-space hand centres
  const rightU = { x: cxU + radius * Math.cos(angleUser), y: cy + radius * Math.sin(angleUser) };
  const leftU = { x: cxU - radius * Math.cos(angleUser), y: cy - radius * Math.sin(angleUser) };
  // convert user x → image x (raw webcam frames are unmirrored)
  const left = makeTrackedHand(leftPose, 'left', 1 - leftU.x, leftU.y, { ts, rotation: angleUser * 0.5 });
  const right = makeTrackedHand(rightPose, 'right', 1 - rightU.x, rightU.y, { ts, rotation: angleUser * 0.5 });
  return { left, right, captureTs: ts, inferMs: 1, liveCount: 2 };
}

export function emptyHands(ts = 0): HandsState {
  return { left: null, right: null, captureTs: ts, inferMs: 0, liveCount: 0 };
}
