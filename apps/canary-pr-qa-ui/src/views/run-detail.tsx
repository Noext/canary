import { useState } from "react";
import type { RunResult, ScenarioSummary } from "@/api/contracts";
import { useError } from "@/app/errors";
import { Button } from "@/components/ui/button";
import { Notice, Pill } from "@/components/ui/feedback";
import { Card, CardHeader } from "@/components/ui/form";
import { runs as copy, phaseSteps, resultSummaries } from "@/i18n";
import {
  githubCommentUrl,
  outcomeLabel,
  phaseIndex,
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
  const error = result.error ? ` ${result.error}` : "";
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
  onUpdate,
  runId,
}: {
  canWrite: boolean;
  onUpdate?: () => void;
  runId?: string;
}) {
  const { report } = useError();
  const [store] = useState(() =>
    createRunDetailStore({ onUpdate, report, runId })
  );
  const { cancelling, job, live, message, result, resultFailure } =
    useStore(store);

  const progress = job?.progress;
  const phase = phaseIndex(progress?.phase);
  const running = job?.status === "queued" || job?.status === "running";
  const summary = result ? summaryFor(result) : resultFailure;
  const summaryTone = summaryToneFor(result);
  const commentUrl = githubCommentUrl(result?.publication?.commentUrl);

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
        <pre
          className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-well p-2 text-xs"
          id="events"
        >
          {job ? JSON.stringify(progress ?? {}, null, 2) : ""}
        </pre>
        <pre
          className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-well p-2 text-xs"
          id="result"
        >
          {result ? JSON.stringify(result, null, 2) : ""}
        </pre>
      </details>
    </Card>
  );
}
