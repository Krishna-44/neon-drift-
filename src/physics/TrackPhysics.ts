/**
 * Track-aware physics services: surface sampling (grip/drag/slope by track
 * position) and boundary collision resolution against walls or runoff limits.
 */
import { clamp } from '../core/MathUtils';
import { TrackSpline } from '../track/Spline';
import type { TrackDef } from '../track/TrackData';
import type { SurfaceSample, VehicleDynamics } from './VehicleDynamics';

export interface TrackSampleInfo {
  s: number;
  t: number;
  onTrack: boolean;
  surface: SurfaceSample;
}

export interface WallHit {
  impulse: number; // m/s of velocity killed into the wall
  side: 1 | -1;
}

const CAR_HALF_WIDTH = 1.0;

export class TrackPhysics {
  constructor(
    readonly spline: TrackSpline,
    readonly def: TrackDef,
  ) {}

  /** Sample surface info at a world position (hintS = car's last known s). */
  sample(x: number, z: number, heading: number, hintS?: number): TrackSampleInfo {
    const proj = this.spline.project(x, z, hintS);
    const onTrack = Math.abs(proj.t) <= this.def.halfWidth;
    // Slope along the CAR's forward direction = track grade × alignment.
    const grade = this.spline.gradeSinAt(proj.s);
    const tan = this.spline.tangentAt(proj.s);
    const fwdX = Math.sin(heading);
    const fwdZ = Math.cos(heading);
    const alignment = fwdX * tan.x + fwdZ * tan.z;
    const surface: SurfaceSample = onTrack
      ? { grip: 1, drag: 1, gradeSin: grade * alignment }
      : {
          grip: this.def.offTrack.grip,
          drag: this.def.offTrack.drag,
          gradeSin: grade * alignment,
        };
    return { s: proj.s, t: proj.t, onTrack, surface };
  }

  /**
   * Enforce track boundaries. Mutates the car state (position clamp + velocity
   * reflection) and returns hit info for audio/FX/score, or null.
   */
  resolveBounds(dyn: VehicleDynamics, info: TrackSampleInfo): WallHit | null {
    const limit = this.def.walls
      ? this.def.halfWidth - CAR_HALF_WIDTH * 0.5
      : this.def.halfWidth + this.def.runoffWidth;
    const t = info.t;
    if (Math.abs(t) <= limit) return null;

    const s = dyn.state;
    const side: 1 | -1 = t > 0 ? 1 : -1;
    const tan = this.spline.tangentAt(info.s);
    const center = this.spline.posAt(info.s);
    const rightX = tan.z;
    const rightZ = -tan.x;

    // Clamp position back to the boundary.
    const clampedT = side * limit;
    s.x = center.x + rightX * clampedT;
    s.z = center.z + rightZ * clampedT;

    // World velocity → kill the outward component (with restitution).
    const sinH = Math.sin(s.heading);
    const cosH = Math.cos(s.heading);
    let wvx = s.vx * sinH + s.vy * cosH;
    let wvz = s.vx * cosH - s.vy * sinH;
    const outward = wvx * rightX * side + wvz * rightZ * side;
    let impulse = 0;
    if (outward > 0) {
      impulse = outward;
      const restitution = 0.25;
      wvx -= (1 + restitution) * outward * rightX * side;
      wvz -= (1 + restitution) * outward * rightZ * side;
      // Wall friction scrubs forward speed.
      wvx *= 0.94;
      wvz *= 0.94;
      // Back to body frame.
      s.vx = wvx * sinH + wvz * cosH;
      s.vy = wvx * cosH - wvz * sinH;
      // Glancing yaw disturbance.
      s.yawRate += -side * clamp(impulse * 0.06, 0, 0.8);
      dyn.lastCollisionImpulse = impulse;
    }
    return impulse > 0.5 ? { impulse, side } : null;
  }
}

/**
 * Car-vs-car circle collisions with impulse exchange. O(n²) over ≤8 cars.
 * Returns pairs that collided this step (for audio).
 */
export function resolveCarContacts(cars: VehicleDynamics[]): Array<[number, number, number]> {
  const RADIUS = 1.45;
  const hits: Array<[number, number, number]> = [];
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i].state;
      const b = cars[j].state;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const dist = Math.hypot(dx, dz);
      const minDist = RADIUS * 2;
      if (dist >= minDist || dist < 1e-4) continue;

      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = minDist - dist;
      // Positional separation (half each).
      a.x -= nx * overlap * 0.5;
      a.z -= nz * overlap * 0.5;
      b.x += nx * overlap * 0.5;
      b.z += nz * overlap * 0.5;

      // World velocities.
      const av = bodyToWorld(a.vx, a.vy, a.heading);
      const bv = bodyToWorld(b.vx, b.vy, b.heading);
      const relN = (bv.x - av.x) * nx + (bv.z - av.z) * nz;
      if (relN < 0) {
        const restitution = 0.3;
        const jImp = (-(1 + restitution) * relN) / 2; // equal masses
        av.x -= jImp * nx;
        av.z -= jImp * nz;
        bv.x += jImp * nx;
        bv.z += jImp * nz;
        worldToBody(a, av.x, av.z);
        worldToBody(b, bv.x, bv.z);
        // Small yaw disturbances make contact feel physical.
        a.yawRate += clamp(jImp * 0.04, -0.5, 0.5) * (nx * Math.cos(a.heading) - nz * Math.sin(a.heading) > 0 ? 1 : -1);
        b.yawRate += clamp(jImp * 0.04, -0.5, 0.5) * (nx * Math.cos(b.heading) - nz * Math.sin(b.heading) > 0 ? -1 : 1);
        cars[i].lastCollisionImpulse = Math.max(cars[i].lastCollisionImpulse, Math.abs(jImp));
        cars[j].lastCollisionImpulse = Math.max(cars[j].lastCollisionImpulse, Math.abs(jImp));
        hits.push([i, j, Math.abs(jImp)]);
      }
    }
  }
  return hits;
}

function bodyToWorld(vx: number, vy: number, heading: number): { x: number; z: number } {
  const sinH = Math.sin(heading);
  const cosH = Math.cos(heading);
  return { x: vx * sinH + vy * cosH, z: vx * cosH - vy * sinH };
}

function worldToBody(state: { vx: number; vy: number; heading: number }, wx: number, wz: number): void {
  const sinH = Math.sin(state.heading);
  const cosH = Math.cos(state.heading);
  state.vx = wx * sinH + wz * cosH;
  state.vy = wx * cosH - wz * sinH;
}
