/**
 * Minimal typed pub/sub bus. Modules communicate through events instead of
 * direct references, which keeps the vision / input / physics / UI layers
 * decoupled (and individually replaceable — e.g. multiplayer feeds the same
 * events a local race does).
 */

export type Handler<T> = (payload: T) => void;

export class EventBus<EventMap extends Record<string, unknown>> {
  private handlers = new Map<keyof EventMap, Set<Handler<any>>>();

  on<K extends keyof EventMap>(event: K, fn: Handler<EventMap[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  once<K extends keyof EventMap>(event: K, fn: Handler<EventMap[K]>): () => void {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  off<K extends keyof EventMap>(event: K, fn: Handler<EventMap[K]>): void {
    this.handlers.get(event)?.delete(fn);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // Copy so handlers that unsubscribe mid-emit don't skip siblings.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${String(event)}" threw:`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
