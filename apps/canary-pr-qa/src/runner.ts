import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createLogger } from "@usecanary/logger";
import { Canary, compileAction, type Observation } from "./canary.js";
import { type Config, validateConfiguration } from "./config.js";
import { diagnose, QaError } from "./diagnostics.js";
import { executeScenario } from "./executor.js";
import { fixtureCatalog } from "./fixtures.js";
import { GitHub, type PrContext } from "./github.js";
import { Model, PLANNER_PROMPT } from "./model.js";
import { runModelConfig } from "./model-catalog.js";
import {
  trustedPolicy,
  validateCoverage,
  validateProvider,
  writeEvidenceRefusals,
} from "./policy.js";
import { resolvePreview, verifyPreviewUrl } from "./preview.js";
import { Progress } from "./progress.js";
import { reportMarkdown, saveReport } from "./report.js";
import { checkBudget, runScope } from "./run-scope.js";
import {
  type Outcome,
  type Plan,
  PlanSchema,
  type Preview,
  type RunResult,
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
): Promise<Observation> {
  const sessionId = await canary.start(`PR ${context.ref.number} discovery`);
  let observation: Observation;
  try {
    observation = await canary.act(
      sessionId,
      "discover-preview",
      compileAction({ type: "goto", path: preview.url }, preview.url)
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
  return observation;
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
  const initialPage = await discover(context, preview, root, canary);
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
      const refusals = writeEvidenceRefusals(candidate, policy);
      return refusals.length
        ? `Plan rejected: ${refusals
            .map((item) => `${item.error.message}. ${item.error.hint}`)
            .join(" ")} Return the complete corrected plan.`
        : undefined;
    }
  );
  validatePlan(result.plan, context, config);
  result.coverage = validateCoverage(result.plan, context, policy, config);
  const refusals = new Map(
    writeEvidenceRefusals(result.plan, policy).map((item) => [
      item.scenario.id,
      item.error,
    ])
  );
  await saveReport(root, result, config);
  for (const scenario of result.plan.scenarios) {
    const refusal = refusals.get(scenario.id);
    if (refusal) {
      const diagnostic = diagnose(refusal, config);
      logger.warn(
        { runId: result.id, scenario: scenario.id, diagnostic },
        "Scenario refused without change evidence"
      );
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
        phase: "execution",
        scenarioId: scenario.id,
        outcome: "blocked",
        diagnostic,
      });
      await saveReport(root, result, config);
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
        model,
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
      result.baseline.scenarios.push(
        await executeScenario(
          scenario,
          basePreview.url,
          join(root, "_baseline"),
          config,
          canary,
          model,
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
