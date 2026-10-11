import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  return [
    "<!-- canary-pr-qa -->",
    "## Canary autonomous PR QA",
    `**Result: ${result.outcome.toUpperCase()}** · Commit \`${result.sha ?? "unavailable"}\``,
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
        (item) => `- ${clean(item.scenario.title)}: ${clean(item.error ?? "")}`
      ),
    ...(result.plan?.skipped.map(
      (item) =>
        `- Not browser-tested: \`${clean(item.sourceFile)}\` — ${clean(item.reason)}`
    ) ?? []),
    ...(result.error ? [`Error: ${clean(result.error)}`] : []),
    reportUrl
      ? `[Report, videos, traces and assertions](${reportUrl})`
      : "Artifacts saved locally. Configure ARTIFACT_BASE_URL to expose links.",
    "Assertions were evaluated by the runner against the original plan. A browser-only pass does not cover explicitly skipped changes.",
  ].join("\n\n");
}
export async function saveReport(root: string, result: RunResult) {
  await mkdir(root, { recursive: true });
  await writeJson(join(root, "result.json"), result);
  await writeFile(join(root, "report.md"), reportMarkdown(result));
  const items = result.scenarios
    .map(
      (
        item
      ) => `<section><h2>${escapeHtml(item.scenario.title)} — ${escapeHtml(item.outcome)}</h2><p>${escapeHtml(item.scenario.rationale)}</p><p>${escapeHtml(item.error)}</p>
<a href="${escapeHtml(item.scenario.id)}/report.html">Canary session report</a>
${item.artifacts
  .filter((file) => file.endsWith(".webm"))
  .map(
    (file) =>
      `<video controls preload="metadata" src="${escapeHtml(item.scenario.id)}/${escapeHtml(file)}"></video>`
  )
  .join("")}
<ul>${item.assertions.map((a) => `<li>${escapeHtml(a.id)}: ${a.passed ? "PASS" : "FAIL"} — actual: ${escapeHtml(JSON.stringify(a.actual))}</li>`).join("")}</ul>
<details><summary>Executed steps</summary><pre>${escapeHtml(JSON.stringify(item.steps, null, 2))}</pre></details></section>`
    )
    .join("");
  await writeFile(
    join(root, "report.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canary PR QA</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;background:#111827;color:#e5e7eb}a{color:#93c5fd}section{border-top:1px solid #475569;padding:24px 0}video{display:block;width:100%;max-height:600px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}p{overflow-wrap:anywhere}</style><h1>Canary PR QA: ${escapeHtml(result.outcome)}</h1><p>${escapeHtml(result.prUrl)}</p><p>Commit: ${escapeHtml(result.sha)}</p><p>${escapeHtml(result.preview?.url)}</p><p>${escapeHtml(result.error)}</p><p>${escapeHtml(result.plan?.summary)}</p><a href="result.json">Machine-readable results</a>${items}<h2>Not browser-tested</h2><ul>${result.plan?.skipped.map((item) => `<li>${escapeHtml(item.sourceFile)}: ${escapeHtml(item.reason)}</li>`).join("") ?? ""}</ul></html>`
  );
}
