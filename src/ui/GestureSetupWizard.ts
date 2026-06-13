/**
 * Guided gesture setup — the first-run "stand in front of the camera" flow.
 *
 * Walks the user through each driving action, counts them in, then RECORDS
 * their own pose (averaged feature centroid) for it: relax → throttle (fist) →
 * brake (thumb down) → reverse (thumb up) → nitro (peace). The captured set is
 * handed back so the GestureMapper can recognise the user's personal poses,
 * making in-game control easier and more reliable. Fed hand frames by the App.
 */
import { el } from './dom';
import { WebcamOverlay } from './WebcamOverlay';
import { featureVector } from '../vision/HandFeatures';
import { centroidOf, DriveAction, DriveCentroid, DrivingGestureSet } from '../input/PersonalGestures';
import type { HandsState, TrackedHand } from '../vision/HandTypes';

interface SetupStep {
  action: DriveAction;
  title: string;
  instr: string;
  emoji: string;
}

const STEPS: SetupStep[] = [
  { action: 'idle', title: 'Relax', instr: 'Hold your hand relaxed — loosely curled, like resting on a wheel', emoji: '🖐' },
  { action: 'throttle', title: 'Accelerate', instr: 'Make a tight FIST — this is your GAS', emoji: '✊' },
  { action: 'brake', title: 'Brake', instr: 'Point your THUMB DOWN — this is your BRAKE', emoji: '👎' },
  { action: 'reverse', title: 'Reverse', instr: 'Point your THUMB UP — this is REVERSE', emoji: '👍' },
  { action: 'nitro', title: 'Nitro', instr: 'Make a PEACE / V sign — this is your NITRO boost', emoji: '✌️' },
];

const PREP_SECONDS = 2.0;
const RECORD_FRAMES = 40;

type Phase = 'await-hands' | 'prep' | 'record' | 'done';

export class GestureSetupWizard {
  readonly root: HTMLDivElement;
  readonly overlay: WebcamOverlay;
  private phase: Phase = 'await-hands';
  private stepIdx = 0;
  private prepT = 0;
  private samples: number[][] = [];
  private captured: DriveCentroid[] = [];
  private onComplete: ((set: DrivingGestureSet) => void) | null = null;
  private onCancel: (() => void) | null = null;
  private nowMs = 0;

  private emojiEl: HTMLElement;
  private titleEl: HTMLElement;
  private instrEl: HTMLElement;
  private ring: HTMLElement;
  private countEl: HTMLElement;
  private dots: HTMLElement[] = [];

  constructor() {
    this.overlay = new WebcamOverlay({ title: 'GESTURE SETUP', pip: false });
    this.emojiEl = el('div', { class: 'gsw-emoji', textContent: '🖐🖐' });
    this.titleEl = el('div', { class: 'gsw-title', textContent: 'Gesture Setup' });
    this.instrEl = el('div', { class: 'wizard-step-msg', textContent: '' });
    this.ring = el('i');
    this.countEl = el('div', { class: 'gsw-count' });

    const dotRow = el('div', { class: 'wizard-steps' });
    for (let i = 0; i < STEPS.length; i++) {
      const d = el('div', { class: 'ws' });
      this.dots.push(d);
      dotRow.append(d);
    }

    const cancel = el('button', { class: 'neon', textContent: 'Skip Setup' });
    cancel.addEventListener('click', () => this.onCancel?.());

    const card = el('div', { class: 'panel screen-card', style: { textAlign: 'center', maxWidth: '620px' } as any }, [
      el('h2', { textContent: 'Teach Your Gestures' }),
      el('p', { class: 'hint', textContent: 'Stand in front of the camera with one hand clearly visible. We’ll record YOUR version of each control so the game reads you reliably.' }),
      el('div', { class: 'wizard-stage' }, [
        this.overlay.root,
        dotRow,
        this.emojiEl,
        this.titleEl,
        this.countEl,
        el('div', { class: 'wizard-ring' }, [this.ring]),
        this.instrEl,
      ]),
      el('div', { class: 'row end' }, [cancel]),
    ]);
    this.root = el('div', { class: 'layer interactive screen hidden' }, [card]);
  }

  begin(video: HTMLVideoElement | null, mirror: boolean, onComplete: (set: DrivingGestureSet) => void, onCancel: () => void): void {
    this.onComplete = onComplete;
    this.onCancel = onCancel;
    if (video) this.overlay.attachVideo(video);
    this.overlay.setMirror(mirror);
    this.overlay.setNoCamera(!video);
    this.phase = 'await-hands';
    this.stepIdx = 0;
    this.prepT = 0;
    this.samples = [];
    this.captured = [];
    this.render();
  }

  private activeHand(hands: HandsState): TrackedHand | null {
    // prefer the right hand; fall back to whichever is visible & not coasting
    const r = hands.right && !hands.right.coasting ? hands.right : null;
    const l = hands.left && !hands.left.coasting ? hands.left : null;
    return r ?? l;
  }

  /** Feed each frame from the App while this screen is active. */
  feed(hands: HandsState, dt: number): void {
    this.nowMs += dt * 1000;
    this.overlay.render(hands);
    const hand = this.activeHand(hands);

    if (this.phase === 'await-hands') {
      if (hand) {
        this.phase = 'prep';
        this.prepT = PREP_SECONDS;
      }
      this.render(hand);
      return;
    }

    if (this.phase === 'prep') {
      this.prepT -= dt;
      if (this.prepT <= 0) {
        this.phase = 'record';
        this.samples = [];
      }
      this.render(hand);
      return;
    }

    if (this.phase === 'record') {
      if (hand) this.samples.push(featureVector(hand.features));
      this.render(hand);
      if (this.samples.length >= RECORD_FRAMES) {
        this.captured.push({ action: STEPS[this.stepIdx].action, centroid: centroidOf(this.samples) });
        this.dots[this.stepIdx]?.classList.add('done');
        this.stepIdx++;
        if (this.stepIdx >= STEPS.length) {
          this.finish();
        } else {
          this.phase = 'prep';
          this.prepT = PREP_SECONDS;
        }
      }
    }
  }

  private finish(): void {
    this.phase = 'done';
    const set: DrivingGestureSet = { trained: true, classes: this.captured, trainedAt: this.nowMs > 0 ? Date.now() : 0 };
    this.instrEl.textContent = 'All set! Your gestures are personalised.';
    this.onComplete?.(set);
  }

  private render(hand: TrackedHand | null = null): void {
    const step = STEPS[this.stepIdx];
    this.dots.forEach((d, i) => d.classList.toggle('active', i === this.stepIdx && this.phase !== 'done'));

    if (this.phase === 'await-hands') {
      this.emojiEl.textContent = '🖐';
      this.titleEl.textContent = 'Show your hand';
      this.instrEl.textContent = 'Raise one hand so the camera can see it…';
      this.countEl.textContent = '';
      this.ring.style.width = '0%';
      return;
    }

    this.emojiEl.textContent = step.emoji;
    this.titleEl.textContent = step.title;
    this.instrEl.textContent = step.instr;

    if (this.phase === 'prep') {
      const secs = Math.ceil(this.prepT);
      this.countEl.textContent = hand ? `Get ready… ${secs}` : 'Show your hand to the camera';
      this.ring.style.width = '0%';
    } else if (this.phase === 'record') {
      this.countEl.textContent = hand ? 'Hold it… recording' : 'Keep your hand visible!';
      this.ring.style.width = `${Math.round((this.samples.length / RECORD_FRAMES) * 100)}%`;
    }
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }
}
