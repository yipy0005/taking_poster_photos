// Tiny shared primitives: Dispose type and a typed emitter. No global mutable app state lives here.
export type Dispose = () => void;

export interface Emitter<T> {
  subscribe(listener: (value: T) => void): Dispose;
  emit(value: T): void;
  readonly size: number;
}

export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(value) {
      for (const l of Array.from(listeners)) {
        try {
          l(value);
        } catch (e) {
          console.error('[poster-photos] listener failed', e);
        }
      }
    },
    get size() {
      return listeners.size;
    },
  };
}

/**
 * Late-bound hooks that main.ts runs at the right moment. Features register themselves here so main.ts
 * does not import them before they exist.
 */
export interface AppHooks {
  /** Lazy thumbnail sweep (2.9 item 5): runs once after the first user interaction, in an idle slot. */
  thumbSweep: (() => Promise<void>) | null;
}

export const appHooks: AppHooks = { thumbSweep: null };
