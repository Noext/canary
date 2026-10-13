import { api, DashboardError } from "@/api/client";
import type { AutomaticDetail } from "@/api/contracts";
import { automaticDetailSchema } from "@/api/schemas";
import {
  createStore,
  failureMessage,
  type Readable,
  type Store,
} from "@/lib/store";

export interface AutomaticDetailState {
  detail?: AutomaticDetail;
  error?: string;
  loading: boolean;
  missing: boolean;
}

/** The error code the server returns for an attempt that no longer exists. */
const unknownAttempt = "AUTOMATIC_UNKNOWN";

async function loadAutomaticDetail(
  store: Store<AutomaticDetailState>,
  id: string,
  signal: AbortSignal,
  report: (failure: unknown) => void
) {
  try {
    const detail = await api<AutomaticDetail>(
      `/dashboard/automatic/${encodeURIComponent(id)}`,
      { schema: automaticDetailSchema, signal }
    );
    if (signal.aborted) {
      return;
    }
    store.set((current) => ({ ...current, detail, loading: false }));
  } catch (failure) {
    if (signal.aborted) {
      return;
    }
    if (failure instanceof DashboardError && failure.code === unknownAttempt) {
      // A purged attempt is a state of its own, not a server failure: the screen
      // explains it, and the alert is left for real breakdowns.
      store.set((current) => ({
        ...current,
        error: failureMessage(failure),
        loading: false,
        missing: true,
      }));
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
 * One automatic attempt and the evidence of why it never became a run.
 *
 * The id is read once, at construction: `requested` is the deep link the screen
 * was mounted for, `consumeRequest` clears the pending request so a later render
 * cannot resurrect it. A request that never carried an id is the `missing`
 * screen — no id, no call.
 *
 * The request is a real lifecycle: it starts on the first subscription and the
 * store abandons it when the last listener leaves. The abort is deferred to a
 * microtask because React StrictMode unsubscribes and immediately re-subscribes
 * on mount, and the load starts exactly once — a synchronous abort there would
 * cancel the only load and never restart it.
 */
export function createAutomaticDetailStore(options: {
  consumeRequest: () => string | undefined;
  report: (failure: unknown) => void;
  requested?: string;
}): Readable<AutomaticDetailState> {
  const { consumeRequest, report, requested = "" } = options;
  // Exactly one read of the pending link, whether it came as a prop or through
  // the consumer: `requested` wins, and the consumer still clears the state.
  const id = requested || consumeRequest();
  if (requested) {
    consumeRequest();
  }

  let listeners = 0;
  let abort: (() => void) | undefined;

  const state = createStore<AutomaticDetailState>(
    { loading: Boolean(id), missing: !id },
    (store) => {
      if (!id) {
        return;
      }
      const controller = new AbortController();
      abort = () => controller.abort();
      void loadAutomaticDetail(store, id, controller.signal, report);
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
