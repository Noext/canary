import { api } from "@/api/client";
import type { AutomaticStatus } from "@/api/contracts";
import {
  createStore,
  failureMessage,
  type Readable,
  type Store,
} from "@/lib/store";

export interface AutomaticRunsState {
  /** Message of a failed `/dashboard/automatic`, so the block can explain it. */
  error?: string;
  loading: boolean;
  status: AutomaticStatus;
}

const emptyStatus: AutomaticStatus = {
  attempts: [],
  enabledRepos: [],
  summary: { expired: 0, rateLimited: 0, waiting: 0 },
};

async function loadAutomatic(
  store: Store<AutomaticRunsState>,
  signal: AbortSignal,
  report: (failure: unknown) => void
) {
  try {
    const status = await api("/dashboard/automatic", { signal });
    if (signal.aborted) {
      return;
    }
    store.set((current) => ({ ...current, loading: false, status }));
  } catch (failure) {
    if (signal.aborted) {
      return;
    }
    // The alert carries the failure; the block keeps an empty, readable list
    // instead of a half-rendered one.
    report(failure);
    store.set((current) => ({
      ...current,
      error: failureMessage(failure),
      loading: false,
      status: emptyStatus,
    }));
  }
}

/**
 * The automatic attempts the home screen reports.
 *
 * The request is a real lifecycle: the screen owns it and abandons it on
 * unmount, so it starts on the first subscription and is aborted when the last
 * listener leaves. The abort is deferred to a microtask because React
 * StrictMode unsubscribes and immediately re-subscribes on mount, and the work
 * starts exactly once: a synchronous abort there would cancel the only load and
 * never restart it.
 */
export function createAutomaticRunsStore(
  report: (failure: unknown) => void
): Readable<AutomaticRunsState> {
  let listeners = 0;
  let abort: (() => void) | undefined;

  const state = createStore<AutomaticRunsState>(
    { loading: true, status: emptyStatus },
    (store) => {
      const controller = new AbortController();
      abort = () => controller.abort();
      void loadAutomatic(store, controller.signal, report);
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
