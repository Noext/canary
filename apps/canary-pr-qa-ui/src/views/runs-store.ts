import type { z } from "zod";
import { api } from "@/api/client";
import type { runJobListSchema } from "@/api/schemas";
import { createStore, type Store } from "@/lib/store";

type RunRow = z.infer<typeof runJobListSchema>[number];

export interface RunsFilters {
  search: string;
  status: string;
}

const emptyFilters: RunsFilters = { search: "", status: "" };

interface RunsState {
  /** The filters the visible rows were loaded with; the manual refresh reuses them. */
  applied: RunsFilters;
  draft: RunsFilters;
  filtered: boolean;
  rows: RunRow[];
  selected?: string;
}

export interface RunsStore extends Store<RunsState> {
  editDraft(patch: Partial<RunsFilters>): void;
  /** Stable identity across renders: the detail panel calls it after every frame. */
  refresh(): void;
  select(runId: string): void;
  submitFilters(): void;
}

async function load(
  store: Store<RunsState>,
  filters: RunsFilters,
  report: (failure: unknown) => void
) {
  try {
    const rows = await api("/runs", {
      query: { search: filters.search, status: filters.status },
    });
    store.set((current) => ({
      ...current,
      filtered: Boolean(filters.search || filters.status),
      rows,
    }));
  } catch (failure) {
    report(failure);
  }
}

/**
 * The runs screen: the recorded sessions, the filters and the selected run.
 *
 * React reads it through `useSyncExternalStore`, so the subscription performed
 * on mount is what starts the first load; a later reload is an event (the
 * filter form, the refresh after a stream frame).
 */
export function createRunsStore(options: {
  consumeRequest?: () => void;
  report: (failure: unknown) => void;
  requestedRun?: string;
}): RunsStore {
  const { consumeRequest, report, requestedRun } = options;
  const store = createStore<RunsState>(
    { applied: emptyFilters, draft: emptyFilters, filtered: false, rows: [] },
    (self) => {
      void load(self, emptyFilters, report);
      if (requestedRun) {
        // A deep link, a recent run or a freshly created run arrives as a
        // navigation request. It is consumed here as a plain call: a store
        // cannot wait for a later React state change to react to one, and a
        // request read once is enough for a screen mounted per navigation.
        self.set((current) => ({ ...current, selected: requestedRun }));
        consumeRequest?.();
      }
    }
  );
  return {
    ...store,
    editDraft: (patch) =>
      store.set((current) => ({
        ...current,
        draft: { ...current.draft, ...patch },
      })),
    refresh: () => {
      void load(store, store.getSnapshot().applied, report);
    },
    select: (runId) =>
      store.set((current) => ({ ...current, selected: runId })),
    submitFilters: () => {
      const { draft } = store.getSnapshot();
      store.set((current) => ({ ...current, applied: draft }));
      void load(store, draft, report);
    },
  };
}
