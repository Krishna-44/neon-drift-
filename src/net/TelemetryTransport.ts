/**
 * Telemetry transport for spectator mode + multiplayer-ready architecture.
 *
 * Two pluggable channels behind one interface:
 *   - BroadcastChannelTransport: zero-config same-machine spectating (open a
 *     second tab in spectator mode — it receives the live telemetry feed).
 *   - WebSocketTransport: connects to the bundled relay server (scripts/relay.mjs)
 *     so spectators/telemetry sinks can live on other machines. This is the
 *     seam a future authoritative multiplayer server slots into — the wire
 *     format (TelemetryFrame) is already the netcode payload.
 *
 * Both are fire-and-forget and never throw into the game loop.
 */
import type { TelemetryFrame } from '../game/Telemetry';

export interface NetMessage {
  type: 'telemetry' | 'race-state' | 'hello' | 'bye';
  roomId: string;
  role: 'host' | 'spectator';
  payload?: unknown;
}

export interface TelemetryTransport {
  send(msg: NetMessage): void;
  onMessage(cb: (msg: NetMessage) => void): void;
  readonly kind: string;
  close(): void;
}

export class BroadcastChannelTransport implements TelemetryTransport {
  readonly kind = 'broadcast';
  private ch: BroadcastChannel | null = null;
  private cb: ((m: NetMessage) => void) | null = null;

  constructor(channel = 'neondrift-gp') {
    if (typeof BroadcastChannel !== 'undefined') {
      this.ch = new BroadcastChannel(channel);
      this.ch.onmessage = (e) => this.cb?.(e.data as NetMessage);
    }
  }
  send(msg: NetMessage): void {
    try {
      this.ch?.postMessage(msg);
    } catch {
      /* structured-clone failure — ignore */
    }
  }
  onMessage(cb: (m: NetMessage) => void): void {
    this.cb = cb;
  }
  close(): void {
    this.ch?.close();
    this.ch = null;
  }
}

export class WebSocketTransport implements TelemetryTransport {
  readonly kind = 'websocket';
  private ws: WebSocket | null = null;
  private cb: ((m: NetMessage) => void) | null = null;
  private queue: NetMessage[] = [];
  private closed = false;
  connected = false;

  constructor(private url: string) {
    this.connect();
  }
  private connect(): void {
    if (this.closed) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      for (const m of this.queue) this.rawSend(m);
      this.queue = [];
    };
    this.ws.onmessage = (e) => {
      try {
        this.cb?.(JSON.parse(e.data) as NetMessage);
      } catch {
        /* malformed */
      }
    };
    this.ws.onclose = () => {
      this.connected = false;
      if (!this.closed) setTimeout(() => this.connect(), 1500); // auto-reconnect
    };
    this.ws.onerror = () => this.ws?.close();
  }
  private rawSend(msg: NetMessage): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }
  send(msg: NetMessage): void {
    if (this.connected) this.rawSend(msg);
    else if (this.queue.length < 30) this.queue.push(msg);
  }
  onMessage(cb: (m: NetMessage) => void): void {
    this.cb = cb;
  }
  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

/**
 * Host-side throttled publisher: decimates the 120 Hz physics telemetry down
 * to a network-friendly rate before sending.
 */
export class TelemetryPublisher {
  private accum = 0;
  constructor(
    private transport: TelemetryTransport,
    private roomId: string,
    private hz = 20,
  ) {}

  publish(frame: TelemetryFrame, dt: number): void {
    this.accum += dt;
    if (this.accum < 1 / this.hz) return;
    this.accum = 0;
    this.transport.send({ type: 'telemetry', roomId: this.roomId, role: 'host', payload: frame });
  }

  raceState(payload: unknown): void {
    this.transport.send({ type: 'race-state', roomId: this.roomId, role: 'host', payload });
  }
}
