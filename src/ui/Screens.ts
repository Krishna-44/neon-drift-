/**
 * Front-end screens: main menu, track select, settings (tabbed, live-bound to
 * the SettingsStore), pause overlay, results, and help. Each is a self-managed
 * panel; the App wires high-level callbacks and toggles visibility via the
 * StateMachine. All controls are real <button>/<input> elements so the gesture
 * cursor (which dispatches DOM clicks) drives them for free.
 */
import { el, clear, formatTime, ordinal } from './dom';
import { TRACKS } from '../track/TrackData';
import type { SettingsStore } from '../core/Settings';
import type { RacerProgress } from '../ai/RaceDirector';
import type { AIDifficulty } from '../ai/AIDriver';

export interface MenuCallbacks {
  onPlay(): void;
  onCalibrate(): void;
  onTrain(): void;
  onSettings(): void;
  onHelp(): void;
}

export class MainMenu {
  readonly root: HTMLDivElement;
  private cvDot: HTMLSpanElement;
  private cvText: HTMLSpanElement;

  constructor(cb: MenuCallbacks) {
    this.cvDot = el('span', { class: 'cv-dot' });
    this.cvText = el('span', { textContent: 'Camera: idle' });
    const badge = el('div', { class: 'cv-badge' }, [this.cvDot, this.cvText]);

    const mkBtn = (label: string, fn: () => void, primary = false) => {
      const b = el('button', { class: `neon${primary ? ' primary' : ''}`, textContent: label });
      b.addEventListener('click', fn);
      return b;
    };
    const buttons = el('div', { class: 'menu-buttons' }, [
      mkBtn('Race', cb.onPlay, true),
      mkBtn('Calibrate Hands', cb.onCalibrate),
      mkBtn('Gesture Training', cb.onTrain),
      mkBtn('Settings', cb.onSettings),
      mkBtn('How To Play', cb.onHelp),
    ]);

    this.root = el('div', { class: 'layer interactive', id: 'menu-root' }, [
      el('div', { class: 'menu-grid-bg' }),
      badge,
      el('h1', { class: 'title', html: 'NEON<span class="glitch">DRIFT</span> <span style="color:var(--c-magenta)">GP</span>' }),
      el('p', { class: 'subtitle', textContent: 'Gesture-Controlled Racing Simulator' }),
      buttons,
      el('div', { class: 'menu-foot', html: 'Drive with your hands · No controller required · ESC to pause in race' }),
    ]);
  }

  setCameraStatus(state: 'idle' | 'ok' | 'warn' | 'error', text: string): void {
    this.cvDot.className = 'cv-dot' + (state === 'ok' ? ' ok' : state === 'warn' ? ' warn' : '');
    this.cvText.textContent = text;
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }
}

export interface TrackSelectCallbacks {
  onStart(cfg: { trackId: string; opponents: number; laps: number; difficulty: AIDifficulty }): void;
  onBack(): void;
}

export class TrackSelect {
  readonly root: HTMLDivElement;
  private selected = TRACKS[0].id;
  private opponents = 5;
  private laps = 3;
  private difficulty: AIDifficulty = 'racer';
  private cards = new Map<string, HTMLElement>();

  constructor(cb: TrackSelectCallbacks, defaults: { trackId: string; opponents: number; laps: number }) {
    this.selected = defaults.trackId;
    this.opponents = defaults.opponents;
    this.laps = defaults.laps;

    const grid = el('div', { class: 'track-grid' });
    for (const t of TRACKS) {
      const card = el('div', {
        class: 'track-card' + (t.id === this.selected ? ' selected' : ''),
        dataset: { track: t.id },
        style: { '--card-accent': t.accentColor, '--card-accent2': t.accentColor2 } as any,
      }, [
        el('div', { class: 'tc-name', textContent: t.name }),
        el('div', { class: 'tc-tag', textContent: t.tagline }),
        el('div', { class: 'tc-diff', textContent: 'DIFFICULTY ' + '◆'.repeat(t.difficulty) + '◇'.repeat(3 - t.difficulty) }),
        el('div', { class: 'tc-bar' }),
      ]);
      card.setAttribute('data-gesture-click', '');
      card.addEventListener('click', () => this.select(t.id));
      this.cards.set(t.id, card);
      grid.append(card);
    }

    const oppVal = el('span', { class: 'val', textContent: String(this.opponents) });
    const oppRange = el('input', { type: 'range', min: '0', max: '7', value: String(this.opponents) }) as HTMLInputElement;
    oppRange.addEventListener('input', () => {
      this.opponents = +oppRange.value;
      oppVal.textContent = oppRange.value;
    });
    const lapVal = el('span', { class: 'val', textContent: String(this.laps) });
    const lapRange = el('input', { type: 'range', min: '1', max: '10', value: String(this.laps) }) as HTMLInputElement;
    lapRange.addEventListener('input', () => {
      this.laps = +lapRange.value;
      lapVal.textContent = lapRange.value;
    });
    const diffSel = el('select') as HTMLSelectElement;
    for (const [v, label] of [['rookie', 'Rookie'], ['racer', 'Racer'], ['pro', 'Pro']] as const) {
      diffSel.append(el('option', { value: v, textContent: label, selected: v === this.difficulty }));
    }
    diffSel.addEventListener('change', () => (this.difficulty = diffSel.value as AIDifficulty));

    const opts = el('div', {}, [
      el('div', { class: 'setting' }, [el('label', { textContent: 'Opponents' }), oppRange, oppVal]),
      el('div', { class: 'setting' }, [el('label', { textContent: 'Laps' }), lapRange, lapVal]),
      el('div', { class: 'setting' }, [el('label', { textContent: 'AI Difficulty' }), diffSel]),
    ]);

    const back = el('button', { class: 'neon', textContent: 'Back' });
    back.addEventListener('click', cb.onBack);
    const start = el('button', { class: 'neon primary', textContent: 'Start Race' });
    start.addEventListener('click', () =>
      cb.onStart({ trackId: this.selected, opponents: this.opponents, laps: this.laps, difficulty: this.difficulty }),
    );

    const card = el('div', { class: 'panel screen-card' }, [
      el('h2', { textContent: 'Select Circuit' }),
      el('p', { class: 'hint', textContent: 'Choose your track and race setup. Open palm + pinch to select with gestures.' }),
      grid,
      opts,
      el('div', { class: 'row end' }, [back, el('div', { class: 'spacer' }), start]),
    ]);
    this.root = el('div', { class: 'layer interactive screen hidden' }, [card]);
  }

  private select(id: string): void {
    this.selected = id;
    for (const [tid, card] of this.cards) card.classList.toggle('selected', tid === id);
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }
}

export class SettingsScreen {
  readonly root: HTMLDivElement;
  private body: HTMLDivElement;
  private tab: 'graphics' | 'audio' | 'controls' = 'graphics';

  constructor(
    private settings: SettingsStore,
    private cb: { onClose(): void; onRecalibrate(): void; onApply(): void },
  ) {
    this.body = el('div');
    const tabs = el('div', { class: 'settings-tabs' });
    for (const [key, label] of [['graphics', 'Graphics'], ['audio', 'Audio'], ['controls', 'Controls']] as const) {
      const t = el('div', { class: 'tab' + (key === this.tab ? ' active' : ''), textContent: label, dataset: { tab: key } });
      t.setAttribute('data-gesture-click', '');
      t.addEventListener('click', () => {
        this.tab = key;
        tabs.querySelectorAll('.tab').forEach((n) => n.classList.toggle('active', (n as HTMLElement).dataset.tab === key));
        this.render();
      });
      tabs.append(t);
    }

    const close = el('button', { class: 'neon primary', textContent: 'Done' });
    close.addEventListener('click', () => {
      this.cb.onApply();
      this.cb.onClose();
    });

    const card = el('div', { class: 'panel screen-card' }, [
      el('h2', { textContent: 'Settings' }),
      tabs,
      this.body,
      el('div', { class: 'row end' }, [close]),
    ]);
    this.root = el('div', { class: 'layer interactive screen hidden' }, [card]);
    this.render();
  }

  private slider(label: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number, fmt?: (v: number) => string): HTMLElement {
    const val = el('span', { class: 'val', textContent: (fmt ?? String)(get()) });
    const range = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()) }) as HTMLInputElement;
    range.addEventListener('input', () => {
      const v = +range.value;
      set(v);
      val.textContent = (fmt ?? String)(v);
      this.settings.save();
    });
    return el('div', { class: 'setting' }, [el('label', { textContent: label }), range, val]);
  }

  private toggle(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const tg = el('div', { class: 'toggle' + (get() ? ' on' : '') });
    tg.setAttribute('data-gesture-click', '');
    tg.addEventListener('click', () => {
      const nv = !get();
      set(nv);
      tg.classList.toggle('on', nv);
      this.settings.save();
    });
    return el('div', { class: 'setting' }, [el('label', { textContent: label }), el('div', { class: 'spacer' }), tg]);
  }

  private select(label: string, options: [string, string][], get: () => string, set: (v: string) => void): HTMLElement {
    const sel = el('select') as HTMLSelectElement;
    for (const [v, l] of options) sel.append(el('option', { value: v, textContent: l, selected: v === get() }));
    sel.addEventListener('change', () => {
      set(sel.value);
      this.settings.save();
    });
    return el('div', { class: 'setting' }, [el('label', { textContent: label }), sel]);
  }

  private render(): void {
    clear(this.body);
    const s = this.settings.data;
    if (this.tab === 'graphics') {
      this.body.append(
        this.select('Quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], () => s.graphics.quality, (v) => (s.graphics.quality = v as any)),
        this.toggle('Bloom / Glow', () => s.graphics.bloom, (v) => (s.graphics.bloom = v)),
        this.toggle('Particles', () => s.graphics.particles, (v) => (s.graphics.particles = v)),
        this.toggle('Performance HUD', () => s.graphics.showFpsHud, (v) => (s.graphics.showFpsHud = v)),
        this.select('Camera', [['chase', 'Chase'], ['cockpit', 'Cockpit']], () => s.camera, (v) => (s.camera = v as any)),
      );
    } else if (this.tab === 'audio') {
      const pct = (v: number) => `${Math.round(v * 100)}`;
      this.body.append(
        this.slider('Master', () => s.audio.master, (v) => (s.audio.master = v), 0, 1, 0.01, pct),
        this.slider('Engine', () => s.audio.engine, (v) => (s.audio.engine = v), 0, 1, 0.01, pct),
        this.slider('Effects', () => s.audio.sfx, (v) => (s.audio.sfx = v), 0, 1, 0.01, pct),
        this.slider('Music', () => s.audio.music, (v) => (s.audio.music = v), 0, 1, 0.01, pct),
      );
    } else {
      const recal = el('button', { class: 'neon', textContent: 'Re-run Calibration' });
      recal.addEventListener('click', this.cb.onRecalibrate);
      this.body.append(
        this.slider('Steering Sensitivity', () => s.control.steerSensitivity, (v) => (s.control.steerSensitivity = v), 0.5, 2, 0.05, (v) => v.toFixed(2)),
        this.slider('Steering Smoothing', () => s.control.steerSmoothing, (v) => (s.control.steerSmoothing = v), 0, 1, 0.05, (v) => v.toFixed(2)),
        this.slider('Dead Zone (deg)', () => s.control.deadZoneDeg, (v) => (s.control.deadZoneDeg = v), 0, 20, 1),
        this.slider('Throttle Softness', () => s.control.throttleExpo, (v) => (s.control.throttleExpo = v), 0, 0.6, 0.05, (v) => v.toFixed(2)),
        this.select('Throttle Hand', [['either', 'Either'], ['right', 'Right'], ['left', 'Left']], () => s.control.throttleHand, (v) => (s.control.throttleHand = v as any)),
        this.toggle('Mirror Webcam', () => s.control.mirrorPreview, (v) => (s.control.mirrorPreview = v)),
        this.toggle('Stability Assist', () => s.control.stabilityAssist, (v) => (s.control.stabilityAssist = v)),
        this.toggle('Counter-Steer Assist', () => s.control.counterSteerAssist, (v) => (s.control.counterSteerAssist = v)),
        this.toggle('Adaptive Assists', () => s.control.adaptiveAssists, (v) => (s.control.adaptiveAssists = v)),
        el('div', { class: 'row', style: { marginTop: '16px' } as any }, [recal]),
      );
    }
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
    if (v) this.render();
  }
}

export class PauseScreen {
  readonly root: HTMLDivElement;
  constructor(cb: { onResume(): void; onRestart(): void; onSettings(): void; onQuit(): void }) {
    const mk = (label: string, fn: () => void, primary = false) => {
      const b = el('button', { class: `neon${primary ? ' primary' : ''}`, textContent: label });
      b.addEventListener('click', fn);
      return b;
    };
    const card = el('div', { class: 'panel screen-card', style: { maxWidth: '420px', textAlign: 'center' } as any }, [
      el('h2', { textContent: 'Paused' }),
      el('p', { class: 'hint', textContent: 'Open palm (2s) or ESC resumes. Show an open palm to navigate; pinch to select.' }),
      el('div', { class: 'menu-buttons', style: { width: '100%' } as any }, [
        mk('Resume', cb.onResume, true),
        mk('Restart Race', cb.onRestart),
        mk('Settings', cb.onSettings),
        mk('Quit to Menu', cb.onQuit),
      ]),
    ]);
    this.root = el('div', { class: 'layer interactive screen hidden' }, [card]);
  }
  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }
}

export class ResultsScreen {
  readonly root: HTMLDivElement;
  private body: HTMLDivElement;
  constructor(cb: { onReplay(): void; onAgain(): void; onMenu(): void }) {
    this.body = el('div');
    const replay = el('button', { class: 'neon', textContent: 'Watch Replay' });
    replay.addEventListener('click', cb.onReplay);
    const again = el('button', { class: 'neon primary', textContent: 'Race Again' });
    again.addEventListener('click', cb.onAgain);
    const menu = el('button', { class: 'neon', textContent: 'Main Menu' });
    menu.addEventListener('click', cb.onMenu);
    const card = el('div', { class: 'panel screen-card' }, [
      el('h2', { textContent: 'Race Complete' }),
      this.body,
      el('div', { class: 'row end' }, [menu, replay, el('div', { class: 'spacer' }), again]),
    ]);
    this.root = el('div', { class: 'layer interactive screen hidden' }, [card]);
  }

  show(standings: RacerProgress[], playerSkill: number, suggestedDifficulty: string): void {
    clear(this.body);
    const table = el('table', { class: 'results-table' });
    const head = el('tr', {}, [
      el('th', { textContent: 'Pos' }),
      el('th', { textContent: 'Driver' }),
      el('th', { textContent: 'Best Lap' }),
      el('th', { textContent: 'Total' }),
    ]);
    table.append(el('thead', {}, [head]));
    const tbody = el('tbody');
    standings.forEach((r, i) => {
      const pos = i + 1;
      const badge = el('span', { class: `pos-badge p${pos <= 3 ? pos : ''}`, textContent: String(pos) });
      const row = el('tr', { class: r.isPlayer ? 'player' : '' }, [
        el('td', {}, [badge]),
        el('td', { textContent: r.isPlayer ? 'YOU' : `CPU ${r.id.replace('ai', '')}` }),
        el('td', { textContent: formatTime(r.bestLapMs) }),
        el('td', { textContent: r.finished ? formatTime(r.finishTimeMs) : 'DNF' }),
      ]);
      tbody.append(row);
    });
    table.append(tbody);

    const player = standings.find((r) => r.isPlayer);
    const place = player ? standings.indexOf(player) + 1 : standings.length;
    const summary = el('p', { class: 'hint', html:
      `You finished <b style="color:var(--c-cyan)">${ordinal(place)}</b> · ` +
      `Skill rating <b style="color:var(--c-amber)">${Math.round(playerSkill)}</b>/100 · ` +
      `Suggested AI: <b>${suggestedDifficulty}</b>` });
    this.body.append(summary, table);
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }
}

export class HelpScreen {
  readonly root: HTMLDivElement;
  constructor(cb: { onBack(): void }) {
    const gestures: [string, string, string][] = [
      ['🖐🖐', 'Steer', 'Hold both hands like a wheel; rotate to turn'],
      ['👎', 'Throttle', 'Right-hand thumb down — deeper = more gas'],
      ['👍', 'Reverse', 'Thumb up to select reverse gear'],
      ['✊', 'Brake', 'Make a fist (both fists = max brake)'],
      ['✌️', 'Nitro', 'Peace / V sign for a boost'],
      ['✊↘', 'Drift', 'Fist while turning hard pulls the handbrake'],
      ['🖐', 'Pause', 'Hold an open palm for 2 seconds'],
    ];
    const guide = el('div', { class: 'gesture-guide' },
      gestures.map(([ico, t, d]) =>
        el('div', { class: 'gg-row' }, [
          el('div', { class: 'gg-ico', textContent: ico }),
          el('div', { class: 'gg-txt' }, [el('b', { textContent: t }), el('span', { textContent: d })]),
        ]),
      ),
    );
    const keys: [string, string][] = [
      ['↑ / W', 'Throttle'], ['↓ / S', 'Brake'], ['← → / A D', 'Steer'],
      ['Space', 'Drift / Handbrake'], ['Shift', 'Nitro'], ['R', 'Reverse'],
      ['C', 'Camera view'], ['ESC', 'Pause'], ['H', 'Toggle perf HUD'],
    ];
    const kbd = el('div', { class: 'kbd-list' });
    for (const [k, d] of keys) kbd.append(el('div', { class: 'k', textContent: k }), el('div', { textContent: d }));

    const back = el('button', { class: 'neon primary', textContent: 'Got it' });
    back.addEventListener('click', cb.onBack);

    const card = el('div', { class: 'panel screen-card' }, [
      el('h2', { textContent: 'How To Play' }),
      el('p', { class: 'hint', textContent: 'Drive entirely with your hands via the webcam — or use the keyboard fallback anytime.' }),
      el('div', { class: 'help-cols' }, [
        el('div', {}, [el('h3', { textContent: 'Gestures', style: { color: 'var(--c-magenta)', letterSpacing: '0.1em' } as any }), guide]),
        el('div', {}, [el('h3', { textContent: 'Keyboard', style: { color: 'var(--c-cyan)', letterSpacing: '0.1em' } as any }), kbd]),
      ]),
      el('div', { class: 'row end' }, [back]),
    ]);
    this.root = el('div', { class: 'layer interactive screen hidden' }, [card]);
  }
  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }
}
