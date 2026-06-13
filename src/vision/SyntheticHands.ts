/**
 * Synthetic hand-landmark generator.
 *
 * Two production purposes:
 *  1. Demo/attract mode + headless integration testing: drives the ENTIRE
 *     pipeline (landmarks → features → gestures → controls → physics) with a
 *     scripted "ghost driver", no webcam required.
 *  2. Ground-truth templates for the unit tests of the feature extractor and
 *     classifier — the same geometry must classify correctly in both worlds.
 *
 * Templates are authored in a hand-local frame: wrist at origin, palm axis up
 * (image y is DOWN, so "up" = -y), handSize (wrist→middleMCP) = 1.
 */
import { RawHand, RawHandsFrame } from './HandTypes';
import { seededRandom } from '../core/MathUtils';

type Pts = ReadonlyArray<readonly [number, number]>; // 21 [x, y] pairs, local frame

// Shared digit blocks --------------------------------------------------------

const FINGERS_EXTENDED: Pts = [
  // index mcp/pip/dip/tip
  [-0.18, -0.95], [-0.22, -1.3], [-0.24, -1.52], [-0.26, -1.72],
  // middle
  [0.0, -1.0], [0.0, -1.38], [0.0, -1.62], [0.0, -1.85],
  // ring
  [0.17, -0.96], [0.2, -1.3], [0.22, -1.52], [0.24, -1.7],
  // pinky
  [0.32, -0.88], [0.38, -1.12], [0.42, -1.28], [0.45, -1.45],
];

const FINGERS_CURLED: Pts = [
  [-0.18, -0.95], [-0.2, -1.15], [-0.18, -0.92], [-0.16, -0.7],
  [0.0, -1.0], [0.0, -1.2], [0.0, -0.95], [0.0, -0.72],
  [0.17, -0.96], [0.19, -1.14], [0.18, -0.92], [0.17, -0.7],
  [0.32, -0.88], [0.35, -1.02], [0.33, -0.84], [0.31, -0.66],
];

const FINGERS_HALF: Pts = [
  [-0.18, -0.95], [-0.21, -1.22], [-0.22, -1.3], [-0.22, -1.34],
  [0.0, -1.0], [0.0, -1.26], [0.0, -1.35], [0.0, -1.38],
  [0.17, -0.96], [0.19, -1.22], [0.2, -1.3], [0.2, -1.33],
  [0.32, -0.88], [0.36, -1.06], [0.37, -1.12], [0.37, -1.15],
];

const THUMB_NEUTRAL: Pts = [[-0.25, -0.15], [-0.45, -0.38], [-0.58, -0.55], [-0.68, -0.68]];
const THUMB_CURLED: Pts = [[-0.25, -0.15], [-0.4, -0.4], [-0.3, -0.6], [-0.12, -0.68]];
const THUMB_UP: Pts = [[-0.25, -0.15], [-0.42, -0.42], [-0.5, -0.75], [-0.55, -1.08]];
const THUMB_DOWN: Pts = [[-0.25, -0.12], [-0.42, -0.28], [-0.5, -0.02], [-0.55, 0.28]];

function buildTemplate(thumb: Pts, fingers: Pts): Pts {
  return [[0, 0], ...thumb, ...fingers] as Pts;
}

/** Canonical pose templates (local frame). */
export const POSE_TEMPLATES = {
  open: buildTemplate(THUMB_NEUTRAL, FINGERS_EXTENDED),
  fist: buildTemplate(THUMB_CURLED, FINGERS_CURLED),
  grip: buildTemplate(THUMB_NEUTRAL, FINGERS_HALF),
  thumbUp: buildTemplate(THUMB_UP, FINGERS_CURLED),
  thumbDown: buildTemplate(THUMB_DOWN, FINGERS_CURLED),
  peace: buildTemplate(THUMB_CURLED, [
    ...FINGERS_EXTENDED.slice(0, 8),
    ...FINGERS_CURLED.slice(8, 16),
  ] as Pts),
  point: buildTemplate(THUMB_CURLED, [
    ...FINGERS_EXTENDED.slice(0, 4),
    ...FINGERS_CURLED.slice(4, 16),
  ] as Pts),
} as const;

export type TemplateName = keyof typeof POSE_TEMPLATES;

export interface PlaceOptions {
  cx: number;       // palm centre x in normalised image coords
  cy: number;
  scale?: number;   // handSize in normalised image units (default 0.13)
  rotation?: number; // radians, +ve = clockwise in image space
  mirrorX?: boolean; // mirror for the left hand of the wheel
  noise?: number;    // uniform noise amplitude (normalised units)
  rng?: () => number;
}

/** Instantiate a template into a normalised-image landmark buffer. */
export function placeTemplate(name: TemplateName, opts: PlaceOptions): Float32Array {
  const { cx, cy, scale = 0.13, rotation = 0, mirrorX = false, noise = 0, rng = Math.random } = opts;
  const pts = POSE_TEMPLATES[name];
  const out = new Float32Array(63);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  // Local palm centre (matches extractFeatures' definition) so cx/cy is the palm.
  const pcx = (pts[0][0] + pts[5][0] + pts[9][0] + pts[13][0]) / 4;
  const pcy = (pts[0][1] + pts[5][1] + pts[9][1] + pts[13][1]) / 4;
  for (let i = 0; i < 21; i++) {
    let x = (pts[i][0] - pcx) * (mirrorX ? -1 : 1);
    let y = pts[i][1] - pcy;
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    out[i * 3] = cx + rx * scale + (noise ? (rng() * 2 - 1) * noise : 0);
    out[i * 3 + 1] = cy + ry * scale + (noise ? (rng() * 2 - 1) * noise : 0);
    out[i * 3 + 2] = 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scripted demo driver: a timeline of driving "scenes" that exercises every
// gesture. Generates frames at the camera cadence.
// ---------------------------------------------------------------------------

interface DemoScene {
  duration: number;
  leftPose: TemplateName;
  rightPose: TemplateName;
  /** Wheel angle in radians as fn of scene-local time. */
  wheel: (t: number) => number;
}

const DEMO_SCRIPT: DemoScene[] = [
  // Gesture map: fist = gas, thumbDown = brake, thumbUp = reverse, peace = nitro.
  { duration: 2.5, leftPose: 'fist', rightPose: 'fist', wheel: () => 0 },                          // launch straight (full gas)
  { duration: 4.0, leftPose: 'fist', rightPose: 'fist', wheel: (t) => Math.sin(t * 0.9) * 0.5 },   // gas through sweepers
  { duration: 1.6, leftPose: 'thumbDown', rightPose: 'grip', wheel: () => 0 },                     // brake
  { duration: 3.0, leftPose: 'fist', rightPose: 'fist', wheel: (t) => Math.sin(t * 1.4) * 0.8 },   // gas + hard slalom
  { duration: 2.0, leftPose: 'fist', rightPose: 'peace', wheel: () => 0.05 },                      // gas + nitro
  { duration: 2.4, leftPose: 'thumbDown', rightPose: 'grip', wheel: () => 0.85 },                  // brake-drift right
  { duration: 3.5, leftPose: 'fist', rightPose: 'fist', wheel: (t) => Math.sin(t * 0.7) * 0.35 },  // cruise
];
const DEMO_TOTAL = DEMO_SCRIPT.reduce((s, sc) => s + sc.duration, 0);

export class SyntheticHandSource {
  private rng = seededRandom(0xc0ffee);
  readonly width = 640;
  readonly height = 480;

  /** Generate the two-hand frame for a given elapsed time (seconds). */
  frameAt(elapsed: number, captureTs: number): RawHandsFrame {
    let t = elapsed % DEMO_TOTAL;
    let scene = DEMO_SCRIPT[0];
    for (const sc of DEMO_SCRIPT) {
      if (t < sc.duration) {
        scene = sc;
        break;
      }
      t -= sc.duration;
    }
    const wheel = scene.wheel(t);
    // Hands on an invisible wheel of radius ~0.21 normalised units.
    const r = 0.21;
    const cx = 0.5;
    const cy = 0.58;
    const leftX = cx - r * Math.cos(wheel);
    const leftY = cy - r * Math.sin(wheel);
    const rightX = cx + r * Math.cos(wheel);
    const rightY = cy + r * Math.sin(wheel);
    const noise = 0.0035; // realistic landmark jitter

    const left: RawHand = {
      landmarks: placeTemplate(scene.leftPose, {
        cx: leftX, cy: leftY, rotation: wheel * 0.5, mirrorX: true, noise, rng: this.rng,
      }),
      handednessLabel: 'Right', // raw (unmirrored) webcam labels are swapped vs screen position
      score: 0.97,
    };
    const right: RawHand = {
      landmarks: placeTemplate(scene.rightPose, {
        cx: rightX, cy: rightY, rotation: wheel * 0.5, noise, rng: this.rng,
      }),
      handednessLabel: 'Left',
      score: 0.96,
    };

    return { hands: [left, right], captureTs, inferMs: 0.1, width: this.width, height: this.height };
  }
}
