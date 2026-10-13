import type { z } from "zod";
import { api, DashboardError, errorText, post } from "@/api/client";
import type { RunResult } from "@/api/contracts";
import { cancelSchema, runJobSchema, runResultSchema } from "@/api/schemas";
import { runs as copy } from "@/i18n";
import { isTerminal, phaseLabel, stateLabel } from "@/lib/format";
import { createStore, type Store } from "@/lib/store";

type LiveRun = z.infer<typeof runJobSchema>;

interface RunDetailState {
  cancelling: boolean;
  job?: LiveRun;
  live: string;
  message: string;
  result?: RunResult;
  /** Set when `result.json` could not be read: the summary explains the gap. */
  resultFailure?: string;
  /**
   * Set when the run itself could not be read — purged, or another account's —
   * so no frame will ever arrive. Without it the panel would keep announcing a
   * connection for a run that does not exist.
   */
  unavailable?: boolean;
}

export interface RunDetailStore extends Store<RunDetailState> {
  cancel(): Promise<void>;
}

/**
 * Whether a failed lookup is a verdict on the run rather than a bad moment.
 *
 * A purged run answers `RUN_NOT_FOUND`, a run of another account is refused with
 * 403, and both mean no frame will ever arrive. A 5xx, an unreachable server or a
 * response that breaks the contract say nothing about the run: replacing the
 * detail then would claim it is missing, so those stay reportable.
 */
function isMissing(failure: unknown): boolean {
  if (!(failure instanceof DashboardError)) {
    return false;
  }
  return failure.code === "RUN_NOT_FOUND" || failure.status === 403;
}

function parseFrame(data: string): LiveRun | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  const parsed = runJobSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

function messageFor(data: LiveRun): string {
  if (data.error) {
    return `${copy.liveInterrupted}${data.error}`;
  }
  const progress = data.progress ?? {};
  const base =
    phaseLabel(progress.phase) || stateLabel(data.status) || copy.eventsLoading;
  const details = [progress.scenarioId, progress.action].filter(
    (value): value is string => Boolean(value)
  );
  return details.length > 0 ? `${base} · ${details.join(" · ")}` : base;
}

/**
 * The lifecycle of one selected run: validate the job, follow its stream while
 * it runs, read its result once it is finished.
 *
 * Unlike the other stores of this app, this one has a real resource to release:
 * the stream opens with the first listener and closes with the last one. A
 * `start`-once store could open it but never close it, so `subscribe`/
 * `unsubscribe` own the resource instead — the same pair React's
 * `useSyncExternalStore` drives on mount and unmount. StrictMode's
 * subscribe/unsubscribe/subscribe cycle therefore re-validates the run and
 * opens a fresh stream, which is exactly what a closed-then-reopened
 * subscription means; no state is lost, because the snapshot lives in the
 * store, not in the stream.
 *
 * The instance belongs to one run id: the caller remounts the panel per
 * selection (`RunsView` keys it on the selected id).
 */
export function createRunDetailStore(options: {
  onUnavailable?: () => void;
  onUpdate?: () => void;
  report: (failure: unknown) => void;
  runId?: string;
}): RunDetailStore {
  const { onUnavailable, onUpdate, report, runId } = options;
  const store = createStore<RunDetailState>({
    cancelling: false,
    live: copy.liveConnecting,
    message: copy.eventsLoading,
  });

  let source: EventSource | undefined;
  // Bumped by every teardown: a request that resolves after the panel left, or
  // after another run was selected, must not write into this snapshot.
  let generation = 0;
  let listeners = 0;

  async function loadResult(run: string, token: number) {
    try {
      const payload = await api<RunResult>(`/artifacts/${run}/result.json`, {
        schema: runResultSchema,
      });
      if (token === generation) {
        store.set((current) => ({ ...current, result: payload }));
      }
    } catch (failure) {
      if (token === generation) {
        store.set((current) => ({
          ...current,
          resultFailure: copy.missingResult + errorText(failure),
        }));
      }
    }
  }

  function follow(run: string, token: number) {
    const stream = new EventSource(`/runs/${run}/events`);
    source = stream;
    stream.onopen = () => {
      if (token === generation) {
        store.set((current) => ({ ...current, live: copy.liveConnected }));
      }
    };
    stream.onerror = () => {
      // A closed source is finished, not reconnecting.
      if (token === generation && stream.readyState !== EventSource.CLOSED) {
        store.set((current) => ({ ...current, live: copy.liveReconnecting }));
      }
    };
    stream.onmessage = (event: MessageEvent<string>) => {
      if (token !== generation) {
        return;
      }
      const frame = parseFrame(event.data);
      if (!frame) {
        stream.close();
        store.set((current) => ({ ...current, live: copy.liveInvalid }));
        report(new Error(copy.invalidFrame));
        return;
      }
      store.set((current) => ({
        ...current,
        job: frame,
        message: messageFor(frame),
      }));
      if (isTerminal(frame.status)) {
        stream.close();
        store.set((current) => ({ ...current, live: copy.liveDone }));
        void loadResult(run, token);
      }
      // The history row of a running test says "en cours" until this refresh.
      onUpdate?.();
    };
  }

  function start() {
    const run = runId;
    if (!run) {
      return;
    }
    const token = generation;
    // Validate the run first: the stream is opened for a run this account may
    // read, otherwise an unknown or forbidden id would leave EventSource
    // reconnecting forever while the interface pretends to follow it.
    void api<LiveRun>(`/runs/${run}`, { schema: runJobSchema })
      .then((initial) => {
        if (token !== generation) {
          return;
        }
        store.set((current) => ({
          ...current,
          job: initial,
          message: messageFor(initial),
        }));
        if (isTerminal(initial.status)) {
          // No stream will fire: the history has to be refreshed from here, or a
          // run that finished before this request would stay "en cours" in the
          // table next to a finished detail.
          store.set((current) => ({ ...current, live: copy.liveDone }));
          void loadResult(run, token);
          onUpdate?.();
          return;
        }
        follow(run, token);
      })
      .catch((failure) => {
        if (token !== generation) {
          return;
        }
        if (!isMissing(failure)) {
          // Not a verdict on the run: the alert says what happened, and the
          // panel keeps the state a reload can move out of.
          report(failure);
          return;
        }
        store.set((current) => ({
          ...current,
          live: copy.liveDone,
          unavailable: true,
        }));
        // A caller that explains the missing run on its own screen owns the
        // error surface; the rest get the shared alert, as before.
        if (onUnavailable) {
          onUnavailable();
        } else {
          report(failure);
        }
      });
  }

  function teardown() {
    generation += 1;
    source?.close();
    source = undefined;
  }

  return {
    ...store,
    cancel: async () => {
      const run = runId;
      if (!run) {
        return;
      }
      store.set((current) => ({ ...current, cancelling: true }));
      try {
        await api(`/runs/${run}/cancel`, { ...post({}), schema: cancelSchema });
        store.set((current) => ({
          ...current,
          message: copy.cancelRequested,
        }));
      } catch (failure) {
        report(failure);
      } finally {
        store.set((current) => ({ ...current, cancelling: false }));
      }
    },
    subscribe(listener: () => void) {
      listeners += 1;
      if (listeners === 1) {
        start();
      }
      const release = store.subscribe(listener);
      return () => {
        release();
        listeners -= 1;
        if (listeners === 0) {
          teardown();
        }
      };
    },
  };
}
