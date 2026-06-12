/**
 * Gameplay recorder. Captures the game canvas (and optionally composites the
 * webcam feed into a corner) into a downloadable .webm via MediaRecorder.
 * Degrades gracefully where the API/codecs are unavailable.
 */
export class GameplayRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private composite: HTMLCanvasElement | null = null;
  private compositeCtx: CanvasRenderingContext2D | null = null;
  private rafId = 0;
  private gameCanvas: HTMLCanvasElement | null = null;
  private webcam: HTMLVideoElement | null = null;
  recording = false;

  static isSupported(): boolean {
    return typeof MediaRecorder !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  }

  start(gameCanvas: HTMLCanvasElement, webcam: HTMLVideoElement | null, withWebcam: boolean): boolean {
    if (!GameplayRecorder.isSupported() || this.recording) return false;
    this.gameCanvas = gameCanvas;
    this.webcam = withWebcam ? webcam : null;

    let stream: MediaStream;
    if (this.webcam) {
      // Composite canvas so the webcam PiP is burned into the recording.
      this.composite = document.createElement('canvas');
      this.composite.width = gameCanvas.width;
      this.composite.height = gameCanvas.height;
      this.compositeCtx = this.composite.getContext('2d');
      stream = this.composite.captureStream(30);
      const drawComposite = () => {
        if (!this.recording || !this.compositeCtx) return;
        const ctx = this.compositeCtx;
        ctx.drawImage(this.gameCanvas!, 0, 0, this.composite!.width, this.composite!.height);
        if (this.webcam && this.webcam.readyState >= 2) {
          const pw = this.composite!.width * 0.2;
          const ph = pw * 0.75;
          const px = this.composite!.width - pw - 20;
          const py = this.composite!.height - ph - 20;
          ctx.save();
          ctx.strokeStyle = '#00f0ff';
          ctx.lineWidth = 2;
          ctx.translate(px + pw, py);
          ctx.scale(-1, 1);
          ctx.drawImage(this.webcam, 0, 0, pw, ph);
          ctx.restore();
          ctx.strokeRect(px, py, pw, ph);
        }
        this.rafId = requestAnimationFrame(drawComposite);
      };
      this.rafId = requestAnimationFrame(drawComposite);
    } else {
      stream = gameCanvas.captureStream(30);
    }

    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
    try {
      this.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    } catch {
      return false;
    }
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(1000);
    this.recording = true;
    return true;
  }

  /** Stops and triggers a download. Returns the object URL (revoked on next call). */
  async stop(filename = 'neondrift-replay.webm'): Promise<boolean> {
    if (!this.recording || !this.recorder) return false;
    const done = new Promise<void>((resolve) => {
      this.recorder!.onstop = () => resolve();
    });
    this.recorder.stop();
    this.recording = false;
    cancelAnimationFrame(this.rafId);
    await done;
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    this.composite = null;
    this.compositeCtx = null;
    return true;
  }
}
