/**
 * Calibration + gesture-training wizard screens. Both embed a large webcam
 * preview with the skeleton overlay and step the underlying pure-logic session
 * (CalibrationSession / GestureTrainer) from hand frames fed by the App.
 */
import { el } from './dom';
import { WebcamOverlay } from './WebcamOverlay';
import { CalibrationSession } from '../input/Calibration';
import { GestureTrainer, TRAINING_FRAMES } from '../input/CustomGestures';
import { featureVector } from '../vision/HandFeatures';
import type { CalibrationData, CustomGestureSample } from '../core/Settings';
import type { HandsState } from '../vision/HandTypes';

export class CalibrationWizard {
  readonly root: HTMLDivElement;
  readonly overlay: WebcamOverlay;
  private session: CalibrationSession | null = null;
  private msg: HTMLElement;
  private ring: HTMLElement;
  private steps: HTMLElement[] = [];
  private onComplete: ((data: CalibrationData) => void) | null = null;
  private onCancel: (() => void) | null = null;

  constructor() {
    this.overlay = new WebcamOverlay({ title: 'CALIBRATION', pip: false });
    this.msg = el('div', { class: 'wizard-step-msg' });
    this.ring = el('i');
    const stepDots = el('div', { class: 'wizard-steps' });
    for (let i = 0; i < 3; i++) {
      const d = el('div', { class: 'ws' });
      this.steps.push(d);
      stepDots.append(d);
    }
    const cancel = el('button', { class: 'neon', textContent: 'Cancel' });
    cancel.addEventListener('click', () => this.onCancel?.());
    const skip = el('button', { class: 'neon', textContent: 'Use Defaults' });
    skip.addEventListener('click', () => this.onCancel?.());

    const card = el('div', { class: 'panel screen-card', style: { textAlign: 'center' } as any }, [
      el('h2', { textContent: 'Calibrate Your Wheel' }),
      el('div', { class: 'wizard-stage' }, [
        this.overlay.root,
        stepDots,
        el('div', { class: 'wizard-ring' }, [this.ring]),
        this.msg,
      ]),
      el('div', { class: 'row end' }, [cancel, el('div', { class: 'spacer' }), skip]),
    ]);
    this.root = el('div', { class: 'layer interactive screen hidden' }, [card]);
  }

  begin(base: CalibrationData, video: HTMLVideoElement | null, mirror: boolean, onComplete: (d: CalibrationData) => void, onCancel: () => void): void {
    this.session = new CalibrationSession(base);
    this.onComplete = onComplete;
    this.onCancel = onCancel;
    if (video) this.overlay.attachVideo(video);
    this.overlay.setMirror(mirror);
    this.overlay.setNoCamera(!video);
    this.update0();
  }

  private update0(): void {
    if (!this.session) return;
    this.msg.textContent = this.session.message;
    this.ring.style.width = '0%';
  }

  /** Feed each frame from the App while this screen is active. */
  feed(hands: HandsState, dt: number): void {
    if (!this.session) return;
    this.overlay.render(hands);
    const done = this.session.feed(hands, dt);
    this.msg.textContent = this.session.message;
    this.ring.style.width = `${(this.session.progress * 100).toFixed(0)}%`;
    const order = ['neutral', 'lock', 'throttle', 'done'];
    const idx = order.indexOf(this.session.step);
    this.steps.forEach((d, i) => {
      d.classList.toggle('done', i < idx);
      d.classList.toggle('active', i === idx);
    });
    if (done) {
      const data = this.session.getResult();
      this.session = null;
      this.onComplete?.(data);
    }
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }
}

type TrainStage = 'choose' | 'record' | 'test' | 'done';

export class TrainingWizard {
  readonly root: HTMLDivElement;
  readonly overlay: WebcamOverlay;
  private trainer = new GestureTrainer();
  private stage: TrainStage = 'choose';
  private action: CustomGestureSample['action'] = 'nitro';
  private label = 'Custom Nitro';
  private msg: HTMLElement;
  private ring: HTMLElement;
  private actionBtns: HTMLDivElement;
  private recordBtn: HTMLButtonElement;
  private built: CustomGestureSample | null = null;
  private testHits = 0;
  private onSave: ((s: CustomGestureSample) => void) | null = null;
  private onCancel: (() => void) | null = null;

  constructor() {
    this.overlay = new WebcamOverlay({ title: 'TRAINING', pip: false });
    this.msg = el('div', { class: 'wizard-step-msg', textContent: 'Pick an action to bind a custom hand pose to.' });
    this.ring = el('i');

    this.actionBtns = el('div', { class: 'row' });
    for (const [act, label] of [['nitro', 'Nitro Boost'], ['pause', 'Pause'], ['camera', 'Camera']] as const) {
      const b = el('button', { class: 'neon', textContent: label });
      b.addEventListener('click', () => {
        this.action = act;
        this.label = `Custom ${label}`;
        this.startRecording();
      });
      this.actionBtns.append(b);
    }

    this.recordBtn = el('button', { class: 'neon primary', textContent: 'Hold your pose…', disabled: true }) as HTMLButtonElement;

    const cancel = el('button', { class: 'neon', textContent: 'Cancel' });
    cancel.addEventListener('click', () => this.onCancel?.());
    const retry = el('button', { class: 'neon', textContent: 'Retry' });
    retry.addEventListener('click', () => this.startRecording());

    const card = el('div', { class: 'panel screen-card', style: { textAlign: 'center' } as any }, [
      el('h2', { textContent: 'Gesture Training' }),
      el('div', { class: 'wizard-stage' }, [
        this.overlay.root,
        el('div', { class: 'wizard-ring' }, [this.ring]),
        this.msg,
        this.actionBtns,
      ]),
      el('div', { class: 'row end' }, [cancel, retry, el('div', { class: 'spacer' }), this.recordBtn]),
    ]);
    this.root = el('div', { class: 'layer interactive screen hidden' }, [card]);
  }

  begin(video: HTMLVideoElement | null, mirror: boolean, onSave: (s: CustomGestureSample) => void, onCancel: () => void): void {
    this.onSave = onSave;
    this.onCancel = onCancel;
    if (video) this.overlay.attachVideo(video);
    this.overlay.setMirror(mirror);
    this.overlay.setNoCamera(!video);
    this.stage = 'choose';
    this.built = null;
    this.testHits = 0;
    this.actionBtns.classList.remove('hidden');
    this.recordBtn.disabled = true;
    this.msg.textContent = 'Pick an action to bind a custom hand pose to.';
    this.ring.style.width = '0%';
  }

  private startRecording(): void {
    this.trainer.reset();
    this.stage = 'record';
    this.built = null;
    this.testHits = 0;
    this.actionBtns.classList.add('hidden');
    this.recordBtn.disabled = true;
    this.recordBtn.textContent = 'Hold your pose…';
    this.msg.textContent = `Hold a distinctive pose for "${this.label}". Keep it steady…`;
  }

  feed(hands: HandsState, _dt: number): void {
    this.overlay.render(hands);
    const hand = hands.right ?? hands.left;

    if (this.stage === 'record') {
      if (hand && !hand.coasting) {
        this.trainer.addSample(featureVector(hand.features));
      }
      this.ring.style.width = `${(this.trainer.progress * 100).toFixed(0)}%`;
      this.msg.textContent = `Recording… ${Math.round(this.trainer.progress * TRAINING_FRAMES)}/${TRAINING_FRAMES} frames. Hold steady.`;
      if (this.trainer.isComplete) {
        const sample = this.trainer.build(this.action, this.label);
        if (!sample) {
          this.stage = 'choose';
          this.actionBtns.classList.remove('hidden');
          this.msg.textContent = 'Too inconsistent — pick an action and try holding the pose more steadily.';
          this.ring.style.width = '0%';
          return;
        }
        this.built = sample;
        this.stage = 'test';
        this.msg.textContent = 'Got it! Now make the pose again to confirm it triggers reliably.';
        this.recordBtn.disabled = false;
        this.recordBtn.textContent = 'Save Gesture';
        this.recordBtn.onclick = () => {
          if (this.built) this.onSave?.(this.built);
        };
      }
    } else if (this.stage === 'test' && this.built && hand && !hand.coasting) {
      const vec = featureVector(hand.features);
      const sim = cosineSim(vec, this.built.centroid);
      const hit = sim >= this.built.threshold;
      if (hit) this.testHits = Math.min(this.testHits + 1, 30);
      else this.testHits = Math.max(this.testHits - 1, 0);
      this.ring.style.width = `${((this.testHits / 30) * 100).toFixed(0)}%`;
      this.msg.textContent = hit ? '✓ Recognised! Save when happy.' : 'Make your trained pose to test recognition…';
    }
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
