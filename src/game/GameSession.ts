/**
 * GameSession — the race orchestrator.
 *
 * Owns the three.js renderer/scene/post-FX, the player + AI vehicles (all on
 * the SAME VehicleDynamics), the track (spline + collision + mesh), race
 * director, camera rig, audio, particles, the performance governor, and the
 * telemetry/replay stream. Exposes a fixed-step `simulate()` for deterministic
 * physics and a `renderFrame()` for interpolated drawing, matching GameLoop.
 *
 * It is input-agnostic: the App writes `playerInput` each step (from gestures,
 * keyboard, or a replay) and the session never reaches back for it.
 */
import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import { clamp, clamp01 } from '../core/MathUtils';
import { Profiler } from '../core/Profiler';
import { PerfGovernor } from '../core/PerfGovernor';
import { CarInputs, neutralInputs } from '../input/ControlState';
import { VehicleDynamics, FLAT_SURFACE } from '../physics/VehicleDynamics';
import { TrackPhysics, resolveCarContacts } from '../physics/TrackPhysics';
import { TrackSpline } from '../track/Spline';
import { trackById, TrackDef } from '../track/TrackData';
import { buildTrack, applyEnvironment, BuiltTrack, ThemeConfig } from '../track/TrackBuilder';
import { buildCar, CarVisual, CAR_COLORS } from '../vehicle/CarFactory';
import { AIDriver, AI_PRESETS, AIDifficulty, AIPeer } from '../ai/AIDriver';
import { RaceDirector, RacerProgress } from '../ai/RaceDirector';
import { CameraRig, CameraMode } from '../camera/CameraRig';
import { AudioEngine } from '../audio/AudioEngine';
import { ParticleManager } from '../fx/ParticleSystem';
import { PostFX } from '../fx/PostFX';
import { buildEnvironment, EnvProbe } from '../fx/EnvironmentProbe';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CarTelemetry, ReplayBuffer, TelemetryFrame } from './Telemetry';
import type { GameSettings } from '../core/Settings';

export interface RaceConfig {
  trackId: string;
  opponents: number;
  laps: number;
  difficulty: AIDifficulty;
}

export interface SessionEvents extends Record<string, unknown> {
  countdown: { value: number | 'GO' };
  raceStart: {};
  lap: { racer: RacerProgress; lapMs: number; isBest: boolean };
  finish: { racer: RacerProgress };
  raceComplete: { standings: RacerProgress[] };
  wrongWay: { wrong: boolean };
  collision: { intensity: number };
  telemetry: { frame: TelemetryFrame };
  nitroStart: {};
}

interface Car {
  id: string;
  isPlayer: boolean;
  dyn: VehicleDynamics;
  visual: CarVisual;
  driver: AIDriver | null;
  lastS: number;
  lastT: number;
  color: number;
  prevNitro: boolean;
}

const COUNTDOWN_SECONDS = 3;

export class GameSession {
  readonly events = new EventBus<SessionEvents>();
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: CameraRig;
  readonly profiler = new Profiler();
  readonly perf: PerfGovernor;

  private postfx: PostFX;
  private particles: ParticleManager;
  private builtTrack: BuiltTrack | null = null;
  private environment: { dispose: () => void } | null = null;
  private theme: ThemeConfig | null = null;
  private spline: TrackSpline | null = null;
  private trackPhysics: TrackPhysics | null = null;
  private trackDef: TrackDef | null = null;

  private cars: Car[] = [];
  private player: Car | null = null;
  private director: RaceDirector | null = null;
  readonly replay = new ReplayBuffer();

  playerInput: CarInputs = neutralInputs();
  private phase: 'idle' | 'countdown' | 'racing' | 'finished' = 'idle';
  private countdownTimer = 0;
  private lastCountdownInt = COUNTDOWN_SECONDS + 1;
  private accentColor = new THREE.Color(0x00f0ff);
  private envProbe: EnvProbe | null = null;
  private hdriEnv: THREE.Texture | null = null;
  private hdriRT: THREE.WebGLRenderTarget | null = null;

  /**
   * Apply a reflection environment scene-wide. Prefers a real HDRI (downloaded
   * to public/hdri/env.hdr) once it has loaded; falls back to the procedural
   * neon probe so reflections work even with no asset present.
   */
  private setEnvironment(accents: number[], skyTop: number, skyBottom: number): void {
    if (this.hdriEnv) {
      this.scene.environment = this.hdriEnv;
      return;
    }
    this.envProbe?.dispose();
    this.envProbe = buildEnvironment(this.renderer, accents, skyTop, skyBottom);
    this.scene.environment = this.envProbe.texture;
  }

  private carModel: THREE.Object3D | null = null;

  /** Optional player car model: drop a car.glb in public/models/ and it's used. */
  private async loadCarModel(): Promise<void> {
    try {
      const base = new URL(import.meta.env.BASE_URL, document.baseURI).href;
      const url = new URL('models/car.glb', base).href;
      const head = await fetch(url, { method: 'HEAD' });
      // Dev servers answer missing files with index.html, so check the type too.
      if (!head.ok || head.headers.get('content-type')?.includes('text/html')) return;
      const gltf = await new GLTFLoader().loadAsync(url);
      this.carModel = gltf.scene;
    } catch {
      /* no/invalid model → procedural car */
    }
  }

  /** Load the optional HDRI (RGBE → PMREM). Once ready it takes over reflections. */
  private async loadHdriEnvironment(): Promise<void> {
    try {
      const base = new URL(import.meta.env.BASE_URL, document.baseURI).href;
      const url = new URL('hdri/env.hdr', base).href;
      // Validate before parsing: a missing file comes back as index.html from
      // dev/static servers, and the parser throws outside the promise on junk.
      const res = await fetch(url);
      if (!res.ok) return;
      const buf = await res.arrayBuffer();
      const magic = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(2, buf.byteLength)));
      if (magic !== '#?') return;
      const blobUrl = URL.createObjectURL(new Blob([buf]));
      let tex: THREE.DataTexture;
      try {
        tex = await new HDRLoader().loadAsync(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      tex.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      pmrem.compileEquirectangularShader();
      this.hdriRT = pmrem.fromEquirectangular(tex);
      pmrem.dispose();
      tex.dispose();
      this.hdriEnv = this.hdriRT.texture;
      this.scene.environment = this.hdriEnv; // upgrade reflections in place
    } catch {
      /* no HDRI present → keep the procedural environment */
    }
  }

  constructor(
    canvas: HTMLCanvasElement,
    private settings: GameSettings,
    private audio: AudioEngine,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setClearColor(0x05060f, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.55; // brighter — cars/track were too dark

    this.camera = new CameraRig(canvas.clientWidth / Math.max(canvas.clientHeight, 1));
    this.camera.mode = settings.camera === 'cockpit' ? 'cockpit' : 'chase';

    this.postfx = new PostFX(this.renderer);
    this.postfx.enabled = settings.graphics.bloom;
    this.particles = new ParticleManager(this.scene, settings.graphics.quality);
    this.particles.setEnabled(settings.graphics.particles);

    this.perf = new PerfGovernor(
      {
        setPixelRatio: (r) => this.renderer.setPixelRatio(r),
        setBloom: (on) => (this.postfx.enabled = on && this.settings.graphics.bloom),
        setParticles: (on) => this.particles.setEnabled(on && this.settings.graphics.particles),
      },
      this.profiler,
      settings.graphics.quality,
    );

    this.resize(canvas.clientWidth, canvas.clientHeight);
    void this.loadHdriEnvironment(); // upgrades reflections once the HDRI loads
    void this.loadCarModel(); // uses public/models/car.glb if present
  }

  get racePhase() {
    return this.phase;
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.postfx.setSize(width, height);
    this.camera.setAspect(width / Math.max(height, 1));
  }

  // ----------------------------------------------------------- race setup

  loadRace(config: RaceConfig): void {
    this.disposeShowroom();
    this.teardownRace();
    const def = trackById(config.trackId);
    this.trackDef = def;
    this.spline = new TrackSpline(def.controlPoints, def.heightFn);
    this.trackPhysics = new TrackPhysics(this.spline, def);
    this.accentColor.set(def.accentColor);

    this.builtTrack = buildTrack(this.spline, def, this.settings.graphics.quality);
    this.scene.add(this.builtTrack.group);
    this.theme = this.builtTrack.theme;
    this.environment = applyEnvironment(this.scene, this.theme);
    // Neon HDR reflections tinted to the track (wet roads + glossy car paint).
    this.setEnvironment([this.theme.edgeColor, this.theme.edgeColor2, 0xffffff, this.theme.hemiSky], this.theme.skyTop, this.theme.skyBottom);
    this.camera.buildTripods(this.spline, def.halfWidth);

    // grid: cars staggered behind the start line, alternating sides.
    const fieldSize = config.opponents + 1;
    const startTan = this.spline.tangentAt(0);
    const startHeading = Math.atan2(startTan.x, startTan.z);

    this.director = new RaceDirector(this.spline, config.laps, {
      onLap: (r, lapMs, isBest) => {
        this.events.emit('lap', { racer: r, lapMs, isBest });
        if (r.isPlayer) this.audio.checkpoint();
      },
      onFinish: (r) => {
        this.events.emit('finish', { racer: r });
        if (this.director!.allFinished || (r.isPlayer && this.allHumansDone())) {
          this.phase = 'finished';
          this.events.emit('raceComplete', { standings: this.director!.standings });
        }
      },
      onWrongWay: (r, wrong) => {
        if (r.isPlayer) this.events.emit('wrongWay', { wrong });
      },
    });

    for (let i = 0; i < fieldSize; i++) {
      const isPlayer = i === 0;
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      const backS = this.spline.wrap(-6 - row * 7);
      const startPos = this.spline.posAt(backS);
      const tan = this.spline.tangentAt(backS);
      const rightX = tan.z;
      const rightZ = -tan.x;
      const lateral = side * def.halfWidth * 0.4;
      const px = startPos.x + rightX * lateral;
      const pz = startPos.z + rightZ * lateral;

      const dyn = new VehicleDynamics(undefined, {
        stability: isPlayer ? this.settings.control.stabilityAssist : true,
        counterSteer: isPlayer ? this.settings.control.counterSteerAssist : true,
      });
      dyn.teleport(px, pz, Math.atan2(tan.x, tan.z));

      let color = isPlayer ? this.settings.playerCarColor : CAR_COLORS[(i + 2) % CAR_COLORS.length];
      if (!isPlayer && color === this.settings.playerCarColor) color = CAR_COLORS[(i + 3) % CAR_COLORS.length];
      const handles = buildCar(color, isPlayer, isPlayer ? this.carModel ?? undefined : undefined);
      this.scene.add(handles.group);
      const visual = new CarVisual(handles);

      const driver = isPlayer
        ? null
        : new AIDriver(this.spline, def.halfWidth, AI_PRESETS[config.difficulty], (i * 0.137) % 1);

      const car: Car = { id: isPlayer ? 'player' : `ai${i}`, isPlayer, dyn, visual, driver, lastS: backS, lastT: lateral, color, prevNitro: false };
      this.cars.push(car);
      if (isPlayer) this.player = car;
      this.director.addRacer(car.id, isPlayer, backS);
    }

    this.replay.reset();
    this.phase = 'idle';
    void startHeading;
    // initial camera placement
    if (this.player) this.camera.snapBehind(this.player.dyn.state, this.groundYFor(this.player));
  }

  beginCountdown(): void {
    if (!this.director) return;
    this.phase = 'countdown';
    this.countdownTimer = COUNTDOWN_SECONDS;
    this.lastCountdownInt = COUNTDOWN_SECONDS + 1;
  }

  private allHumansDone(): boolean {
    return this.cars.filter((c) => c.isPlayer).every((c) => this.director!.racers.get(c.id)?.finished);
  }

  // ----------------------------------------------------------- simulation

  /** Fixed-step physics. Returns the race phase for the caller. */
  simulate(dt: number): void {
    const physStart = performance.now();
    if (this.phase === 'countdown') {
      this.countdownTimer -= dt;
      const intVal = Math.ceil(this.countdownTimer);
      if (intVal !== this.lastCountdownInt && intVal >= 0) {
        this.lastCountdownInt = intVal;
        if (intVal > 0) {
          this.events.emit('countdown', { value: intVal });
          this.audio.countdownBeep(false);
        }
      }
      if (this.countdownTimer <= 0) {
        this.phase = 'racing';
        this.director!.start();
        this.events.emit('countdown', { value: 'GO' });
        this.events.emit('raceStart', {});
        this.audio.countdownBeep(true);
        this.camera.triggerLaunch(); // standing-start FOV punch + shake
      }
    }

    const racing = this.phase === 'racing' || this.phase === 'finished';
    const raceTime = this.director ? this.director.raceTimeMs / 1000 : 0;

    // Build AI peer list once (cheap; ≤8 cars).
    const peers: Record<string, AIPeer> = {};
    for (const c of this.cars) peers[c.id] = { s: c.lastS, t: c.lastT, speed: c.dyn.state.vx };

    for (const car of this.cars) {
      let inputs: CarInputs;
      if (car.isPlayer) {
        inputs = racing ? this.playerInput : neutralInputs();
      } else if (car.driver && this.spline) {
        const others = this.cars.filter((o) => o !== car).map((o) => peers[o.id]);
        const playerGapS = this.player ? signedGap(this.spline, this.player.lastS, car.lastS) : 0;
        inputs = car.driver.update(dt, car.dyn.state, car.lastS, car.lastT, others, playerGapS, racing ? raceTime : -1);
      } else {
        inputs = neutralInputs();
      }

      const surface = this.trackPhysics
        ? this.trackPhysics.sample(car.dyn.state.x, car.dyn.state.z, car.dyn.state.heading, car.lastS).surface
        : FLAT_SURFACE;
      car.dyn.step(inputs, surface, dt);

      // nitro start event (player only) for audio whoosh
      if (car.isPlayer) {
        if (car.dyn.state.nitroActive && !car.prevNitro) {
          this.audio.nitroWhoosh();
          this.events.emit('nitroStart', {});
        }
        car.prevNitro = car.dyn.state.nitroActive;
      }
    }

    // collisions
    if (this.cars.length > 1) {
      const hits = resolveCarContacts(this.cars.map((c) => c.dyn));
      for (const [i, j, imp] of hits) {
        if (this.cars[i].isPlayer || this.cars[j].isPlayer) {
          this.events.emit('collision', { intensity: clamp01(imp / 10) });
        }
      }
    }

    // track bounds + progress
    for (const car of this.cars) {
      if (this.trackPhysics) {
        const info = this.trackPhysics.sample(car.dyn.state.x, car.dyn.state.z, car.dyn.state.heading, car.lastS);
        const hit = this.trackPhysics.resolveBounds(car.dyn, info);
        car.lastS = info.s;
        car.lastT = info.t;
        if (hit && car.isPlayer) {
          this.events.emit('collision', { intensity: clamp01(hit.impulse / 14) });
        }
        if (racing) this.director!.updateRacer(car.id, info.s, dt);
      }
    }

    if (this.director && racing) this.director.tick(dt * 1000);

    // telemetry + replay
    if (this.director) {
      const frame = this.buildTelemetry();
      this.replay.record(frame, dt);
      this.events.emit('telemetry', { frame });
    }

    this.profiler.markPhysics(performance.now() - physStart);
  }

  private buildTelemetry(): TelemetryFrame {
    const cars: CarTelemetry[] = this.cars.map((c) => {
      const s = c.dyn.state;
      const prog = this.director!.racers.get(c.id);
      return {
        id: c.id,
        isPlayer: c.isPlayer,
        x: s.x,
        z: s.z,
        y: this.groundYFor(c),
        heading: s.heading,
        speedKmh: s.speedKmh,
        rpm: s.rpm,
        gear: s.gearIndex,
        nitro: s.nitroTank,
        nitroActive: s.nitroActive,
        drifting: s.drifting,
        skid: s.skidIntensity,
        steerAngle: s.steerAngle,
        accel: s.accelSmoothed,
        position: prog?.position ?? 1,
        lap: prog?.lap ?? 1,
      };
    });
    return { t: this.director!.raceTimeMs, cars };
  }

  // ----------------------------------------------------------- rendering

  renderFrame(frameDt: number): void {
    this.profiler.frameStart();

    const groundY = this.player ? this.groundYFor(this.player) : 0;
    for (const car of this.cars) {
      const gp = this.gradePitchFor(car);
      car.visual.update(car.dyn.state, this.groundYFor(car), gp, frameDt);
      this.spawnCarFx(car, frameDt);
    }

    if (this.player) {
      this.camera.update(this.player.dyn.state, groundY, frameDt);
      this.updateAudio(frameDt);
    }
    this.particles.update(frameDt);
    this.perf.update(frameDt);

    this.postfx.intensity = 0.9;
    this.postfx.render(this.scene, this.camera.camera);
  }

  /** Drive the scene from a replay frame instead of live physics. */
  renderReplayFrame(frame: TelemetryFrame, frameDt: number): void {
    this.profiler.frameStart();
    for (const car of this.cars) {
      const tc = frame.cars.find((c) => c.id === car.id);
      if (!tc) continue;
      // splat telemetry back onto the dynamics state for the visual binder
      const s = car.dyn.state;
      s.x = tc.x;
      s.z = tc.z;
      s.heading = tc.heading;
      s.speedKmh = tc.speedKmh;
      s.steerAngle = tc.steerAngle;
      s.nitroActive = tc.nitroActive;
      s.skidIntensity = tc.skid;
      s.accelSmoothed = tc.accel;
      car.visual.update(s, tc.y, 0, frameDt);
      this.spawnCarFx(car, frameDt);
    }
    if (this.player) {
      const pc = frame.cars.find((c) => c.isPlayer);
      if (pc) this.camera.update(this.player.dyn.state, pc.y, frameDt);
    }
    this.particles.update(frameDt);
    this.postfx.render(this.scene, this.camera.camera);
  }

  private spawnCarFx(car: Car, frameDt: number): void {
    const s = car.dyn.state;
    const sinH = Math.sin(s.heading);
    const cosH = Math.cos(s.heading);
    // rear axle world point (≈1.45 m behind CG)
    const rx = s.x - sinH * 1.45;
    const rz = s.z - cosH * 1.45;
    if (s.skidIntensity > 0.2 && s.speedKmh > 8) {
      const tint = car.isPlayer ? this.accentColor : new THREE.Color(car.color);
      this.particles.driftSmoke(rx, rz, s.skidIntensity, tint, frameDt);
    }
    if (s.nitroActive) {
      this.particles.nitroTrail(rx, this.groundYFor(car) + 0.45, rz, sinH, cosH);
    }
    if (car.dyn.lastCollisionImpulse > 1) {
      this.particles.impactSparks(s.x, this.groundYFor(car) + 0.4, s.z, clamp01(car.dyn.lastCollisionImpulse / 8), new THREE.Color(0xffd166));
    }
  }

  private updateAudio(frameDt: number): void {
    if (!this.player) return;
    this.audio.updatePlayer(this.player.dyn.state, this.playerInput.throttle);
    // opponents spatialised relative to player heading
    const p = this.player.dyn.state;
    const sinH = Math.sin(p.heading);
    const cosH = Math.cos(p.heading);
    for (const car of this.cars) {
      if (car.isPlayer) continue;
      const dx = car.dyn.state.x - p.x;
      const dz = car.dyn.state.z - p.z;
      const dist = Math.hypot(dx, dz);
      // right vector dot → stereo pan
      const pan = clamp((dx * cosH - dz * sinH) / Math.max(dist, 1), -1, 1);
      this.audio.updateOpponent(car.id, car.dyn.state, pan, dist);
    }
    void frameDt;
  }

  // ----------------------------------------------------------- helpers

  private groundYFor(car: Car): number {
    if (!this.spline) return 0;
    return this.spline.heightAt(car.lastS);
  }

  private gradePitchFor(car: Car): number {
    if (!this.spline) return 0;
    const grade = this.spline.gradeSinAt(car.lastS);
    const tan = this.spline.tangentAt(car.lastS);
    const fwdX = Math.sin(car.dyn.state.heading);
    const fwdZ = Math.cos(car.dyn.state.heading);
    const alignment = fwdX * tan.x + fwdZ * tan.z;
    return -Math.asin(clamp(grade * alignment, -0.3, 0.3));
  }

  setCameraMode(mode: CameraMode): void {
    this.camera.mode = mode;
  }

  getStandings(): RacerProgress[] {
    return this.director?.standings ?? [];
  }

  getPlayerProgress(): RacerProgress | undefined {
    return this.director?.playerProgress();
  }

  getPlayerState() {
    return this.player?.dyn.state ?? null;
  }

  getTrackDef(): TrackDef | null {
    return this.trackDef;
  }

  getSpline(): TrackSpline | null {
    return this.spline;
  }

  getCarPositions(): { id: string; isPlayer: boolean; s: number; color: number }[] {
    return this.cars.map((c) => ({ id: c.id, isPlayer: c.isPlayer, s: c.lastS, color: c.color }));
  }

  /** World x/z of every car (minimap blips). */
  getCarWorldPositions(): { id: string; isPlayer: boolean; x: number; z: number; color: number }[] {
    return this.cars.map((c) => ({ id: c.id, isPlayer: c.isPlayer, x: c.dyn.state.x, z: c.dyn.state.z, color: c.color }));
  }

  getRaceTimeMs(): number {
    return this.director?.raceTimeMs ?? 0;
  }

  // ------------------------------------------------------- menu garage

  private showroom: {
    group: THREE.Group;
    carHolder: THREE.Group;
    car: ReturnType<typeof buildCar>;
    ringMat: THREE.MeshBasicMaterial;
    ring2Mat: THREE.MeshBasicMaterial;
    keyLight: THREE.PointLight;
    gridCanvas: HTMLCanvasElement;
    disposables: Array<{ dispose(): void }>;
  } | null = null;
  private showroomAngle = 0;
  private carColorIndex = 0;
  /** Spin animation progress when swapping cars (radians of extra spin remaining). */
  private swapSpin = 0;
  private swapPending: number | null = null;
  private targetRing = new THREE.Color(0x00f0ff);

  /** Cycle the garage car. dir = +1 next, -1 prev. Persists the choice. */
  cycleShowroomCar(dir: number): number {
    const n = CAR_COLORS.length;
    this.carColorIndex = (this.carColorIndex + dir + n) % n;
    this.swapPending = CAR_COLORS[this.carColorIndex];
    this.swapSpin = Math.PI; // half-turn spin while the new car swaps in
    return CAR_COLORS[this.carColorIndex];
  }

  get showroomColor(): number {
    return CAR_COLORS[this.carColorIndex];
  }

  private syncCarColorIndex(): void {
    const want = this.settings.playerCarColor;
    const idx = CAR_COLORS.indexOf(want);
    this.carColorIndex = idx >= 0 ? idx : 0;
  }

  private buildShowroom(): void {
    this.syncCarColorIndex();
    const group = new THREE.Group();
    const disposables: Array<{ dispose(): void }> = [];
    const keep = <T extends { dispose(): void }>(o: T): T => {
      disposables.push(o);
      return o;
    };

    // neon grid floor
    const gridCanvas = document.createElement('canvas');
    gridCanvas.width = gridCanvas.height = 256;
    const g = gridCanvas.getContext('2d')!;
    g.fillStyle = '#04060d';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(0,240,255,0.55)';
    g.lineWidth = 2;
    g.strokeRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(0,240,255,0.16)';
    for (let i = 32; i < 256; i += 32) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
    }
    const gridTex = keep(new THREE.CanvasTexture(gridCanvas));
    gridTex.wrapS = THREE.RepeatWrapping;
    gridTex.wrapT = THREE.RepeatWrapping;
    gridTex.repeat.set(30, 30);
    const floor = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(220, 220)),
      keep(new THREE.MeshStandardMaterial({ map: gridTex, roughness: 0.4, metalness: 0.7, emissive: 0x07242a, emissiveIntensity: 0.7 })),
    );
    floor.rotation.x = -Math.PI / 2;
    group.add(floor);

    const accent = CAR_COLORS[this.carColorIndex];

    // glowing podium rings under the car (inner lerps to the selected car colour)
    const ringMat = keep(new THREE.MeshBasicMaterial({ color: accent }));
    const ring = new THREE.Mesh(keep(new THREE.TorusGeometry(3.6, 0.07, 10, 64)), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.04;
    group.add(ring);
    const ring2Mat = keep(new THREE.MeshBasicMaterial({ color: 0xff2bd6 }));
    const ring2 = new THREE.Mesh(keep(new THREE.TorusGeometry(4.3, 0.04, 8, 64)), ring2Mat);
    ring2.rotation.x = Math.PI / 2;
    ring2.position.y = 0.04;
    group.add(ring2);

    // showcase car on a turntable holder (so we can spin it on swap)
    const carHolder = new THREE.Group();
    const car = buildCar(accent, false, this.carModel ?? undefined);
    carHolder.add(car.group);
    group.add(carHolder);

    // dramatic two-tone lighting (tracked via keep() so disposeShowroom frees them)
    const hemi = keep(new THREE.HemisphereLight(0x3a5a8a, 0x0a0a14, 0.8));
    const keyLight = keep(new THREE.PointLight(accent, 220, 60, 1.8));
    keyLight.position.set(6, 7, 6);
    const fill = keep(new THREE.PointLight(0xff2bd6, 160, 60, 1.8));
    fill.position.set(-7, 5, -5);
    group.add(hemi, keyLight, fill);

    this.scene.fog = new THREE.FogExp2(0x04060d, 0.018);
    this.scene.add(group);
    this.targetRing.set(accent);
    // Neon showroom reflections (cyan/magenta) so the hero car gleams.
    this.setEnvironment([0x00f0ff, 0xff2bd6, 0xffffff, 0x7a5cff], 0x05060f, 0x1a0b2e);
    this.showroom = { group, carHolder, car, ringMat, ring2Mat, keyLight, gridCanvas, disposables };
  }

  private disposeShowroom(): void {
    if (!this.showroom) return;
    this.scene.remove(this.showroom.group);
    for (const d of this.showroom.disposables) d.dispose();
    this.showroom.car.dispose();
    // CanvasTexture.dispose() keeps the backing <canvas>; shrink it to free the
    // bitmap so menu↔race cycles don't accumulate detached 256² canvases.
    this.showroom.gridCanvas.width = this.showroom.gridCanvas.height = 0;
    this.scene.fog = null;
    this.showroom = null;
  }

  /** Live 3D garage backdrop while in menus: orbiting hero car on a podium that
   *  swaps colour with a spin when the player flicks through the carousel. */
  renderMenuBackdrop(frameDt = 1 / 60): void {
    if (this.builtTrack) this.teardownRace(); // back at the menu: free the race world
    if (!this.showroom) this.buildShowroom();
    const sr = this.showroom!;

    // mid-spin car swap: when the holder is "edge-on" (~90°), replace the model.
    if (this.swapSpin > 0) {
      this.swapSpin = Math.max(0, this.swapSpin - frameDt * 7);
      if (this.swapPending !== null && this.swapSpin <= Math.PI / 2) {
        const accent = this.swapPending;
        this.swapPending = null;
        sr.car.dispose();
        sr.carHolder.remove(sr.car.group);
        sr.car = buildCar(accent, false, this.carModel ?? undefined);
        sr.carHolder.add(sr.car.group);
        this.targetRing.set(accent);
        // settings.playerCarColor is persisted by the App on cycle; mutate the
        // shared data object here so loadRace() picks up the latest choice too.
        this.settings.playerCarColor = accent;
      }
    }
    sr.carHolder.rotation.y = this.showroomAngle + (this.swapSpin > 0 ? this.swapSpin : 0);

    // ring + key-light colour ease toward the selected car
    sr.ringMat.color.lerp(this.targetRing, 1 - Math.pow(0.5, frameDt / 0.12));
    sr.keyLight.color.lerp(this.targetRing, 1 - Math.pow(0.5, frameDt / 0.2));

    this.showroomAngle += frameDt * 0.22;
    const r = 8.2;
    const cam = this.camera.camera;
    cam.position.set(Math.sin(this.showroomAngle * 0.5) * r, 2.4 + Math.sin(this.showroomAngle * 0.4) * 0.45, Math.cos(this.showroomAngle * 0.5) * r);
    cam.lookAt(0, 0.7, 0);
    if (Math.abs(cam.fov - 50) > 0.01) {
      cam.fov = 50;
      cam.updateProjectionMatrix();
    }
    // gentle idle motion: wheels roll, underglow pulses
    for (const w of sr.car.wheels) w.rotation.x += frameDt * 1.4;
    sr.car.underglow.opacity = 0.3 + Math.sin(this.showroomAngle * 4) * 0.12;
    this.postfx.render(this.scene, cam);
  }

  applyGraphicsSettings(): void {
    this.postfx.enabled = this.settings.graphics.bloom;
    this.particles.setEnabled(this.settings.graphics.particles);
    this.perf.setQuality(this.settings.graphics.quality);
  }

  private teardownRace(): void {
    for (const car of this.cars) {
      this.scene.remove(car.visual.handles.group);
      car.visual.handles.dispose();
      this.audio.removeOpponent(car.id);
    }
    this.cars = [];
    this.player = null;
    this.director = null;
    if (this.builtTrack) {
      this.scene.remove(this.builtTrack.group);
      this.builtTrack.dispose();
      this.builtTrack = null;
    }
    this.environment?.dispose();
    this.environment = null;
  }

  dispose(): void {
    this.disposeShowroom();
    this.teardownRace();
    this.envProbe?.dispose();
    this.envProbe = null;
    this.hdriRT?.dispose();
    this.hdriRT = null;
    this.hdriEnv = null;
    this.scene.environment = null;
    this.particles.dispose();
    this.postfx.dispose();
    this.renderer.dispose();
  }
}

/** Signed forward gap on a loop: (+) means `aheadS` is ahead of `behindS`. */
function signedGap(spline: TrackSpline, aheadS: number, behindS: number): number {
  let g = spline.wrap(aheadS - behindS);
  if (g > spline.length / 2) g -= spline.length;
  return g;
}
