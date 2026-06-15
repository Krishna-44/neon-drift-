/**
 * Post-processing: a custom threshold-bloom pipeline implemented directly on
 * top of WebGLRenderTargets (no postprocessing addon dependency, so the bundle
 * stays lean and the pass count is exactly what we need).
 *
 * Pipeline: scene → bright-pass → separable Gaussian (H+V, half-res) →
 * additive composite over the original. Falls back to a plain renderer.render
 * when bloom is disabled or the GPU is struggling (toggled by PerfGovernor).
 */
import * as THREE from 'three';

const BRIGHT_FS = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float threshold;
  uniform float knee;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tDiffuse, vUv);
    float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    float soft = clamp((l - threshold + knee) / (2.0 * knee), 0.0, 1.0);
    float contrib = max(soft, step(threshold, l));
    gl_FragColor = vec4(c.rgb * contrib, 1.0);
  }
`;

const BLUR_FS = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 direction;
  uniform vec2 resolution;
  varying vec2 vUv;
  void main() {
    vec2 px = direction / resolution;
    vec4 sum = texture2D(tDiffuse, vUv) * 0.227027;
    sum += texture2D(tDiffuse, vUv + px * 1.3846) * 0.316216;
    sum += texture2D(tDiffuse, vUv - px * 1.3846) * 0.316216;
    sum += texture2D(tDiffuse, vUv + px * 3.2308) * 0.070270;
    sum += texture2D(tDiffuse, vUv - px * 3.2308) * 0.070270;
    gl_FragColor = sum;
  }
`;

const COMPOSITE_FS = /* glsl */ `
  uniform sampler2D tBase;
  uniform sampler2D tBloom;
  uniform float intensity;
  uniform float time;
  uniform float aberration; // chromatic-aberration strength at the edges
  varying vec2 vUv;
  void main() {
    vec2 d = vUv - 0.5;
    float r2 = dot(d, d);
    // Chromatic aberration: split the channels radially, stronger toward edges.
    vec2 ca = d * r2 * aberration;
    vec3 base = vec3(
      texture2D(tBase, vUv + ca).r,
      texture2D(tBase, vUv).g,
      texture2D(tBase, vUv - ca).b
    );
    vec3 bloom = texture2D(tBloom, vUv).rgb;
    vec3 col = base + bloom * intensity;
    // Cyberpunk vignette.
    float vig = smoothstep(0.95, 0.30, r2 * 2.2);
    col *= mix(0.78, 1.0, vig);
    // Subtle animated film grain.
    float grain = fract(sin(dot(vUv * vec2(time * 0.7 + 12.9898, 78.233), vec2(1.0))) * 43758.5453);
    col += (grain - 0.5) * 0.035;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`;

export class PostFX {
  enabled = true;
  intensity = 1.15; // richer bloom for the neon look
  threshold = 0.58;
  aberration = 1.4; // chromatic-aberration strength
  private elapsed = 0;

  private sceneRT: THREE.WebGLRenderTarget;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private fsScene = new THREE.Scene();
  private fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;
  private width = 1;
  private height = 1;

  constructor(private renderer: THREE.WebGLRenderer) {
    const opts = { type: THREE.HalfFloatType, depthBuffer: true };
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.rtB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BRIGHT_FS,
      uniforms: { tDiffuse: { value: null }, threshold: { value: this.threshold }, knee: { value: 0.15 } },
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BLUR_FS,
      uniforms: { tDiffuse: { value: null }, direction: { value: new THREE.Vector2(1, 0) }, resolution: { value: new THREE.Vector2(1, 1) } },
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FS,
      uniforms: {
        tBase: { value: null },
        tBloom: { value: null },
        intensity: { value: this.intensity },
        time: { value: 0 },
        aberration: { value: this.aberration },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.brightMat);
    this.fsScene.add(this.quad);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    const dpr = this.renderer.getPixelRatio();
    const w = Math.floor(this.width * dpr);
    const h = Math.floor(this.height * dpr);
    this.sceneRT.setSize(w, h);
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    this.rtA.setSize(hw, hh);
    this.rtB.setSize(hw, hh);
    this.blurMat.uniforms.resolution.value.set(hw, hh);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }
    // 1. scene → sceneRT
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.clear();
    this.renderer.render(scene, camera);

    // 2. bright pass → rtA (half res)
    this.brightMat.uniforms.tDiffuse.value = this.sceneRT.texture;
    this.brightMat.uniforms.threshold.value = this.threshold;
    this.blit(this.brightMat, this.rtA);

    // 3. separable blur rtA → rtB (H) → rtA (V), twice for a wider kernel
    for (let i = 0; i < 2; i++) {
      this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
      this.blurMat.uniforms.direction.value.set(1, 0);
      this.blit(this.blurMat, this.rtB);
      this.blurMat.uniforms.tDiffuse.value = this.rtB.texture;
      this.blurMat.uniforms.direction.value.set(0, 1);
      this.blit(this.blurMat, this.rtA);
    }

    // 4. composite → screen
    this.elapsed += 1 / 60;
    this.compositeMat.uniforms.tBase.value = this.sceneRT.texture;
    this.compositeMat.uniforms.tBloom.value = this.rtA.texture;
    this.compositeMat.uniforms.intensity.value = this.intensity;
    this.compositeMat.uniforms.aberration.value = this.aberration;
    this.compositeMat.uniforms.time.value = this.elapsed;
    this.quad.material = this.compositeMat;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.fsScene, this.fsCamera);
  }

  private blit(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(this.fsScene, this.fsCamera);
  }

  dispose(): void {
    this.sceneRT.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.quad.geometry.dispose();
  }
}
