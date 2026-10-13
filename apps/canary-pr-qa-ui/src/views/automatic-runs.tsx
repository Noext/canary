import { type ReactNode, useState } from "react";
import { useError } from "@/app/errors";
import { useNavigation } from "@/app/navigation";
import { useSession } from "@/app/session";
import { useWorkspace } from "@/app/workspace";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/feedback";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/form";
import { automatic, common } from "@/i18n";
import {
  automaticReasonLabel,
  automaticStateLabel,
  formatDate,
  githubPullUrl,
  retryableAutomatic,
  shortSha,
  toneForAutomatic,
} from "@/lib/format";
import { useStore } from "@/lib/store";
import { createAutomaticRunsStore } from "./automatic-runs-store";

/**
 * Pull requests Canary picked up by itself and could not run yet: the exact-SHA
 * preview is still missing, the deadline passed or GitHub throttled the
 * repository. A delivery that already produced a run is reported by the runs
 * history, never here. Dates are rendered, not counted down, so nothing here
 * depends on the current time. A failure that stopped without a run offers the
 * retry that puts it back in the probe loop.
 */
export function AutomaticRuns(): ReactNode {
  const { githubReady } = useWorkspace();
  // Without GitHub there is no automatic run to report: the block is not
  // mounted, so no request is issued for a scope that can only be empty.
  if (!githubReady) {
    return null;
  }
  return <AutomaticRunsBlock />;
}

function AutomaticRunsBlock(): ReactNode {
  const { report } = useError();
  const { canWrite } = useSession();
  const { openAutomatic } = useNavigation();
  // The store instance belongs to this screen, never to module scope: React's
  // first subscription starts the request and abandoning the screen aborts it.
  const [store] = useState(() => createAutomaticRunsStore(report));
  const { loading, retrying, status } = useStore(store);

  const attempts = status.attempts;
  const summary = status.summary;

  return (
    <Card className="mb-5" id="automaticRuns">
      <CardHeader>
        <div>
          <CardTitle>{automatic.title}</CardTitle>
          <CardDescription>{automatic.intro}</CardDescription>
        </div>
        <span
          className="text-muted-foreground text-xs"
          hidden={loading}
          id="automaticEnabledRepos"
        >
          {automatic.enabledRepos(status.enabledRepos.length)}
        </span>
      </CardHeader>
      <p
        className="text-muted-foreground text-sm"
        hidden={!loading}
        role="status"
      >
        {common.loading}
      </p>
      <div
        className="flex flex-wrap gap-2"
        hidden={loading}
        id="automaticSummary"
      >
        <Pill tone="pending">{automatic.summary.waiting(summary.waiting)}</Pill>
        <Pill tone="failed">{automatic.summary.expired(summary.expired)}</Pill>
        <Pill tone="neutral">
          {automatic.summary.rateLimited(summary.rateLimited)}
        </Pill>
      </div>
      <ul
        className="mt-3 grid gap-2"
        hidden={loading || attempts.length === 0}
        id="automaticAttempts"
      >
        {attempts.map((attempt) => {
          const reason = automaticReasonLabel(attempt.reason);
          const prUrl = githubPullUrl(attempt.repo, attempt.pr);
          return (
            <li
              className="rounded-lg border border-border px-3 py-2"
              data-state={attempt.state}
              key={attempt.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2">
                  {prUrl ? (
                    <a
                      className="font-medium text-sm underline-offset-4 hover:underline"
                      href={prUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {`${attempt.repo} #${attempt.pr}`}
                    </a>
                  ) : (
                    <span className="font-medium text-sm">
                      {`${attempt.repo} #${attempt.pr}`}
                    </span>
                  )}
                  <code className="text-muted-foreground text-xs">
                    {shortSha(attempt.sha)}
                  </code>
                </span>
                <Pill tone={toneForAutomatic(attempt.state)}>
                  {automaticStateLabel(attempt.state)}
                </Pill>
              </div>
              {reason ? (
                <p className="mt-1 text-muted-foreground text-sm">{reason}</p>
              ) : null}
              <p className="mt-1 text-muted-foreground text-xs">
                {`${automatic.attempts(attempt.attempts)} · ${automatic.deadline(
                  formatDate(attempt.deadlineAt)
                )}`}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Button
                  id={`automaticAttempt-${attempt.id}`}
                  onClick={() => openAutomatic(attempt.id)}
                  variant="quiet"
                >
                  {automatic.detail}
                </Button>
                {/*
                  An attempt that stopped without a run can be re-armed where
                  the operator already is. A viewer gets no button: the server
                  refuses the write, and its detail screen explains the state.
                */}
                {canWrite && retryableAutomatic(attempt.state) ? (
                  <Button
                    disabled={retrying === attempt.id}
                    id={`automaticRetry-${attempt.id}`}
                    onClick={() => store.retry(attempt.id)}
                    title={automatic.retryTitle}
                    variant="primary"
                  >
                    {retrying === attempt.id
                      ? automatic.retrying
                      : automatic.retry}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <div
        className="py-6 text-center"
        hidden={loading || attempts.length > 0}
        id="automaticEmpty"
      >
        <div aria-hidden="true" className="text-2xl text-faint">
          ⏱
        </div>
        <h3 className="mt-2 font-semibold text-sm">{automatic.empty}</h3>
        <p className="mt-1 text-muted-foreground text-sm">
          {automatic.emptyHint}
        </p>
      </div>
      <p
        className="mt-3 text-muted-foreground text-sm"
        id="automaticManualHint"
      >
        {automatic.manualHint}
      </p>
    </Card>
  );
}
