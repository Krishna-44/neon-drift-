/**
 * Procedural track + environment construction (three.js layer).
 * Everything is generated — road ribbon, neon edges, walls, embankment skirts,
 * start gantry, themed skies/fog/lighting and instanced props. No asset files.
 */
import * as THREE from 'three';
import { TrackSpline } from './Spline';
import type { ThemeId, TrackDef } from './TrackData';
import { seededRandom } from '../core/MathUtils';

export interface ThemeConfig {
  skyTop: number;
  skyBottom: number;
  fogColor: number;
  fogDensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  dirColor: number;
  dirIntensity: number;
  dirPos: [number, number, number];
  groundColor: number;
  roadTint: number;
  edgeColor: number;
  edgeColor2: number;
  stars: boolean;
}

export const THEMES: Record<ThemeId, ThemeConfig> = {
  city: {
    skyTop: 0x05060f, skyBottom: 0x1a0b2e, fogColor: 0x0c0a1e, fogDensity: 0.0042,
    hemiSky: 0x3a3a6a, hemiGround: 0x10101e, hemiIntensity: 0.55,
    dirColor: 0x8899ff, dirIntensity: 0.5, dirPos: [120, 180, 80],
    groundColor: 0x07070e, roadTint: 0x2a2a33, edgeColor: 0x00f0ff, edgeColor2: 0xff2bd6,
    stars: true,
  },
  desert: {
    skyTop: 0x2c1e4d, skyBottom: 0xff7e47, fogColor: 0xc26a3d, fogDensity: 0.0028,
    hemiSky: 0xffd9b0, hemiGround: 0x6a3f2a, hemiIntensity: 0.85,
    dirColor: 0xffd2a0, dirIntensity: 1.25, dirPos: [-200, 120, 60],
    groundColor: 0xb97f4e, roadTint: 0x3a3127, edgeColor: 0xffb648, edgeColor2: 0xff5e3a,
    stars: false,
  },
  highway: {
    skyTop: 0x020208, skyBottom: 0x101a3a, fogColor: 0x060a18, fogDensity: 0.0036,
    hemiSky: 0x2a3a6a, hemiGround: 0x0a0a14, hemiIntensity: 0.5,
    dirColor: 0xaabbff, dirIntensity: 0.4, dirPos: [80, 220, -120],
    groundColor: 0x05060c, roadTint: 0x23232c, edgeColor: 0x7a5cff, edgeColor2: 0x00f0ff,
    stars: true,
  },
  mountain: {
    skyTop: 0x1a1033, skyBottom: 0xb35a8f, fogColor: 0x4a2a52, fogDensity: 0.0048,
    hemiSky: 0xcc88bb, hemiGround: 0x1a2a1e, hemiIntensity: 0.7,
    dirColor: 0xffb0d8, dirIntensity: 0.8, dirPos: [-100, 150, 140],
    groundColor: 0x16241c, roadTint: 0x2e2c31, edgeColor: 0xff7eb6, edgeColor2: 0xb14aed,
    stars: true,
  },
};

// ----------------------------------------------------------- canvas textures

/**
 * Asphalt material maps. Texture space: x = along the track (u), y = across (v).
 * Returns a colour map plus a shared bump/roughness map for realistic light
 * response (multi-octave aggregate, tyre-wear bands, edge lines, centre dashes).
 */
function asphaltTextures(tint: number, edge: number): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const col = new THREE.Color(tint);
  g.fillStyle = `rgb(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0})`;
  g.fillRect(0, 0, S, S);

  // coarse aggregate (two octaves of speckle)
  for (let i = 0; i < 9000; i++) {
    const v = 14 + Math.random() * 42;
    g.fillStyle = `rgba(${v},${v},${v + 7},${0.18 + Math.random() * 0.35})`;
    const s = Math.random() < 0.85 ? 1.4 : 2.8;
    g.fillRect(Math.random() * S, Math.random() * S, s, s);
  }
  // patch repairs / tar lines (sparse darker streaks along the road)
  for (let i = 0; i < 7; i++) {
    g.strokeStyle = `rgba(8,8,12,${0.18 + Math.random() * 0.2})`;
    g.lineWidth = 1.5 + Math.random() * 2.5;
    const y0 = Math.random() * S;
    g.beginPath();
    g.moveTo(0, y0);
    g.bezierCurveTo(S * 0.3, y0 + (Math.random() - 0.5) * 40, S * 0.7, y0 + (Math.random() - 0.5) * 40, S, y0);
    g.stroke();
  }
  // tyre-wear bands: darker polished strips where wheels run (~30 % / 70 % across)
  for (const band of [0.3, 0.7]) {
    const grad = g.createLinearGradient(0, S * band - 34, 0, S * band + 34);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, 'rgba(5,5,8,0.34)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, S * band - 34, S, 68);
  }
  // solid edge lines (worn white)
  g.fillStyle = 'rgba(225,228,235,0.5)';
  g.fillRect(0, S * 0.035, S, 5);
  g.fillRect(0, S * 0.965 - 5, S, 5);
  // centre dashes run ALONG the track (x axis), neon accent
  const e = new THREE.Color(edge);
  g.fillStyle = `rgba(${(e.r * 255) | 0},${(e.g * 255) | 0},${(e.b * 255) | 0},0.75)`;
  g.shadowColor = `#${e.getHexString()}`;
  g.shadowBlur = 6;
  for (let x = 0; x < S; x += 128) g.fillRect(x, S / 2 - 3, 68, 6);
  g.shadowBlur = 0;

  const map = new THREE.CanvasTexture(c);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;
  map.colorSpace = THREE.SRGBColorSpace;

  // bump/roughness: greyscale aggregate (lighter = rougher/raised)
  const b = document.createElement('canvas');
  b.width = b.height = 256;
  const bg = b.getContext('2d')!;
  bg.fillStyle = '#808080';
  bg.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 6000; i++) {
    const v = 90 + Math.random() * 110;
    bg.fillStyle = `rgba(${v},${v},${v},0.5)`;
    bg.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
  }
  const bump = new THREE.CanvasTexture(b);
  bump.wrapS = THREE.RepeatWrapping;
  bump.wrapT = THREE.RepeatWrapping;

  return { map, bump };
}

function windowsTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#05050a';
  g.fillRect(0, 0, 64, 128);
  const palette = ['#00f0ff', '#ff2bd6', '#ffd166', '#9b5cff', '#3affd1'];
  for (let y = 4; y < 124; y += 8) {
    for (let x = 4; x < 60; x += 8) {
      if (Math.random() < 0.42) {
        g.fillStyle = palette[(Math.random() * palette.length) | 0];
        g.globalAlpha = 0.45 + Math.random() * 0.55;
        g.fillRect(x, y, 4, 5);
      }
    }
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function textPlane(text: string, color: string, w = 18, h = 3): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000000';
  g.fillRect(0, 0, 512, 96);
  g.font = 'bold 64px Arial';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 24;
  g.fillStyle = color;
  g.fillText(text, 256, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: false, side: THREE.DoubleSide }),
  );
  return mesh;
}

// ----------------------------------------------------------------- builder

export interface BuiltTrack {
  group: THREE.Group;
  theme: ThemeConfig;
  dispose: () => void;
}

export function buildTrack(spline: TrackSpline, def: TrackDef, quality: 'low' | 'medium' | 'high'): BuiltTrack {
  const theme = THEMES[def.themeId];
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(o: T): T => {
    disposables.push(o);
    return o;
  };

  const samples = spline.samples;
  const n = samples.length;
  const halfW = def.halfWidth;

  const rightOf = (i: number) => ({ x: samples[i].tanZ, z: -samples[i].tanX });

  // ------------------------------------------------------------ road ribbon
  {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const r = rightOf(i);
      pos.push(s.x - r.x * halfW, s.y + 0.02, s.z - r.z * halfW);
      pos.push(s.x + r.x * halfW, s.y + 0.02, s.z + r.z * halfW);
      const u = s.s / 9;
      uv.push(u, 0, u, 1);
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      const b = ((i + 1) % n) * 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const maps = asphaltTextures(theme.roadTint, theme.edgeColor);
    const mat = track(
      new THREE.MeshStandardMaterial({
        map: track(maps.map),
        bumpMap: track(maps.bump),
        bumpScale: 0.6,
        roughnessMap: maps.bump,
        roughness: 0.95,
        metalness: 0.08,
      }),
    ) as THREE.MeshStandardMaterial;
    group.add(new THREE.Mesh(geo, mat));
  }

  // ------------------------------------------------- neon edges + embankment
  const stripGeoms: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1] as const) {
    const pos: number[] = [];
    const idx: number[] = [];
    const skirtPos: number[] = [];
    const skirtIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const r = rightOf(i);
      const ex = s.x + r.x * halfW * side;
      const ez = s.z + r.z * halfW * side;
      const ox = s.x + r.x * (halfW + 0.45) * side;
      const oz = s.z + r.z * (halfW + 0.45) * side;
      pos.push(ex, s.y + 0.06, ez, ox, s.y + 0.06, oz);
      // skirt: from outer edge down to ground 0
      skirtPos.push(ox, s.y + 0.05, oz, ox, -0.2, oz);
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      const b = ((i + 1) % n) * 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
      skirtIdx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    stripGeoms.push(geo as THREE.BufferGeometry);
    const mat = track(
      new THREE.MeshBasicMaterial({ color: side === 1 ? theme.edgeColor : theme.edgeColor2, side: THREE.DoubleSide }),
    ) as THREE.MeshBasicMaterial;
    group.add(new THREE.Mesh(geo as THREE.BufferGeometry, mat));

    const sgeo = track(new THREE.BufferGeometry());
    sgeo.setAttribute('position', new THREE.Float32BufferAttribute(skirtPos, 3));
    sgeo.setIndex(skirtIdx);
    sgeo.computeVertexNormals();
    const smat = track(
      new THREE.MeshStandardMaterial({ color: 0x0a0a12, roughness: 1, side: THREE.DoubleSide }),
    ) as THREE.MeshStandardMaterial;
    group.add(new THREE.Mesh(sgeo as THREE.BufferGeometry, smat));
  }

  // ------------------------------------------------------------------ walls
  if (def.walls) {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    let vi = 0;
    for (const side of [-1, 1] as const) {
      const base = vi;
      for (let i = 0; i < n; i++) {
        const s = samples[i];
        const r = rightOf(i);
        const wx = s.x + r.x * (halfW + 0.5) * side;
        const wz = s.z + r.z * (halfW + 0.5) * side;
        pos.push(wx, s.y, wz, wx, s.y + 1.3, wz);
        const u = s.s / 6;
        uv.push(u, 0, u, 1);
        vi += 2;
      }
      for (let i = 0; i < n; i++) {
        const a = base + i * 2;
        const b = base + ((i + 1) % n) * 2;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = track(
      new THREE.MeshStandardMaterial({
        color: 0x14141f,
        roughness: 0.6,
        metalness: 0.4,
        emissive: new THREE.Color(theme.edgeColor),
        emissiveIntensity: 0.08,
        side: THREE.DoubleSide,
      }),
    ) as THREE.MeshStandardMaterial;
    group.add(new THREE.Mesh(geo, mat));
  }

  // ------------------------------------------------------------------ ground
  {
    const geo = track(new THREE.CircleGeometry(900, 48));
    const mat = track(
      new THREE.MeshStandardMaterial({ color: theme.groundColor, roughness: 1, metalness: 0 }),
    ) as THREE.MeshStandardMaterial;
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.22;
    // centre the disc on the track bounding box
    const bb = trackBounds(spline);
    ground.position.x = bb.cx;
    ground.position.z = bb.cz;
    group.add(ground);
  }

  // -------------------------------------------------------------------- sky
  {
    const geo = track(new THREE.SphereGeometry(1500, 24, 12));
    const mat = track(
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: new THREE.Color(theme.skyTop) },
          bottom: { value: new THREE.Color(theme.skyBottom) },
        },
        vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vPos;
          void main(){ float h = clamp(normalize(vPos).y * 1.6 + 0.35, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }`,
      }),
    ) as THREE.ShaderMaterial;
    const sky = new THREE.Mesh(geo, mat);
    sky.frustumCulled = false;
    group.add(sky);

    if (theme.stars) {
      const starGeo = track(new THREE.BufferGeometry());
      const starPos: number[] = [];
      const rng = seededRandom(def.propSeed * 7);
      for (let i = 0; i < 700; i++) {
        const a = rng() * Math.PI * 2;
        const e = rng() * Math.PI * 0.45 + 0.08;
        const rr = 1380;
        starPos.push(Math.cos(a) * Math.cos(e) * rr, Math.sin(e) * rr, Math.sin(a) * Math.cos(e) * rr);
      }
      starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
      const starMat = track(
        new THREE.PointsMaterial({ color: 0xcfe8ff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.85 }),
      ) as THREE.PointsMaterial;
      const stars = new THREE.Points(starGeo, starMat);
      stars.frustumCulled = false;
      group.add(stars);
    }
  }

  // ------------------------------------------------------------ start gantry
  {
    const start = spline.posAt(0);
    const r0 = rightOf(0);
    const pole = track(new THREE.BoxGeometry(0.5, 6.5, 0.5));
    const poleMat = track(new THREE.MeshStandardMaterial({ color: 0x10101a, metalness: 0.6, roughness: 0.4 })) as THREE.MeshStandardMaterial;
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(pole, poleMat);
      m.position.set(start.x + r0.x * (halfW + 1.2) * side, start.y + 3.25, start.z + r0.z * (halfW + 1.2) * side);
      group.add(m);
    }
    const beam = new THREE.Mesh(
      track(new THREE.BoxGeometry(halfW * 2 + 3.4, 0.7, 0.7)),
      track(new THREE.MeshBasicMaterial({ color: theme.edgeColor })) as THREE.MeshBasicMaterial,
    );
    beam.position.set(start.x, start.y + 6.2, start.z);
    beam.rotation.y = Math.atan2(r0.x, r0.z) + Math.PI / 2;
    group.add(beam);
    const sign = textPlane(def.name, '#' + new THREE.Color(theme.edgeColor).getHexString(), halfW * 1.8, 1.9);
    sign.position.set(start.x, start.y + 5.1, start.z);
    sign.rotation.y = Math.atan2(r0.x, r0.z) + Math.PI / 2;
    group.add(sign);
    track((sign.material as THREE.MeshBasicMaterial).map!);
    track(sign.material as THREE.Material);
    track(sign.geometry);
  }

  // -------------------------------------------------------------- theme props
  addProps(group, spline, def, theme, quality, track);

  return {
    group,
    theme,
    dispose: () => {
      for (const d of disposables) d.dispose();
      group.clear();
    },
  };
}

function trackBounds(spline: TrackSpline) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of spline.samples) {
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z);
  }
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

function addProps(
  group: THREE.Group,
  spline: TrackSpline,
  def: TrackDef,
  theme: ThemeConfig,
  quality: 'low' | 'medium' | 'high',
  track: <T extends { dispose(): void }>(o: T) => T,
): void {
  const rng = seededRandom(def.propSeed);
  const qMul = quality === 'low' ? 0.45 : quality === 'medium' ? 0.8 : 1;
  const L = spline.length;

  /** Random point at lateral offset range from the track. */
  const scatter = (minT: number, maxT: number) => {
    const s = rng() * L;
    const t = (minT + rng() * (maxT - minT)) * (rng() < 0.5 ? -1 : 1);
    const c = spline.posAt(s);
    const tan = spline.tangentAt(s);
    return { x: c.x + tan.z * t, z: c.z - tan.x * t, s, t };
  };

  const dummy = new THREE.Object3D();

  if (def.themeId === 'city') {
    const count = Math.round(150 * qMul);
    const geo = track(new THREE.BoxGeometry(1, 1, 1));
    const mat = track(
      new THREE.MeshStandardMaterial({
        color: 0x090911,
        roughness: 0.7,
        metalness: 0.25,
        emissive: 0xffffff,
        emissiveIntensity: 0.85,
        emissiveMap: track(windowsTexture()) as THREE.CanvasTexture,
      }),
    ) as THREE.MeshStandardMaterial;
    const inst = new THREE.InstancedMesh(geo, mat, count);
    for (let i = 0; i < count; i++) {
      const p = scatter(def.halfWidth + 14, def.halfWidth + 110);
      const w = 8 + rng() * 18;
      const h = 14 + rng() * 58;
      dummy.position.set(p.x, h / 2 - 0.2, p.z);
      dummy.scale.set(w, h, 8 + rng() * 18);
      dummy.rotation.y = rng() * Math.PI;
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  } else if (def.themeId === 'desert') {
    const rocks = Math.round(110 * qMul);
    const geo = track(new THREE.DodecahedronGeometry(1, 0));
    const mat = track(new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 1 })) as THREE.MeshStandardMaterial;
    const inst = new THREE.InstancedMesh(geo, mat, rocks);
    for (let i = 0; i < rocks; i++) {
      const p = scatter(def.halfWidth + def.runoffWidth + 4, def.halfWidth + 130);
      const s = 0.8 + rng() * 3.4;
      dummy.position.set(p.x, s * 0.35, p.z);
      dummy.scale.set(s, s * (0.5 + rng() * 0.6), s);
      dummy.rotation.set(rng(), rng() * Math.PI, rng());
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);

    const cacti = Math.round(50 * qMul);
    const cgeo = track(new THREE.CylinderGeometry(0.35, 0.45, 1, 7));
    const cmat = track(new THREE.MeshStandardMaterial({ color: 0x2e6b3a, roughness: 0.9 })) as THREE.MeshStandardMaterial;
    const cinst = new THREE.InstancedMesh(cgeo, cmat, cacti);
    for (let i = 0; i < cacti; i++) {
      const p = scatter(def.halfWidth + def.runoffWidth + 3, def.halfWidth + 90);
      const h = 2.2 + rng() * 2.6;
      dummy.position.set(p.x, h / 2, p.z);
      dummy.scale.set(1, h, 1);
      dummy.rotation.set(0, rng() * Math.PI, 0);
      dummy.updateMatrix();
      cinst.setMatrixAt(i, dummy.matrix);
    }
    cinst.instanceMatrix.needsUpdate = true;
    group.add(cinst);
  } else if (def.themeId === 'highway') {
    // Light poles along both edges + emissive heads.
    const every = quality === 'low' ? 70 : 45;
    const count = Math.floor(L / every) * 2;
    const poleGeo = track(new THREE.CylinderGeometry(0.09, 0.12, 7, 6));
    const poleMat = track(new THREE.MeshStandardMaterial({ color: 0x1a1a26, roughness: 0.5, metalness: 0.6 })) as THREE.MeshStandardMaterial;
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, count);
    const headGeo = track(new THREE.SphereGeometry(0.32, 8, 6));
    const headMat = track(new THREE.MeshBasicMaterial({ color: 0xbfd4ff })) as THREE.MeshBasicMaterial;
    const heads = new THREE.InstancedMesh(headGeo, headMat, count);
    let i = 0;
    for (let s = 0; s < L && i < count; s += every) {
      for (const side of [-1, 1]) {
        if (i >= count) break;
        const c = spline.posAt(s);
        const tan = spline.tangentAt(s);
        const x = c.x + tan.z * (def.halfWidth + 2.2) * side;
        const z = c.z - tan.x * (def.halfWidth + 2.2) * side;
        dummy.position.set(x, c.y + 3.5, z);
        dummy.scale.set(1, 1, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        poles.setMatrixAt(i, dummy.matrix);
        dummy.position.set(x, c.y + 7, z);
        dummy.updateMatrix();
        heads.setMatrixAt(i, dummy.matrix);
        i++;
      }
    }
    poles.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    group.add(poles, heads);

    // Distant skyline: ring of dark emissive-window slabs.
    const slabCount = Math.round(60 * qMul);
    const slabGeo = track(new THREE.BoxGeometry(1, 1, 1));
    const slabMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x05050c,
        emissive: 0xffffff,
        emissiveIntensity: 0.5,
        emissiveMap: track(windowsTexture()) as THREE.CanvasTexture,
        roughness: 0.8,
      }),
    ) as THREE.MeshStandardMaterial;
    const slabs = new THREE.InstancedMesh(slabGeo, slabMat, slabCount);
    for (let k = 0; k < slabCount; k++) {
      const p = scatter(def.halfWidth + 60, def.halfWidth + 240);
      const w = 14 + rng() * 26;
      const h = 20 + rng() * 80;
      dummy.position.set(p.x, h / 2, p.z);
      dummy.scale.set(w, h, 12 + rng() * 22);
      dummy.rotation.y = rng() * Math.PI;
      dummy.updateMatrix();
      slabs.setMatrixAt(k, dummy.matrix);
    }
    slabs.instanceMatrix.needsUpdate = true;
    group.add(slabs);
  } else if (def.themeId === 'mountain') {
    const pines = Math.round(260 * qMul);
    const geo = track(new THREE.ConeGeometry(1, 1, 7));
    const mat = track(new THREE.MeshStandardMaterial({ color: 0x12351f, roughness: 1 })) as THREE.MeshStandardMaterial;
    const inst = new THREE.InstancedMesh(geo, mat, pines);
    const sakuraGeo = track(new THREE.ConeGeometry(1, 1, 7));
    const sakuraMat = track(
      new THREE.MeshStandardMaterial({ color: 0xd96aa8, roughness: 0.9, emissive: 0xff7eb6, emissiveIntensity: 0.18 }),
    ) as THREE.MeshStandardMaterial;
    const sakCount = Math.round(60 * qMul);
    const sak = new THREE.InstancedMesh(sakuraGeo, sakuraMat, sakCount);
    for (let i = 0; i < pines; i++) {
      const p = scatter(def.halfWidth + def.runoffWidth + 3, def.halfWidth + 120);
      const proj = spline.project(p.x, p.z, p.s);
      const baseY = spline.heightAt(proj.s) * Math.max(0, 1 - (Math.abs(proj.t) - def.halfWidth) / 60);
      const h = 5 + rng() * 7;
      dummy.position.set(p.x, baseY + h / 2, p.z);
      dummy.scale.set(1.6 + rng() * 1.4, h, 1.6 + rng() * 1.4);
      dummy.rotation.set(0, rng(), 0);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    for (let i = 0; i < sakCount; i++) {
      const p = scatter(def.halfWidth + def.runoffWidth + 2, def.halfWidth + 26);
      const proj = spline.project(p.x, p.z, p.s);
      const baseY = spline.heightAt(proj.s) * Math.max(0, 1 - (Math.abs(proj.t) - def.halfWidth) / 60);
      const h = 4 + rng() * 4;
      dummy.position.set(p.x, baseY + h / 2, p.z);
      dummy.scale.set(2 + rng(), h, 2 + rng());
      dummy.rotation.set(0, rng(), 0);
      dummy.updateMatrix();
      sak.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    sak.instanceMatrix.needsUpdate = true;
    group.add(inst, sak);
  }
}

/** Scene-level lighting + fog for a theme (applied by the session). */
export function applyEnvironment(scene: THREE.Scene, theme: ThemeConfig): { dispose: () => void } {
  const fog = new THREE.FogExp2(theme.fogColor, theme.fogDensity);
  scene.fog = fog;
  const hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, theme.hemiIntensity);
  const dir = new THREE.DirectionalLight(theme.dirColor, theme.dirIntensity);
  dir.position.set(...theme.dirPos);
  const amb = new THREE.AmbientLight(0xffffff, 0.16);
  scene.add(hemi, dir, amb);
  return {
    dispose: () => {
      scene.remove(hemi, dir, amb);
      scene.fog = null;
    },
  };
}
