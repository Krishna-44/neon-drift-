/**
 * Canonical vehicle input contract. Everything that can drive a car —
 * gestures, keyboard, AI, replays, (future) network players — produces this
 * exact struct, which is what makes the architecture input-agnostic.
 */
import type { HandPose } from '../vision/HandTypes';

export interface CarInputs {
  /** Steering -1 (full left) .. +1 (full right). */
  steer: number;
  /** Throttle 0..1 (applies to current gear direction). */
  throttle: number;
  /** Brake 0..1. */
  brake: number;
  /** Handbrake / drift flag. */
  handbrake: boolean;
  /** Nitro boost request. */
  nitro: boolean;
  /** Request reverse gear (engages below a speed threshold). */
  reverse: boolean;
}

export function neutralInputs(): CarInputs {
  return { steer: 0, throttle: 0, brake: 0, handbrake: false, nitro: false, reverse: false };
}

export interface GestureDiagnostics {
  leftPose: HandPose;
  rightPose: HandPose;
  leftConfidence: number;
  rightConfidence: number;
  wheelAngleDeg: number;
  wheelEngaged: boolean;
  handsVisible: number;
  coasting: boolean;
  customActive: string | null;
}

export interface ControlState extends CarInputs {
  source: 'gesture' | 'keyboard' | 'none';
  /** Open-palm pause hold progress 0..1 (UI ring). */
  pauseHoldProgress: number;
  /** True for exactly one update when the pause hold completes. */
  pauseFired: boolean;
  gesture: GestureDiagnostics;
}

export function neutralControlState(): ControlState {
  return {
    ...neutralInputs(),
    source: 'none',
    pauseHoldProgress: 0,
    pauseFired: false,
    gesture: {
      leftPose: 'none',
      rightPose: 'none',
      leftConfidence: 0,
      rightConfidence: 0,
      wheelAngleDeg: 0,
      wheelEngaged: false,
      handsVisible: 0,
      coasting: false,
      customActive: null,
    },
  };
}
