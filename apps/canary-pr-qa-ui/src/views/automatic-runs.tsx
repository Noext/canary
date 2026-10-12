import { type ReactNode, useEffect, useState } from "react";
import { api } from "@/api/client";
import type { AutomaticStatus } from "@/api/contracts";
import { useError } from "@/app/errors";
import { useWorkspace } from "@/app/workspace";
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
  shortSha,
  toneForAutomatic,
} from "@/lib/format";

const emptyStatus: AutomaticStatus = {
  attempts: [],
  enabledRepos: [],
  summary: { expired: 0, rateLimited: 0, waiting: 0 },
};

/**
 * Pull requests Canary picked up by itself and could not run yet: the exact-SHA
 * preview is still missing, the deadline passed or GitHub throttled the
 * repository. A delivery that already produced a run is reported by the runs
 * history, never here. Dates are rendered, not counted down, so nothing here
 * depends on the current time.
 */
export function AutomaticRuns(): ReactNode {
  const { githubReady } = useWorkspace();
  const { report } = useError();
  const [status, setStatus] = useState<AutomaticStatus>();

  useEffect(() => {
    if (!githubReady) {
      return;
    }
    let active = true;
    api("/dashboard/automatic")
      .then((next) => {
        if (active) {
          setStatus(next);
        }
      })
      .catch((failure: unknown) => {
        if (!active) {
          return;
        }
        // The alert carries the failure; the block keeps an empty, readable
        // list instead of a half-rendered one.
        report(failure);
        setStatus(emptyStatus);
      });
    return () => {
      active = false;
    };
  }, [githubReady, report]);

  // Without GitHub there is no automatic run to report, and the endpoint would
  // only answer an empty scope.
  if (!githubReady) {
    return null;
  }

  const loading = status === undefined;
  const attempts = status?.attempts ?? [];
  const summary = status?.summary ?? emptyStatus.summary;

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
          {automatic.enabledRepos(status?.enabledRepos.length ?? 0)}
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
