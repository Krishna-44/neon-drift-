/**
 * Webcam picture-in-picture with a live neon hand-skeleton overlay.
 *
 * Draws the (mirrored) camera frame and the tracked landmarks/bones on a
 * canvas, colour-coded per hand role with pose labels and a confidence ring.
 * Reused at two sizes: the in-race PiP and the larger calibration/training
 * preview. Pure presentation — reads HandsState, never mutates it.
 */
import { el } from './dom';
import { HAND_CONNECTIONS, LM } from '../vision/HandTypes';
import type { HandsState, TrackedHand } from '../vision/HandTypes';

const ROLE_COLOR = { left: '#ff2bd6', right: '#00f0ff' } as const;

export class WebcamOverlay {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private video: HTMLVideoElement | null = null;
  private collapsed = false;
  private mirror = true;
  private note: HTMLDivElement;
  private showVideo = true;

  constructor(opts: { title?: string; pip?: boolean } = {}) {
    this.canvas = el('canvas', { width: 320, height: 240 });
    this.ctx = this.canvas.getContext('2d')!;
    this.note = el('div', { class: 'no-cam-note hidden', html: 'No camera — running on synthetic input' });
    const title = el('div', { class: 'pip-title', textContent: opts.title ?? 'CV FEED' });
    const toggle = el('button', { class: 'pip-toggle', textContent: '–', title: 'Collapse' });
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setCollapsed(!this.collapsed);
    });
    this.root = el('div', { class: opts.pip === false ? 'wizard-cam' : 'webcam-pip' }, [
      title,
      ...(opts.pip === false ? [] : [toggle]),
      this.canvas,
      this.note,
    ]);
  }

  attachVideo(video: HTMLVideoElement): void {
    this.video = video;
  }

  setMirror(m: boolean): void {
    this.mirror = m;
  }

  setShowVideo(v: boolean): void {
    this.showVideo = v;
  }

  setNoCamera(on: boolean): void {
    this.note.classList.toggle('hidden', !on);
  }

  setCollapsed(c: boolean): void {
    this.collapsed = c;
    this.root.classList.toggle('collapsed', c);
  }

  /** Draw a frame. Call from the render loop. */
  render(hands: HandsState): void {
    if (this.collapsed) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.save();
    if (this.mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    // camera frame (object-fit: cover behaviour)
    if (this.showVideo && this.video && this.video.readyState >= 2 && this.video.videoWidth > 0) {
      drawCover(ctx, this.video, w, h);
    } else {
      ctx.fillStyle = '#02030a';
      ctx.fillRect(0, 0, w, h);
    }
    for (const hand of [hands.left, hands.right]) {
      if (hand) this.drawHand(ctx, hand, w, h);
    }
    ctx.restore();
    // labels drawn un-mirrored so text reads correctly
    this.drawLabels(hands, w, h);
  }

  private drawHand(ctx: CanvasRenderingContext2D, hand: TrackedHand, w: number, h: number): void {
    const lm = hand.landmarks;
    const color = ROLE_COLOR[hand.role];
    const alpha = hand.coasting ? 0.4 : 1;
    ctx.globalAlpha = alpha;

    // YOLO-style detection box: corner brackets around the hand's bbox.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 21; i++) {
      const x = lm[i * 3] * w;
      const y = lm[i * 3 + 1] * h;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const padX = (maxX - minX) * 0.12 + 4;
    const padY = (maxY - minY) * 0.12 + 4;
    minX -= padX; maxX += padX; minY -= padY; maxY += padY;
    const bw = maxX - minX;
    const bh = maxY - minY;
    const corner = Math.min(bw, bh) * 0.22;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    // four corner brackets (detection-box look)
    ctx.moveTo(minX, minY + corner); ctx.lineTo(minX, minY); ctx.lineTo(minX + corner, minY);
    ctx.moveTo(maxX - corner, minY); ctx.lineTo(maxX, minY); ctx.lineTo(maxX, minY + corner);
    ctx.moveTo(maxX, maxY - corner); ctx.lineTo(maxX, maxY); ctx.lineTo(maxX - corner, maxY);
    ctx.moveTo(minX + corner, maxY); ctx.lineTo(minX, maxY); ctx.lineTo(minX, maxY - corner);
    ctx.stroke();
    // faint full box
    ctx.globalAlpha = alpha * 0.25;
    ctx.strokeRect(minX, minY, bw, bh);
    ctx.globalAlpha = alpha;

    // bones
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(lm[a * 3] * w, lm[a * 3 + 1] * h);
      ctx.lineTo(lm[b * 3] * w, lm[b * 3 + 1] * h);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // joints
    for (let i = 0; i < 21; i++) {
      const x = lm[i * 3] * w;
      const y = lm[i * 3 + 1] * h;
      const big = i === LM.WRIST || i === LM.INDEX_TIP || i === LM.THUMB_TIP;
      ctx.fillStyle = big ? '#ffffff' : color;
      ctx.beginPath();
      ctx.arc(x, y, big ? 4 : 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // remember bbox (unmirrored) for the label pass
    (hand as any).__bbox = { minX, minY, maxX, maxY };
  }

  private drawLabels(hands: HandsState, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.font = '700 11px Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (const hand of [hands.left, hands.right]) {
      if (!hand) continue;
      const bbox = (hand as any).__bbox as { minX: number; minY: number; maxX: number; maxY: number } | undefined;
      const color = ROLE_COLOR[hand.role];
      // YOLO-style label tag: "RIGHT · THUMBDOWN 97%" on a filled chip above the box.
      const conf = Math.round(hand.poseConfidence * 100);
      const label = `${hand.role.toUpperCase()} · ${hand.pose.toUpperCase()} ${conf}%${hand.coasting ? ' ~' : ''}`;
      const tw = ctx.measureText(label).width + 12;
      let bx: number;
      let by: number;
      if (bbox) {
        // bbox is in unmirrored canvas space; flip to screen space when mirrored
        const left = this.mirror ? w - bbox.maxX : bbox.minX;
        bx = Math.min(Math.max(left, 2), w - tw - 2);
        by = Math.max(bbox.minY - 10, 9);
      } else {
        let px = hand.features.palmX * w;
        if (this.mirror) px = w - px;
        bx = Math.min(Math.max(px - 20, 2), w - tw - 2);
        by = Math.max(hand.features.palmY * h - 28, 9);
      }
      ctx.fillStyle = color;
      ctx.globalAlpha = hand.coasting ? 0.5 : 0.92;
      ctx.fillRect(bx, by - 8, tw, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#02030a';
      ctx.fillText(label, bx + 6, by + 1);
      // confidence underline
      ctx.fillStyle = 'rgba(2,3,10,0.55)';
      ctx.fillRect(bx, by + 6, tw, 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(bx, by + 6, tw * hand.poseConfidence, 2);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

function drawCover(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, w: number, h: number): void {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
