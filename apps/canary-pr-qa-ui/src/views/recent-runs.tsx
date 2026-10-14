import type { RunJob } from "@/api/contracts";
import { routeUrl } from "@/app/routing";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/feedback";
import { Card, CardHeader, CardTitle } from "@/components/ui/form";
import { home } from "@/i18n";
import { outcomeLabel, stateLabel, toneFor } from "@/lib/format";
import { isPlainLeftClick } from "@/lib/link";

/** The pill follows the run's outcome, falling back to its status. */
function runLabel(run: RunJob): string {
  return run.outcome ? outcomeLabel(run.outcome) : stateLabel(run.status);
}

/**
 * The home panel's recent-runs card: the latest runs, each one linking to its
 * own page, and the way into the whole history. It renders the list it is
 * given, so the panel keeps the single request that also fills its counters.
 */
export function RecentRunsCard({
  all,
  error,
  loading,
  onOpen,
  onShowHistory,
  recent,
}: {
  all: RunJob[];
  error?: string;
  loading: boolean;
  onOpen(runId: string): void;
  onShowHistory(): void;
  recent: RunJob[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{home.cardTitle}</CardTitle>
        <Button id="showHistory" onClick={onShowHistory} variant="quiet">
          {home.showHistory}
        </Button>
      </CardHeader>
      {loading || error ? (
        <p className="text-muted-foreground text-sm" role="status">
          {error ?? home.runsLoading}
        </p>
      ) : null}
      <div
        className="py-6 text-center"
        hidden={loading || Boolean(error) || all.length > 0}
        id="overviewEmpty"
      >
        <div aria-hidden="true" className="text-2xl">
          ✓
        </div>
        <h3 className="mt-2 font-semibold text-sm">{home.emptyTitle}</h3>
        <p className="mt-1 text-muted-foreground text-sm">{home.emptyIntro}</p>
      </div>
      <div className="grid gap-2" id="recentRuns">
        {recent.map((run) => (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
            key={run.id}
          >
            <a
              className="font-medium text-sm underline-offset-4 hover:underline"
              href={routeUrl({ kind: "runs", runId: run.id })}
              onClick={(event) => {
                if (!isPlainLeftClick(event)) {
                  return;
                }
                event.preventDefault();
                onOpen(run.id);
              }}
            >
              {`${run.repo} #${run.pr}`}
            </a>
            <Pill tone={toneFor(run.outcome ?? run.status)}>
              {runLabel(run)}
            </Pill>
          </div>
        ))}
      </div>
    </Card>
  );
}
