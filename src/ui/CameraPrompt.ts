/**
 * Camera-permission overlay.
 *
 * An explicit, friendly gate that asks the user to grant webcam access so the
 * MediaPipe hand tracker (the "YOLO-style" landmark detector) can drive the
 * car. Requesting from a real button click (a user gesture) is far more
 * reliable than a silent boot-time getUserMedia call, and the overlay handles
 * every outcome: prompt → granted (with a device picker), denied (with
 * re-enable instructions), or no-camera (offer demo mode).
 *
 * Self-contained DOM + a callback API; the App wires it to the CameraManager.
 */
import { el } from './dom';

export interface CameraPromptCallbacks {
  /** Request the camera (from the user click). Resolve with the granted state. */
  onEnable(deviceId?: string): Promise<'granted' | 'denied' | 'unavailable'>;
  /** List available cameras (labels only populate after a grant). */
  listDevices(): Promise<{ id: string; label: string }[]>;
  /** User chose to skip and play with synthetic demo + keyboard. */
  onDemo(): void;
  /** Overlay dismissed after camera is live. */
  onClose(): void;
}

export class CameraPrompt {
  readonly root: HTMLDivElement;
  private body: HTMLElement;
  private actions: HTMLElement;
  private deviceSel: HTMLSelectElement;
  private deviceRow: HTMLElement;
  private cb: CameraPromptCallbacks | null = null;
  private visible = false;

  constructor() {
    this.body = el('div', { class: 'cam-body' });
    this.deviceSel = el('select', { class: 'cam-device' }) as HTMLSelectElement;
    this.deviceRow = el('div', { class: 'cam-device-row hidden' }, [
      el('label', { textContent: 'Camera' }),
      this.deviceSel,
    ]);
    this.actions = el('div', { class: 'row end cam-actions' });

    const card = el('div', { class: 'panel screen-card cam-card' }, [
      el('div', { class: 'cam-icon', html: '📷' }),
      el('h2', { textContent: 'Enable Hand Tracking' }),
      this.body,
      this.deviceRow,
      this.actions,
    ]);
    this.root = el('div', { class: 'layer interactive screen hidden cam-prompt' }, [card]);

    this.deviceSel.addEventListener('change', () => {
      // re-request with the chosen device
      if (this.cb) void this.request(this.deviceSel.value);
    });
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Show the intro state and wire callbacks. */
  open(cb: CameraPromptCallbacks, currentState: 'granted' | 'denied' | 'prompt' | 'unknown', hasCamera: boolean): void {
    this.cb = cb;
    this.visible = true;
    this.root.classList.remove('hidden');
    if (!hasCamera) this.renderNoCamera();
    else if (currentState === 'denied') this.renderDenied();
    else this.renderIntro();
  }

  hide(): void {
    this.visible = false;
    this.root.classList.add('hidden');
  }

  private setActions(buttons: HTMLElement[]): void {
    this.actions.innerHTML = '';
    for (const b of buttons) this.actions.append(b);
  }

  private btn(label: string, fn: () => void, primary = false): HTMLButtonElement {
    const b = el('button', { class: `neon${primary ? ' primary' : ''}`, textContent: label }) as HTMLButtonElement;
    b.setAttribute('data-gesture-click', '');
    b.addEventListener('click', fn);
    return b;
  }

  private renderIntro(): void {
    this.deviceRow.classList.add('hidden');
    this.body.innerHTML =
      '<p class="hint">NEONDRIFT GP steers with your hands. Allow camera access and the on-screen tracker will read your hand pose in real time — no controller needed.</p>' +
      '<ul class="cam-points">' +
      '<li>🖐 Sit ~60&nbsp;cm from the camera with both hands visible</li>' +
      '<li>🟦 The corner screen shows exactly what the tracker sees</li>' +
      '<li>🔒 Video never leaves your device — all processing is local</li>' +
      '</ul>';
    this.setActions([
      this.btn('Use Demo + Keyboard', () => this.cb?.onDemo()),
      el('div', { class: 'spacer' }),
      this.btn('Enable Camera', () => void this.request(), true),
    ]);
  }

  private renderRequesting(): void {
    this.body.innerHTML = '<div class="cam-spinner"></div><p class="hint">Requesting camera… choose <b>Allow</b> in your browser’s prompt.</p>';
    this.setActions([]);
  }

  private renderDenied(): void {
    this.deviceRow.classList.add('hidden');
    this.body.innerHTML =
      '<p class="hint cam-warn">Camera access is blocked.</p>' +
      '<ol class="cam-points">' +
      '<li>Click the 🔒 / camera icon in your browser’s address bar</li>' +
      '<li>Set Camera to <b>Allow</b> for this site</li>' +
      '<li>Then press <b>Try Again</b> below</li>' +
      '</ol>' +
      '<p class="hint">On the desktop app, allow access when Windows asks. You can always play with the keyboard instead.</p>';
    this.setActions([
      this.btn('Use Demo + Keyboard', () => this.cb?.onDemo()),
      el('div', { class: 'spacer' }),
      this.btn('Try Again', () => void this.request(), true),
    ]);
  }

  private renderNoCamera(): void {
    this.deviceRow.classList.add('hidden');
    this.body.innerHTML =
      '<p class="hint cam-warn">No webcam detected on this device.</p>' +
      '<p class="hint">Plug in a camera and press Retry, or play with the synthetic demo driver and the keyboard (WASD / arrows).</p>';
    this.setActions([
      this.btn('Play with Keyboard', () => this.cb?.onDemo(), true),
      el('div', { class: 'spacer' }),
      this.btn('Retry', () => void this.request()),
    ]);
  }

  private async renderGranted(): Promise<void> {
    this.body.innerHTML = '<p class="hint cam-ok">✓ Camera connected — hand tracking is live!</p><p class="hint">Pick a different camera below if needed, then close to start.</p>';
    // populate device picker
    const devices = (await this.cb?.listDevices()) ?? [];
    if (devices.length > 1) {
      this.deviceSel.innerHTML = '';
      for (const d of devices) this.deviceSel.append(el('option', { value: d.id, textContent: d.label }));
      this.deviceRow.classList.remove('hidden');
    } else {
      this.deviceRow.classList.add('hidden');
    }
    this.setActions([this.btn('Start Racing', () => { this.hide(); this.cb?.onClose(); }, true)]);
  }

  private async request(deviceId?: string): Promise<void> {
    if (!this.cb) return;
    this.renderRequesting();
    const result = await this.cb.onEnable(deviceId);
    if (result === 'granted') await this.renderGranted();
    else if (result === 'denied') this.renderDenied();
    else this.renderNoCamera();
  }
}
