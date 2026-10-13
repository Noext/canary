import { useState } from "react";
import type { RunResult, ScenarioSummary } from "@/api/contracts";
import { useError } from "@/app/errors";
import { JsonBlock } from "@/components/json-block";
import { Button } from "@/components/ui/button";
import { Notice, Pill } from "@/components/ui/feedback";
import { Card, CardHeader } from "@/components/ui/form";
import {
  runs as copy,
  errorMessages,
  phaseSteps,
  resultSummaries,
  runAdvice,
  runDiagnostic,
  runScreen,
} from "@/i18n";
import {
  githubCommentUrl,
  outcomeLabel,
  phaseIndex,
  phaseLabel,
  safeArtifactPath,
  shortSha,
  stateLabel,
  toneFor,
} from "@/lib/format";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { createRunDetailStore } from "./run-detail-store";

/**
 * Runs recorded before model selection existed carry no `input`: the wire
 * schema keeps the field opaque, so read the model defensively.
 */
export function modelFromInput(input: unknown): string {
  if (typeof input !== "object" || input === null || !("model" in input)) {
    return "";
  }
  const value = (input as { model?: unknown }).model;
  return typeof value === "string" ? value : "";
}

const errorOutcomes = ["failed", "blocked", "stale"];

/**
 * A run that was not browser-tested is not a run that failed.
 *
 * `errorOutcomes` is what the diagnostic block is for; `skipped` is the outcome
 * of a sound run whose plan retained nothing safe to drive, and `passed` needs no
 * explanation at all. The distinction is documented, so the block must not
 * flatten it into a red "why did this fail" panel.
 */

/** Phase tracker states: real utilities, the stylesheet has no `.done`. */
const phaseBase = "rounded-full border px-2 py-1";
const phaseDone = "border-pass/40 bg-pass/10 text-pass";
const phaseActive = "border-primary-edge bg-primary/20 font-semibold";

function phaseClass(
  index: number,
  phase: number,
  name: string | null | undefined,
  outcome: string | null | undefined
): string {
  if (name === "done") {
    return outcome === "passed" ? phaseDone : "";
  }
  if (index === phase) {
    return phaseActive;
  }
  return index < phase ? phaseDone : "";
}

function summaryFor(result: RunResult): string {
  const base = resultSummaries[result.outcome] ?? copy.resultFallback;
  // A structured diagnostic is rendered in French by the block below; the raw
  // server error is only the summary when there is nothing else to show, so the
  // two never repeat the same sentence in two languages.
  const error = result.error && !result.diagnostic ? ` ${result.error}` : "";
  const publication =
    result.publication?.status === "failed" ? copy.publicationFailed : "";
  return `${base}${error}${publication}`;
}

function summaryToneFor(
  result: RunResult | undefined
): "error" | "neutral" | "warning" {
  if (!result) {
    // The report could not be read: the summary explains the gap.
    return "warning";
  }
  return errorOutcomes.includes(result.outcome) ? "error" : "neutral";
}

/** The token/cost line, whose copy belongs to i18n like the rest. */
function usageLine(usage: RunResult["usage"]): string {
  if (!usage) {
    return "";
  }
  return copy.usage(
    usage.tokens,
    usage.costUsd,
    // Only a proven `true` may be labelled as an estimate: results persisted
    // before the field existed, or any result that omits it, carry no proof
    // that a tariff was configured.
    usage.pricingConfigured === true
  );
}

/** Bounded rendering of an `actual` value, which is arbitrary JSON. */
function actualText(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function Assertions({ item }: { item: ScenarioSummary }) {
  const executed = item.assertions ?? [];
  if (executed.length === 0) {
    return (
      <p className="mt-2 text-muted-foreground text-xs">
        {copy.assertionsEmpty}
      </p>
    );
  }
  const passed = executed.filter((assertion) => assertion.passed).length;
  return (
    <div className="mt-2">
      <p className="text-muted-foreground text-xs">
        {copy.assertions(passed, executed.length)}
      </p>
      <ul className="mt-1 space-y-1 text-xs">
        {executed.map((assertion) => {
          const planned = item.scenario.assertions?.find(
            (candidate) => candidate.id === assertion.id
          );
          const actual = actualText(assertion.actual);
          return (
            <li className="flex items-start gap-2" key={assertion.id}>
              <span aria-hidden="true">{assertion.passed ? "✓" : "✕"}</span>
              <span
                className={
                  assertion.passed ? "text-muted-foreground" : "text-on-fail"
                }
              >
                {planned?.description ?? assertion.id}
                {!assertion.passed && actual ? ` — ${actual}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ScenarioCard({
  item,
  runId,
}: {
  item: ScenarioSummary;
  runId: string;
}) {
  const videos = item.artifacts
    .map((artifact) => ({
      path: artifact.endsWith(".webm") ? safeArtifactPath(artifact) : undefined,
      source: artifact,
    }))
    .filter(
      (entry): entry is { path: string; source: string } =>
        entry.path !== undefined
    );
  return (
    <article className="rounded-lg border border-border bg-well p-4">
      <h3 className="flex flex-wrap items-center gap-2 font-semibold text-sm">
        <span>{item.scenario.title}</span>
        <Pill tone={toneFor(item.outcome)}>{outcomeLabel(item.outcome)}</Pill>
      </h3>
      <p className="mt-1 text-muted-foreground text-sm">
        {resultSummaries[item.outcome] ?? outcomeLabel(item.outcome)}
      </p>
      <Assertions item={item} />
      {item.error ? (
        <p className="mt-2 text-on-fail text-sm">{item.error}</p>
      ) : null}
      {videos.map((video) => (
        // biome-ignore lint/a11y/useMediaCaption: the run records a video, not a captioned track.
        <video
          aria-label={copy.videoLabel(item.scenario.title)}
          className="mt-3 w-full max-w-md rounded-md border border-border"
          controls
          key={`${item.scenario.id}/${video.source}`}
          preload="none"
          src={`/artifacts/${runId}/${encodeURIComponent(item.scenario.id)}/${video.path}`}
        />
      ))}
    </article>
  );
}

/**
 * Why the run did not go all the way: the server diagnostic, the phase it
 * stopped in and the scenarios that stopped on an error.
 *
 * A report written before the diagnostic existed carries none of it — the field
 * is absent or null — so the block gives the generic advice instead of an empty
 * panel. The expected cause and the next step are shown in French whenever this
 * build knows the code: the interface is French only, and `diagnose()` writes
 * its hint in English. An unknown code keeps the server's own wording, so the
 * advice Canary was given is never swallowed.
 *
 * `done` is the marker the runner records when it finishes, not a phase a run
 * can fail in: announcing it as the phase reached would say nothing, so it is
 * left out. An intermediate phase (a cancelled or interrupted run) is reported.
 */
function RunDiagnosticBlock({
  phase,
  result,
}: {
  phase: string | null | undefined;
  result: RunResult;
}) {
  const diagnostic = result.diagnostic;
  const failedScenarios = result.scenarios.filter((item) =>
    errorOutcomes.includes(item.outcome)
  );
  return (
    <Notice className="mt-3" id="runDiagnostic" tone="error">
      <h3 className="font-semibold text-sm">{runDiagnostic.title}</h3>
      {diagnostic ? (
        <>
          <p className="mt-1" id="runDiagnosticCode">
            {runDiagnostic.code(diagnostic.code)}
          </p>
          <p className="mt-1">
            {errorMessages[diagnostic.code] ?? diagnostic.message}
          </p>
          <p className="mt-1" id="runDiagnosticHint">
            {runDiagnostic.hint(runAdvice[diagnostic.code] ?? diagnostic.hint)}
          </p>
        </>
      ) : (
        <>
          <p className="mt-1">{runDiagnostic.fallback}</p>
          <p className="mt-1" id="runDiagnosticHint">
            {runDiagnostic.hintMissing}
          </p>
        </>
      )}
      {phase && phase !== "done" ? (
        <p className="mt-1" id="runDiagnosticPhase">
          {runDiagnostic.stoppedAt(phaseLabel(phase))}
        </p>
      ) : null}
      {failedScenarios.length > 0 ? (
        <>
          <p className="mt-2">
            {runDiagnostic.scenarios(failedScenarios.length)}
          </p>
          <ul className="mt-1 space-y-1">
            {failedScenarios.map((item) => (
              <FailedScenario item={item} key={item.scenario.id} />
            ))}
          </ul>
        </>
      ) : null}
    </Notice>
  );
}

/**
 * One scenario that stopped on an error, in the same French-first wording as the
 * run-level cause: its code drives the copy, and its own message and hint are
 * the fallback for a code this build does not know yet.
 */
function FailedScenario({ item }: { item: ScenarioSummary }) {
  const code = item.diagnostic?.code ?? "";
  const cause = errorMessages[code] ?? item.error;
  const advice = runAdvice[code] ?? item.diagnostic?.hint ?? undefined;
  return (
    <li>
      <span className="font-medium">{item.scenario.title}</span>
      {cause ? ` — ${cause}` : null}
      {advice ? <p>{runDiagnostic.hint(advice)}</p> : null}
    </li>
  );
}

/**
 * The panel the history mounts when the run could not be read. Its own screen,
 * `RunScreenView`, shows the same sentence in place of the whole detail; this is
 * for the callers that have nothing else to put there.
 */
function RunMissing({ runId }: { runId?: string }) {
  return (
    <Card hidden={!runId} id="detail">
      <Notice id="runMissing" tone="warning">
        {runScreen.missing}
      </Notice>
      <p className="mt-3 text-muted-foreground text-sm" id="runIdentifier">
        {runId ? copy.runIdentifierPrefix + runId : ""}
      </p>
    </Card>
  );
}

/**
 * The selected run: its live progress, its result report and the technical
 * diagnostic every assertion of the end-to-end suite reads.
 *
 * The whole run lifecycle lives in the store, which the caller keys on the
 * selected id: the subscription React performs on mount is what validates the
 * run and opens its stream, and the one it releases on unmount closes it.
 * `onUpdate` is captured once — it is the stable refresh of the caller, not a
 * value that changes per render.
 */
export function RunDetail({
  canWrite,
  onUnavailable,
  onUpdate,
  runId,
}: {
  canWrite: boolean;
  /**
   * Called when the run cannot be read at all. A caller that shows the missing
   * state on its own screen takes over the explanation; the panel the history
   * mounts keeps it in place, because it has nowhere else to put it.
   */
  onUnavailable?: () => void;
  onUpdate?: () => void;
  runId?: string;
}) {
  const { report } = useError();
  const [store] = useState(() =>
    createRunDetailStore({ onUnavailable, onUpdate, report, runId })
  );
  const { cancelling, job, live, message, result, resultFailure, unavailable } =
    useStore(store);

  const progress = job?.progress;
  const phase = phaseIndex(progress?.phase);
  const running = job?.status === "queued" || job?.status === "running";
  const summary = result ? summaryFor(result) : resultFailure;
  const summaryTone = summaryToneFor(result);
  const commentUrl = githubCommentUrl(result?.publication?.commentUrl);
  const progressJson = job ? JSON.stringify(progress ?? {}, null, 2) : "";
  const resultJson = result ? JSON.stringify(result, null, 2) : "";

  // A purged run, or one belonging to another account, never produces a frame:
  // saying so beats a panel that waits forever for a stream that cannot open.
  if (unavailable) {
    return <RunMissing runId={runId} />;
  }

  return (
    <Card hidden={!runId} id="detail">
      <CardHeader>
        <div>
          <p
            className="font-semibold text-muted-foreground text-xs uppercase tracking-wide"
            id="runState"
          >
            {job
              ? outcomeLabel(job.outcome ?? "") ||
                stateLabel(job.status) ||
                job.status
              : copy.detailEyebrow}
          </p>
          <h2 className="font-semibold text-lg" id="runTitle">
            {job ? `${job.repo} · PR #${job.pr}` : ""}
          </h2>
        </div>
        <Button
          disabled={cancelling}
          hidden={!(canWrite && running)}
          id="cancel"
          onClick={() => void store.cancel()}
          type="button"
          variant="danger"
        >
          {copy.cancel}
        </Button>
      </CardHeader>
      <p className="text-muted-foreground text-sm" id="provenance">
        {job
          ? `Commit ${shortSha(job.sha)} · ${
              modelFromInput(job.input) || copy.historicalModelDetail
            }`
          : ""}
      </p>
      <ol className="mt-3 flex flex-wrap gap-2 text-xs" id="phaseList">
        {phaseSteps.map((step, index) => (
          <li
            className={cn(
              phaseBase,
              phaseClass(index, phase, progress?.phase, job?.outcome)
            )}
            key={step}
          >
            {step}
          </li>
        ))}
      </ol>
      <Pill className="mt-3" id="liveConnection">
        {live}
      </Pill>
      <p className="mt-2 text-sm" id="liveMessage">
        {message}
      </p>
      <Notice
        className="mt-3"
        hidden={!summary}
        id="resultSummary"
        tone={summaryTone}
      >
        {summary}
      </Notice>
      {result && errorOutcomes.includes(result.outcome) ? (
        <RunDiagnosticBlock phase={progress?.phase} result={result} />
      ) : null}
      <div className="mt-4 space-y-3" id="scenarioCards">
        {result?.scenarios.map((item) => (
          <ScenarioCard item={item} key={item.scenario.id} runId={result.id} />
        ))}
      </div>
      <p className="mt-3 text-muted-foreground text-sm" id="usage">
        {usageLine(result?.usage)}
      </p>
      <div className="mt-3 flex flex-wrap gap-4 font-medium text-sm" id="links">
        {result ? (
          <>
            <a
              className="underline-offset-4 hover:underline"
              href={`/artifacts/${result.id}/report.html`}
              rel="noopener"
              target="_blank"
            >
              {copy.report}
            </a>
            {commentUrl ? (
              <a
                className="underline-offset-4 hover:underline"
                href={commentUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                {copy.githubResult}
              </a>
            ) : null}
          </>
        ) : null}
      </div>
      <details className="technical mt-4 text-sm">
        <summary className="cursor-pointer font-medium">
          {copy.technicalSummary}
        </summary>
        <p className="mt-2 text-muted-foreground">{copy.technicalIntro}</p>
        <p id="runIdentifier">
          {runId ? copy.runIdentifierPrefix + runId : ""}
        </p>
        <JsonBlock
          copyId="copyEvents"
          id="events"
          label={copy.eventsLabel}
          text={progressJson}
        />
        <JsonBlock
          copyId="copyResult"
          id="result"
          label={copy.resultLabel}
          text={resultJson}
        />
      </details>
    </Card>
  );
}
