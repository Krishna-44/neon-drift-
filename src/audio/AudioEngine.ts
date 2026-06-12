/**
 * Procedural audio engine (Web Audio API). No sound files — everything is
 * synthesised: a multi-oscillator engine note whose pitch/timbre tracks rpm &
 * load, filtered-noise skid/tyre, collision thuds, nitro whoosh, and UI blips.
 * Spatial panning positions opponents around the player.
 *
 * Guards against the browser autoplay policy: stays silent until resume() is
 * called from a user gesture; all nodes are created lazily.
 */
import { clamp, clamp01, lerp } from '../core/MathUtils';
import type { VehicleState } from '../physics/VehicleDynamics';

interface EngineVoice {
  oscSaw: OscillatorNode;
  oscSquare: OscillatorNode;
  subOsc: OscillatorNode;
  gain: GainNode;
  filter: BiquadFilterNode;
  panner: StereoPannerNode;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private playerVoice: EngineVoice | null = null;
  private skidGain: GainNode | null = null;
  private skidFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;

  private opponentVoices = new Map<string, EngineVoice>();
  private musicTimer = 0;
  private musicStep = 0;
  private started = false;

  volumes = { master: 0.8, engine: 0.7, sfx: 0.8, music: 0.5 };

  get isRunning(): boolean {
    return this.started && this.ctx?.state === 'running';
  }

  /** Must be called from a user gesture (click/keydown). Idempotent. */
  async resume(): Promise<void> {
    if (!this.ctx) this.init();
    if (this.ctx!.state === 'suspended') await this.ctx!.resume();
  }

  private init(): void {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new Ctx();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.volumes.master;
    this.master.connect(ctx.destination);

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = this.volumes.engine;
    this.engineBus.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.volumes.sfx;
    this.sfxBus.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.volumes.music * 0.5;
    this.musicBus.connect(this.master);

    // 2 s of pink-ish noise for tyre/skid/wind/impact.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.5;
    }
    this.noiseBuffer = buf;
    this.started = true;
  }

  private makeVoice(spatial: boolean): EngineVoice {
    const ctx = this.ctx!;
    const oscSaw = ctx.createOscillator();
    oscSaw.type = 'sawtooth';
    const oscSquare = ctx.createOscillator();
    oscSquare.type = 'square';
    const subOsc = ctx.createOscillator();
    subOsc.type = 'triangle';
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    filter.Q.value = 6;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = ctx.createStereoPanner();
    oscSaw.connect(filter);
    oscSquare.connect(filter);
    subOsc.connect(gain);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(spatial ? this.sfxBus! : this.engineBus!);
    oscSaw.start();
    oscSquare.start();
    subOsc.start();
    return { oscSaw, oscSquare, subOsc, gain, filter, panner };
  }

  private updateVoice(voice: EngineVoice, state: VehicleState, throttle: number, pan: number, volume: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    // Base frequency from rpm across the virtual gear; sub an octave down.
    const baseHz = lerp(46, 190, state.rpm) + state.gearIndex * 5;
    voice.oscSaw.frequency.setTargetAtTime(baseHz, t, 0.04);
    voice.oscSquare.frequency.setTargetAtTime(baseHz * 1.005, t, 0.04);
    voice.subOsc.frequency.setTargetAtTime(baseHz * 0.5, t, 0.04);
    const load = clamp01(throttle * 0.7 + state.rpm * 0.5 + (state.wheelspin ? 0.3 : 0));
    voice.filter.frequency.setTargetAtTime(lerp(420, 3200, load), t, 0.05);
    voice.gain.gain.setTargetAtTime(volume * lerp(0.18, 0.5, load), t, 0.05);
    voice.panner.pan.setTargetAtTime(clamp(pan, -1, 1), t, 0.08);
  }

  /** Per-frame player engine + tyre update. */
  updatePlayer(state: VehicleState, throttle: number): void {
    if (!this.isRunning) return;
    const ctx = this.ctx!;
    if (!this.playerVoice) {
      this.playerVoice = this.makeVoice(false);
      // skid noise chain
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      this.skidFilter = ctx.createBiquadFilter();
      this.skidFilter.type = 'bandpass';
      this.skidFilter.frequency.value = 1400;
      this.skidFilter.Q.value = 1.2;
      this.skidGain = ctx.createGain();
      this.skidGain.gain.value = 0;
      src.connect(this.skidFilter);
      this.skidFilter.connect(this.skidGain);
      this.skidGain.connect(this.sfxBus!);
      src.start();
      // wind (high noise) rising with speed
      const wsrc = ctx.createBufferSource();
      wsrc.buffer = this.noiseBuffer;
      wsrc.loop = true;
      const wf = ctx.createBiquadFilter();
      wf.type = 'highpass';
      wf.frequency.value = 3200;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      wsrc.connect(wf);
      wf.connect(this.windGain);
      this.windGain.connect(this.sfxBus!);
      wsrc.start();
    }
    this.updateVoice(this.playerVoice, state, throttle, 0, 1);
    const t = ctx.currentTime;
    this.skidGain!.gain.setTargetAtTime(state.skidIntensity * 0.5, t, 0.03);
    this.skidFilter!.frequency.setTargetAtTime(lerp(900, 1900, state.skidIntensity), t, 0.05);
    this.windGain!.gain.setTargetAtTime(clamp01(state.speedKmh / 240) * 0.12, t, 0.1);
  }

  /** Update an opponent's spatialised engine. pan/-volume from relative pos. */
  updateOpponent(id: string, state: VehicleState, pan: number, distance: number): void {
    if (!this.isRunning) return;
    let v = this.opponentVoices.get(id);
    if (!v) {
      v = this.makeVoice(true);
      this.opponentVoices.set(id, v);
    }
    const vol = clamp01(1 - distance / 90) * 0.5;
    this.updateVoice(v, state, 0.5, pan, vol);
  }

  removeOpponent(id: string): void {
    const v = this.opponentVoices.get(id);
    if (v) {
      try {
        v.oscSaw.stop();
        v.oscSquare.stop();
        v.subOsc.stop();
      } catch {
        /* already stopped */
      }
      this.opponentVoices.delete(id);
    }
  }

  // --------------------------------------------------------------- one-shots

  private noiseBurst(freq: number, q: number, dur: number, gain: number, type: BiquadFilterType = 'bandpass'): void {
    if (!this.isRunning) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxBus!);
    src.start();
    src.stop(t + dur + 0.02);
  }

  collision(intensity: number): void {
    const i = clamp01(intensity);
    this.noiseBurst(90 + i * 60, 0.8, 0.18 + i * 0.2, 0.4 + i * 0.4, 'lowpass');
    // metallic ring
    if (this.isRunning && i > 0.3) this.tone(220 + i * 200, 0.12, 0.18, 'triangle');
  }

  nitroWhoosh(): void {
    if (!this.isRunning) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(4000, t + 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxBus!);
    src.start();
    src.stop(t + 0.65);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', bus: GainNode | null = this.sfxBus): void {
    if (!this.isRunning) return;
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(bus ?? this.sfxBus!);
    osc.start();
    osc.stop(t + dur + 0.02);
  }

  uiBlip(kind: 'move' | 'select' | 'back' | 'error' = 'move'): void {
    const map = { move: 520, select: 760, back: 360, error: 180 };
    this.tone(map[kind], 0.1, 0.12, 'square');
    if (kind === 'select') this.tone(map[kind] * 1.5, 0.12, 0.08, 'square');
  }

  countdownBeep(go: boolean): void {
    this.tone(go ? 880 : 440, go ? 0.5 : 0.2, 0.25, 'sine');
  }

  checkpoint(): void {
    this.tone(660, 0.1, 0.18, 'triangle');
    this.tone(990, 0.16, 0.14, 'triangle');
  }

  /** Simple synthwave arpeggio bed for menus. Call each frame; it self-paces. */
  updateMusic(frameDt: number, active: boolean): void {
    if (!this.isRunning || !active) return;
    this.musicTimer += frameDt;
    const stepDur = 0.16;
    if (this.musicTimer >= stepDur) {
      this.musicTimer -= stepDur;
      const scale = [0, 3, 7, 10, 12, 10, 7, 3];
      const root = 220;
      const note = root * Math.pow(2, scale[this.musicStep % scale.length] / 12);
      this.tone(note, 0.4, 0.05, 'sawtooth', this.musicBus);
      if (this.musicStep % 4 === 0) this.tone(root / 2, 0.35, 0.08, 'triangle', this.musicBus);
      this.musicStep++;
    }
  }

  setVolumes(v: { master: number; engine: number; sfx: number; music: number }): void {
    this.volumes = v;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master?.gain.setTargetAtTime(v.master, t, 0.05);
    this.engineBus?.gain.setTargetAtTime(v.engine, t, 0.05);
    this.sfxBus?.gain.setTargetAtTime(v.sfx, t, 0.05);
    this.musicBus?.gain.setTargetAtTime(v.music * 0.5, t, 0.05);
  }

  /** Silence engine voices (e.g. on pause) without tearing down the graph. */
  setEngineMuted(muted: boolean): void {
    if (!this.ctx || !this.engineBus) return;
    this.engineBus.gain.setTargetAtTime(muted ? 0 : this.volumes.engine, this.ctx.currentTime, 0.05);
  }

  dispose(): void {
    for (const id of [...this.opponentVoices.keys()]) this.removeOpponent(id);
    if (this.playerVoice) {
      try {
        this.playerVoice.oscSaw.stop();
        this.playerVoice.oscSquare.stop();
        this.playerVoice.subOsc.stop();
      } catch {
        /* noop */
      }
      this.playerVoice = null;
    }
    this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}
