import type { ScenarioSummary } from "@/api/contracts";
import { Pill } from "@/components/ui/feedback";
import { runs as copy, resultSummaries } from "@/i18n";
import { outcomeLabel, safeArtifactPath, toneFor } from "@/lib/format";

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

/**
 * Un scénario et ses preuves : la carte, ses assertions et ses vidéos. Le
 * détail du run ne garde que l'orchestration de l'écran.
 */
export function ScenarioCard({
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
      {/* The Canary session report holds the steps, commands, console and
          network of this one scenario; the aggregate report links it too. A
          scenario stopped before its session started (a planning refusal, a
          failed preparation, a lost evidence finalization) exported no report:
          linking it would open a missing artifact. */}
      {item.artifacts.includes("report.html") ? (
        <a
          className="mt-3 inline-block text-sm underline-offset-4 hover:underline"
          href={`/artifacts/${runId}/${encodeURIComponent(item.scenario.id)}/report.html`}
          rel="noopener"
          target="_blank"
        >
          {copy.sessionReport}
        </a>
      ) : null}
    </article>
  );
}
