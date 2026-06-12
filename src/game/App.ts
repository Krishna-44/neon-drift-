/**
 * App — top-level wiring.
 *
 * Owns the StateMachine, the fixed-step GameLoop, the CV stack (camera →
 * tracker → gesture mapper) with keyboard fallback, every UI screen, the
 * GameSession, recording, and the telemetry publisher. Routes input → session
 * each physics step, session events → HUD/audio, and state transitions →
 * screen visibility.
 *
 * Designed so a single class boots from main.ts and is fully disposable.
 */
import './../ui/styles.css';
import { GameLoop } from '../core/GameLoop';
import { StateMachine, GameState } from '../core/StateMachine';
import { SettingsStore } from '../core/Settings';
import { CameraManager } from '../vision/CameraManager';
import { HandTracker } from '../vision/HandTracker';
import { GestureMapper } from '../input/GestureMapper';
import { KeyboardInput } from '../input/KeyboardInput';
import { GestureCursor } from '../input/GestureCursor';
import { neutralControlState, type ControlState, type CarInputs } from '../input/ControlState';
import { GameSession } from './GameSession';
import { AudioEngine } from '../audio/AudioEngine';
import { GameplayRecorder } from './Recorder';
import { ReplayPlayer } from './ReplayPlayer';
import { RaceObserver, suggestAssists, suggestDifficulty, updateProfile } from './AdaptiveProfile';
import { BroadcastChannelTransport, TelemetryPublisher } from '../net/TelemetryTransport';
import { HUD } from '../ui/HUD';
import { WebcamOverlay } from '../ui/WebcamOverlay';
import { MainMenu, TrackSelect, SettingsScreen, PauseScreen, ResultsScreen, HelpScreen } from '../ui/Screens';
import { CalibrationWizard, TrainingWizard } from '../ui/Wizards';
import { el } from '../ui/dom';
import type { RaceConfig } from './GameSession';
import type { HandsState } from '../vision/HandTypes';

export class App {
  private canvas: HTMLCanvasElement;
  private loop: GameLoop;
  private fsm = new StateMachine();
  private settings: SettingsStore;
  private audio = new AudioEngine();

  private camera = new CameraManager();
  private tracker: HandTracker;
  private mapper: GestureMapper;
  private keyboard = new KeyboardInput();
  private cursor: GestureCursor;

  private session: GameSession;
  private recorder = new GameplayRecorder();
  private replayPlayer = new ReplayPlayer();
  private observer = new RaceObserver();
  private publisher: TelemetryPublisher;
  private transport = new BroadcastChannelTransport();

  private hud = new HUD();
  private pip = new WebcamOverlay({ title: 'CV FEED' });
  private mainMenu: MainMenu;
  private trackSelect: TrackSelect;
  private settingsScreen: SettingsScreen;
  private pauseScreen: PauseScreen;
  private resultsScreen: ResultsScreen;
  private helpScreen: HelpScreen;
  private calibration = new CalibrationWizard();
  private training = new TrainingWizard();
  private loadingScreen: HTMLDivElement;

  private hands: HandsState = { left: null, right: null, captureTs: 0, inferMs: 0, liveCount: 0 };
  private control: ControlState = neutralControlState();
  private pendingRaceConfig: RaceConfig | null = null;
  private settingsReturnState: GameState = 'menu';
  private isRecording = false;

  constructor(root: HTMLElement) {
    this.settings = new SettingsStore();

    this.canvas = el('canvas', { id: 'game-canvas' });
    root.append(this.canvas);

    this.tracker = new HandTracker(this.camera);
    this.mapper = new GestureMapper(this.settings.data.control, this.settings.data.calibration, this.settings.data.customGestures);
    this.cursor = new GestureCursor(root);

    this.audio.setVolumes(this.settings.data.audio);
    this.session = new GameSession(this.canvas, this.settings.data, this.audio);
    this.publisher = new TelemetryPublisher(this.transport, 'local-race');

    // ---- build screens
    this.mainMenu = new MainMenu({
      onPlay: () => this.fsm.transition('trackSelect'),
      onCalibrate: () => this.startCalibration(),
      onTrain: () => this.startTraining(),
      onSettings: () => this.openSettings('menu'),
      onHelp: () => this.fsm.transition('help'),
    });
    this.trackSelect = new TrackSelect(
      {
        onStart: (cfg) => this.startRace(cfg),
        onBack: () => this.fsm.transition('menu'),
      },
      { trackId: this.settings.data.lastTrack, opponents: this.settings.data.opponents, laps: this.settings.data.laps },
    );
    this.settingsScreen = new SettingsScreen(this.settings, {
      onClose: () => this.fsm.transition(this.settingsReturnState),
      onRecalibrate: () => this.startCalibration(),
      onApply: () => this.applySettings(),
    });
    this.pauseScreen = new PauseScreen({
      onResume: () => this.resumeRace(),
      onRestart: () => this.startRace(this.pendingRaceConfig!),
      onSettings: () => this.openSettings('paused'),
      onQuit: () => this.quitToMenu(),
    });
    this.resultsScreen = new ResultsScreen({
      onReplay: () => this.startReplay(),
      onAgain: () => this.startRace(this.pendingRaceConfig!),
      onMenu: () => this.quitToMenu(),
    });
    this.helpScreen = new HelpScreen({ onBack: () => this.fsm.transition('menu') });

    this.loadingScreen = el('div', { class: 'layer screen hidden', id: 'loading-root' }, [
      el('div', { class: 'loader-ring' }),
      el('div', { class: 'loader-text', textContent: 'Loading circuit…' }),
    ]);

    // ---- mount UI layers (order = z-order)
    root.append(
      this.hud.root,
      this.pip.root,
      this.mainMenu.root,
      this.trackSelect.root,
      this.settingsScreen.root,
      this.pauseScreen.root,
      this.resultsScreen.root,
      this.helpScreen.root,
      this.calibration.root,
      this.training.root,
      this.loadingScreen,
    );
    this.pip.attachVideo(this.camera.video);
    this.pip.setMirror(this.settings.data.control.mirrorPreview);

    this.wireStates();
    this.wireSessionEvents();
    this.wireGlobalKeys();
    this.tracker.events.on('status', ({ phase, message }) => this.onTrackerStatus(phase, message));
    this.tracker.events.on('state', ({ hands }) => (this.hands = hands));

    this.loop = new GameLoop({
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      frameUpdate: (frameDt) => this.frameUpdate(frameDt),
      render: () => this.render(),
    });

    window.addEventListener('resize', () => this.onResize());
    this.onResize();
  }

  async start(): Promise<void> {
    this.fsm.transition('menu');
    this.loop.start();
    // Kick off camera + tracking in the background; UI works regardless.
    this.initTracking();
    // Resume audio on first interaction (autoplay policy).
    const resumeAudio = () => {
      void this.audio.resume();
      window.removeEventListener('pointerdown', resumeAudio);
      window.removeEventListener('keydown', resumeAudio);
    };
    window.addEventListener('pointerdown', resumeAudio);
    window.addEventListener('keydown', resumeAudio);
    this.keyboard.attach();

    // Headless smoke test (Electron `--smoke`): drive a short race entirely from
    // synthetic hands and report pass/fail on window.__smokeResult.
    if (new URLSearchParams(location.search).get('smoke') === '1') {
      this.runSmokeTest();
    }
  }

  private runSmokeTest(): void {
    (window as any).__smokeResult = 'running';
    this.tracker.startSynthetic();
    this.startRace({ trackId: 'city', opponents: 3, laps: 1, difficulty: 'racer' });
    const startedAt = performance.now();
    const check = () => {
      const ps = this.session.getPlayerState();
      const moved = ps ? Math.hypot(ps.x, ps.z) : 0;
      const fps = this.session.profiler.fps;
      if (this.fsm.is('racing') && moved > 5 && fps > 0) {
        (window as any).__smokeResult = JSON.stringify({ pass: true, fps: Math.round(fps), state: this.fsm.state, moved: +moved.toFixed(1) });
        return;
      }
      if (performance.now() - startedAt > 20000) {
        (window as any).__smokeResult = JSON.stringify({ pass: false, state: this.fsm.state, moved: +moved.toFixed(1), fps: Math.round(fps) });
        return;
      }
      setTimeout(check, 500);
    };
    setTimeout(check, 1500);
  }

  private async initTracking(): Promise<void> {
    this.mainMenu.setCameraStatus('warn', 'Camera: starting…');
    const ok = await this.tracker.startCamera();
    if (!ok) {
      // No camera/permission → synthetic demo so the game is still fully playable.
      this.mainMenu.setCameraStatus('warn', 'No camera — demo + keyboard');
      this.pip.setNoCamera(true);
      this.tracker.startSynthetic();
    }
  }

  private onTrackerStatus(phase: string, message: string): void {
    const map: Record<string, 'ok' | 'warn' | 'error'> = {
      ready: 'ok',
      loading: 'warn',
      'fallback-cpu': 'warn',
      'fallback-inline': 'warn',
      error: 'error',
    };
    this.mainMenu.setCameraStatus(map[phase] ?? 'warn', `Camera: ${message}`);
    if (phase === 'ready') this.pip.setNoCamera(this.tracker.mode === 'synthetic');
  }

  // ----------------------------------------------------------- state wiring

  private wireStates(): void {
    const show = (...screens: { setVisible(v: boolean): void }[]) => {
      const all = [this.mainMenu, this.trackSelect, this.settingsScreen, this.pauseScreen, this.resultsScreen, this.helpScreen, this.calibration, this.training];
      for (const s of all) s.setVisible(screens.includes(s));
    };
    const hudVisible = (v: boolean) => this.hud.setVisible(!v ? false : true);

    // PiP stays visible in the menu too — instant feedback that tracking works.
    this.fsm.register('menu', { enter: () => { show(this.mainMenu); this.hud.setVisible(false); this.setPipInRace(true); this.cursor.setActive(true); } });
    this.fsm.register('trackSelect', { enter: () => { show(this.trackSelect); this.cursor.setActive(true); } });
    this.fsm.register('settings', { enter: () => { show(this.settingsScreen); this.cursor.setActive(true); } });
    this.fsm.register('help', { enter: () => { show(this.helpScreen); this.cursor.setActive(true); } });
    this.fsm.register('calibration', { enter: () => { show(this.calibration); this.cursor.setActive(false); this.setPipInRace(false); } });
    this.fsm.register('training', { enter: () => { show(this.training); this.cursor.setActive(false); this.setPipInRace(false); } });
    this.fsm.register('loading', { enter: () => { show(); this.loadingScreen.classList.remove('hidden'); }, exit: () => this.loadingScreen.classList.add('hidden') });
    this.fsm.register('countdown', { enter: () => { show(); this.hud.setVisible(true); this.setPipInRace(true); this.cursor.setActive(false); } });
    this.fsm.register('racing', { enter: () => { show(); this.hud.setVisible(true); this.setPipInRace(true); this.cursor.setActive(false); this.audio.setEngineMuted(false); } });
    this.fsm.register('paused', { enter: () => { show(this.pauseScreen); this.cursor.setActive(true); this.audio.setEngineMuted(true); } });
    this.fsm.register('finished', { enter: () => { this.onRaceComplete(); this.cursor.setActive(true); } });
    this.fsm.register('replay', { enter: () => { show(); this.hud.setVisible(false); this.cursor.setActive(false); } });
    void hudVisible;
  }

  private setPipInRace(inRace: boolean): void {
    // PiP only visible during race states; hidden in menus (overlay shown there instead)
    this.pip.root.classList.toggle('hidden', !inRace);
  }

  private wireSessionEvents(): void {
    this.session.events.on('countdown', ({ value }) => this.hud.showCountdown(value));
    this.session.events.on('raceStart', () => {
      if (this.fsm.is('countdown')) this.fsm.transition('racing');
    });
    this.session.events.on('lap', ({ racer, lapMs, isBest }) => {
      if (racer.isPlayer && racer.lap <= (this.pendingRaceConfig?.laps ?? 3)) {
        this.hud.toast(isBest ? `LAP ${racer.lap - 1} — NEW BEST ${(lapMs / 1000).toFixed(2)}s` : `LAP ${racer.lap - 1}`, isBest ? 'best' : '');
      }
    });
    this.session.events.on('collision', ({ intensity }) => {
      this.audio.collision(intensity);
      this.session.camera.addImpact(intensity);
    });
    this.session.events.on('wrongWay', () => {});
    this.session.events.on('raceComplete', () => this.fsm.transition('finished'));
    this.session.events.on('telemetry', ({ frame }) => this.publisher.publish(frame, 1 / 120));
  }

  private wireGlobalKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      switch (e.code) {
        case 'Escape':
          if (this.fsm.is('racing', 'countdown')) this.pauseRace();
          else if (this.fsm.is('paused')) this.resumeRace();
          else if (this.fsm.is('replay')) this.fsm.transition('finished');
          else if (this.fsm.is('trackSelect', 'help')) this.fsm.transition('menu');
          break;
        case 'KeyC':
          if (this.fsm.is('racing', 'countdown', 'paused')) {
            const mode = this.session.camera.cycleMode();
            this.settings.update((s) => (s.camera = mode === 'cockpit' ? 'cockpit' : 'chase'));
          }
          break;
        case 'KeyH':
          this.settings.update((s) => (s.graphics.showFpsHud = !s.graphics.showFpsHud));
          this.hud.setDebugVisible(this.settings.data.graphics.showFpsHud);
          break;
        case 'KeyV':
          if (this.fsm.is('racing')) this.toggleRecording();
          break;
      }
    });
  }

  // ----------------------------------------------------------- flow actions

  private startCalibration(): void {
    this.fsm.transition('calibration');
    const video = this.tracker.mode === 'camera' ? this.camera.video : null;
    this.calibration.begin(
      this.settings.data.calibration,
      video,
      this.settings.data.control.mirrorPreview,
      (data) => {
        this.settings.update((s) => (s.calibration = data));
        this.mapper.calibration = data;
        this.fsm.transition('menu');
        this.hud.toast('Calibration saved', 'best');
      },
      () => this.fsm.transition('menu'),
    );
  }

  private startTraining(): void {
    this.fsm.transition('training');
    const video = this.tracker.mode === 'camera' ? this.camera.video : null;
    this.training.begin(
      video,
      this.settings.data.control.mirrorPreview,
      (sample) => {
        this.settings.update((s) => {
          // one custom sample per action
          s.customGestures = [...s.customGestures.filter((g) => g.action !== sample.action), sample];
        });
        this.mapper.customGestures = this.settings.data.customGestures;
        this.fsm.transition('menu');
        this.hud.toast(`Gesture "${sample.label}" saved`, 'best');
      },
      () => this.fsm.transition('menu'),
    );
  }

  private openSettings(returnState: GameState): void {
    this.settingsReturnState = returnState;
    this.fsm.transition('settings');
  }

  private applySettings(): void {
    const s = this.settings.data;
    this.audio.setVolumes(s.audio);
    this.mapper.settings = s.control;
    this.tracker.setSmoothing(s.control.steerSmoothing);
    this.pip.setMirror(s.control.mirrorPreview);
    this.hud.setDebugVisible(s.graphics.showFpsHud);
    this.session.applyGraphicsSettings();
    this.settings.save();
  }

  private startRace(cfg: RaceConfig): void {
    // First-run onboarding: show the gesture guide once before the first race.
    if (!this.settings.data.seenOnboarding) {
      this.showOnboarding(cfg);
      return;
    }
    this.launchRace(cfg);
  }

  private launchRace(cfg: RaceConfig): void {
    void this.audio.resume();
    this.pendingRaceConfig = cfg;
    this.settings.update((s) => {
      s.lastTrack = cfg.trackId;
      s.opponents = cfg.opponents;
      s.laps = cfg.laps;
    });
    // adaptive difficulty/assists from the persistent profile
    if (this.settings.data.control.adaptiveAssists) {
      const a = suggestAssists(this.settings.data.adaptive);
      this.settings.update((s) => {
        s.control.steerSmoothing = a.steerSmoothing;
        s.control.stabilityAssist = a.stabilityAssist;
        s.control.counterSteerAssist = a.counterSteerAssist;
      });
      this.tracker.setSmoothing(a.steerSmoothing);
    }
    this.raceFinalized = false;
    this.fsm.transition('loading');
    // Defer so the loading screen paints before the (sync) heavy build.
    // setTimeout (not rAF) — rAF never fires in a backgrounded tab, which
    // would strand the app on the loading screen.
    setTimeout(() => {
      this.session.loadRace(cfg);
      const spline = this.session.getSpline()!;
      const def = this.session.getTrackDef()!;
      this.hud.setTrack(spline, def.halfWidth, cfg.laps, cfg.opponents + 1);
      this.hud.setDebugVisible(this.settings.data.graphics.showFpsHud);
      this.mapper.reset();
      this.observer = new RaceObserver();
      this.publisher.raceState({ trackId: cfg.trackId, opponents: cfg.opponents, laps: cfg.laps });
      this.fsm.transition('countdown');
      this.session.beginCountdown();
    }, 40);
  }

  private showOnboarding(cfg: RaceConfig): void {
    const rows: [string, string, string][] = [
      ['🖐🖐', 'STEER', 'Hold both hands like a wheel — tilt to turn'],
      ['👎', 'GAS', 'Right thumb DOWN · deeper = faster'],
      ['✊', 'BRAKE', 'Make a fist (both fists = full stop)'],
      ['✌️', 'NITRO', 'Peace sign for boost'],
      ['✊+↪', 'DRIFT', 'Fist while turning hard'],
      ['🖐', 'PAUSE', 'Open palm for 2 seconds'],
    ];
    const grid = el('div', { class: 'gg-grid' },
      rows.map(([ico, t, d]) =>
        el('div', { class: 'gg-row' }, [
          el('div', { class: 'gg-ico', textContent: ico }),
          el('div', { class: 'gg-txt' }, [el('b', { textContent: t }), el('span', { textContent: d })]),
        ]),
      ),
    );
    const go = el('button', { class: 'neon primary', textContent: "Got it — let's race!" });
    const overlay = el('div', { class: 'layer interactive screen fade-in' }, [
      el('div', { class: 'panel screen-card onboarding-card' }, [
        el('h2', { textContent: 'Drive With Your Hands' }),
        el('p', { class: 'hint', textContent: 'Sit ~60 cm from the camera with both hands visible. Watch the corner screen — it shows exactly what the tracker sees.' }),
        grid,
        el('div', { class: 'row end', style: { justifyContent: 'center' } as any }, [go]),
      ]),
    ]);
    go.addEventListener('click', () => {
      this.settings.update((s) => (s.seenOnboarding = true));
      overlay.remove();
      this.launchRace(cfg);
    });
    document.getElementById('app')!.append(overlay);
  }

  private pauseRace(): void {
    if (this.fsm.transition('paused')) {
      this.audio.uiBlip('back');
    }
  }

  private resumeRace(): void {
    // resume back into racing (or countdown if it hadn't started)
    const target = this.session.racePhase === 'countdown' ? 'countdown' : 'racing';
    this.fsm.transition(target as GameState);
  }

  private quitToMenu(): void {
    if (this.isRecording) void this.toggleRecording();
    this.fsm.transition('menu');
  }

  private raceFinalized = false;

  private onRaceComplete(): void {
    if (this.isRecording) void this.toggleRecording();
    const standings = this.session.getStandings();
    const player = this.session.getPlayerProgress();
    const cfg = this.pendingRaceConfig!;
    // Re-entering 'finished' from a replay must not double-count the race.
    if (!this.raceFinalized) {
      this.raceFinalized = true;
      const place = player ? standings.findIndex((r) => r.id === player.id) + 1 : standings.length;
      const result = this.observer.finalize({
        position: place,
        fieldSize: standings.length,
        laps: cfg.laps,
        lapTimesMs: player?.lapTimes ?? [],
      });
      this.settings.update((s) => {
        s.adaptive = updateProfile(s.adaptive, result);
        if (player && isFinite(player.bestLapMs)) {
          const prev = s.adaptive.bestLapMsByTrack[cfg.trackId] ?? Infinity;
          if (player.bestLapMs < prev) s.adaptive.bestLapMsByTrack[cfg.trackId] = player.bestLapMs;
        }
      });
    }
    // restore the player camera if we came back from a cinematic replay
    this.session.setCameraMode(this.settings.data.camera === 'cockpit' ? 'cockpit' : 'chase');
    this.resultsScreen.show(standings, this.settings.data.adaptive.skill, suggestDifficulty(this.settings.data.adaptive));
    this.resultsScreen.setVisible(true);
    this.mainMenu.setVisible(false);
    this.audio.setEngineMuted(true);
  }

  private startReplay(): void {
    this.fsm.transition('replay');
    this.replayPlayer.load(this.session.replay.toArray());
    this.session.setCameraMode('cinematic');
    this.replayPlayer.play();
  }

  private async toggleRecording(): Promise<void> {
    if (this.isRecording) {
      this.isRecording = false;
      await this.recorder.stop(`neondrift-${Date.now()}.webm`);
      this.hud.toast('Replay saved to downloads', 'best');
    } else {
      const video = this.tracker.mode === 'camera' ? this.camera.video : null;
      const ok = this.recorder.start(this.canvas, video, true);
      this.isRecording = ok;
      this.hud.toast(ok ? '● Recording…' : 'Recording unsupported', ok ? 'warn' : 'warn');
    }
  }

  // ----------------------------------------------------------- loop

  private fixedUpdate(dt: number): void {
    // Update the input source every physics step.
    if (this.fsm.is('racing')) {
      const inputs = this.resolveInputs(dt);
      this.session.playerInput = inputs;
      this.session.simulate(dt);
      // adaptive observation
      const ps = this.session.getPlayerState();
      const prog = this.session.getPlayerProgress();
      if (ps) {
        const onTrack = true; // surface checked inside session; approximate here
        this.observer.sample(inputs.steer, inputs.throttle, onTrack, this.session.getPlayerState()!.skidIntensity > 0.9, dt);
      }
      void prog;
    } else if (this.fsm.is('countdown')) {
      this.session.playerInput = this.resolveInputs(dt);
      this.session.simulate(dt);
    } else if (this.fsm.is('finished')) {
      this.session.playerInput = { steer: 0, throttle: 0, brake: 0.4, handbrake: false, nitro: false, reverse: false };
      this.session.simulate(dt);
    }
  }

  /** Decide gesture vs keyboard and produce the car inputs for this step. */
  private resolveInputs(dt: number): CarInputs {
    const now = performance.now();
    // Always run the mapper so smoothing/holds stay warm.
    this.control = this.mapper.update(this.hands, now);
    const kb = this.keyboard.update(dt);
    const keyboardActive = this.keyboard.isActive();

    // Pause via held open palm (gesture) handled here.
    if (this.control.pauseFired && this.fsm.is('racing')) {
      this.pauseRace();
    }

    if (keyboardActive) {
      return kb;
    }
    if (this.hands.liveCount > 0 || this.control.gesture.wheelEngaged || this.control.throttle > 0 || this.control.brake > 0) {
      this.session.profiler.markInputApplied(this.hands.captureTs || now);
      return {
        steer: this.control.steer,
        throttle: this.control.throttle,
        brake: this.control.brake,
        handbrake: this.control.handbrake,
        nitro: this.control.nitro,
        reverse: this.control.reverse,
      };
    }
    return kb; // neutral
  }

  private frameUpdate(frameDt: number): void {
    // CV-driven UI everywhere
    if (this.fsm.is('calibration')) {
      this.calibration.feed(this.hands, frameDt);
      return;
    }
    if (this.fsm.is('training')) {
      this.training.feed(this.hands, frameDt);
      return;
    }
    // gesture cursor in menus
    if (this.fsm.is('menu', 'trackSelect', 'settings', 'help', 'paused', 'finished')) {
      this.cursor.update(this.hands, performance.now());
      // menu-state pause-hold to resume
      if (this.fsm.is('paused')) {
        const c = this.mapper.update(this.hands, performance.now());
        if (c.pauseFired) this.resumeRace();
      }
      this.audio.updateMusic(frameDt, this.fsm.is('menu'));
    }

    // webcam PiP overlay (race + menus — the "corner screen" showing what the
    // tracker sees; hidden only where a full-size preview exists)
    if (!this.fsm.is('calibration', 'training', 'replay')) {
      this.pip.render(this.hands);
    }

    // replay playback
    if (this.fsm.is('replay')) {
      this.replayPlayer.update(frameDt);
    }

    // HUD
    if (this.fsm.is('racing', 'countdown', 'paused', 'finished')) {
      this.updateHud();
      this.updateHints();
    }
    this.lastFrameDt = frameDt;
  }

  private lastFrameDt = 1 / 60;

  /** Rotating gesture hints during countdown + the opening seconds of a race. */
  private updateHints(): void {
    const HINTS = [
      '🖐🖐 Tilt both hands to <b>STEER</b>',
      '👎 Thumb down = <b>GAS</b> · deeper = faster',
      '✊ Fist = <b>BRAKE</b> · ✌️ = <b>NITRO</b>',
      '✊ while turning hard = <b>DRIFT</b>',
    ];
    const phase = this.session.racePhase;
    const t = this.session.getRaceTimeMs();
    if (phase === 'countdown' || (phase === 'racing' && t < 14000)) {
      const idx = Math.floor(t / 3500) % HINTS.length;
      this.hud.setHint(phase === 'countdown' ? HINTS[0] + ' · ' + HINTS[1] : HINTS[idx]);
    } else {
      this.hud.setHint(null);
    }
    // hands-lost warning (only when gestures are the active input)
    const noHands =
      this.fsm.is('racing') &&
      this.tracker.mode !== 'idle' &&
      this.hands.liveCount === 0 &&
      !this.keyboard.isActive(2000);
    this.hud.setNoHands(noHands);
  }

  private updateHud(): void {
    const playerState = this.session.getPlayerState();
    const prog = this.session.getPlayerProgress();
    const playerTele = playerState
      ? {
          id: 'player', isPlayer: true, x: playerState.x, z: playerState.z, y: 0,
          heading: playerState.heading, speedKmh: playerState.speedKmh, rpm: playerState.rpm,
          gear: playerState.gearIndex, nitro: playerState.nitroTank, nitroActive: playerState.nitroActive,
          drifting: playerState.drifting, skid: playerState.skidIntensity, steerAngle: playerState.steerAngle,
          accel: playerState.accelSmoothed, position: prog?.position ?? 1, lap: prog?.lap ?? 1,
        }
      : null;
    this.hud.update({
      player: playerTele,
      gesture: this.control.gesture,
      inputs: this.session.playerInput,
      progress: prog,
      raceTimeMs: this.session.getRaceTimeMs(),
      cars: this.session.getCarWorldPositions(),
      profiler: this.session.profiler,
      inputLatencyMs: this.session.profiler.inputLatencyMs.mean,
    });
  }

  private render(): void {
    if (this.fsm.is('replay')) {
      const frame = this.replayPlayer.currentFrame();
      if (frame) this.session.renderReplayFrame(frame, 1 / 60);
      else this.session.renderFrame(1 / 60);
      return;
    }
    if (this.fsm.is('racing', 'countdown', 'paused', 'finished')) {
      this.session.renderFrame(1 / 60);
    } else {
      // live 3D showroom behind the menus
      this.session.renderMenuBackdrop(this.lastFrameDt);
    }
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w;
    this.canvas.height = h;
    this.session.resize(w, h);
  }

  dispose(): void {
    this.loop.stop();
    this.tracker.dispose();
    this.camera.stop();
    this.keyboard.detach();
    this.session.dispose();
    this.audio.dispose();
    this.transport.close();
  }
}
