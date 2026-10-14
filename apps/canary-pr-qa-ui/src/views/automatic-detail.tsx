import { type ReactNode, useState } from "react";
import type { AutomaticDetail, AutomaticState } from "@/api/contracts";
import { useError } from "@/app/errors";
import { useNavigation } from "@/app/navigation";
import { useSession } from "@/app/session";
import { Button } from "@/components/ui/button";
import { Notice, Pill } from "@/components/ui/feedback";
import { Card, CardHeader } from "@/components/ui/form";
import {
  automatic,
  automaticAdvice,
  automaticDetail,
  automaticSteps,
} from "@/i18n";
import {
  automaticReasonLabel,
  automaticStateLabel,
  deletableAutomatic,
  formatDate,
  githubPullUrl,
  retryableAutomatic,
  shortSha,
  toneForAutomatic,
} from "@/lib/format";
import { useStore } from "@/lib/store";
import { AutomaticDelete } from "./automatic-delete";
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
  const { canWrite } = useSession();
  const { consumeAutomatic, navigate, openRunScreen, requestedAutomatic } =
    useNavigation();
  const [store] = useState(() =>
    createAutomaticDetailStore({
      consumeRequest: consumeAutomatic,
      report,
      requested: requestedAutomatic,
    })
  );
  const { deleting, detail, error, loading, missing, retrying } =
    useStore(store);

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
      canWrite={canWrite}
      deleting={Boolean(deleting)}
      detail={detail}
      navigate={navigate}
      onDelete={() => {
        // The attempt is gone once the write is done, so the screen hands the
        // operator back to the list that still has the others. A refused write
        // keeps this screen: its own message and the attempt are both there.
        void store.remove().then((removed) => {
          if (removed) {
            navigate("home");
          }
        });
      }}
      onRetry={store.retry}
      openRunScreen={openRunScreen}
      retrying={Boolean(retrying)}
    />
  );
}

function AutomaticDetailBody({
  canWrite,
  deleting,
  detail,
  navigate,
  onDelete,
  onRetry,
  openRunScreen,
  retrying,
}: {
  canWrite: boolean;
  deleting: boolean;
  detail: AutomaticDetail;
  navigate: (view: "home" | "new") => void;
  onDelete: () => void;
  onRetry: () => void;
  openRunScreen: (runId: string) => void;
  retrying: boolean;
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
  const diagnosed = diagnosedStates.includes(attempt.state);
  // A cause exists only once a probe recorded one. An attempt re-armed from this
  // screen is waiting again with no reason yet: an empty cause and the fallback
  // advice would tell the operator to start a manual run on a commit Canary is
  // already probing. The facts below it are still about this attempt, so they
  // stay, and the waiting notice above says what is happening.
  const explained = diagnosed && Boolean(attempt.reason);

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

      {attempt.state === "discarded" ? (
        <Notice id="automaticDetailDiscarded" tone="neutral">
          {automaticDetail.discarded}
        </Notice>
      ) : null}

      <PromotedAction
        canWrite={canWrite}
        deletable={deletableAutomatic(attempt.state)}
        deleting={deleting}
        navigate={navigate}
        onDelete={onDelete}
        onRetry={onRetry}
        openRunScreen={openRunScreen}
        retryable={retryableAutomatic(attempt.state)}
        retrying={retrying}
        runId={promotedRunId}
      />

      {/*
        The cause and the advice explain what stopped this attempt. A promoted or
        discarded attempt kept the reason of a failed probe from before it ended
        that way, so rendering it here would tell the operator to deploy a commit
        whose test has already started. `disabled` is included: there the reason
        is the refusal itself, and the advice matches it. A waiting attempt that
        has no reason yet is skipped too — see `explained`.
      */}
      {explained ? (
        <>
          <section className="mt-4" id="automaticDetailCause">
            <h2 className="font-semibold text-sm">
              {automaticDetail.causeTitle}
            </h2>
            <p className="mt-1 text-muted-foreground text-sm">
              {automaticReasonLabel(attempt.reason)}
            </p>
          </section>

          <section className="mt-4" id="automaticDetailAdvice">
            <h2 className="font-semibold text-sm">
              {automaticDetail.adviceTitle}
            </h2>
            <p className="mt-1 text-muted-foreground text-sm">
              {automaticAdvice[attempt.reason] ??
                automaticDetail.adviceFallback}
            </p>
          </section>
        </>
      ) : null}

      {diagnosed ? (
        <section className="mt-4" id="automaticDetailFacts">
          <h2 className="font-semibold text-sm">
            {automaticDetail.factsTitle}
          </h2>
          <ul className="mt-1 text-muted-foreground text-sm">
            <li>{automaticDetail.attempts(attempt.attempts)}</li>
            <li>{automaticDetail.deadline(formatDate(attempt.deadlineAt))}</li>
            <li>{automaticDetail.lastProbe(formatDate(attempt.updatedAt))}</li>
            <li>{automaticDetail.pinned(attempt.sha)}</li>
          </ul>
        </section>
      ) : null}

      {attempt.lastError ? (
        <Notice className="mt-4" id="automaticDetailError" tone="error">
          <strong className="block font-semibold">
            {automaticDetail.lastErrorTitle}
          </strong>
          {attempt.lastError}
        </Notice>
      ) : null}

      {preview ? <PreviewProof preview={preview} /> : null}

      <Timeline steps={steps} />

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

/**
 * The states whose recorded reason is what stopped the attempt. `promoted` and
 * `discarded` are ends that a later probe produced, so their reason is history;
 * the audit timeline is where that history belongs.
 */
const diagnosedStates: AutomaticState[] = [
  "waiting",
  "expired",
  "rate_limited",
  "disabled",
];

/** The run a promoted attempt created, or the actions that take its place. */
function PromotedAction({
  canWrite,
  deletable,
  deleting,
  navigate,
  onDelete,
  onRetry,
  openRunScreen,
  retryable,
  retrying,
  runId,
}: {
  canWrite: boolean;
  deletable: boolean;
  deleting: boolean;
  navigate: (view: "home" | "new") => void;
  onDelete: () => void;
  onRetry: () => void;
  openRunScreen: (runId: string) => void;
  retryable: boolean;
  retrying: boolean;
  runId: string | null;
}): ReactNode {
  if (!runId) {
    return (
      <FailedAttemptActions
        canWrite={canWrite}
        deletable={deletable}
        deleting={deleting}
        navigate={navigate}
        onDelete={onDelete}
        onRetry={onRetry}
        retryable={retryable}
        retrying={retrying}
      />
    );
  }
  return (
    <div
      className="mt-4 flex flex-wrap items-center gap-3"
      id="automaticDetailPromoted"
    >
      <span className="text-sm">{automaticDetail.promoted}</span>
      <Button
        id="automaticDetailRunCta"
        onClick={() => openRunScreen(runId)}
        variant="primary"
      >
        {automaticDetail.promotedCta}
      </Button>
    </div>
  );
}

/**
 * The version proof the preview of this attempt had to satisfy, and — first —
 * how Canary was supposed to find the application at all.
 *
 * The two questions are separate and both decide the outcome: without a URL
 * model, Canary falls back to the GitHub deployments of the pull request, which
 * is exactly the difference between "aucune application trouvée" and "cette
 * application n'annonce pas le commit". Stating the fallback even when a header
 * or a JSON path is configured is what makes that difference readable.
 */
function PreviewProof({
  preview,
}: {
  preview: NonNullable<AutomaticDetail["preview"]>;
}): ReactNode {
  const lines = [
    preview.template
      ? automaticDetail.previewTemplate(preview.template)
      : automaticDetail.previewNone,
    preview.shaHeader
      ? automaticDetail.previewHeader(preview.shaHeader)
      : undefined,
    preview.shaPath ? automaticDetail.previewPath(preview.shaPath) : undefined,
  ].filter((line): line is string => line !== undefined);
  return (
    <section className="mt-4" id="automaticDetailPreview">
      <h2 className="font-semibold text-sm">{automaticDetail.previewTitle}</h2>
      <ul className="mt-1 text-muted-foreground text-sm">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

/** The audit trail, oldest first, whatever order the server returned. */
function Timeline({
  steps,
}: {
  steps: AutomaticDetail["timeline"];
}): ReactNode {
  return (
    <section className="mt-4" id="automaticDetailTimeline">
      <h2 className="font-semibold text-sm">{automaticDetail.timelineTitle}</h2>
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
  );
}

/**
 * The actions of an attempt that never started a run: re-arm it on the same
 * commit, give up on it and clear the list, or start a run by hand with an
 * explicit URL. All three answer "what now?", and only a failure that a probe can
 * still fix offers the retry or the delete.
 *
 * They are open to writers only: the navigation guard would silently send a
 * viewer back to the home screen, so a viewer is told what to ask for instead of
 * being offered a button that does nothing.
 */
function FailedAttemptActions({
  canWrite,
  deletable,
  deleting,
  navigate,
  onDelete,
  onRetry,
  retryable,
  retrying,
}: {
  canWrite: boolean;
  deletable: boolean;
  deleting: boolean;
  navigate: (view: "home" | "new") => void;
  onDelete: () => void;
  onRetry: () => void;
  retryable: boolean;
  retrying: boolean;
}): ReactNode {
  if (!canWrite) {
    return (
      <p
        className="mt-4 text-muted-foreground text-sm"
        id="automaticDetailRunViewer"
      >
        {automaticDetail.runViewer}
      </p>
    );
  }
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button id="automaticDetailRunCta" onClick={() => navigate("new")}>
        {automaticDetail.runCta}
      </Button>
      {retryable ? (
        <Button
          disabled={retrying}
          id="automaticDetailRetry"
          onClick={onRetry}
          title={automatic.retryTitle}
          variant="primary"
        >
          {retrying ? automatic.retrying : automatic.retry}
        </Button>
      ) : null}
      {/*
        A failure this screen was opened to act on is also the one an operator
        decides to give up on: the delete is the same write the list offers.
      */}
      {deletable ? (
        <AutomaticDelete
          id="automaticDetailDelete"
          onConfirm={onDelete}
          pending={deleting}
        />
      ) : null}
    </div>
  );
}
