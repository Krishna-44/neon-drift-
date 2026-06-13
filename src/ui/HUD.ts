/**
 * In-race heads-up display: speedometer + RPM arc, gear, nitro gauge, position
 * & lap chips, lap timing with delta, live gesture-state chips, steering-wheel
 * indicator, SVG minimap with live car blips, countdown, toasts, wrong-way
 * warning, and the FPS / latency / CV debug readout.
 *
 * Pure view: `update()` consumes already-computed state and writes the DOM.
 * Heavy nodes are built once; per-frame work is attribute/text mutation only.
 */
import { clamp, clamp01 } from '../core/MathUtils';
import { el, formatTime, formatDelta } from './dom';
import type { CarTelemetry } from '../game/Telemetry';
import type { GestureDiagnostics } from '../input/ControlState';
import type { RacerProgress } from '../ai/RaceDirector';
import type { TrackSpline } from '../track/Spline';
import type { Profiler } from '../core/Profiler';

const GAUGE_MAX_KMH = 260;
const SPEEDO_START = 135; // deg
const SPEEDO_SWEEP = 270;
const NITRO_SEGMENTS = 14;

interface GestureChipDef {
  key: keyof GestureFlags;
  label: string;
  icon: string;
  cls?: string;
}

interface GestureFlags {
  throttle: boolean;
  reverse: boolean;
  brake: boolean;
  nitro: boolean;
  drift: boolean;
  steer: boolean;
}

const CHIP_DEFS: GestureChipDef[] = [
  { key: 'steer', label: 'STEER', icon: '🎮' },
  { key: 'throttle', label: 'THROTTLE', icon: '✊' },
  { key: 'reverse', label: 'REVERSE', icon: '👍' },
  { key: 'brake', label: 'BRAKE', icon: '👎', cls: 'brake' },
  { key: 'nitro', label: 'NITRO', icon: '✌', cls: 'nitro' },
  { key: 'drift', label: 'DRIFT', icon: '🌀', cls: 'drift' },
];

export class HUD {
  readonly root: HTMLDivElement;
  private speedVal: HTMLElement;
  private rpmArc: SVGPathElement;
  private speedArc: SVGPathElement;
  private gearVal: HTMLElement;
  private nitroGauge!: HTMLElement;
  private nitroSegEls: HTMLElement[] = [];
  private posChip!: HTMLElement;
  private posVal: HTMLElement;
  private posTotal: HTMLElement;
  private lapVal: HTMLElement;
  private lapTotal: HTMLElement;
  private curTime: HTMLElement;
  private bestTime: HTMLElement;
  private deltaEl: HTMLElement;
  private chips = new Map<string, HTMLElement>();
  private chipConf = new Map<string, HTMLElement>();
  private wheelInner: SVGGElement;
  private wheelAngleText: HTMLElement;
  private minimapSvg: SVGSVGElement;
  private minimapBlips: SVGCircleElement[] = [];
  private debugPanel: HTMLElement;
  private countdownLayer: HTMLDivElement;
  private toastStack: HTMLDivElement;
  private wrongWayEl: HTMLDivElement;
  private motionCanvas!: HTMLCanvasElement;
  private motionCtx!: CanvasRenderingContext2D;
  private motionLines: { x: number; y: number; angle: number; len: number; t: number; life: number; color: string }[] = [];
  private motionEmitAccum = 0;
  private nitroFlash!: HTMLDivElement;
  private deltaPopups!: HTMLDivElement;
  private driftFlare!: HTMLDivElement;
  private lastPos = 0;
  private lastLapCount = 0;
  private lastDriftFlare = false;
  private fxEnabled = true;
  private debugVisible = true;
  private minimapBuilt = false;
  private minimapTransform = { ox: 0, oz: 0, scale: 1, size: 168 };

  constructor() {
    // speedo
    this.speedVal = el('div', { class: 'speedo-val', textContent: '0' });
    const speedoSvg = this.buildSpeedo();
    this.speedArc = speedoSvg.querySelector('.speed-arc')!;
    this.rpmArc = speedoSvg.querySelector('.rpm-arc')!;
    const speedo = el('div', { class: 'speedo' }, [
      speedoSvg,
      el('div', { class: 'speedo-readout' }, [this.speedVal, el('div', { class: 'speedo-unit', textContent: 'KM/H' })]),
    ]);

    this.gearVal = el('div', { class: 'gear-val', textContent: 'D' });
    const gearBox = el('div', { class: 'gear-box' }, [this.gearVal, el('div', { class: 'gear-label', textContent: 'GEAR' })]);
    const cluster = el('div', { class: 'hud-cluster' }, [speedo, gearBox]);

    // nitro — Asphalt-style segmented gauge (fills L→R, flares when active)
    this.nitroSegEls = [];
    const segWrap = el('div', { class: 'nitro-segs' });
    for (let i = 0; i < NITRO_SEGMENTS; i++) {
      const seg = el('i', { class: 'nseg' });
      this.nitroSegEls.push(seg);
      segWrap.append(seg);
    }
    this.nitroGauge = segWrap;
    const nitroWrap = el('div', { class: 'nitro-wrap' }, [
      segWrap,
      el('div', { class: 'nitro-label', textContent: 'NITRO' }),
    ]);

    // position + lap chips
    this.posVal = el('span', { textContent: '1' });
    this.posTotal = el('span', { class: 'small', textContent: '/1' });
    this.lapVal = el('span', { textContent: '1' });
    this.lapTotal = el('span', { class: 'small', textContent: '/3' });
    this.posChip = el('div', { class: 'info-chip pos' }, [
      el('div', { class: 'ic-big' }, [this.posVal, this.posTotal]),
      el('div', { class: 'ic-label', textContent: 'Position' }),
    ]);
    const raceInfo = el('div', { class: 'race-info' }, [
      this.posChip,
      el('div', { class: 'info-chip' }, [
        el('div', { class: 'ic-big' }, [this.lapVal, this.lapTotal]),
        el('div', { class: 'ic-label', textContent: 'Lap' }),
      ]),
    ]);

    // timing
    this.curTime = el('div', { class: 'cur', textContent: '0:00.000' });
    this.bestTime = el('div', { class: 'best', textContent: 'BEST --:--.---' });
    this.deltaEl = el('div', { class: 'delta' });
    const timing = el('div', { class: 'timing' }, [this.curTime, this.bestTime, this.deltaEl]);

    // gesture chips
    const chipNodes: HTMLElement[] = [];
    for (const def of CHIP_DEFS) {
      const conf = el('i');
      const confBar = el('div', { class: 'gc-conf' }, [conf]);
      const chip = el('div', { class: `g-chip ${def.cls ?? ''}` }, [
        el('span', { class: 'gc-ico', textContent: def.icon }),
        el('span', { textContent: def.label }),
        confBar,
      ]);
      this.chips.set(def.key, chip);
      this.chipConf.set(def.key, conf);
      chipNodes.push(chip);
    }
    const gesturePanel = el('div', { class: 'gesture-panel' }, chipNodes);

    // steering wheel indicator
    const { svg: wheelSvg, inner: wheelInner } = this.buildWheel();
    this.wheelInner = wheelInner;
    this.wheelAngleText = el('div', {
      class: 'wheel-ind',
      style: { display: 'none' } as any,
    });
    const wheelWrap = el('div', { class: 'wheel-ind' }, [wheelSvg]);

    // minimap
    this.minimapSvg = this.svg('svg', { viewBox: '0 0 168 168' }) as SVGSVGElement;
    const minimap = el('div', { class: 'minimap' }, [this.minimapSvg]);

    // debug
    this.debugPanel = el('div', { class: 'debug-panel' });

    // countdown + toasts + wrongway
    this.countdownLayer = el('div', { class: 'countdown' });
    this.toastStack = el('div', { class: 'toast-stack' });
    this.wrongWayEl = el('div', { class: 'wrongway hidden', textContent: '◄ WRONG WAY' });

    // onboarding helpers: rotating gesture hints + hands-lost warning
    this.hintStrip = el('div', { class: 'hint-strip hidden' });
    this.noHandsEl = el('div', { class: 'nohands hidden', html: '✋ ✋ &nbsp;SHOW BOTH HANDS TO THE CAMERA' });

    // speed-reactive FX: motion-line canvas (behind HUD chrome) + nitro flash
    this.motionCanvas = el('canvas', { class: 'motion-fx' });
    this.motionCtx = this.motionCanvas.getContext('2d')!;
    this.nitroFlash = el('div', { class: 'nitro-flash' });
    this.deltaPopups = el('div', { class: 'delta-popups' });
    this.driftFlare = el('div', { class: 'drift-flare hidden' });

    this.root = el('div', { class: 'layer', id: 'hud' }, [
      this.motionCanvas, this.nitroFlash,
      cluster, nitroWrap, raceInfo, timing, gesturePanel, wheelWrap, minimap,
      this.debugPanel, this.countdownLayer, this.toastStack, this.wrongWayEl,
      this.hintStrip, this.noHandsEl, this.deltaPopups, this.driftFlare,
    ]);
    this.resizeFx();
    window.addEventListener('resize', () => this.resizeFx());
    void this.wheelAngleText;
  }

  private resizeFx(): void {
    this.motionCanvas.width = window.innerWidth;
    this.motionCanvas.height = window.innerHeight;
  }

  /** Gate the heavy speed-FX with the particle/quality setting (PerfGovernor). */
  setFxEnabled(on: boolean): void {
    this.fxEnabled = on;
    if (!on) {
      this.motionLines.length = 0;
      this.motionCtx.clearRect(0, 0, this.motionCanvas.width, this.motionCanvas.height);
      this.nitroFlash.style.opacity = '0';
    }
  }

  private hintStrip!: HTMLDivElement;
  private noHandsEl!: HTMLDivElement;

  /** Rotating control hint shown during countdown + the first laps for new players. */
  setHint(html: string | null): void {
    if (html === null) {
      this.hintStrip.classList.add('hidden');
    } else {
      if (this.hintStrip.innerHTML !== html) this.hintStrip.innerHTML = html;
      this.hintStrip.classList.remove('hidden');
    }
  }

  setNoHands(show: boolean): void {
    this.noHandsEl.classList.toggle('hidden', !show);
  }

  // ----------------------------------------------------------- builders

  private svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  private arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
    const s = (startDeg * Math.PI) / 180;
    const e = (endDeg * Math.PI) / 180;
    const x1 = cx + r * Math.cos(s);
    const y1 = cy + r * Math.sin(s);
    const x2 = cx + r * Math.cos(e);
    const y2 = cy + r * Math.sin(e);
    const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }

  private buildSpeedo(): SVGSVGElement {
    const svg = this.svg('svg', { viewBox: '0 0 100 100' });
    const track = this.svg('path', {
      d: this.arcPath(50, 50, 42, SPEEDO_START, SPEEDO_START + SPEEDO_SWEEP),
      fill: 'none',
      stroke: 'rgba(125,166,189,0.15)',
      'stroke-width': '6',
      'stroke-linecap': 'round',
    });
    const speedArc = this.svg('path', {
      class: 'speed-arc',
      d: this.arcPath(50, 50, 42, SPEEDO_START, SPEEDO_START + 1),
      fill: 'none',
      stroke: 'url(#speedGrad)',
      'stroke-width': '6',
      'stroke-linecap': 'round',
    });
    const rpmArc = this.svg('path', {
      class: 'rpm-arc',
      d: this.arcPath(50, 50, 33, SPEEDO_START, SPEEDO_START + 1),
      fill: 'none',
      stroke: '#ff2bd6',
      'stroke-width': '2.5',
      'stroke-linecap': 'round',
    });
    const defs = this.svg('defs');
    defs.innerHTML =
      '<linearGradient id="speedGrad" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#00f0ff"/><stop offset="0.7" stop-color="#7a5cff"/><stop offset="1" stop-color="#ff2bd6"/></linearGradient>';
    svg.append(defs, track, speedArc, rpmArc);
    // tick marks
    for (let i = 0; i <= 10; i++) {
      const a = ((SPEEDO_START + (SPEEDO_SWEEP * i) / 10) * Math.PI) / 180;
      const r1 = 46;
      const r2 = i % 5 === 0 ? 49 : 47.5;
      const tick = this.svg('line', {
        x1: (50 + r1 * Math.cos(a)).toFixed(2),
        y1: (50 + r1 * Math.sin(a)).toFixed(2),
        x2: (50 + r2 * Math.cos(a)).toFixed(2),
        y2: (50 + r2 * Math.sin(a)).toFixed(2),
        stroke: 'rgba(0,240,255,0.5)',
        'stroke-width': i % 5 === 0 ? '1.2' : '0.6',
      });
      svg.append(tick);
    }
    return svg;
  }

  private buildWheel(): { svg: SVGSVGElement; inner: SVGGElement } {
    const svg = this.svg('svg', { viewBox: '0 0 100 100' });
    const g = this.svg('g') as SVGGElement;
    const rim = this.svg('circle', { cx: '50', cy: '50', r: '38', fill: 'none', stroke: 'rgba(0,240,255,0.6)', 'stroke-width': '5' });
    const spoke1 = this.svg('line', { x1: '50', y1: '50', x2: '50', y2: '14', stroke: '#00f0ff', 'stroke-width': '4' });
    const spoke2 = this.svg('line', { x1: '15', y1: '58', x2: '85', y2: '58', stroke: '#00f0ff', 'stroke-width': '4' });
    const hub = this.svg('circle', { cx: '50', cy: '50', r: '7', fill: '#ff2bd6' });
    const topMark = this.svg('circle', { cx: '50', cy: '14', r: '3.5', fill: '#fff' });
    g.append(rim, spoke1, spoke2, topMark, hub);
    svg.append(g);
    return { svg, inner: g };
  }

  private buildMinimap(spline: TrackSpline, halfWidth: number): void {
    const size = 168;
    const pad = 14;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of spline.samples) {
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
      minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z);
    }
    const spanX = maxX - minX || 1;
    const spanZ = maxZ - minZ || 1;
    const scale = (size - pad * 2) / Math.max(spanX, spanZ);
    const ox = minX - (Math.max(spanX, spanZ) - spanX) / 2;
    const oz = minZ - (Math.max(spanX, spanZ) - spanZ) / 2;
    this.minimapTransform = { ox, oz, scale, size: size - pad * 2 };
    const toXY = (x: number, z: number) => ({
      x: pad + (x - ox) * scale,
      y: pad + (z - oz) * scale,
    });

    while (this.minimapSvg.firstChild) this.minimapSvg.removeChild(this.minimapSvg.firstChild);
    let d = '';
    for (let i = 0; i < spline.samples.length; i++) {
      const p = toXY(spline.samples[i].x, spline.samples[i].z);
      d += `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
    }
    d += 'Z';
    const widthPx = clamp(halfWidth * scale * 2, 4, 14);
    const path = this.svg('path', { d, fill: 'none', stroke: 'rgba(0,240,255,0.22)', 'stroke-width': String(widthPx), 'stroke-linejoin': 'round' });
    const line = this.svg('path', { d, fill: 'none', stroke: 'rgba(0,240,255,0.7)', 'stroke-width': '1.4', 'stroke-dasharray': '2 3' });
    // start line marker
    const sp = toXY(spline.posAt(0).x, spline.posAt(0).z);
    const startMark = this.svg('circle', { cx: sp.x.toFixed(1), cy: sp.y.toFixed(1), r: '3', fill: '#ffb648' });
    this.minimapSvg.append(path, line, startMark);
    this.minimapBuilt = true;
    this.minimapBlips = [];
  }

  setTrack(spline: TrackSpline, halfWidth: number, laps: number, fieldSize: number): void {
    this.buildMinimap(spline, halfWidth);
    this.lapTotal.textContent = `/${laps}`;
    this.posTotal.textContent = `/${fieldSize}`;
    // reset per-race transient state
    this.lastPos = 0;
    this.lastLapCount = 0;
    this.lastDriftFlare = false;
    this.motionLines.length = 0;
  }

  // ----------------------------------------------------------- speed FX

  private updateMotionFx(speedKmh: number): void {
    const ctx = this.motionCtx;
    const W = this.motionCanvas.width;
    const H = this.motionCanvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!this.fxEnabled) return;

    // colour by speed band
    const color = speedKmh > 200 ? '#7a5cff' : speedKmh > 160 ? '#ff2bd6' : '#00f0ff';
    const cx = W / 2;
    const cy = H * 0.86; // emanate from near the speed pill

    // emit new streaks above 140 km/h, rate scaling with speed
    if (speedKmh > 140) {
      this.motionEmitAccum += (speedKmh - 140) / 60;
      while (this.motionEmitAccum >= 1 && this.motionLines.length < 40) {
        this.motionEmitAccum -= 1;
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
        this.motionLines.push({ x: cx, y: cy, angle, len: 60 + Math.random() * 160, t: 0, life: 0.45, color });
      }
    }
    // advance + draw
    const dt = 1 / 60;
    ctx.lineWidth = 2.5;
    for (let i = this.motionLines.length - 1; i >= 0; i--) {
      const ln = this.motionLines[i];
      ln.t += dt;
      if (ln.t >= ln.life) {
        this.motionLines.splice(i, 1);
        continue;
      }
      const prog = ln.t / ln.life;
      const dist = prog * 380;
      const ax = ln.x + Math.cos(ln.angle) * dist;
      const ay = ln.y + Math.sin(ln.angle) * dist;
      const bx = ln.x + Math.cos(ln.angle) * (dist + ln.len * (1 - prog));
      const by = ln.y + Math.sin(ln.angle) * (dist + ln.len * (1 - prog));
      ctx.globalAlpha = (1 - prog) * 0.5;
      ctx.strokeStyle = ln.color;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // edge vignette at very high speed
    if (speedKmh > 180) {
      const v = clamp01((speedKmh - 180) / 60) * 0.5;
      const grad = ctx.createRadialGradient(cx, H / 2, H * 0.25, cx, H / 2, H * 0.75);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, `rgba(2,3,10,${v})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
  }

  private showDriftFlare(): void {
    this.driftFlare.textContent = 'DRIFT BOOST';
    this.driftFlare.classList.remove('hidden', 'play');
    void this.driftFlare.offsetWidth;
    this.driftFlare.classList.add('play');
  }

  private showLapDelta(lapMs: number, lapTimes: number[], isPB: boolean): void {
    // delta vs previous best (the best BEFORE this lap)
    const prevBest = lapTimes.length > 1 ? Math.min(...lapTimes.slice(0, -1)) : Infinity;
    const delta = lapMs - prevBest;
    const pop = el('div', {
      class: 'lap-delta-popup ' + (isPB ? 'pb' : delta < 0 ? 'negative' : 'positive'),
      html: isPB ? `✓ ${formatTime(lapMs)}` : `${formatDelta(delta)}`,
    });
    this.deltaPopups.append(pop);
    setTimeout(() => pop.remove(), 900);
  }

  // ----------------------------------------------------------- per-frame

  update(args: {
    player: CarTelemetry | null;
    gesture: GestureDiagnostics;
    inputs: { throttle: number; brake: number; reverse: boolean; nitro: boolean; handbrake: boolean };
    progress: RacerProgress | undefined;
    raceTimeMs: number;
    cars: { id: string; isPlayer: boolean; x: number; z: number; color: number }[];
    profiler: Profiler;
    inputLatencyMs: number;
  }): void {
    const p = args.player;
    if (p) {
      const speed = Math.round(p.speedKmh);
      this.speedVal.textContent = String(speed);
      const speedFrac = clamp01(p.speedKmh / GAUGE_MAX_KMH);
      this.speedArc.setAttribute('d', this.arcPath(50, 50, 42, SPEEDO_START, SPEEDO_START + SPEEDO_SWEEP * speedFrac + 0.01));
      this.rpmArc.setAttribute('d', this.arcPath(50, 50, 33, SPEEDO_START, SPEEDO_START + SPEEDO_SWEEP * clamp01(p.rpm) + 0.01));
      this.gearVal.textContent = p.gear === 0 ? 'R' : String(p.gear);
      this.gearVal.style.color = p.gear === 0 ? 'var(--c-amber)' : 'var(--c-magenta)';

      // segmented nitro gauge: fill L→R, segments past 80% go magenta, flare when active
      const filled = Math.round(clamp01(p.nitro) * NITRO_SEGMENTS);
      for (let i = 0; i < NITRO_SEGMENTS; i++) {
        const on = i < filled;
        const hot = i >= NITRO_SEGMENTS * 0.8;
        const seg = this.nitroSegEls[i];
        seg.className = 'nseg' + (on ? ' on' : '') + (on && hot ? ' hot' : '');
      }
      this.nitroGauge.classList.toggle('flaring', p.nitroActive);

      // nitro screen flash (violet wash) eases in/out with activation
      this.nitroFlash.style.opacity = this.fxEnabled && p.nitroActive ? '0.16' : '0';

      // speed-reactive motion lines + edge vignette
      this.updateMotionFx(p.speedKmh);

      // drift-flare transient on drift + nitro combo
      const driftCombo = p.drifting && p.nitroActive;
      if (driftCombo && !this.lastDriftFlare) this.showDriftFlare();
      this.lastDriftFlare = driftCombo;
    }

    // gesture chips
    const flags: GestureFlags = {
      steer: args.gesture.wheelEngaged,
      throttle: args.inputs.throttle > 0.05 && !args.inputs.reverse,
      reverse: args.inputs.reverse,
      brake: args.inputs.brake > 0.1 && !args.inputs.handbrake,
      nitro: args.inputs.nitro,
      drift: args.inputs.handbrake,
    };
    for (const def of CHIP_DEFS) {
      const chip = this.chips.get(def.key)!;
      chip.classList.toggle('active', (flags as any)[def.key]);
      const conf = def.key === 'steer'
        ? Math.max(args.gesture.leftConfidence, args.gesture.rightConfidence)
        : (flags as any)[def.key] ? 1 : 0;
      this.chipConf.get(def.key)!.style.width = `${(conf * 100).toFixed(0)}%`;
    }

    // wheel indicator
    this.wheelInner.setAttribute('transform', `rotate(${(args.gesture.wheelAngleDeg).toFixed(1)} 50 50)`);

    // position / lap / timing
    if (args.progress) {
      const pos = args.progress.position;
      this.posVal.textContent = String(pos);
      // position pill: amber glow in P1, radar-ping flash when the position changes
      this.posChip.classList.toggle('first-place', pos === 1);
      if (this.lastPos && pos !== this.lastPos) {
        this.posChip.classList.remove('ping');
        void this.posChip.offsetWidth; // restart the one-shot animation
        this.posChip.classList.add('ping');
      }
      this.lastPos = pos;

      this.lapVal.textContent = String(Math.min(args.progress.lap, +this.lapTotal.textContent.slice(1)));
      const lapElapsed = args.raceTimeMs - args.progress.lapStartMs;
      this.curTime.textContent = formatTime(lapElapsed);
      this.bestTime.textContent = 'BEST ' + formatTime(args.progress.bestLapMs);
      if (isFinite(args.progress.bestLapMs) && args.progress.lapTimes.length > 0) {
        const delta = lapElapsed - args.progress.bestLapMs;
        this.deltaEl.textContent = formatDelta(delta);
        this.deltaEl.className = 'delta ' + (delta >= 0 ? 'pos' : 'neg');
      } else {
        this.deltaEl.textContent = '';
      }
      // lap-completed delta popup (fires once when a lap is banked)
      if (args.progress.lapTimes.length > this.lastLapCount) {
        this.lastLapCount = args.progress.lapTimes.length;
        const justRan = args.progress.lapTimes[args.progress.lapTimes.length - 1];
        const isPB = justRan <= args.progress.bestLapMs;
        this.showLapDelta(justRan, args.progress.lapTimes, isPB);
      }
      this.wrongWayEl.classList.toggle('hidden', !args.progress.wrongWay);
    }

    // minimap blips
    if (this.minimapBuilt) this.updateMinimapBlips(args.cars);

    // debug
    if (this.debugVisible) this.updateDebug(args.profiler, args.inputLatencyMs, args.gesture);
  }

  private updateMinimapBlips(cars: { id: string; isPlayer: boolean; x: number; z: number; color: number }[]): void {
    const { ox, oz, scale } = this.minimapTransform;
    const pad = 14;
    if (this.minimapBlips.length !== cars.length) {
      for (const b of this.minimapBlips) b.remove();
      this.minimapBlips = cars.map((c) => {
        const blip = this.svg('circle', { r: c.isPlayer ? '4' : '3', fill: c.isPlayer ? '#00f0ff' : '#' + c.color.toString(16).padStart(6, '0') });
        if (c.isPlayer) blip.setAttribute('stroke', '#fff'), blip.setAttribute('stroke-width', '1');
        this.minimapSvg.append(blip);
        return blip;
      });
    }
    cars.forEach((c, i) => {
      const blip = this.minimapBlips[i];
      blip.setAttribute('cx', (pad + (c.x - ox) * scale).toFixed(1));
      blip.setAttribute('cy', (pad + (c.z - oz) * scale).toFixed(1));
    });
  }

  private updateDebug(profiler: Profiler, latency: number, gesture: GestureDiagnostics): void {
    const snap = profiler.snapshot();
    const fpsCls = snap.fps >= 55 ? '' : snap.fps >= 40 ? 'warn' : 'bad';
    const latCls = latency <= 50 ? '' : latency <= 90 ? 'warn' : 'bad';
    this.debugPanel.innerHTML =
      `<span class="${fpsCls}">FPS <b>${snap.fps}</b></span> · ${snap.frameMs}ms<br>` +
      `CV <b>${snap.cvFps}</b>fps · ${snap.cvInferMs}ms<br>` +
      `<span class="${latCls}">INPUT <b>${Math.round(latency)}</b>ms</span><br>` +
      `hands ${gesture.handsVisible} ${gesture.coasting ? '· coast' : ''}`;
  }

  setDebugVisible(v: boolean): void {
    this.debugVisible = v;
    this.debugPanel.style.display = v ? '' : 'none';
  }

  // ----------------------------------------------------------- transient UI

  showCountdown(value: number | 'GO'): void {
    this.countdownLayer.innerHTML = '';
    const isGo = value === 'GO';
    const num = el('div', { class: 'num' + (isGo ? ' go' : ''), textContent: isGo ? 'GO!' : String(value) });
    if (isGo) {
      // radial speed-line burst behind GO!
      const burst = el('div', { class: 'countdown-burst' });
      for (let i = 0; i < 14; i++) {
        const line = el('div', { class: 'speed-line' });
        line.style.transform = `rotate(${((i / 14) * 360).toFixed(0)}deg)`;
        line.style.animationDelay = `${(i % 3) * 0.02}s`;
        burst.append(line);
      }
      this.countdownLayer.append(burst);
      setTimeout(() => burst.remove(), 900);
    }
    this.countdownLayer.append(num);
    setTimeout(() => num.remove(), isGo ? 1200 : 1000);
  }

  toast(message: string, kind: '' | 'best' | 'warn' = ''): void {
    const t = el('div', { class: `toast ${kind}`, textContent: message });
    this.toastStack.append(t);
    setTimeout(() => {
      t.style.transition = 'opacity 0.4s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 400);
    }, 2200);
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }
}
