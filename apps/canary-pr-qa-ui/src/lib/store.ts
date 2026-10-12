import { useSyncExternalStore } from "react";

/**
 * A tiny external store.
 *
 * React reads it through `useSyncExternalStore`, which performs the
 * subscription itself: a component never needs an effect to start loading, and
 * work is triggered by an action (an event) or by the first subscription
 * instead of by "state changed, so run something".
 */
export interface Readable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export interface Store<T> extends Readable<T> {
  /** Replaces the snapshot; a no-op update never notifies. */
  set(update: (current: T) => T): void;
}

export function createStore<T>(
  initial: T,
  start?: (store: Store<T>) => void
): Store<T> {
  let snapshot = initial;
  let started = false;
  const listeners = new Set<() => void>();

  const store: Store<T> = {
    getSnapshot: () => snapshot,
    set(update) {
      const next = update(snapshot);
      if (next !== snapshot) {
        snapshot = next;
        for (const listener of listeners) {
          listener();
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!started) {
        // Exactly once per store instance: a re-subscription (React remounts a
        // component twice under StrictMode) must not restart the work.
        started = true;
        start?.(store);
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return store;
}

export function useStore<T>(store: Readable<T>): T {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
}

/** Message of an unknown rejection, for a store that keeps failures as state. */
export function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
