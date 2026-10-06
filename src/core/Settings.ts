/**
 * Persistent user settings + profiles (localStorage-backed, schema-versioned).
 * Everything tunable from the UI lives here so calibration survives restarts.
 */

import type { DrivingGestureSet } from '../input/PersonalGestures';

export type GraphicsQuality = 'low' | 'medium' | 'high';
export type CameraModeSetting = 'chase' | 'cockpit';

export interface ControlSettings {
  /** Mirror the webcam preview (selfie view). Gesture math is mirror-invariant. */
  mirrorPreview: boolean;
  /** Steering sensitivity multiplier (0.5 .. 2). */
  steerSensitivity: number;
  /** Steering smoothing strength (0 = raw, 1 = heavy). */
  steerSmoothing: number;
  /** Dead-zone in degrees around the calibrated wheel centre. */
  deadZoneDeg: number;
  /** Which hand's fist counts as throttle: 'right' | 'left' | 'either'. */
  throttleHand: 'right' | 'left' | 'either';
  /** Stability assist: yaw damping at the limit. */
  stabilityAssist: boolean;
  /** Automatic counter-steer help while drifting. */
  counterSteerAssist: boolean;
  /** Adapt assists automatically from the driving profile. */
  adaptiveAssists: boolean;
}

export interface CalibrationData {
  /** Wheel-centre angle offset captured by the wizard (radians). */
  neutralAngle: number;
  /** Hand separation at neutral grip (normalised image units). */
  neutralSpan: number;
  /** Angle (rad) the user reaches at full lock — maps to steer = ±1. */
  maxLockAngle: number;
  calibratedAt: number; // epoch ms, 0 = never calibrated
}

export interface CustomGestureSample {
  /** Action this custom pose overrides. */
  action: 'nitro' | 'pause' | 'camera';
  /** Averaged feature vector (see GestureClassifier.featureVector). */
  centroid: number[];
  /** Cosine-similarity threshold to trigger. */
  threshold: number;
  label: string;
}

export interface AdaptiveProfile {
  /** 0..100 driving skill estimate (EMA across races). */
  skill: number;
  smoothness: number; // 0..100, higher = smoother steering
  aggression: number; // 0..100, throttle usage
  races: number;
  bestLapMsByTrack: Record<string, number>;
}

export interface GameSettings {
  v: number;
  graphics: {
    quality: GraphicsQuality;
    bloom: boolean;
    particles: boolean;
    showFpsHud: boolean;
  };
  audio: {
    master: number;
    engine: number;
    sfx: number;
    music: number;
  };
  control: ControlSettings;
  calibration: CalibrationData;
  customGestures: CustomGestureSample[];
  adaptive: AdaptiveProfile;
  camera: CameraModeSetting;
  lastTrack: string;
  opponents: number;
  laps: number;
  cvProcessScale: number; // 1 | 0.75 | 0.5 — auto-managed, persisted
  /** First-run "how to play" overlay has been acknowledged. */
  seenOnboarding: boolean;
  /** Player car accent colour chosen in the garage carousel. */
  playerCarColor: number;
  /** Guided gesture setup completed (records the user's own pose per action). */
  gestureSetupDone: boolean;
  /** Personalised driving-gesture centroids captured by the guided setup. */
  drivingGestures: DrivingGestureSet;
}

export const DEFAULT_SETTINGS: GameSettings = {
  v: 1,
  graphics: { quality: 'medium', bloom: true, particles: true, showFpsHud: true },
  audio: { master: 0.8, engine: 0.7, sfx: 0.8, music: 0.5 },
  control: {
    mirrorPreview: true,
    steerSensitivity: 1.0,
    steerSmoothing: 0.45,
    deadZoneDeg: 6,
    throttleHand: 'either',
    stabilityAssist: true,
    counterSteerAssist: true,
    adaptiveAssists: true,
  },
  calibration: {
    neutralAngle: 0,
    neutralSpan: 0.32,
    maxLockAngle: (75 * Math.PI) / 180,
    calibratedAt: 0,
  },
  customGestures: [],
  adaptive: { skill: 35, smoothness: 50, aggression: 50, races: 0, bestLapMsByTrack: {} },
  camera: 'chase',
  lastTrack: 'city',
  opponents: 5,
  laps: 3,
  cvProcessScale: 1,
  seenOnboarding: false,
  playerCarColor: 0x00f0ff,
  gestureSetupDone: false,
  drivingGestures: { trained: false, classes: [], trainedAt: 0 },
};

const STORAGE_KEY = 'neondrift-gp.settings.v1';

function deepMerge<T>(base: T, patch: any): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return patch as T;
  const out: any = { ...base };
  for (const k of Object.keys(patch)) {
    const bv = (base as any)[k];
    out[k] = bv !== undefined && typeof bv === 'object' && !Array.isArray(bv) ? deepMerge(bv, patch[k]) : patch[k];
  }
  return out;
}

export class SettingsStore {
  data: GameSettings;
  private listeners = new Set<(s: GameSettings) => void>();
  private storage: Pick<Storage, 'getItem' | 'setItem'> | null;

  constructor(storage?: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.storage = storage === undefined ? (typeof localStorage !== 'undefined' ? localStorage : null) : storage;
    this.data = this.load();
  }

  private load(): GameSettings {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_SETTINGS);
      const parsed = JSON.parse(raw);
      return deepMerge(structuredClone(DEFAULT_SETTINGS), parsed);
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[Settings] persist failed:', err);
    }
    for (const fn of this.listeners) fn(this.data);
  }

  /** Apply a partial patch and persist. */
  update(patch: Partial<GameSettings> | ((s: GameSettings) => void)): void {
    if (typeof patch === 'function') patch(this.data);
    else this.data = deepMerge(this.data, patch);
    this.save();
  }

  onChange(fn: (s: GameSettings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  resetAll(): void {
    this.data = structuredClone(DEFAULT_SETTINGS);
    this.save();
  }
}
