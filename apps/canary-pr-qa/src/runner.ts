import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createLogger } from "@usecanary/logger";
import { Canary, compileAction, type Observation } from "./canary.js";
import type { Config } from "./config.js";
import { executeScenario } from "./executor.js";
import { GitHub, type PrContext } from "./github.js";
import { Model, PLANNER_PROMPT } from "./model.js";
import { resolvePreview } from "./preview.js";
import { reportMarkdown, saveReport } from "./report.js";
import {
  type Outcome,
  type Plan,
  PlanSchema,
  type Preview,
  type RunResult,
  type ScenarioResult,
} from "./schema.js";

const logger = createLogger({ name: "canary-pr-qa" });
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
export interface RunOptions {
  id?: string;
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
  model: Model
) {
  const initialPage = await discover(context, preview, root, canary);
  const payload = {
    pr: context,
    preview,
    initialPage,
    maxScenarios: config.QA_MAX_SCENARIOS,
  };
  if (JSON.stringify(payload).length > config.QA_CONTEXT_CHARS + 30_000) {
    throw new Error(
      "PR context exceeds model budget; refusing partial diff analysis"
    );
  }
  result.plan = await model.json(PLANNER_PROMPT, payload, PlanSchema);
  validatePlan(result.plan, context, config);
  await saveReport(root, result);
  for (const scenario of result.plan.scenarios) {
    logger.info(
      { runId: result.id, scenario: scenario.id },
      "Executing scenario"
    );
    result.scenarios.push(
      await executeScenario(scenario, preview.url, root, config, canary, model)
    );
    await saveReport(root, result);
  }
  result.outcome = aggregate(result.scenarios);
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
  reportUrl?: string
) {
  try {
    const commentUrl = await github.comment(
      context,
      reportMarkdown(result, reportUrl)
    );
    result.publication = { commentUrl, status: "pending" };
    const status = statusFor(result.outcome);
    await github.status(
      context,
      status,
      `QA ${result.outcome}: ${result.scenarios.filter((s) => s.outcome === "passed").length}/${result.scenarios.length} scenarios`,
      reportUrl
    );
    result.publication.status = status;
  } catch (error) {
    result.error =
      `${result.error ?? ""} GitHub publication failed: ${message(error)}`.trim();
    await github
      .status(
        context,
        "error",
        "QA completed but publication failed",
        reportUrl
      )
      .catch(() => undefined);
  }
}
export async function runQa(
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
    startedAt: new Date().toISOString(),
    outcome: "blocked",
    scenarios: [],
  };
  const github = new GitHub(config);
  const canary = new Canary(config);
  const model = new Model(config);
  let context: PrContext | undefined;
  const reportUrl = config.ARTIFACT_BASE_URL
    ? `${config.ARTIFACT_BASE_URL.replace(/\/$/, "")}/artifacts/${id}/report.html`
    : undefined;
  try {
    if (options.publish !== false && !config.GITHUB_TOKEN) {
      throw new Error(
        "GITHUB_TOKEN is required to publish. Use --no-publish for local verification."
      );
    }
    context = await github.context(options.prUrl);
    result.sha = context.sha;
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
      model
    );
    await recheck(result, context, result.preview, options, github, config);
  } catch (error) {
    result.error = message(error);
    result.outcome = "blocked";
    logger.warn({ runId: id, error: result.error }, "QA blocked");
  }
  result.endedAt = new Date().toISOString();
  await saveReport(root, result);
  if (context && options.publish !== false) {
    await publish(result, context, github, reportUrl);
    await saveReport(root, result);
  }
  return result;
}
