/**
 * Live gesture tuning + diagnostics overlay (toggle with T in-race).
 *
 * Shows what the tracker and input pipeline are doing in real time —
 * per-hand pose + confidence, a rolling sparkline of RAW vs SMOOTHED steering
 * (so you can see the One-Euro filter + slew limiter working), throttle/brake
 * bars, wheel angle, and the latency/FPS/CV budget — plus live sliders for
 * sensitivity / smoothing / dead-zone so a new user can dial in the feel on
 * their own webcam without leaving the race.
 *
 * Self-contained: own DOM + scoped CSS, fed once per frame by the App.
 */
import './tuning.css';
import { el } from './dom';
import type { HandsState } from '../vision/HandTypes';
import type { GestureMapper } from '../input/GestureMapper';
import type { Profiler } from '../core/Profiler';
import type { SettingsStore } from '../core/Settings';

const GRAPH_W = 288;
const GRAPH_H = 54;
const HISTORY = 120;

export class TuningOverlay {
  readonly root: HTMLDivElement;
  private visible = false;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rawHist = new Float32Array(HISTORY);
  private smoothHist = new Float32Array(HISTORY);
  private head = 0;

  private leftPose: HTMLElement;
  private rightPose: HTMLElement;
  private leftConf: HTMLElement;
  private rightConf: HTMLElement;
  private rows: Record<string, HTMLElement> = {};

  constructor(private settings: SettingsStore, private onLiveChange?: () => void) {
    this.canvas = el('canvas', { class: 'tuning-graph', width: GRAPH_W, height: GRAPH_H });
    this.ctx = this.canvas.getContext('2d')!;

    const mkPose = (cls: string, role: string) => {
      const pose = el('div', { class: 'pose', textContent: '—' });
      const conf = el('i');
      const wrap = el('div', { class: `p ${cls}` }, [
        el('div', { class: 'role', textContent: role }),
        pose,
        el('div', { class: 'conf' }, [conf]),
      ]);
      return { wrap, pose, conf };
    };
    const lp = mkPose('left', 'LEFT HAND');
    const rp = mkPose('right', 'RIGHT HAND');
    this.leftPose = lp.pose; this.leftConf = lp.conf;
    this.rightPose = rp.pose; this.rightConf = rp.conf;

    const mkRow = (key: string, label: string) => {
      const v = el('span', { class: 'v', textContent: '—' });
      this.rows[key] = v;
      return el('div', { class: 'tuning-row' }, [el('span', { class: 'lbl', textContent: label }), v]);
    };

    const sliders = this.buildSliders();

    this.root = el('div', { class: 'layer interactive tuning-overlay hidden' }, [
      el('h4', {}, [document.createTextNode('Gesture Tuning'), el('span', { class: 'kbd', textContent: 'T' })]),
      this.canvas,
      el('div', { class: 'tuning-legend' }, [
        el('span', { html: '<i style="background:#ff2bd6"></i>raw' }),
        el('span', { html: '<i style="background:#00f0ff"></i>smoothed (applied)' }),
      ]),
      el('div', { class: 'tuning-pose' }, [lp.wrap, rp.wrap]),
      mkRow('wheel', 'Wheel angle'),
      mkRow('throttle', 'Throttle'),
      mkRow('brake', 'Brake'),
      mkRow('hands', 'Hands seen'),
      mkRow('latency', 'Input latency'),
      mkRow('fps', 'FPS / CV fps'),
      sliders,
      el('div', { class: 'tuning-hint', html: 'Tweak live, then drive. Settings auto-save. Run <b>Calibrate Hands</b> from the menu for a full setup.' }),
    ]);
  }

  private buildSliders(): HTMLElement {
    const c = this.settings.data.control;
    const mk = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number, fmt: (v: number) => string) => {
      const num = el('span', { class: 'num', textContent: fmt(get()) });
      const range = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()) }) as HTMLInputElement;
      range.addEventListener('input', () => {
        const v = +range.value;
        set(v);
        num.textContent = fmt(v);
        this.settings.save();
        this.onLiveChange?.();
      });
      this.sliderInputs.push(range);
      return el('div', { class: 'ts' }, [el('label', { textContent: label }), range, num]);
    };
    return el('div', { class: 'tuning-sliders' }, [
      mk('Sensitivity', () => c.steerSensitivity, (v) => (c.steerSensitivity = v), 0.5, 2, 0.05, (v) => v.toFixed(2)),
      mk('Smoothing', () => c.steerSmoothing, (v) => (c.steerSmoothing = v), 0, 1, 0.05, (v) => v.toFixed(2)),
      mk('Dead-zone°', () => c.deadZoneDeg, (v) => (c.deadZoneDeg = v), 0, 20, 1, (v) => String(Math.round(v))),
      mk('Throttle soft', () => c.throttleExpo, (v) => (c.throttleExpo = v), 0, 0.6, 0.05, (v) => v.toFixed(2)),
    ]);
  }

  private sliderInputs: HTMLInputElement[] = [];

  /** Called by App when smoothing slider changes elsewhere — keep sliders synced. */
  syncSliders(): void {
    const c = this.settings.data.control;
    const vals = [c.steerSensitivity, c.steerSmoothing, c.deadZoneDeg, c.throttleExpo];
    this.sliderInputs.forEach((inp, i) => (inp.value = String(vals[i])));
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
    if (this.visible) this.syncSliders();
    return this.visible;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Feed once per frame while visible. */
  update(hands: HandsState, mapper: GestureMapper, profiler: Profiler): void {
    if (!this.visible) return;
    const dbg = mapper.debug;

    // push history (ring)
    this.rawHist[this.head] = dbg.steerRaw;
    this.smoothHist[this.head] = dbg.steerSmoothed;
    this.head = (this.head + 1) % HISTORY;
    this.drawGraph();

    // poses
    this.leftPose.textContent = (hands.left?.pose ?? '—').toUpperCase();
    this.rightPose.textContent = (hands.right?.pose ?? '—').toUpperCase();
    this.leftConf.style.width = `${((hands.left?.poseConfidence ?? 0) * 100).toFixed(0)}%`;
    this.rightConf.style.width = `${((hands.right?.poseConfidence ?? 0) * 100).toFixed(0)}%`;

    this.rows.wheel.textContent = `${dbg.wheelAngleDeg.toFixed(0)}°`;
    this.setBar('throttle', dbg.throttle);
    this.setBar('brake', dbg.brake);

    const hands2 = hands.liveCount;
    this.rows.hands.textContent = `${hands2}${hands.left?.coasting || hands.right?.coasting ? ' (coasting)' : ''}`;
    this.rows.hands.className = 'v ' + (hands2 >= 2 ? 'good' : hands2 === 1 ? 'warn' : 'bad');

    const lat = profiler.inputLatencyMs.mean;
    this.rows.latency.textContent = `${Math.round(lat)} ms`;
    this.rows.latency.className = 'v ' + (lat <= 50 ? 'good' : lat <= 90 ? 'warn' : 'bad');

    const snap = profiler.snapshot();
    this.rows.fps.textContent = `${snap.fps} / ${snap.cvFps}`;
    this.rows.fps.className = 'v ' + (snap.fps >= 55 ? 'good' : snap.fps >= 40 ? 'warn' : 'bad');
  }

  private setBar(key: string, v: number): void {
    this.rows[key].textContent = `${(v * 100).toFixed(0)}%`;
    this.rows[key].className = 'v ' + (v > 0.05 ? 'good' : '');
  }

  private drawGraph(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, GRAPH_W, GRAPH_H);
    // zero line
    ctx.strokeStyle = 'rgba(125,166,189,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, GRAPH_H / 2);
    ctx.lineTo(GRAPH_W, GRAPH_H / 2);
    ctx.stroke();
    const plot = (hist: Float32Array, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < HISTORY; i++) {
        const idx = (this.head + i) % HISTORY; // oldest → newest
        const x = (i / (HISTORY - 1)) * GRAPH_W;
        const y = GRAPH_H / 2 - (hist[idx] * (GRAPH_H / 2 - 3));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    plot(this.rawHist, '#ff2bd6');
    plot(this.smoothHist, '#00f0ff');
  }
}
