import { type ReactNode, useState } from "react";
import type { AutomaticDetail } from "@/api/contracts";
import { useError } from "@/app/errors";
import { useNavigation } from "@/app/navigation";
import { Button } from "@/components/ui/button";
import { Notice, Pill } from "@/components/ui/feedback";
import { Card, CardHeader } from "@/components/ui/form";
import { automaticAdvice, automaticDetail, automaticSteps } from "@/i18n";
import {
  automaticReasonLabel,
  automaticStateLabel,
  formatDate,
  githubPullUrl,
  shortSha,
  toneForAutomatic,
} from "@/lib/format";
import { useStore } from "@/lib/store";
import { createAutomaticDetailStore } from "./automatic-detail-store";

/**
 * One automatic attempt that never produced a run: what Canary probed, why it
 * stopped, and the next step for the operator.
 *
 * The shell owns the page title and intro (`views.automatic`); this screen only
 * renders the attempt. A deep link arrives as a navigation request, consumed
 * once when the store is built — the subscription React performs on mount is
 * what issues the request, and abandoning the screen aborts it.
 */
export function AutomaticDetailView(): ReactNode {
  const { report } = useError();
  const { consumeAutomatic, navigate, openRunScreen, requestedAutomatic } =
    useNavigation();
  const [store] = useState(() =>
    createAutomaticDetailStore({
      consumeRequest: consumeAutomatic,
      report,
      requested: requestedAutomatic,
    })
  );
  const { detail, error, loading, missing } = useStore(store);

  if (missing) {
    return (
      <Card id="automaticDetail">
        <div id="automaticDetailState">
          <Notice tone="warning">{automaticDetail.missing}</Notice>
          <Button
            className="mt-3"
            id="automaticDetailBack"
            onClick={() => navigate("home")}
          >
            {automaticDetail.back}
          </Button>
        </div>
      </Card>
    );
  }

  if (loading || !detail) {
    return (
      <Card id="automaticDetail">
        {loading ? (
          <p id="automaticDetailState" role="status">
            {automaticDetail.loading}
          </p>
        ) : (
          <div id="automaticDetailState">
            <Notice tone="error">{error}</Notice>
            <Button
              className="mt-3"
              id="automaticDetailBack"
              onClick={() => navigate("home")}
            >
              {automaticDetail.back}
            </Button>
          </div>
        )}
      </Card>
    );
  }

  return (
    <AutomaticDetailBody
      detail={detail}
      navigate={navigate}
      openRunScreen={openRunScreen}
    />
  );
}

function AutomaticDetailBody({
  detail,
  navigate,
  openRunScreen,
}: {
  detail: AutomaticDetail;
  navigate: (view: "home" | "new") => void;
  openRunScreen: (runId: string) => void;
}): ReactNode {
  const { attempt, preview, timeline } = detail;
  const prUrl = githubPullUrl(attempt.repo, attempt.pr);
  // Narrowed once here: a truthy `attempt.runId` inside a callback would lose
  // the narrowing the JSX branch performs.
  const promotedRunId = attempt.runId;
  // The timeline is rendered oldest first whatever the server order; an absent
  // step name still renders its raw action so the trail is never hidden.
  const steps = [...timeline].sort((left, right) =>
    left.at.localeCompare(right.at)
  );

  return (
    <Card id="automaticDetail">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className="flex flex-wrap items-center gap-2"
            id="automaticDetailHeader"
          >
            <span className="font-semibold text-sm">
              {`${attempt.repo} #${attempt.pr}`}
            </span>
            <code className="text-muted-foreground text-xs">
              {shortSha(attempt.sha)}
            </code>
            {prUrl ? (
              <a
                className="text-sm underline-offset-4 hover:underline"
                href={prUrl}
                rel="noreferrer"
                target="_blank"
              >
                {automaticDetail.githubPr}
              </a>
            ) : null}
          </span>
          <Pill id="automaticDetailPill" tone={toneForAutomatic(attempt.state)}>
            {automaticStateLabel(attempt.state)}
          </Pill>
        </div>
      </CardHeader>

      {attempt.state === "waiting" ? (
        <Notice id="automaticDetailWaiting" tone="neutral">
          {automaticDetail.waiting}
        </Notice>
      ) : null}

      <section className="mt-4" id="automaticDetailCause">
        <h2 className="font-semibold text-sm">{automaticDetail.causeTitle}</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          {automaticReasonLabel(attempt.reason)}
        </p>
      </section>

      <section className="mt-4" id="automaticDetailAdvice">
        <h2 className="font-semibold text-sm">{automaticDetail.adviceTitle}</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          {automaticAdvice[attempt.reason] ?? automaticDetail.adviceFallback}
        </p>
      </section>

      <section className="mt-4" id="automaticDetailFacts">
        <h2 className="font-semibold text-sm">{automaticDetail.factsTitle}</h2>
        <ul className="mt-1 text-muted-foreground text-sm">
          <li>{automaticDetail.attempts(attempt.attempts)}</li>
          <li>{automaticDetail.deadline(formatDate(attempt.deadlineAt))}</li>
          <li>{automaticDetail.lastProbe(formatDate(attempt.updatedAt))}</li>
          <li>{automaticDetail.pinned(attempt.sha)}</li>
        </ul>
      </section>

      {attempt.lastError ? (
        <Notice className="mt-4" id="automaticDetailError" tone="error">
          <strong className="block font-semibold">
            {automaticDetail.lastErrorTitle}
          </strong>
          {attempt.lastError}
        </Notice>
      ) : null}

      {promotedRunId ? (
        <div
          className="mt-4 flex flex-wrap items-center gap-3"
          id="automaticDetailPromoted"
        >
          <span className="text-sm">{automaticDetail.promoted}</span>
          <Button
            id="automaticDetailRunCta"
            onClick={() => openRunScreen(promotedRunId)}
            variant="primary"
          >
            {automaticDetail.promotedCta}
          </Button>
        </div>
      ) : (
        <Button
          className="mt-4"
          id="automaticDetailRunCta"
          onClick={() => navigate("new")}
        >
          {automaticDetail.runCta}
        </Button>
      )}

      {preview ? (
        <section className="mt-4" id="automaticDetailPreview">
          <h2 className="font-semibold text-sm">
            {automaticDetail.previewTitle}
          </h2>
          <ul className="mt-1 text-muted-foreground text-sm">
            {preview.template ? (
              <li>{automaticDetail.previewTemplate(preview.template)}</li>
            ) : null}
            {preview.shaHeader ? (
              <li>{automaticDetail.previewHeader(preview.shaHeader)}</li>
            ) : null}
            {preview.shaPath ? (
              <li>{automaticDetail.previewPath(preview.shaPath)}</li>
            ) : null}
            {preview.template || preview.shaHeader || preview.shaPath ? null : (
              <li>{automaticDetail.previewNone}</li>
            )}
          </ul>
        </section>
      ) : null}

      <section className="mt-4" id="automaticDetailTimeline">
        <h2 className="font-semibold text-sm">
          {automaticDetail.timelineTitle}
        </h2>
        {steps.length === 0 ? (
          <p className="mt-1 text-muted-foreground text-sm">
            {automaticDetail.timelineEmpty}
          </p>
        ) : (
          <ol className="mt-1 space-y-1 text-sm">
            {steps.map((entry) => (
              <li
                className="flex flex-wrap items-baseline gap-2"
                key={`${entry.action}-${entry.at}`}
              >
                <span>{automaticSteps[entry.action] ?? entry.action}</span>
                <span className="text-muted-foreground text-xs">
                  {formatDate(entry.at)}
                  {typeof entry.seconds === "number"
                    ? ` · ${entry.seconds} s`
                    : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <Button
        className="mt-4"
        id="automaticDetailBack"
        onClick={() => navigate("home")}
      >
        {automaticDetail.back}
      </Button>
    </Card>
  );
}
