import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvedTargetName } from "./canary.js";
import type { Config } from "./config.js";
import { classifyFailure, type Diagnostic, redact } from "./diagnostics.js";
import type { RunResult } from "./schema.js";

export async function writeJson(path: string, data: unknown) {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(temp, path);
}
function escapeHtml(input: unknown) {
  return String(input ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char
  );
}
export function reportMarkdown(result: RunResult, reportUrl?: string): string {
  const clean = (value: string) =>
    value.replace(/[\r\n|<>]/g, " ").replace(/`/g, "'");
  // Un nom accessible visé par le repli typographique n'est pas celui que le plan
  // a écrit : la substitution est publiée avec l'étape qui l'a jouée, plutôt que
  // de rester invisible hors de `result.json`.
  const substitutions = result.scenarios.flatMap((item) =>
    item.steps.flatMap((step) => {
      const name = resolvedTargetName(step.observation);
      return name
        ? [
            `- ${clean(item.scenario.title)}: step \`${clean(step.stepId ?? String(step.index))}\` targeted the accessible name \`${clean(name)}\` (typographic fallback)`,
          ]
        : [];
    })
  );
  // Une étape sautée est une information : le rapport publié nomme l'étape qui
  // n'a rien eu à faire, plutôt que de la laisser identique à une étape jouée.
  const skippedSteps = result.scenarios.flatMap((item) =>
    item.steps
      .filter((step) => step.skipped)
      .map(
        (step) =>
          `- ${clean(item.scenario.title)}: step \`${clean(step.stepId ?? String(step.index))}\` skipped — its target was absent, so the state it establishes was already in place`
      )
  );
  // Une assertion dont la valeur satisfaisait déjà l'attendu avant l'étape ne
  // prouve rien sur cette étape : le rapport le dit, sans nommer la cible, et
  // sans changer le verdict.
  const inherited = result.scenarios.flatMap((item) =>
    item.assertions.filter((assertion) => assertion.preMatched)
  );
  const satisfiedBefore =
    inherited.length === 0
      ? []
      : [
          `- ${inherited.length} assertion(s) already satisfied before their step: they prove the state is there, not that the step produced it`,
        ];
  return [
    "<!-- canary-pr-qa -->",
    "## Canary autonomous PR QA",
    `**Result: ${result.outcome.toUpperCase()}** · Commit \`${result.sha ?? "unavailable"}\``,
    `Model: \`${clean(result.model ?? "historical / unavailable")}\``,
    result.preview
      ? `Preview: ${result.preview.url}\nProvenance: ${clean(result.preview.evidence)}`
      : "Preview not verified.",
    result.plan ? clean(result.plan.summary) : "Planning did not complete.",
    "| Scenario | Kind | Result | Assertions |",
    "| --- | --- | --- | --- |",
    ...result.scenarios.map(
      (item) =>
        `| ${clean(item.scenario.title)} | ${item.scenario.kind} | ${item.outcome} | ${item.assertions.filter((a) => a.passed).length}/${item.scenario.assertions.length} |`
    ),
    ...result.scenarios
      .filter((item) => item.error)
      .map(
        (item) =>
          `- ${clean(item.scenario.title)}: ${clean(item.error ?? "")} — class: \`${classifyFailure({ code: item.diagnostic?.code })}\``
      ),
    ...satisfiedBefore,
    ...substitutions,
    ...skippedSteps,
    ...(result.plan?.skipped.map(
      (item) =>
        `- Not browser-tested: \`${clean(item.sourceFile)}\` — ${clean(item.reason)}`
    ) ?? []),
    ...(result.error ? [`Error: ${clean(result.error)}`] : []),
    ...(result.diagnostic
      ? [
          `Diagnostic: \`${clean(result.diagnostic.code)}\` — ${clean(result.diagnostic.hint)}`,
        ]
      : []),
    ...result.scenarios
      .filter((s) => s.diagnostic)
      .map(
        (s) =>
          `- ${clean(s.scenario.title)}: ${clean(s.diagnostic?.hint ?? "")}`
      ),
    reportUrl
      ? `[Report, videos, traces and assertions](${reportUrl})`
      : "Artifacts saved locally. Configure ARTIFACT_BASE_URL to expose links.",
    "Assertions were evaluated by the runner against the original plan. A browser-only pass does not cover explicitly skipped changes.",
  ].join("\n\n");
}
export async function saveReport(
  root: string,
  original: RunResult,
  config?: Config
) {
  const result: RunResult = JSON.parse(
    redact(JSON.stringify(original), config)
  );
  await mkdir(root, { recursive: true });
  await writeJson(join(root, "result.json"), result);
  await writeFile(join(root, "report.md"), reportMarkdown(result));
  const items = result.scenarios
    .map(
      (
        item
      ) => `<section><h2>${escapeHtml(item.scenario.title)} — ${escapeHtml(item.outcome)}</h2><p>${escapeHtml(item.scenario.rationale)}</p><p>${escapeHtml(item.error)}</p>${diagnosticHtml(item.diagnostic)}
${item.artifacts.includes("report.html") ? `<a href="${escapeHtml(item.scenario.id)}/report.html">Canary session report</a>` : ""}
${item.artifacts
  .filter((file) => file.endsWith(".webm"))
  .map(
    (file) =>
      `<video controls preload="metadata" src="${escapeHtml(item.scenario.id)}/${escapeHtml(file)}"></video>`
  )
  .join("")}
<ul>${item.assertions.map((a) => `<li>${escapeHtml(a.id)}: ${a.passed ? "PASS" : "FAIL"}${a.preMatched ? " (already satisfied before the step)" : ""} — actual: ${escapeHtml(JSON.stringify(a.actual))}</li>`).join("")}</ul>
<details><summary>Executed steps</summary><pre>${escapeHtml(JSON.stringify(item.steps, null, 2))}</pre></details></section>`
    )
    .join("");
  await writeFile(
    join(root, "report.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canary PR QA</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;background:#111827;color:#e5e7eb}a{color:#93c5fd}section{border-top:1px solid #475569;padding:24px 0}video{display:block;width:100%;max-height:600px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}p{overflow-wrap:anywhere}</style><h1>Canary PR QA: ${escapeHtml(result.endedAt ? result.outcome : "running")}</h1><p>${escapeHtml(result.prUrl)}</p><p>Commit: ${escapeHtml(result.sha)}</p><p>${escapeHtml(result.preview?.url)}</p><p>${escapeHtml(result.error)}</p>${diagnosticHtml(result.diagnostic)}<p>${escapeHtml(result.plan?.summary)}</p><p><a href="result.json">Machine-readable results</a> · <a href="progress.json">Current progress</a> · <a href="events.jsonl">Action timeline</a></p>${items}<h2>Not browser-tested</h2><ul>${result.plan?.skipped.map((item) => `<li>${escapeHtml(item.sourceFile)}: ${escapeHtml(item.reason)}</li>`).join("") ?? ""}</ul></html>`
  );
}
function diagnosticHtml(diagnostic?: Diagnostic) {
  return diagnostic
    ? `<p><strong>${escapeHtml(diagnostic.code)}</strong>: ${escapeHtml(diagnostic.hint)}</p>`
    : "";
}
