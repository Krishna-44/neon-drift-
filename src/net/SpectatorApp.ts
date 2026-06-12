/**
 * Spectator view: a stripped-down renderer that subscribes to the telemetry
 * feed (BroadcastChannel for same-machine, WebSocket via the relay for remote)
 * and reconstructs the race scene + a compact HUD. It runs the SAME GameSession
 * renderer in replay mode, proving the telemetry format is sufficient to drive
 * a full visual — the foundation the multiplayer client builds on.
 */
import './../ui/styles.css';
import { GameLoop } from '../core/GameLoop';
import { SettingsStore } from '../core/Settings';
import { AudioEngine } from '../audio/AudioEngine';
import { GameSession } from '../game/GameSession';
import { el } from '../ui/dom';
import { BroadcastChannelTransport, WebSocketTransport, TelemetryTransport, NetMessage } from './TelemetryTransport';
import type { TelemetryFrame } from '../game/Telemetry';
import { trackById } from '../track/TrackData';

export class SpectatorApp {
  private canvas: HTMLCanvasElement;
  private session: GameSession;
  private loop: GameLoop;
  private transport: TelemetryTransport;
  private latest: TelemetryFrame | null = null;
  private lastRecvTs = 0;
  private status: HTMLElement;
  private loadedTrack = '';
  private settings = new SettingsStore();
  private audio = new AudioEngine();

  constructor(root: HTMLElement, private roomId: string, relayUrl?: string) {
    this.canvas = el('canvas', { id: 'game-canvas' });
    root.append(this.canvas);

    // Spectators don't need bloom-heavy settings; force medium for smoothness.
    this.settings.data.graphics.quality = 'medium';
    this.session = new GameSession(this.canvas, this.settings.data, this.audio);
    this.session.setCameraMode('cinematic');

    this.status = el('div', { class: 'cv-badge', style: { left: '30px', right: 'auto' } as any, textContent: 'SPECTATOR · waiting for host…' });
    const banner = el('div', { class: 'layer' }, [
      el('div', { style: { position: 'absolute', top: '24px', left: '50%', transform: 'translateX(-50%)', letterSpacing: '0.3em', color: 'var(--c-magenta)', fontWeight: '800' } as any, textContent: 'SPECTATOR MODE' }),
      this.status,
    ]);
    root.append(banner);

    this.transport = relayUrl ? new WebSocketTransport(relayUrl) : new BroadcastChannelTransport();
    this.transport.onMessage((m) => this.onMessage(m));

    this.loop = new GameLoop({
      fixedUpdate: () => {},
      frameUpdate: () => this.frame(),
      render: () => this.render(),
    });
    window.addEventListener('resize', () => this.onResize());
    this.onResize();
  }

  async start(): Promise<void> {
    this.loop.start();
    // Subscriptions are passive; if WS, announce ourselves.
    this.transport.send({ type: 'hello', roomId: this.roomId, role: 'spectator' });
  }

  private onMessage(m: NetMessage): void {
    if (m.roomId !== this.roomId || m.role !== 'host') return;
    if (m.type === 'telemetry') {
      const frame = m.payload as TelemetryFrame;
      this.latest = frame;
      this.lastRecvTs = performance.now();
      this.ensureTrack(frame);
    } else if (m.type === 'race-state') {
      const st = m.payload as { trackId?: string; opponents?: number };
      if (st.trackId) this.loadTrackById(st.trackId, st.opponents ?? 5);
    }
  }

  private ensureTrack(frame: TelemetryFrame): void {
    // We may not get an explicit race-state; infer car count from the frame
    // and default to the city track unless told otherwise.
    if (!this.loadedTrack) this.loadTrackById('city', Math.max(0, frame.cars.length - 1));
  }

  private loadTrackById(trackId: string, opponents: number): void {
    if (this.loadedTrack === trackId) return;
    this.loadedTrack = trackId;
    this.session.loadRace({ trackId: trackById(trackId).id, opponents, laps: 3, difficulty: 'racer' });
  }

  private frame(): void {
    const silent = performance.now() - this.lastRecvTs;
    if (this.latest) {
      this.status.textContent = silent < 1500 ? `SPECTATOR · LIVE · ${this.latest.cars.length} cars` : 'SPECTATOR · host paused…';
    }
  }

  private render(): void {
    if (this.latest && this.loadedTrack) {
      this.session.renderReplayFrame(this.latest, 1 / 60);
    } else {
      this.session.renderMenuBackdrop();
    }
  }

  private onResize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.session.resize(window.innerWidth, window.innerHeight);
  }

  dispose(): void {
    this.loop.stop();
    this.transport.close();
    this.session.dispose();
  }
}
