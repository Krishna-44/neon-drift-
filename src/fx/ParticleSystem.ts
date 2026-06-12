/**
 * GPU-instanced particle pools for drift smoke, nitro trails, sparks and
 * speed streaks. One pre-allocated pool per kind (no per-frame allocation,
 * no GC churn) updated on the CPU and uploaded via instanced attributes.
 */
import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils';

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  size: number;
  active: boolean;
}

abstract class ParticlePool {
  protected particles: Particle[] = [];
  protected mesh: THREE.InstancedMesh;
  protected dummy = new THREE.Object3D();
  protected cursor = 0;
  protected color = new THREE.Color();

  constructor(
    protected scene: THREE.Scene,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    readonly capacity: number,
  ) {
    for (let i = 0; i < capacity; i++) {
      this.particles.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 1, active: false });
    }
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    // hide all initially
    for (let i = 0; i < capacity; i++) {
      this.dummy.position.set(0, -9999, 0);
      this.dummy.scale.setScalar(0.0001);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  protected acquire(): Particle {
    const p = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % this.capacity;
    return p;
  }

  abstract step(p: Particle, dt: number): void;
  abstract appearance(p: Particle): { scale: number; r: number; g: number; b: number };

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this.dummy.position.set(0, -9999, 0);
        this.dummy.scale.setScalar(0.0001);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      this.step(p, dt);
      const a = this.appearance(p);
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.scale.setScalar(a.scale);
      this.dummy.rotation.set(0, 0, p.life * 2);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.color.setRGB(a.r, a.g, a.b);
      this.mesh.setColorAt(i, this.color);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

class SmokePool extends ParticlePool {
  constructor(scene: THREE.Scene, capacity = 220) {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    super(scene, new THREE.PlaneGeometry(1, 1), mat, capacity);
  }
  emit(x: number, y: number, z: number, intensity: number, tint: THREE.Color): void {
    const p = this.acquire();
    p.active = true;
    p.x = x + (Math.random() - 0.5) * 0.5;
    p.y = y + 0.1;
    p.z = z + (Math.random() - 0.5) * 0.5;
    p.vx = (Math.random() - 0.5) * 1.2;
    p.vy = 0.6 + Math.random() * 0.8;
    p.vz = (Math.random() - 0.5) * 1.2;
    p.maxLife = p.life = 0.7 + intensity * 0.7;
    p.size = 0.8 + intensity * 1.4;
    (p as any).r = tint.r;
    (p as any).g = tint.g;
    (p as any).b = tint.b;
  }
  step(p: Particle, dt: number): void {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    p.vy *= 1 - dt * 0.5;
    p.vx *= 1 - dt;
    p.vz *= 1 - dt;
  }
  appearance(p: Particle) {
    const k = p.life / p.maxLife;
    const grey = 0.55 + (1 - k) * 0.25;
    return {
      scale: p.size * (1.4 - k),
      r: ((p as any).r ?? grey) * 0.6 + grey * 0.4,
      g: ((p as any).g ?? grey) * 0.6 + grey * 0.4,
      b: ((p as any).b ?? grey) * 0.6 + grey * 0.4,
    };
  }
}

class SparkPool extends ParticlePool {
  constructor(scene: THREE.Scene, capacity = 160) {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    super(scene, new THREE.SphereGeometry(0.06, 4, 4), mat, capacity);
  }
  emit(x: number, y: number, z: number, count: number, color: THREE.Color): void {
    for (let i = 0; i < count; i++) {
      const p = this.acquire();
      p.active = true;
      p.x = x;
      p.y = y;
      p.z = z;
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 7;
      p.vx = Math.cos(a) * sp;
      p.vy = 1 + Math.random() * 5;
      p.vz = Math.sin(a) * sp;
      p.maxLife = p.life = 0.3 + Math.random() * 0.4;
      p.size = 1;
      (p as any).r = color.r;
      (p as any).g = color.g;
      (p as any).b = color.b;
    }
  }
  step(p: Particle, dt: number): void {
    p.vy -= 14 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    if (p.y < 0.05) {
      p.y = 0.05;
      p.vy = Math.abs(p.vy) * 0.3;
    }
  }
  appearance(p: Particle) {
    const k = clamp01(p.life / p.maxLife);
    return { scale: 0.5 + k, r: (p as any).r, g: (p as any).g, b: (p as any).b };
  }
}

class NitroPool extends ParticlePool {
  constructor(scene: THREE.Scene, capacity = 140) {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    super(scene, new THREE.SphereGeometry(0.12, 6, 6), mat, capacity);
  }
  emit(x: number, y: number, z: number, dirX: number, dirZ: number): void {
    const p = this.acquire();
    p.active = true;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = -dirX * (6 + Math.random() * 4) + (Math.random() - 0.5) * 2;
    p.vy = (Math.random() - 0.3) * 1.5;
    p.vz = -dirZ * (6 + Math.random() * 4) + (Math.random() - 0.5) * 2;
    p.maxLife = p.life = 0.25 + Math.random() * 0.3;
    p.size = 1;
  }
  step(p: Particle, dt: number): void {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
  }
  appearance(p: Particle) {
    const k = clamp01(p.life / p.maxLife);
    // blue → cyan → white core
    return { scale: 0.6 + k * 1.6, r: 0.4 + (1 - k) * 0.6, g: 0.8 + (1 - k) * 0.2, b: 1 };
  }
}

/** Facade managing all pools; the session calls the high-level emitters. */
export class ParticleManager {
  private smoke: SmokePool;
  private sparks: SparkPool;
  private nitro: NitroPool;
  private enabled = true;
  private smokeAccum = 0;

  constructor(scene: THREE.Scene, quality: 'low' | 'medium' | 'high') {
    const mul = quality === 'low' ? 0.4 : quality === 'medium' ? 0.75 : 1;
    this.smoke = new SmokePool(scene, Math.round(220 * mul));
    this.sparks = new SparkPool(scene, Math.round(160 * mul));
    this.nitro = new NitroPool(scene, Math.round(140 * mul));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.smoke.setVisible(on);
    this.sparks.setVisible(on);
    this.nitro.setVisible(on);
  }

  /** Rear-wheel contact points → continuous emitters, rate-limited by frame dt. */
  driftSmoke(rearX: number, rearZ: number, intensity: number, tint: THREE.Color, dt: number): void {
    if (!this.enabled || intensity < 0.15) return;
    this.smokeAccum += intensity * dt * 60;
    while (this.smokeAccum >= 1) {
      this.smokeAccum -= 1;
      this.smoke.emit(rearX, 0.1, rearZ, intensity, tint);
    }
  }

  nitroTrail(x: number, y: number, z: number, dirX: number, dirZ: number): void {
    if (!this.enabled) return;
    this.nitro.emit(x, y, z, dirX, dirZ);
    this.nitro.emit(x, y, z, dirX, dirZ);
  }

  impactSparks(x: number, y: number, z: number, intensity: number, color: THREE.Color): void {
    if (!this.enabled) return;
    this.sparks.emit(x, y, z, Math.round(4 + intensity * 12), color);
  }

  update(dt: number): void {
    this.smoke.update(dt);
    this.sparks.update(dt);
    this.nitro.update(dt);
  }

  dispose(): void {
    this.smoke.dispose();
    this.sparks.dispose();
    this.nitro.dispose();
  }
}
