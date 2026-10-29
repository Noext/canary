import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { TrustedCatalog } from "./fixtures.js";
import type { PrContext } from "./github.js";
import type { Policy } from "./policy.js";
import type { Plan, RunResult } from "./schema.js";

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
    source: {
      prUrl: context.ref.url,
      repo: context.ref.repo,
      number: context.ref.number,
      headSha: context.sha,
      baseSha: context.baseSha,
      model: config.OPENAI_MODEL,
    },
    validationConfig: {
      QA_MAX_SCENARIOS: config.QA_MAX_SCENARIOS,
      QA_MAX_STEPS: config.QA_MAX_STEPS,
      QA_PER_SCENARIO_COVERAGE: config.QA_PER_SCENARIO_COVERAGE,
    },
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

/** Adds the original browser outcomes after the run, without exposing them publicly. */
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
