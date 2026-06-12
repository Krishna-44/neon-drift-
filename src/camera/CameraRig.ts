/**
 * Camera system: chase / cockpit / cinematic (trackside replay) modes with
 * critically-damped follow, speed-reactive FOV, nitro kick and impact shake.
 */
import * as THREE from 'three';
import { clamp01, damp } from '../core/MathUtils';
import { TrackSpline } from '../track/Spline';
import type { VehicleState } from '../physics/VehicleDynamics';

export type CameraMode = 'chase' | 'cockpit' | 'cinematic';

const BASE_FOV = 66;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  private pos = new THREE.Vector3(0, 5, -10);
  private lookTarget = new THREE.Vector3();
  private fov = BASE_FOV;
  private shake = 0;
  private tripods: THREE.Vector3[] = [];
  private activeTripod = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, aspect, 0.3, 2600);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Precompute trackside tripod positions for cinematic mode. */
  buildTripods(spline: TrackSpline, halfWidth: number): void {
    this.tripods = [];
    const count = 14;
    for (let i = 0; i < count; i++) {
      const s = (i / count) * spline.length;
      const c = spline.posAt(s);
      const tan = spline.tangentAt(s);
      const side = i % 2 === 0 ? 1 : -1;
      const d = halfWidth + 7 + (i % 3) * 4;
      this.tripods.push(new THREE.Vector3(c.x + tan.z * d * side, c.y + 4.5 + (i % 3) * 2.2, c.z - tan.x * d * side));
    }
  }

  addImpact(intensity: number): void {
    this.shake = Math.min(this.shake + intensity * 0.25, 1.4);
  }

  snapBehind(state: VehicleState, groundY: number): void {
    const sinH = Math.sin(state.heading);
    const cosH = Math.cos(state.heading);
    this.pos.set(state.x - sinH * 7, groundY + 3, state.z - cosH * 7);
    this.fov = BASE_FOV;
  }

  update(state: VehicleState, groundY: number, frameDt: number): void {
    const sinH = Math.sin(state.heading);
    const cosH = Math.cos(state.heading);
    const speed01 = clamp01(state.speedKmh / 220);

    if (this.mode === 'chase') {
      const dist = 6.4 + speed01 * 1.8;
      const height = 2.6 + speed01 * 0.5;
      const targetX = state.x - sinH * dist;
      const targetZ = state.z - cosH * dist;
      const targetY = groundY + height;
      // faster horizontal follow than vertical → floaty-but-tight feel
      this.pos.x = damp(this.pos.x, targetX, 0.055, frameDt);
      this.pos.z = damp(this.pos.z, targetZ, 0.055, frameDt);
      this.pos.y = damp(this.pos.y, targetY, 0.11, frameDt);
      this.lookTarget.set(state.x + sinH * 5.5, groundY + 1.1, state.z + cosH * 5.5);
    } else if (this.mode === 'cockpit') {
      const lateral = state.steerAngle * 0.35;
      this.pos.set(
        state.x + cosH * lateral + sinH * 0.45,
        groundY + 1.12,
        state.z - sinH * lateral + cosH * 0.45,
      );
      this.lookTarget.set(state.x + sinH * 14, groundY + 0.9, state.z + cosH * 14);
    } else {
      // cinematic: nearest tripod with hysteresis (switch when car runs away)
      if (this.tripods.length > 0) {
        const carPos = new THREE.Vector3(state.x, groundY, state.z);
        const current = this.tripods[this.activeTripod];
        if (current.distanceTo(carPos) > 95) {
          let best = 0;
          let bestD = Infinity;
          this.tripods.forEach((t, i) => {
            const d = t.distanceTo(carPos);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          });
          this.activeTripod = best;
        }
        this.pos.copy(this.tripods[this.activeTripod]);
        this.lookTarget.set(state.x, groundY + 0.9, state.z);
      }
    }

    // FOV: speed widening + nitro punch.
    const targetFov = BASE_FOV + speed01 * 13 + (state.nitroActive ? 8 : 0);
    this.fov = damp(this.fov, targetFov, 0.12, frameDt);

    // impact shake decay
    this.shake = Math.max(0, this.shake - frameDt * 2.6);
    const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 0.5 : 0;
    const shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 0.35 : 0;

    this.camera.position.set(this.pos.x + shakeX, this.pos.y + shakeY, this.pos.z);
    this.camera.lookAt(this.lookTarget);
    if (Math.abs(this.camera.fov - this.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  cycleMode(): CameraMode {
    this.mode = this.mode === 'chase' ? 'cockpit' : 'chase';
    return this.mode;
  }
}
