/**
 * Race control: lap counting with ordered checkpoints (no shortcut laps),
 * live standings, lap/best times, wrong-way detection, finish handling.
 * Pure logic over track-local progress — engine-agnostic and unit-tested.
 */
import { TrackSpline } from '../track/Spline';

export interface RacerProgress {
  id: string;
  isPlayer: boolean;
  lap: number;             // 1-based current lap
  s: number;               // last projected track position
  totalDistance: number;   // unwrapped progress for standings
  checkpoints: boolean[];  // ordered gates hit this lap
  lapTimes: number[];      // ms
  bestLapMs: number;
  lapStartMs: number;
  finished: boolean;
  finishTimeMs: number;
  wrongWay: boolean;
  position: number;        // 1-based standing, updated each tick
}

export interface RaceEvents {
  onLap?: (r: RacerProgress, lapMs: number, isBest: boolean) => void;
  onFinish?: (r: RacerProgress) => void;
  onWrongWay?: (r: RacerProgress, wrong: boolean) => void;
}

const CHECKPOINT_FRACTIONS = [0.25, 0.5, 0.75];

export class RaceDirector {
  readonly racers = new Map<string, RacerProgress>();
  raceTimeMs = 0;
  private started = false;
  private wrongWayTimers = new Map<string, number>();

  constructor(
    private spline: TrackSpline,
    public totalLaps: number,
    private events: RaceEvents = {},
  ) {}

  addRacer(id: string, isPlayer: boolean, startS: number): void {
    this.racers.set(id, {
      id,
      isPlayer,
      lap: 1,
      s: startS,
      totalDistance: 0,
      checkpoints: CHECKPOINT_FRACTIONS.map(() => false),
      lapTimes: [],
      bestLapMs: Infinity,
      lapStartMs: 0,
      finished: false,
      finishTimeMs: 0,
      wrongWay: false,
      position: 1,
    });
  }

  start(): void {
    this.started = true;
    this.raceTimeMs = 0;
    for (const r of this.racers.values()) r.lapStartMs = 0;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Call each physics tick with each car's projected s. */
  updateRacer(id: string, s: number, dt: number): void {
    const r = this.racers.get(id);
    if (!r || r.finished || !this.started) return;
    const L = this.spline.length;

    let ds = s - r.s;
    // unwrap
    if (ds < -L / 2) ds += L;
    else if (ds > L / 2) ds -= L;

    r.totalDistance += ds;
    const prevS = r.s;
    r.s = s;

    // Ordered checkpoints.
    for (let c = 0; c < CHECKPOINT_FRACTIONS.length; c++) {
      const gate = CHECKPOINT_FRACTIONS[c] * L;
      if (!r.checkpoints[c] && (c === 0 || r.checkpoints[c - 1]) && crossed(prevS, s, gate, L) && ds > 0) {
        r.checkpoints[c] = true;
      }
    }

    // Start/finish line crossing (gate at s=0) with all checkpoints → lap.
    if (crossed(prevS, s, 0, L) && ds > 0 && r.checkpoints.every(Boolean)) {
      const lapMs = this.raceTimeMs - r.lapStartMs;
      r.lapTimes.push(lapMs);
      const isBest = lapMs < r.bestLapMs;
      if (isBest) r.bestLapMs = lapMs;
      r.lapStartMs = this.raceTimeMs;
      r.checkpoints = CHECKPOINT_FRACTIONS.map(() => false);
      r.lap++;
      this.events.onLap?.(r, lapMs, isBest);
      if (r.lap > this.totalLaps) {
        r.finished = true;
        r.finishTimeMs = this.raceTimeMs;
        this.events.onFinish?.(r);
      }
    }

    // Wrong-way: sustained negative progress (players only get the warning UI,
    // but we track it for everyone).
    const timer = this.wrongWayTimers.get(id) ?? 0;
    if (ds < -0.02) {
      const t = timer + dt;
      this.wrongWayTimers.set(id, t);
      if (t > 1.2 && !r.wrongWay) {
        r.wrongWay = true;
        this.events.onWrongWay?.(r, true);
      }
    } else if (ds > 0.05) {
      this.wrongWayTimers.set(id, 0);
      if (r.wrongWay) {
        r.wrongWay = false;
        this.events.onWrongWay?.(r, false);
      }
    }
  }

  tick(dtMs: number): void {
    if (this.started) this.raceTimeMs += dtMs;
    this.updateStandings();
  }

  private updateStandings(): void {
    const list = [...this.racers.values()];
    list.sort((a, b) => {
      if (a.finished && b.finished) return a.finishTimeMs - b.finishTimeMs;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.totalDistance - a.totalDistance;
    });
    list.forEach((r, i) => (r.position = i + 1));
  }

  get standings(): RacerProgress[] {
    return [...this.racers.values()].sort((a, b) => a.position - b.position);
  }

  get allFinished(): boolean {
    return [...this.racers.values()].every((r) => r.finished);
  }

  playerProgress(): RacerProgress | undefined {
    return [...this.racers.values()].find((r) => r.isPlayer);
  }
}

/** Did motion from a→b (forward, possibly wrapping) cross the gate? */
function crossed(a: number, b: number, gate: number, L: number): boolean {
  const rel = (x: number) => (((x - gate) % L) + L) % L; // gate at rel 0
  const ra = rel(a);
  const rb = rel(b);
  // forward crossing: ra near the end of the lap, rb near the start
  return ra > L * 0.5 && rb < L * 0.25;
}
