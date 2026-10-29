import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import type { TrustedCatalog } from "./fixtures.js";
import type { PrContext } from "./github.js";
import { Model, PLANNER_PROMPT } from "./model.js";
import { runModelConfig } from "./model-catalog.js";
import { PolicySchema, sourceLineMaterial, type Policy } from "./policy.js";
import { replayPlanValidation } from "./runner.js";
import { PlanSchema, plannerPlanSchema, type Plan } from "./schema.js";

const fileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  changes: z.number().int().optional(),
  patch: z.string().optional(),
  previous_filename: z.string().optional(),
});
const contextSchema = z.object({
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  body: z.string(),
  context: z.array(z.object({
    path: z.string(),
    ref: z.string(),
    content: z.string(),
  })),
  contextWarnings: z.array(z.string()),
  files: z.array(fileSchema),
  headRepo: z.string(),
  ref: z.object({
    repo: z.string(),
    number: z.number().int().positive(),
    url: z.string().url(),
  }),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  title: z.string(),
});

export const ReplayBundleSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime(),
  source: z.object({
    prUrl: z.string().url(),
    repo: z.string(),
    number: z.number().int().positive(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    model: z.string(),
  }),
  validationConfig: z.object({
    QA_MAX_SCENARIOS: z.number().int().positive(),
    QA_MAX_STEPS: z.number().int().positive(),
    QA_PER_SCENARIO_COVERAGE: z.boolean(),
  }),
  context: contextSchema,
  policy: z.unknown(),
  catalog: z.object({
    fixtures: z.record(z.string(), z.string()),
    roles: z.array(z.string()),
    visuals: z.array(z.string()),
  }),
  payload: z.unknown(),
  generatedPlan: z.unknown(),
  plan: z.unknown(),
  evidence: z.object({
    url: z.string().url(),
    aria: z.string(),
  }),
}).strict();

export type ReplayBundle = z.infer<typeof ReplayBundleSchema>;

export function parseReplayBundle(raw: string): ReplayBundle {
  return ReplayBundleSchema.parse(JSON.parse(raw));
}

/**
 * Replays the stored complete plan against the current production gates.
 * Gate mode is strictly offline: it reads only the bundle and never constructs
 * a model client, browser session, preview URL, or GitHub client.
 */
export async function runReplay(
  filePath: string,
  mode: "gate" | "plan",
  config: Config
) {
  const bundle = parseReplayBundle(await readFile(resolve(filePath), "utf8"));
  const context = bundle.context as PrContext;
  const policy: Policy = PolicySchema.parse(bundle.policy);
  const catalog = bundle.catalog as TrustedCatalog;
  const replayConfig: Config = {
    ...config,
    ...bundle.validationConfig,
  };

  let plan: Plan;
  if (mode === "gate") {
    plan = PlanSchema.parse(bundle.plan);
  } else {
    // Planner replay uses the exact stored payload and current prompt/schema,
    // without rediscovering or opening the target application.
    const model = new Model(runModelConfig(config, bundle.source.model));
    plan = await model.json(
      PLANNER_PROMPT,
      bundle.payload,
      plannerPlanSchema(sourceLineMaterial(context)),
      config.QA_PLAN_MAX_TOKENS,
      (candidate) => {
        const result = replayPlanValidation({
          catalog,
          config: replayConfig,
          context,
          evidence: bundle.evidence,
          plan: candidate,
          policy,
        });
        return result.refusals.length === 0
          ? undefined
          : `Plan rejected: ${result.refusals.join(" ")} Return the complete corrected plan.`;
      },
    );
  }

  const validation = replayPlanValidation({
    catalog,
    config: replayConfig,
    context,
    evidence: bundle.evidence,
    plan,
    policy,
  });
  return {
    mode,
    source: bundle.source,
    refusals: validation.refusals,
    inconclusive: validation.inconclusive,
    plan,
    generatedPlan: PlanSchema.parse(bundle.generatedPlan),
  };
}
