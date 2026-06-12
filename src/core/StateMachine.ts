/**
 * Application state machine. Screens/systems register enter/exit handlers;
 * transitions are validated against an allow-list so illegal jumps surface
 * loudly during development instead of corrupting state.
 */

export type GameState =
  | 'boot'
  | 'menu'
  | 'trackSelect'
  | 'settings'
  | 'calibration'
  | 'training'
  | 'help'
  | 'loading'
  | 'countdown'
  | 'racing'
  | 'paused'
  | 'finished'
  | 'replay';

const ALLOWED: Record<GameState, GameState[]> = {
  boot: ['menu'],
  menu: ['trackSelect', 'settings', 'calibration', 'training', 'help', 'loading'],
  trackSelect: ['menu', 'loading'],
  settings: ['menu', 'paused'],
  calibration: ['menu'],
  training: ['menu'],
  help: ['menu'],
  loading: ['countdown', 'menu'],
  countdown: ['racing', 'paused', 'menu'],
  racing: ['paused', 'finished', 'menu'],
  paused: ['racing', 'countdown', 'settings', 'menu', 'loading'],
  finished: ['replay', 'loading', 'menu'],
  replay: ['finished', 'menu', 'loading'],
};

export interface StateHooks {
  enter?: (from: GameState) => void;
  exit?: (to: GameState) => void;
}

export class StateMachine {
  private _state: GameState = 'boot';
  private hooks = new Map<GameState, StateHooks[]>();
  private anyListeners = new Set<(to: GameState, from: GameState) => void>();

  get state(): GameState {
    return this._state;
  }

  is(...states: GameState[]): boolean {
    return states.includes(this._state);
  }

  register(state: GameState, hooks: StateHooks): void {
    const list = this.hooks.get(state) ?? [];
    list.push(hooks);
    this.hooks.set(state, list);
  }

  onTransition(fn: (to: GameState, from: GameState) => void): () => void {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }

  transition(to: GameState): boolean {
    const from = this._state;
    if (from === to) return true;
    if (!ALLOWED[from]?.includes(to)) {
      console.warn(`[StateMachine] blocked illegal transition ${from} -> ${to}`);
      return false;
    }
    for (const h of this.hooks.get(from) ?? []) h.exit?.(to);
    this._state = to;
    for (const h of this.hooks.get(to) ?? []) h.enter?.(from);
    for (const fn of this.anyListeners) fn(to, from);
    return true;
  }
}
