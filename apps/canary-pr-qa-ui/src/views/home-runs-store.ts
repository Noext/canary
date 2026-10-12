import { api } from "@/api/client";
import type { RunJob } from "@/api/contracts";
import {
  createStore,
  failureMessage,
  type Readable,
  type Store,
} from "@/lib/store";

export interface HomeRunsState {
  /** Message of a failed `/runs`, so the stats show a failure instead of zeros. */
  error?: string;
  loading: boolean;
  runs: RunJob[];
}

async function loadRuns(
  store: Store<HomeRunsState>,
  signal: AbortSignal,
  report: (failure: unknown) => void
) {
  try {
    const rows = await api("/runs", { signal });
    if (signal.aborted) {
      return;
    }
    store.set((current) => ({ ...current, loading: false, runs: rows }));
  } catch (failure) {
    if (signal.aborted) {
      return;
    }
    report(failure);
    store.set((current) => ({
      ...current,
      error: failureMessage(failure),
      loading: false,
    }));
  }
}

/**
 * The home screen's runs list.
 *
 * The `/runs` request is a real lifecycle: the screen owns it, and the legacy
 * effect abandoned it on unmount (`active = false`). The store therefore opens
 * the request on the first subscription and aborts it when the last listener
 * leaves; a start-once store would leave the request running and could still
 * report a failure for a screen that is gone. The abort is deferred to a
 * microtask because React StrictMode unsubscribes and immediately re-subscribes
 * on mount, and the work starts exactly once: a synchronous abort there would
 * cancel the only load and never restart it.
 */
export function createHomeStore(
  report: (failure: unknown) => void
): Readable<HomeRunsState> {
  let listeners = 0;
  let abort: (() => void) | undefined;

  const state = createStore<HomeRunsState>(
    { loading: true, runs: [] },
    (store) => {
      const controller = new AbortController();
      abort = () => controller.abort();
      void loadRuns(store, controller.signal, report);
    }
  );

  return {
    getSnapshot: state.getSnapshot,
    subscribe(listener) {
      listeners += 1;
      const unsubscribe = state.subscribe(listener);
      return () => {
        unsubscribe();
        listeners -= 1;
        if (listeners === 0) {
          // Deferred: StrictMode unsubscribes and re-subscribes in the same
          // tick, and the work starts exactly once, so a synchronous abort
          // would cancel the only load and never restart it. The controller
          // stays referenced, so a genuine later unmount still cancels it.
          queueMicrotask(() => {
            if (listeners === 0) {
              abort?.();
            }
          });
        }
      };
    },
  };
}
