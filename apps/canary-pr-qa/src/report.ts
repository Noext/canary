import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@usecanary/logger";
import { nonRuntimeStatus } from "./approved-skips.js";
import {
  compareWithBaseline,
  comparisonSections,
  comparisonStatusNote,
} from "./baseline-diff.js";
import { resolvedTargetName } from "./canary.js";
import type { Config } from "./config.js";
import {
  classifyFailure,
  type Diagnostic,
  diagnose,
  redact,
} from "./diagnostics.js";
import type { TrustedCatalog } from "./fixtures.js";
import type { PrContext } from "./github.js";
import { effectiveModelConfig, PLANNER_DIR } from "./planner-record.js";
import type { Policy } from "./policy.js";
import type { Plan, RunResult } from "./schema.js";

// biome-ignore lint/performance/noBarrelFile: one re-export; the runner, at its import limit, reaches the documentation-and-tests verdict through the module that reports it.
export { settleNonRuntimeDiff } from "./approved-skips.js";

/**
 * Juge le run contre la préversion de base avant sa publication : régression
 * rouge, preuve non discriminante bloquée, comportements modifiés listés. Le
 * runner est à sa limite d'imports : il l'atteint par le module qui rend déjà
 * cette comparaison dans le rapport, le statut et le commentaire.
 */
export function judgeAgainstBaseline(result: RunResult, config: Config): void {
  compareWithBaseline(result, config);
}

/**
 * La description du statut de commit. La comparaison à la base y figure en tête
 * de ce que GitHub tronque (140 caractères) : un comportement modifié par la PR
 * ne peut pas passer inaperçu sous un statut vert. Un diff de documentation et
 * de tests seuls le dit plutôt qu'un « 0/0 scenarios » muet.
 */
export function statusDescription(result: RunResult): string {
  const nonRuntime = nonRuntimeStatus(result);
  if (nonRuntime) {
    return nonRuntime;
  }
  const passed = result.scenarios.filter((s) => s.outcome === "passed").length;
  const note = comparisonStatusNote(result);
  return `QA ${result.outcome}: ${passed}/${result.scenarios.length} scenarios${note ? ` · ${note}` : ""}`;
}

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
/**
 * Le rapport Markdown. Par défaut c'est le corps PUBLIÉ en commentaire de PR :
 * aucune valeur lue dans la page n'y figure. `withObservedValues` sert au seul
 * `report.md` privé, qui recopie les valeurs de la comparaison à la base.
 */
export function reportMarkdown(
  result: RunResult,
  reportUrl?: string,
  withObservedValues = false
): string {
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
  // prouve rien sur cette étape : le rapport le dit, sans nommer la cible. Une
  // valeur laissée identique par l'étape ne passe plus (`STATE_ALREADY_SATISFIED`) ;
  // celles que l'étape a réellement déplacées restent des preuves d'exécution.
  const inherited = result.scenarios.flatMap((item) =>
    item.assertions.filter((assertion) => assertion.preMatched)
  );
  const satisfiedBefore =
    inherited.length === 0
      ? []
      : [
          `- ${inherited.length} assertion(s) already satisfied before their step: they prove the state is there, not that the step produced it`,
        ];
  // La comparaison à la base vient juste après le verdict : une liste de
  // comportements modifiés en bas d'un rapport vert serait manquée.
  const comparison = comparisonSections(result, withObservedValues).flatMap(
    (section) => [
      `### ${clean(section.title)}`,
      section.items.map((item) => `- ${clean(item)}`).join("\n"),
    ]
  );
  return [
    "<!-- canary-pr-qa -->",
    "## Canary autonomous PR QA",
    `**Result: ${result.outcome.toUpperCase()}** · Commit \`${result.sha ?? "unavailable"}\``,
    ...comparison,
    `Model: \`${clean(result.model ?? "historical / unavailable")}\``,
    result.preview
      ? `Preview: ${result.preview.url}\nProvenance: ${clean(result.preview.evidence)}`
      : "Preview not verified.",
    result.plan ? clean(result.plan.summary) : "Planning did not complete.",
    "| Scenario | Kind | Result | Assertions |",
    "| --- | --- | --- | --- |",
    ...result.scenarios.map(
      (item) =>
        `| ${clean(item.scenario.title)} | ${item.scenario.kind} | ${item.outcome}${item.assertions.some((a) => a.reloadPersistence) ? " — judged on re-entry: reload persistence not claimed" : ""} | ${item.assertions.filter((a) => a.passed).length}/${item.scenario.assertions.length} |`
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
  await writeFile(
    join(root, "report.md"),
    reportMarkdown(result, undefined, true)
  );
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
<ul>${item.assertions.map((a) => `<li>${escapeHtml(a.id)}: ${a.passed ? "PASS" : "FAIL"}${a.preMatched ? " (already satisfied before the step)" : ""}${a.reloadPersistence ? " (judged on re-entry: reload persistence not claimed)" : ""} — actual: ${escapeHtml(JSON.stringify(a.actual))}</li>`).join("")}</ul>
<details><summary>Executed steps</summary><pre>${escapeHtml(JSON.stringify(item.steps, null, 2))}</pre></details></section>`
    )
    .join("");
  await writeFile(
    join(root, "report.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canary PR QA</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;background:#111827;color:#e5e7eb}a{color:#93c5fd}section{border-top:1px solid #475569;padding:24px 0}video{display:block;width:100%;max-height:600px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}p{overflow-wrap:anywhere}</style><h1>Canary PR QA: ${escapeHtml(result.endedAt ? result.outcome : "running")}</h1><p>${escapeHtml(result.prUrl)}</p><p>Commit: ${escapeHtml(result.sha)}</p><p>${escapeHtml(result.preview?.url)}</p><p>${escapeHtml(result.error)}</p>${diagnosticHtml(result.diagnostic)}${comparisonSections(
      result,
      true
    )
      .map(
        (section) =>
          `<h2>${escapeHtml(section.title)}</h2><ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      )
      .join(
        ""
      )}<p>${escapeHtml(result.plan?.summary)}</p><p><a href="result.json">Machine-readable results</a> · <a href="progress.json">Current progress</a> · <a href="events.jsonl">Action timeline</a></p>${items}<h2>Not browser-tested</h2><ul>${result.plan?.skipped.map((item) => `<li>${escapeHtml(item.sourceFile)}: ${escapeHtml(item.reason)}</li>`).join("") ?? ""}</ul></html>`
  );
}
function diagnosticHtml(diagnostic?: Diagnostic) {
  return diagnostic
    ? `<p><strong>${escapeHtml(diagnostic.code)}</strong>: ${escapeHtml(diagnostic.hint)}</p>`
    : "";
}

interface SaveReplayBundleInput {
  catalog: TrustedCatalog;
  config: Config;
  context: PrContext;
  evidence: { aria: string; url: string };
  generatedPlan: Plan;
  payload: unknown;
  plan: Plan;
  policy: Policy;
  root: string;
}

/** La PR et les deux commits épinglés d'un run. */
function runSource(context: PrContext) {
  return {
    prUrl: context.ref.url,
    repo: context.ref.repo,
    number: context.ref.number,
    headSha: context.sha,
    baseSha: context.baseSha,
  };
}

/** Les réglages que les portes du plan lisent, rejoués tels quels hors ligne. */
function validationConfig(config: Config) {
  return {
    QA_MAX_SCENARIOS: config.QA_MAX_SCENARIOS,
    QA_MAX_STEPS: config.QA_MAX_STEPS,
    QA_PER_SCENARIO_COVERAGE: config.QA_PER_SCENARIO_COVERAGE,
  };
}

const logger = createLogger({ name: "pr-qa-report" });

/**
 * Écrit les entrées du planificateur AVANT le premier appel payé, sous
 * `_planner/inputs.json` : le contexte, la politique, le catalogue, le message
 * envoyé, l'instantané de découverte et la configuration modèle effective sans
 * secret — ce que les portes lisent pour juger un plan, et ce que
 * `canary-pr-qa rejudge` relit hors ligne. Contrairement au bundle de rejeu,
 * il ne dépend ni d'un plan accepté ni de `QA_REPLAY_BUNDLE` : une réponse
 * refusée doit rester rejugeable. Fichier privé (0600, dossier 0700), passé par
 * `redact`, jamais servi par la route des artefacts ; un échec d'écriture est
 * journalisé et n'échoue pas le run.
 */
export async function savePlannerInputs(
  input: Omit<SaveReplayBundleInput, "generatedPlan" | "plan">
): Promise<void> {
  const { config, context } = input;
  const inputs = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: runSource(context),
    model: effectiveModelConfig(config),
    validationConfig: validationConfig(config),
    context,
    policy: input.policy,
    catalog: input.catalog,
    payload: input.payload,
    evidence: input.evidence,
  };
  try {
    const dir = join(input.root, PLANNER_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir, "inputs.json"),
      `${redact(JSON.stringify(inputs, null, 2), config)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (error) {
    logger.warn(
      { message: diagnose(error, config).message },
      "Planner inputs not persisted"
    );
  }
}

/**
 * Stores the inputs needed to replay the plan locally. This is deliberately
 * opt-in at the caller: source and page text can contain sensitive information.
 */
export async function saveReplayBundle(
  input: SaveReplayBundleInput
): Promise<void> {
  const {
    catalog,
    config,
    context,
    evidence,
    generatedPlan,
    payload,
    plan,
    policy,
    root,
  } = input;
  const bundle = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: { ...runSource(context), model: config.OPENAI_MODEL },
    validationConfig: validationConfig(config),
    context,
    policy,
    catalog,
    payload,
    generatedPlan,
    plan,
    evidence,
  };
  await writeFile(
    join(root, "replay-bundle.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    }
  );
}

/**
 * Adds the original browser outcomes after the run, without exposing them publicly.
 */
export async function attachReplayRuntimeResults(
  root: string,
  result: RunResult
): Promise<void> {
  const bundlePath = join(root, "replay-bundle.json");
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as Record<
    string,
    unknown
  >;
  const updated = {
    ...bundle,
    runtime: {
      outcome: result.outcome,
      finalPlan: result.plan,
      scenarios: result.scenarios.map((item) => ({
        scenarioId: item.scenario.id,
        outcome: item.outcome,
        error: item.error,
        diagnostic: item.diagnostic,
        assertions: item.assertions,
      })),
    },
  };
  await writeFile(bundlePath, `${JSON.stringify(updated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
