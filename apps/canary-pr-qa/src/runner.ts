import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createLogger } from "@usecanary/logger";
import {
  Canary,
  compileAction,
  type Observation,
  PLAN_EVIDENCE_SNAPSHOT_CHARS,
} from "./canary.js";
import { type Config, validateConfiguration } from "./config.js";
import { type Diagnostic, diagnose, QaError } from "./diagnostics.js";
import { executeScenario } from "./executor.js";
import { fixtureCatalog } from "./fixtures.js";
import { GitHub, type PrContext } from "./github.js";
import { Model, PLANNER_PROMPT } from "./model.js";
import { runModelConfig } from "./model-catalog.js";
import {
  type PlanEvidenceRefusal,
  type PlanEvidenceReport,
  planEvidenceDiagnostic,
  unstableSelectorRefusals,
  validatePlanEvidence,
} from "./plan-evidence.js";
import {
  type Policy,
  repairRequirementAttribution,
  trustedPolicy,
  ungroundedPlanRefusals,
  validateCoverage,
  validateProvider,
  writeEvidenceRefusals,
} from "./policy.js";
import { resolvePreview, verifyPreviewUrl } from "./preview.js";
import { Progress } from "./progress.js";
import { reportMarkdown, saveReport } from "./report.js";
import { checkBudget, type RunScope, runScope } from "./run-scope.js";
import {
  type Outcome,
  type Plan,
  PlanSchema,
  type Preview,
  type RunResult,
  type Scenario,
  type ScenarioResult,
} from "./schema.js";
import { traced } from "./telemetry.js";

const logger = createLogger({ name: "canary-pr-qa" });
export interface RunOptions {
  expectedSha?: string;
  id?: string;
  model?: string;
  previewUrl?: string;
  prUrl: string;
  publish?: boolean;
}

async function discover(
  context: PrContext,
  preview: Preview,
  root: string,
  canary: Canary
): Promise<{ evidence: string; initialPage: Observation }> {
  const sessionId = await canary.start(`PR ${context.ref.number} discovery`);
  let observation: Observation;
  try {
    observation = await canary.act(
      sessionId,
      "discover-preview",
      // L'évidence de validation du plan est relevée en même temps que
      // l'instantané du modèle, sans second relevé navigateur.
      compileAction(
        { type: "goto", path: preview.url },
        preview.url,
        undefined,
        {
          evidenceSnapshotChars: PLAN_EVIDENCE_SNAPSHOT_CHARS,
        }
      )
    );
  } catch (error) {
    await canary.abort(sessionId);
    throw error;
  }
  try {
    await canary.end(sessionId, join(root, "_discovery"));
  } catch (error) {
    await canary.abort(sessionId);
    throw error;
  }
  const { evidence, ...initialPage } = observation;
  return { evidence: evidence ?? "", initialPage };
}
function completeSource(context: PrContext, path: string, ref: string) {
  return context.context.some(
    (item) =>
      item.path === path &&
      item.ref === ref &&
      !context.contextWarnings.includes(
        `Truncated context: ${item.path} at ${item.ref}`
      )
  );
}
function validateSourceEvidence(
  context: PrContext,
  scenarioId: string,
  path: string
) {
  const file = context.files.find((item) => item.filename === path);
  if (file?.patch) {
    return;
  }
  const headAvailable =
    file?.status === "removed" || completeSource(context, path, context.sha);
  const baseAvailable =
    file?.status === "added" ||
    completeSource(context, file?.previous_filename ?? path, context.baseSha);
  if (!(headAvailable && baseAvailable)) {
    throw new QaError(
      "CONTEXT_INCOMPLETE",
      `Scenario ${scenarioId} cites ${path} without a textual diff or complete head/base source`,
      "Check GitHub Contents permissions and context budget. Unsupported/binary changes must be explicitly skipped; never infer a tested change from the page alone."
    );
  }
}
function validatePlan(plan: Plan, context: PrContext, config: Config) {
  if (plan.scenarios.length > config.QA_MAX_SCENARIOS) {
    throw new Error("AI plan exceeds QA_MAX_SCENARIOS");
  }
  const changed = new Set(context.files.map((file) => file.filename));
  for (const scenario of plan.scenarios) {
    if (scenario.id === "_discovery") {
      throw new Error("Reserved scenario id");
    }
    if (scenario.sourceFiles.some((file) => !changed.has(file))) {
      throw new Error("AI plan cites a file outside the PR diff");
    }
    for (const path of scenario.sourceFiles) {
      validateSourceEvidence(context, scenario.id, path);
    }
  }
  if (plan.skipped.some((item) => !changed.has(item.sourceFile))) {
    throw new Error("AI plan skips a file outside the PR diff");
  }
  for (const file of changed) {
    if (
      !(
        plan.scenarios.some((s) => s.sourceFiles.includes(file)) ||
        plan.skipped.some((s) => s.sourceFile === file)
      )
    ) {
      throw new Error(`AI plan omitted changed file: ${file}`);
    }
  }
}
function aggregate(scenarios: ScenarioResult[]): Outcome {
  if (scenarios.length === 0) {
    return "skipped";
  }
  if (scenarios.some((s) => s.outcome === "failed")) {
    return "failed";
  }
  if (scenarios.some((s) => s.outcome !== "passed")) {
    return "blocked";
  }
  return "passed";
}
/**
 * A scenario refused before execution is reported blocked and skipped, with the
 * existing diagnostic; the remaining scenarios still run.
 */
async function refuseScenario(
  result: RunResult,
  scenario: Scenario,
  diagnostic: Diagnostic,
  progress: Progress,
  root: string,
  config: Config
) {
  result.scenarios.push({
    scenario,
    outcome: "blocked",
    steps: [],
    assertions: [],
    artifacts: [],
    diagnostic,
    error: diagnostic.message,
  });
  await progress.record({
    phase: "planning",
    scenarioId: scenario.id,
    outcome: "blocked",
    diagnostic,
  });
  await saveReport(root, result, config);
}
/**
 * Diagnostic d'un refus prononcé avant toute exécution : cible absente de la page
 * de découverte, sélecteur construit sur une classe ou une couleur, ou
 * interaction sans preuve du changement. `undefined` quand le scénario peut
 * s'exécuter. Un scénario refusé n'est jamais exécuté — aperçu de tête comme
 * préversion de base — et son refus est journalisé une seule fois, ici.
 */
function refusalDiagnostic(
  result: RunResult,
  scenario: Scenario,
  refusals: Map<string, PlanEvidenceRefusal[]>,
  inconclusive: PlanEvidenceReport["inconclusive"],
  preExecutionRefusals: Map<string, QaError>,
  config: Config
): Diagnostic | undefined {
  const scenarioRefusals = refusals.get(scenario.id);
  if (scenarioRefusals) {
    const { message, hint } = planEvidenceDiagnostic(
      scenario,
      scenarioRefusals,
      inconclusive.filter((item) => item.scenarioId === scenario.id).length
    );
    logger.warn(
      {
        runId: result.id,
        scenario: scenario.id,
        targets: scenarioRefusals.map((item) => item.target),
      },
      "Scénario refusé avant exécution : cible absente de la page de découverte"
    );
    return diagnose(new QaError("PLAN_TARGET_MISSING", message, hint), config);
  }
  const refusal = preExecutionRefusals.get(scenario.id);
  if (!refusal) {
    return;
  }
  const diagnostic = diagnose(refusal, config);
  logger.warn(
    { runId: result.id, scenario: scenario.id, diagnostic },
    "Scénario refusé avant exécution"
  );
  return diagnostic;
}
/**
 * Une assertion d'absence ne lit pas un élément : elle en constate l'absence,
 * donc une cible qui ne résout rien y est normale. Les autres sont comptées sur
 * la page de découverte avant toute exécution.
 */
/**
 * Les refus rendus au planificateur pour un plan candidat : preuve d'écriture,
 * sélecteur construit sur une classe ou une couleur, exigence sans témoin
 * textuel, cible absente de la page de découverte.
 */
function planRefusals(
  candidate: Plan,
  policy: Policy,
  context: PrContext
): string[] {
  return [
    ...writeEvidenceRefusals(candidate, policy).map(
      (item) => `${item.error.message}. ${item.error.hint}`
    ),
    ...unstableSelectorRefusals(candidate).map(
      (item) => `${item.error.message}. ${item.error.hint}`
    ),
    ...ungroundedPlanRefusals(candidate, context),
  ];
}
/**
 * Après la planification : une citation réelle attribuée au mauvais fichier est
 * réparée — la preuve ne change pas, seule la mention du fichier était fausse —
 * le contrat est validé, et un plan qui lit une cible absente de la page de
 * découverte est refusé avant d'exécuter quoi que ce soit.
 */
function settlePlan(
  plan: Plan,
  context: PrContext,
  config: Config,
  runId: string
) {
  for (const repair of repairRequirementAttribution(plan, context)) {
    logger.info(
      {
        from: repair.from,
        runId,
        scenario: repair.scenarioId,
        to: repair.to,
      },
      "Requirement attribution repaired"
    );
  }
  validatePlan(plan, context, config);
}
async function executePlan(
  result: RunResult,
  context: PrContext,
  preview: Preview,
  root: string,
  config: Config,
  canary: Canary,
  model: Model,
  progress: Progress,
  github: GitHub
) {
  await progress.record({ phase: "discovery" });
  const { evidence, initialPage } = await discover(
    context,
    preview,
    root,
    canary
  );
  const payload = {
    pr: context,
    changedFiles: context.files.map((file) => file.filename),
    preview,
    initialPage,
    maxScenarios: config.QA_MAX_SCENARIOS,
    fixtures: await fixtureCatalog(config, context.ref.repo).then((c) => ({
      roles: Object.keys(c.roles),
      visuals: Object.keys(c.visuals),
      fixtures: Object.fromEntries(
        Object.entries(c.fixtures).map(([name, f]) => [name, f.description])
      ),
    })),
  };
  if (JSON.stringify(payload).length > config.QA_CONTEXT_CHARS + 30_000) {
    throw new Error(
      "PR context exceeds model budget; refusing partial diff analysis"
    );
  }
  const policy = await trustedPolicy(github, context);
  validateProvider(policy, config);
  await progress.record({ phase: "planning" });
  result.plan = await model.json(
    PLANNER_PROMPT,
    payload,
    PlanSchema,
    config.QA_PLAN_MAX_TOKENS,
    (candidate) => {
      // Le planificateur reçoit les refus et dispose d'une tentative de
      // correction, au lieu de faire échouer le run sur une citation recopiée
      // de mémoire ou attribuée au mauvais fichier.
      const messages = planRefusals(candidate, policy, context);
      return messages.length
        ? `Plan rejected: ${messages.join(" ")} Return the complete corrected plan.`
        : undefined;
    }
  );
  // Une citation réelle attribuée au mauvais fichier se répare : la preuve ne
  // change pas, seule la mention du fichier était fausse.
  settlePlan(result.plan, context, config, result.id);
  const planEvidence = validatePlanEvidence(result.plan, {
    url: initialPage.url,
    aria: evidence,
  });
  const refusals = new Map<string, PlanEvidenceRefusal[]>();
  for (const refusal of planEvidence.refusals) {
    const list = refusals.get(refusal.scenarioId) ?? [];
    list.push(refusal);
    refusals.set(refusal.scenarioId, list);
  }
  // Les cibles non tranchées restent visibles : le contrôle ne prétend jamais
  // avoir vérifié ce que l'instantané de découverte ne couvre pas.
  const gaps = planEvidence.incomplete
    ? [planEvidence.incomplete]
    : [...new Set(planEvidence.inconclusive.map((item) => item.reason))];
  if (gaps.length > 0) {
    const diagnostic = {
      code: "PLAN_EVIDENCE_INCOMPLETE",
      message: "Contrôle d'évidence du plan non concluant",
      hint: `${gaps.join(" ; ")}. Vérifié : cibles role+nom nécessaires sur la page de découverte ; non couverts : types css/text/label/placeholder/testId et nœuds au-delà de 12 niveaux.`,
    };
    logger.warn(
      { runId: result.id, gaps, targets: planEvidence.inconclusive.length },
      "Contrôle d'évidence du plan non concluant"
    );
    await progress.record({ phase: "planning", diagnostic });
  }
  result.coverage = validateCoverage(result.plan, context, policy, config);
  // Refus rendus au planificateur pendant la planification, rejoués ici : un
  // plan que le modèle n'a pas corrigé est bloqué, jamais exécuté.
  const preExecutionRefusals = new Map(
    [
      ...writeEvidenceRefusals(result.plan, policy),
      ...unstableSelectorRefusals(result.plan),
    ].map((item) => [item.scenario.id, item.error])
  );
  await saveReport(root, result, config);
  for (const scenario of result.plan.scenarios) {
    const refusal = refusalDiagnostic(
      result,
      scenario,
      refusals,
      planEvidence.inconclusive,
      preExecutionRefusals,
      config
    );
    if (refusal) {
      await refuseScenario(result, scenario, refusal, progress, root, config);
      continue;
    }
    logger.info(
      { runId: result.id, scenario: scenario.id },
      "Executing scenario"
    );
    checkBudget();
    result.scenarios.push(
      await executeScenario(
        scenario,
        preview.url,
        root,
        config,
        canary,
        (event) => progress.record(event),
        context.ref.repo
      )
    );
    await saveReport(root, result, config);
  }
  result.outcome = aggregate(result.scenarios);
  if (config.QA_BASELINE_URL_TEMPLATE) {
    const url = config.QA_BASELINE_URL_TEMPLATE.replaceAll(
      "{sha}",
      context.baseSha
    ).replaceAll("{pr}", String(context.ref.number));
    const basePreview = await verifyPreviewUrl(url, context.baseSha, config);
    const scope = runScope.getStore();
    if (scope) {
      scope.previewSha = context.baseSha;
    }
    result.baseline = {
      sha: context.baseSha,
      url: basePreview.url,
      scenarios: [],
    };
    for (const scenario of result.plan.scenarios) {
      if (refusals.has(scenario.id) || preExecutionRefusals.has(scenario.id)) {
        // Un scénario refusé ne dépense aucune étape navigateur, base comprise.
        continue;
      }
      result.baseline.scenarios.push(
        await executeScenario(
          scenario,
          basePreview.url,
          join(root, "_baseline"),
          config,
          canary,
          (event) => progress.record(event),
          context.ref.repo
        )
      );
    }
    const activeScope = runScope.getStore();
    if (activeScope) {
      activeScope.previewSha = context.sha;
    }
  }
}
async function recheck(
  result: RunResult,
  context: PrContext,
  preview: Preview,
  options: RunOptions,
  github: GitHub,
  config: Config
) {
  const latest = await github.pr(options.prUrl);
  if (
    latest.data.head.sha !== context.sha ||
    latest.data.base.sha !== context.baseSha ||
    latest.data.state !== "open"
  ) {
    result.outcome = "stale";
    result.error =
      "PR head/base or state changed during QA. Results apply only to the recorded SHA; run again.";
    return;
  }
  const currentPreview = await resolvePreview(
    context,
    github,
    config,
    options.previewUrl
  );
  if (
    currentPreview.url !== preview.url ||
    currentPreview.sha !== preview.sha
  ) {
    result.outcome = "stale";
    result.error = "Preview deployment changed during QA; run again.";
  }
}
function statusFor(outcome: Outcome): "success" | "failure" | "error" {
  if (outcome === "passed") {
    return "success";
  }
  if (outcome === "failed") {
    return "failure";
  }
  return "error";
}
async function publish(
  result: RunResult,
  context: PrContext,
  github: GitHub,
  config: Config,
  reportUrl?: string
) {
  let commentAttempted = false;
  try {
    await runScope.getStore()?.verifyOwnership?.();
    const status = statusFor(result.outcome);
    await github.status(
      context,
      status,
      `QA ${result.outcome}: ${result.scenarios.filter((s) => s.outcome === "passed").length}/${result.scenarios.length} scenarios`,
      reportUrl
    );
    await runScope.getStore()?.verifyOwnership?.();
    commentAttempted = true;
    const commentUrl = await github.comment(
      context,
      reportMarkdown(result, reportUrl)
    );
    result.publication = { commentUrl, status };
  } catch (error) {
    result.diagnostic = diagnose(error, config);
    result.outcome = "blocked";
    result.error =
      `${result.error ?? ""} GitHub publication failed: ${result.diagnostic.message}`.trim();
    let recoveryStatus = "failed";
    await runScope
      .exit(() =>
        github.status(
          context,
          "error",
          "QA completed but publication failed",
          reportUrl
        )
      )
      .then(() => {
        recoveryStatus = "error";
      })
      .catch(() => undefined);
    // A failed response can follow a successful write: repair the upserted comment too.
    if (commentAttempted) {
      await runScope
        .exit(async () => {
          const commentUrl = await github.comment(
            context,
            reportMarkdown(result, reportUrl)
          );
          result.publication = { commentUrl, status: recoveryStatus };
        })
        .catch((repairError) => {
          result.error += ` Blocked comment update failed: ${diagnose(repairError, config).message}`;
        });
    }
  }
}
/**
 * Le repli de transport publie sa reprise avant chaque attente : le tableau de
 * bord ne doit pas paraître figé pendant le backoff, et l'instabilité de l'amont
 * reste mesurable dans l'historique du run.
 */
export function relayModelRetries(
  scope: RunScope | undefined,
  progress: Progress
) {
  if (scope) {
    scope.onRetry = (retry) => {
      // L'écriture de la progression ne doit jamais faire tomber le worker : un
      // rejet détaché suffirait à terminer le processus et à laisser la ligne
      // SQL courir jusqu'à l'expiration de son lease au lieu de finir bloquée.
      progress.record({ phase: "planning", retry }).catch((error: unknown) => {
        logger.warn({ error, retry }, "Retry progress event not persisted");
      });
    };
  }
}
async function runUnscoped(
  options: RunOptions,
  config: Config
): Promise<RunResult> {
  const id = options.id ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
    throw new Error("Invalid run id");
  }
  const root = join(config.QA_DATA_DIR, id);
  const result: RunResult = {
    id,
    prUrl: options.prUrl,
    model: config.OPENAI_MODEL,
    startedAt: new Date().toISOString(),
    outcome: "blocked",
    scenarios: [],
  };
  const github = new GitHub(config);
  const canary = new Canary(config);
  const model = new Model(config);
  const progress = new Progress(root, id);
  relayModelRetries(runScope.getStore(), progress);
  let context: PrContext | undefined;
  const reportUrl = config.ARTIFACT_BASE_URL
    ? `${config.ARTIFACT_BASE_URL.replace(/\/$/, "")}/artifacts/${id}/report.html`
    : undefined;
  try {
    await progress.record({ phase: "context" });
    validateConfiguration(config);
    if (
      options.publish !== false &&
      !config.GITHUB_TOKEN &&
      !config.GITHUB_APP_ID
    ) {
      throw new Error(
        "GITHUB_TOKEN is required to publish. Use --no-publish for local verification."
      );
    }
    const loaded = await github.context(options.prUrl);
    if (options.expectedSha && loaded.sha !== options.expectedSha) {
      throw new QaError(
        "STALE_HEAD",
        "Queued commit is no longer the PR head",
        "Submit a new run for the current commit."
      );
    }
    context = loaded;
    result.sha = context.sha;
    const scope = runScope.getStore();
    if (scope) {
      scope.previewSha = context.sha;
    }
    logger.info(
      { runId: id, sha: context.sha, pr: context.ref.url },
      "PR context pinned"
    );
    if (options.publish !== false) {
      await github.status(
        context,
        "pending",
        "Planning and executing browser scenarios",
        reportUrl
      );
    }
    await progress.record({ phase: "preview" });
    result.preview = await resolvePreview(
      context,
      github,
      config,
      options.previewUrl
    );
    await executePlan(
      result,
      context,
      result.preview,
      root,
      config,
      canary,
      model,
      progress,
      github
    );
    await progress.record({ phase: "verification" });
    await recheck(result, context, result.preview, options, github, config);
  } catch (error) {
    result.diagnostic = diagnose(error, config);
    result.error = result.diagnostic.message;
    result.outcome =
      result.diagnostic.code === "STALE_HEAD" ? "stale" : "blocked";
    logger.warn({ runId: id, error: result.error }, "QA blocked");
  }
  const usage = runScope.getStore();
  if (usage) {
    result.usage = {
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      calls: usage.calls,
      retries: usage.retries ?? 0,
      model: config.OPENAI_MODEL,
      estimated: usage.estimated ?? false,
      pricingConfigured:
        config.QA_INPUT_COST_PER_MILLION > 0 ||
        config.QA_OUTPUT_COST_PER_MILLION > 0,
    };
  }
  result.endedAt = new Date().toISOString();
  await saveReport(root, result, config);
  if (
    context &&
    options.publish !== false &&
    !runScope.getStore()?.signal.aborted
  ) {
    await progress.record({ phase: "publication" });
    await publish(result, context, github, config, reportUrl);
    await saveReport(root, result, config);
  } else if (
    context &&
    options.publish !== false &&
    runScope.getStore()?.signal.aborted
  ) {
    const pinnedContext = context;
    // Only close the check for the pinned historical SHA. Aborted runs can never publish success.
    await runScope
      .exit(() =>
        github.status(
          pinnedContext,
          "error",
          "QA interrupted or cancelled; no successful verdict",
          reportUrl
        )
      )
      .catch((error) => {
        logger.warn(
          { runId: id, diagnostic: diagnose(error, config) },
          "Could not close interrupted GitHub check"
        );
      });
  }
  await progress.record({
    phase: "done",
    outcome: result.outcome,
    diagnostic: result.diagnostic,
  });
  return result;
}

export async function runQa(
  options: RunOptions,
  configured: Config
): Promise<RunResult> {
  const config = runModelConfig(configured, options.model);
  if (runScope.getStore()) {
    return traced(
      "qa.run",
      { runId: options.id ?? "direct", pr: options.prUrl },
      () => runUnscoped(options, config)
    );
  }
  const id = options.id ?? randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new QaError(
          "RUN_DEADLINE",
          "Run deadline exceeded",
          "Inspect the last progress phase before increasing QA_RUN_TIMEOUT_SECONDS."
        )
      ),
    config.QA_RUN_TIMEOUT_SECONDS * 1000
  );
  try {
    return await runScope.run(
      {
        id,
        signal: controller.signal,
        tokens: 0,
        costUsd: 0,
        calls: 0,
        retries: 0,
        maxTokens: config.QA_RUN_MAX_TOKENS,
        maxCostUsd: config.QA_RUN_MAX_COST_USD,
      },
      () =>
        traced("qa.run", { runId: id, pr: options.prUrl }, () =>
          runUnscoped({ ...options, id }, config)
        )
    );
  } finally {
    clearTimeout(timer);
  }
}
