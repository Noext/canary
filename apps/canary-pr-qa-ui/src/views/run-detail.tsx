import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { api, errorText, post } from "@/api/client";
import type { RunResult, ScenarioSummary } from "@/api/contracts";
import { cancelSchema, runJobSchema, runResultSchema } from "@/api/schemas";
import { useError } from "@/app/errors";
import { Button } from "@/components/ui/button";
import { Notice, Pill } from "@/components/ui/feedback";
import { Card, CardHeader } from "@/components/ui/form";
import { runs as copy, phaseSteps, resultSummaries } from "@/i18n";
import {
  githubCommentUrl,
  isTerminal,
  outcomeLabel,
  phaseIndex,
  phaseLabel,
  safeArtifactPath,
  shortSha,
  stateLabel,
  toneFor,
  usageText,
} from "@/lib/format";

type LiveRun = z.infer<typeof runJobSchema>;

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

function phaseClass(
  index: number,
  phase: number,
  name: string | null | undefined,
  outcome: string | null | undefined
): string {
  if (name === "done") {
    return outcome === "passed" ? "done" : "";
  }
  if (index === phase) {
    return "active";
  }
  return index < phase ? "done" : "";
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
  const [job, setJob] = useState<LiveRun>();
  const [result, setResult] = useState<RunResult>();
  const [resultFailure, setResultFailure] = useState<string>();
  const [live, setLive] = useState<string>(copy.liveConnecting);
  const [message, setMessage] = useState<string>(copy.eventsLoading);
  const [cancelling, setCancelling] = useState(false);
  const update = useRef(onUpdate);

  useEffect(() => {
    update.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    if (!runId) {
      return;
    }
    let active = true;
    let source: EventSource | undefined;
    // A finished run publishes its result next to its other artifacts.
    const loadResult = async () => {
      try {
        const payload = await api<RunResult>(
          `/artifacts/${runId}/result.json`,
          { schema: runResultSchema }
        );
        if (active) {
          setResult(payload);
        }
      } catch (failure) {
        if (active) {
          setResultFailure(copy.missingResult + errorText(failure));
        }
      }
    };
    const watch = () => {
      source = new EventSource(`/runs/${runId}/events`);
      source.onopen = () => {
        if (active) {
          setLive(copy.liveConnected);
        }
      };
      source.onerror = () => {
        // A closed source is finished, not reconnecting.
        if (active && source?.readyState !== EventSource.CLOSED) {
          setLive(copy.liveReconnecting);
        }
      };
      source.onmessage = (event: MessageEvent<string>) => {
        if (!active) {
          return;
        }
        const frame = parseFrame(event.data);
        if (!frame) {
          source?.close();
          setLive(copy.liveInvalid);
          report(new Error(copy.invalidFrame));
          return;
        }
        setJob(frame);
        setMessage(messageFor(frame));
        if (isTerminal(frame.status)) {
          source?.close();
          setLive(copy.liveDone);
          void loadResult();
        }
        update.current?.();
      };
    };
    // Validate the run first: the stream is opened for a run this account may
    // read, otherwise an unknown or forbidden id would leave EventSource
    // reconnecting forever while the interface pretends to follow it.
    void api<LiveRun>(`/runs/${runId}`, { schema: runJobSchema })
      .then((initial) => {
        if (!active) {
          return;
        }
        setJob(initial);
        setMessage(messageFor(initial));
        if (isTerminal(initial.status)) {
          // No stream will fire: the history has to be refreshed from here, or a
          // run that finished before this request would stay "en cours" in the
          // table next to a finished detail.
          setLive(copy.liveDone);
          void loadResult();
          update.current?.();
          return;
        }
        watch();
      })
      .catch((failure) => {
        if (active) {
          report(failure);
        }
      });
    return () => {
      active = false;
      source?.close();
    };
  }, [report, runId]);

  const cancel = useCallback(async () => {
    if (!runId) {
      return;
    }
    setCancelling(true);
    try {
      await api(`/runs/${runId}/cancel`, { ...post({}), schema: cancelSchema });
      setMessage(copy.cancelRequested);
    } catch (failure) {
      report(failure);
    } finally {
      setCancelling(false);
    }
  }, [report, runId]);

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
          onClick={() => void cancel()}
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
            className={phaseClass(index, phase, progress?.phase, job?.outcome)}
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
        {usageText(result?.usage)}
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
