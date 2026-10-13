import { type ReactNode, useState } from "react";
import { useNavigation } from "@/app/navigation";
import { useSession } from "@/app/session";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/feedback";
import { runScreen as copy } from "@/i18n";
import { createStore, type Store, useStore } from "@/lib/store";
import { RunDetail } from "./run-detail";

interface RunScreenState {
  runId?: string;
}

/**
 * The run this screen was opened on.
 *
 * The deep link is turned into a run id once, by the first subscription — the
 * moment React mounts the screen — and consumed right away: a request that has
 * become a run id must not outlive the screen it opened, or coming back to
 * `#run=<uuid>` would resurrect it. The id lives in the snapshot, so a
 * re-render (or StrictMode's replayed subscription) reads the same run.
 */
function createRunScreenStore(options: {
  consumeRequest: () => string | undefined;
  requestedRunScreen?: string;
}): Store<RunScreenState> {
  const { consumeRequest, requestedRunScreen } = options;
  return createStore<RunScreenState>({ runId: requestedRunScreen }, () => {
    if (requestedRunScreen) {
      consumeRequest();
    }
  });
}

/**
 * The full-screen report of one run, opened from its own link (`#run=<uuid>`).
 *
 * The page title and intro belong to the shell: this screen only offers the way
 * back to the history and the way to select the same run there, and hands the
 * run over to the detail panel every assertion of the suite already reads.
 */
export function RunScreenView(): ReactNode {
  const { canWrite } = useSession();
  const { consumeRunScreen, navigate, openRun, requestedRunScreen } =
    useNavigation();
  const [store] = useState(() =>
    createRunScreenStore({
      consumeRequest: consumeRunScreen,
      requestedRunScreen,
    })
  );
  const { runId } = useStore(store);
  // A syntactically valid link can still point at a purged run, or at another
  // account's: the panel reports it, and this screen replaces it with the
  // missing state instead of leaving a detail that can never load.
  const [missing, setMissing] = useState(false);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" id="runScreen">
        <Button id="runScreenBack" onClick={() => navigate("runs")}>
          {copy.back}
        </Button>
        {runId && !missing ? (
          <Button
            id="runScreenSeenIn"
            onClick={() => {
              openRun(runId);
              navigate("runs");
            }}
          >
            {copy.seenIn}
          </Button>
        ) : null}
      </div>
      {runId && !missing ? (
        <div className="mt-5">
          <RunDetail
            canWrite={canWrite}
            key={runId}
            onUnavailable={() => setMissing(true)}
            runId={runId}
          />
        </div>
      ) : (
        <Notice className="mt-5" id="runScreenMissing" tone="warning">
          {copy.missing}
        </Notice>
      )}
    </>
  );
}
