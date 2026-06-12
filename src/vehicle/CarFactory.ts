/**
 * Procedural neon racer meshes + the visual binding that maps physics state to
 * the scene graph (wheel spin/steer, body roll & squat, brake lights, nitro
 * glow, headlights). No external models.
 */
import * as THREE from 'three';
import { clamp, damp } from '../core/MathUtils';
import type { VehicleState } from '../physics/VehicleDynamics';

export interface CarHandles {
  group: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Object3D[];
  frontWheels: THREE.Object3D[];
  brakeLight: THREE.MeshBasicMaterial;
  underglow: THREE.MeshBasicMaterial;
  nitroFlame: THREE.Mesh;
  headlight: THREE.SpotLight | null;
  dispose: () => void;
}

export const CAR_COLORS = [0x00f0ff, 0xff2bd6, 0xffd166, 0x7a5cff, 0x3affd1, 0xff5e3a, 0xa0ff57, 0xff8ad8];

export function buildCar(accent: number, isPlayer: boolean): CarHandles {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(o: T): T => {
    disposables.push(o);
    return o;
  };

  const paint = keep(
    new THREE.MeshStandardMaterial({ color: 0x0d0d16, metalness: 0.75, roughness: 0.32 }),
  );
  const accentMat = keep(new THREE.MeshBasicMaterial({ color: accent }));
  const glass = keep(new THREE.MeshStandardMaterial({ color: 0x05060a, metalness: 0.9, roughness: 0.12 }));
  const tire = keep(new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.95 }));

  // hull
  const hull = new THREE.Mesh(keep(new THREE.BoxGeometry(1.84, 0.5, 4.3)), paint);
  hull.position.y = 0.5;
  body.add(hull);
  // nose wedge
  const nose = new THREE.Mesh(keep(new THREE.BoxGeometry(1.6, 0.3, 0.9)), paint);
  nose.position.set(0, 0.38, 2.3);
  body.add(nose);
  // cabin
  const cabin = new THREE.Mesh(keep(new THREE.BoxGeometry(1.42, 0.44, 1.9)), glass);
  cabin.position.set(0, 0.93, -0.25);
  body.add(cabin);
  // spoiler
  const spoiler = new THREE.Mesh(keep(new THREE.BoxGeometry(1.78, 0.07, 0.5)), paint);
  spoiler.position.set(0, 0.98, -2.05);
  body.add(spoiler);
  for (const sx of [-0.6, 0.6]) {
    const strut = new THREE.Mesh(keep(new THREE.BoxGeometry(0.08, 0.3, 0.12)), paint);
    strut.position.set(sx, 0.82, -2.0);
    body.add(strut);
  }

  // neon sills + light bars
  for (const sx of [-0.95, 0.95]) {
    const sill = new THREE.Mesh(keep(new THREE.BoxGeometry(0.06, 0.07, 3.6)), accentMat);
    sill.position.set(sx, 0.3, 0);
    body.add(sill);
  }
  const headBar = new THREE.Mesh(keep(new THREE.BoxGeometry(1.5, 0.09, 0.06)), keep(new THREE.MeshBasicMaterial({ color: 0xeaf6ff })));
  headBar.position.set(0, 0.55, 2.16);
  body.add(headBar);
  const brakeLight = keep(new THREE.MeshBasicMaterial({ color: 0x550008 }));
  const tailBar = new THREE.Mesh(keep(new THREE.BoxGeometry(1.6, 0.1, 0.06)), brakeLight);
  tailBar.position.set(0, 0.62, -2.16);
  body.add(tailBar);

  // underglow
  const underglow = keep(
    new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.33,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const glowPlane = new THREE.Mesh(keep(new THREE.PlaneGeometry(2.6, 4.8)), underglow);
  glowPlane.rotation.x = -Math.PI / 2;
  glowPlane.position.y = 0.05;
  body.add(glowPlane);

  // nitro flame (scaled by activity)
  const nitroFlame = new THREE.Mesh(
    keep(new THREE.ConeGeometry(0.22, 1.3, 8)),
    keep(new THREE.MeshBasicMaterial({ color: 0x66f6ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })),
  );
  nitroFlame.rotation.x = Math.PI / 2;
  nitroFlame.position.set(0, 0.42, -2.7);
  nitroFlame.scale.setScalar(0.001);
  body.add(nitroFlame);

  // wheels
  const wheelGeo = keep(new THREE.CylinderGeometry(0.35, 0.35, 0.28, 16));
  const rimMat = keep(new THREE.MeshBasicMaterial({ color: accent }));
  const rimGeo = keep(new THREE.CylinderGeometry(0.13, 0.13, 0.30, 10));
  const wheels: THREE.Object3D[] = [];
  const frontWheels: THREE.Object3D[] = [];
  const positions: Array<[number, number, boolean]> = [
    [-0.92, 1.35, true],
    [0.92, 1.35, true],
    [-0.92, -1.45, false],
    [0.92, -1.45, false],
  ];
  for (const [x, z, isFront] of positions) {
    const pivot = new THREE.Object3D();
    pivot.position.set(x, 0.35, z);
    const spin = new THREE.Object3D();
    const tyre = new THREE.Mesh(wheelGeo, tire);
    tyre.rotation.z = Math.PI / 2;
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.z = Math.PI / 2;
    spin.add(tyre, rim);
    pivot.add(spin);
    body.add(pivot);
    wheels.push(spin);
    if (isFront) frontWheels.push(pivot);
  }

  // player headlights
  let headlight: THREE.SpotLight | null = null;
  if (isPlayer) {
    headlight = new THREE.SpotLight(0xbfe6ff, 60, 60, 0.5, 0.5, 1.2);
    headlight.position.set(0, 0.8, 2.0);
    const target = new THREE.Object3D();
    target.position.set(0, 0, 24);
    body.add(target);
    headlight.target = target;
    body.add(headlight);
  }

  return {
    group,
    body,
    wheels,
    frontWheels,
    brakeLight,
    underglow,
    nitroFlame,
    headlight,
    dispose: () => {
      for (const d of disposables) d.dispose();
      group.clear();
    },
  };
}

/** Binds a VehicleDynamics state to a car mesh each render frame. */
export class CarVisual {
  private rollSmooth = 0;
  private pitchSmooth = 0;

  constructor(readonly handles: CarHandles) {}

  update(state: VehicleState, groundY: number, gradePitch: number, frameDt: number): void {
    const g = this.handles.group;
    g.position.set(state.x, groundY, state.z);
    g.rotation.y = state.heading;

    // body roll from lateral accel, squat/dive from longitudinal, plus slope.
    const latAccel = state.yawRate * state.vx;
    this.rollSmooth = damp(this.rollSmooth, clamp(latAccel * 0.014, -0.16, 0.16), 0.08, frameDt);
    this.pitchSmooth = damp(
      this.pitchSmooth,
      clamp(-state.accelSmoothed * 0.01, -0.09, 0.09) + gradePitch,
      0.1,
      frameDt,
    );
    this.handles.body.rotation.z = this.rollSmooth;
    this.handles.body.rotation.x = this.pitchSmooth;

    // wheels
    const spinDelta = (state.vx / 0.35) * frameDt;
    for (const w of this.handles.wheels) w.rotation.x += spinDelta;
    for (const fw of this.handles.frontWheels) fw.rotation.y = state.steerAngle * 0.9;

    // lights & glow
    this.handles.brakeLight.color.setHex(state.speedKmh > 1 && state.accelSmoothed < -2 ? 0xff2030 : 0x550008);
    const nitroScale = state.nitroActive ? 1 + Math.random() * 0.35 : 0.001;
    this.handles.nitroFlame.scale.set(nitroScale, nitroScale, nitroScale);
    (this.handles.underglow as THREE.MeshBasicMaterial).opacity = state.nitroActive ? 0.55 : 0.33;
  }
}
