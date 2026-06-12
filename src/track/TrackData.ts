/**
 * The four shipped circuits. Geometry is procedural (control points → spline →
 * mesh), so tracks are data, not assets — adding a fifth track is ~15 lines.
 */

export type ThemeId = 'city' | 'desert' | 'highway' | 'mountain';

export interface OffTrackSurface {
  grip: number;
  drag: number;
}

export interface TrackDef {
  id: string;
  name: string;
  tagline: string;
  themeId: ThemeId;
  /** Centreline control points [x, z] in metres (closed loop). */
  controlPoints: ReadonlyArray<readonly [number, number]>;
  /** Track half-width in metres. */
  halfWidth: number;
  /** Hard walls at the edge (true) or runoff + outer barrier (false). */
  walls: boolean;
  /** Off-track surface physics (only relevant when walls=false). */
  offTrack: OffTrackSurface;
  /** Outer hard limit beyond half-width when walls=false. */
  runoffWidth: number;
  heightFn: (sNorm: number) => number;
  propSeed: number;
  /** UI accents. */
  accentColor: string;
  accentColor2: string;
  difficulty: 1 | 2 | 3;
}

const flat = () => 0;

export const TRACKS: TrackDef[] = [
  {
    id: 'city',
    name: 'NEON DISTRICT',
    tagline: 'Tight 90s between glowing towers. Walls bite.',
    themeId: 'city',
    controlPoints: [
      [0, 0], [90, -6], [150, 4], [186, 36], [196, 86], [188, 140],
      [150, 172], [104, 178], [70, 152], [34, 160], [-6, 176], [-50, 158],
      [-72, 118], [-64, 72], [-36, 40], [-30, 10],
    ],
    halfWidth: 8.5,
    walls: true,
    offTrack: { grip: 0.85, drag: 2 },
    runoffWidth: 2,
    heightFn: flat,
    propSeed: 101,
    accentColor: '#00f0ff',
    accentColor2: '#ff2bd6',
    difficulty: 2,
  },
  {
    id: 'desert',
    name: 'DUNE RUSH',
    tagline: 'Wide flowing sweepers. Sand punishes the greedy.',
    themeId: 'desert',
    controlPoints: [
      [0, 0], [130, -28], [250, -16], [340, 40], [384, 130], [360, 224],
      [272, 270], [170, 252], [110, 300], [10, 330], [-100, 296],
      [-150, 210], [-136, 110], [-70, 48],
    ],
    halfWidth: 11,
    walls: false,
    offTrack: { grip: 0.55, drag: 7 },
    runoffWidth: 14,
    heightFn: (u) => 3.2 * Math.sin(u * Math.PI * 4) + 1.8 * Math.sin(u * Math.PI * 10 + 1.3),
    propSeed: 202,
    accentColor: '#ffb648',
    accentColor2: '#ff5e3a',
    difficulty: 1,
  },
  {
    id: 'highway',
    name: 'MIDNIGHT RUN',
    tagline: 'Flat-out night expressway. Barriers at 200 km/h.',
    themeId: 'highway',
    controlPoints: [
      [0, 0], [170, -14], [330, 6], [470, 60], [550, 160], [540, 268],
      [440, 330], [300, 322], [160, 352], [0, 360], [-140, 318],
      [-208, 220], [-180, 104], [-90, 40],
    ],
    halfWidth: 10,
    walls: true,
    offTrack: { grip: 0.8, drag: 2.5 },
    runoffWidth: 2,
    heightFn: (u) => 2.2 * Math.sin(u * Math.PI * 6),
    propSeed: 303,
    accentColor: '#7a5cff',
    accentColor2: '#00f0ff',
    difficulty: 1,
  },
  {
    id: 'mountain',
    name: 'SAKURA PASS',
    tagline: 'Hairpin switchbacks built for sideways. Drift or die.',
    themeId: 'mountain',
    controlPoints: [
      [0, 0], [90, -8], [134, 30], [120, 78], [62, 88], [44, 136],
      [98, 164], [160, 148], [196, 196], [160, 248], [92, 242],
      [20, 262], [-52, 244], [-78, 192], [-58, 140], [-96, 96], [-72, 36],
    ],
    halfWidth: 6.5,
    walls: false,
    offTrack: { grip: 0.6, drag: 6 },
    runoffWidth: 7,
    heightFn: (u) => 11 * Math.sin(u * Math.PI * 2) + 4 * Math.sin(u * Math.PI * 6 + 0.8),
    propSeed: 404,
    accentColor: '#ff7eb6',
    accentColor2: '#b14aed',
    difficulty: 3,
  },
];

export function trackById(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
