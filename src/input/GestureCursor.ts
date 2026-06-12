/**
 * Gesture-driven menu navigation: the right-hand index fingertip moves a neon
 * cursor; a pinch (thumb↔index) clicks the element underneath. Mirrors hand
 * motion (selfie-consistent) and smooths with One-Euro filters.
 */
import { OneEuroFilter } from '../vision/OneEuro';
import { LM } from '../vision/HandTypes';
import type { HandsState } from '../vision/HandTypes';

export class GestureCursor {
  private el: HTMLDivElement;
  private fx = new OneEuroFilter(2.2, 0.9);
  private fy = new OneEuroFilter(2.2, 0.9);
  private pinchWas = false;
  private hovered: Element | null = null;
  private active = false;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'gesture-cursor';
    this.el.style.display = 'none';
    root.appendChild(this.el);
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.el.style.display = 'none';
      this.setHover(null);
      this.pinchWas = false;
    }
  }

  update(hands: HandsState, now: number): void {
    if (!this.active) return;
    const hand = hands.right ?? hands.left;
    if (!hand || hand.coasting || (hand.pose !== 'point' && hand.pose !== 'grip' && !hand.features.pinching)) {
      this.el.style.display = 'none';
      this.setHover(null);
      this.pinchWas = false;
      return;
    }
    // Index fingertip in user space (mirror x so motion matches a mirror).
    const ix = 1 - hand.landmarks[LM.INDEX_TIP * 3];
    const iy = hand.landmarks[LM.INDEX_TIP * 3 + 1];
    const t = now / 1000;
    // Use the central 70% of camera space for full-screen reach.
    const nx = Math.min(Math.max((ix - 0.15) / 0.7, 0), 1);
    const ny = Math.min(Math.max((iy - 0.15) / 0.7, 0), 1);
    const x = this.fx.filter(nx, t) * window.innerWidth;
    const y = this.fy.filter(ny, t) * window.innerHeight;

    this.el.style.display = 'block';
    this.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;

    const target = document.elementFromPoint(x, y);
    const clickable = target?.closest('button, [data-gesture-click]') ?? null;
    this.setHover(clickable);

    const pinch = hand.features.pinching;
    this.el.classList.toggle('pinching', pinch);
    if (pinch && !this.pinchWas && clickable instanceof HTMLElement) {
      clickable.click();
    }
    this.pinchWas = pinch;
  }

  private setHover(el: Element | null): void {
    if (this.hovered === el) return;
    this.hovered?.classList.remove('gesture-hover');
    this.hovered = el;
    this.hovered?.classList.add('gesture-hover');
  }

  dispose(): void {
    this.el.remove();
  }
}
