import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import type { TrustedCatalog } from "./fixtures.js";
import type { PrContext } from "./github.js";
import { Model, PLANNER_PROMPT } from "./model.js";
import { runModelConfig } from "./model-catalog.js";
import { PolicySchema, type Policy, sourceLineMaterial } from "./policy.js";
import {
  replayPlanValidation,
  replayPlannerCorrection,
} from "./replay-validation.js";
import { PlanSchema, type Plan, plannerPlanSchema } from "./schema.js";

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
  context: z.array(
    z.object({
      path: z.string(),
      ref: z.string(),
      content: z.string(),
    })
  ),
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

const ReplayBundleSchema = z
  .object({
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
    runtime: z.unknown().optional(),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    if (bundle.source.headSha !== bundle.context.sha) {
      ctx.addIssue({
        code: "custom",
        path: ["source", "headSha"],
        message: "Bundle source head SHA must match the captured PR context.",
      });
    }
    if (bundle.source.baseSha !== bundle.context.baseSha) {
      ctx.addIssue({
        code: "custom",
        path: ["source", "baseSha"],
        message: "Bundle source base SHA must match the captured PR context.",
      });
    }
    if (bundle.source.prUrl !== bundle.context.ref.url) {
      ctx.addIssue({
        code: "custom",
        path: ["source", "prUrl"],
        message: "Bundle PR URL must match the captured PR context.",
      });
    }
  });

type ReplayBundle = z.infer<typeof ReplayBundleSchema>;

function parseReplayBundle(raw: string): ReplayBundle {
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
  const generatedPlan = PlanSchema.parse(bundle.generatedPlan);
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
        return replayPlannerCorrection({
          catalog,
          config: replayConfig,
          context,
          evidence: bundle.evidence,
          plan: candidate,
          policy,
        });
      }
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
    generatedPlan,
    runtime: bundle.runtime,
  };
}
