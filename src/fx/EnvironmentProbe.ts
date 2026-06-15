/**
 * Procedural neon HDR environment probe.
 *
 * Builds a prefiltered (PMREM) environment map from a tiny scene — a vertical
 * sky gradient plus a ring of bright emissive "lightformer" panels in the
 * track's accent colours. Assigning the result to `scene.environment` gives
 * every metallic/clearcoat material crisp, coloured reflections — the single
 * biggest step from "flat 3D" to an expensive, showroom look. Built once per
 * track/showroom (cheap at runtime: reflections are just env lookups).
 */
import * as THREE from 'three';

export interface EnvProbe {
  texture: THREE.Texture;
  dispose(): void;
}

function gradientEquirect(top: number, bottom: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  const t = new THREE.Color(top);
  const b = new THREE.Color(bottom);
  grad.addColorStop(0, `#${t.getHexString()}`);
  grad.addColorStop(1, `#${b.getHexString()}`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * @param renderer  the live WebGLRenderer
 * @param accents   neon colours that become reflection streaks
 * @param skyTop / skyBottom  background gradient (the dominant ambient reflection)
 */
export function buildEnvironment(
  renderer: THREE.WebGLRenderer,
  accents: number[],
  skyTop: number,
  skyBottom: number,
): EnvProbe {
  const envScene = new THREE.Scene();
  const bg = gradientEquirect(skyTop, skyBottom);
  envScene.background = bg;

  const disposables: Array<{ dispose(): void }> = [bg];
  const panelGeo = new THREE.PlaneGeometry(1, 1);
  disposables.push(panelGeo);

  // Ring of bright emissive panels → coloured reflection highlights on bodywork.
  const ring = Math.max(accents.length, 4);
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2;
    const color = accents[i % accents.length];
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    disposables.push(mat);
    const panel = new THREE.Mesh(panelGeo, mat);
    const r = 8;
    panel.position.set(Math.cos(a) * r, 1.2 + (i % 2) * 2.5, Math.sin(a) * r);
    panel.scale.set(5, 3 + (i % 3), 1);
    panel.lookAt(0, 1.5, 0);
    envScene.add(panel);
  }
  // A cool overhead fill + a warm low kicker for body-roll highlights.
  const top = new THREE.Mesh(panelGeo, new THREE.MeshBasicMaterial({ color: 0x223044 }));
  disposables.push(top.material as THREE.Material);
  top.scale.set(20, 20, 1);
  top.position.set(0, 9, 0);
  top.lookAt(0, 0, 0);
  envScene.add(top);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  for (const d of disposables) d.dispose();

  return {
    texture: rt.texture,
    dispose: () => rt.dispose(),
  };
}
