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
  /** Attempt being re-armed: its button reports the wait instead of firing twice. */
  retrying?: string;
  status: AutomaticStatus;
}

export interface AutomaticRunsStore extends Readable<AutomaticRunsState> {
  /** Re-arms a failed attempt and reloads the list with the state it now has. */
  retry(id: string): void;
}

const emptyStatus: AutomaticStatus = {
  attempts: [],
  enabledRepos: [],
  summary: { expired: 0, rateLimited: 0, waiting: 0 },
};

async function loadAutomatic(
  store: Store<AutomaticRunsState>,
  report: (failure: unknown) => void,
  signal?: AbortSignal
) {
  try {
    const status = await api("/dashboard/automatic", { signal });
    if (signal?.aborted) {
      return;
    }
    store.set((current) => ({ ...current, loading: false, status }));
  } catch (failure) {
    if (signal?.aborted) {
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
 * Re-arms one failed attempt, then reloads the list. The answer of the write is
 * deliberately not read: the reloaded list is the single source of what the
 * attempt became, and it is that response the shared schema guards.
 */
async function retryAutomatic(
  store: Store<AutomaticRunsState>,
  id: string,
  report: (failure: unknown) => void
) {
  store.set((current) => ({ ...current, retrying: id }));
  try {
    await api(`/dashboard/automatic/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    });
    await loadAutomatic(store, report);
  } catch (failure) {
    report(failure);
  } finally {
    store.set((current) => ({ ...current, retrying: undefined }));
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
): AutomaticRunsStore {
  let listeners = 0;
  let abort: (() => void) | undefined;

  const state = createStore<AutomaticRunsState>(
    { loading: true, status: emptyStatus },
    (store) => {
      const controller = new AbortController();
      abort = () => controller.abort();
      void loadAutomatic(store, report, controller.signal);
    }
  );

  return {
    getSnapshot: state.getSnapshot,
    retry: (id) => {
      void retryAutomatic(state, id, report);
    },
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
