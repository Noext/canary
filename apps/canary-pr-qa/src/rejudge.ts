import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import type { TrustedCatalog } from "./fixtures.js";
import type { PrContext } from "./github.js";
import { PLANNER_PROMPT } from "./model.js";
import {
  gateVerdict,
  invalidVerdict,
  purposeOf,
  type ResponseVerdict,
} from "./model-capture.js";
import {
  exceededOutputBound,
  readModelContent,
  unusableOutputMessage,
  usableResponse,
} from "./model-content.js";
import { PLANNER_DIR, responseFile } from "./planner-record.js";
import { PolicySchema, sourceLineMaterial } from "./policy.js";
import { contextSchema } from "./replay.js";
import {
  replayPlannerCorrection,
  replayPlanValidation,
} from "./replay-validation.js";
import { plannerPlanSchema } from "./schema.js";

/**
 * Rejugement hors ligne d'une réponse payée du planificateur.
 *
 * Relit `_planner/inputs.json` et une ou plusieurs `_planner/response-<n>.json`,
 * puis rejoue EXACTEMENT le jugement du run : la réponse est-elle utilisable
 * (`usableResponse`), son JSON se lit-il et respecte-t-il le schéma du
 * planificateur (`readModelContent` + `plannerPlanSchema(sourceLineMaterial)`),
 * et que lui opposent les portes (`replayPlannerCorrection`, la même correction
 * que le run envoie, et `replayPlanValidation`, la porte complète d'avant
 * exécution). Aucun modèle, aucun navigateur, aucun réseau : c'est gratuit, et
 * cela dit pourquoi une réponse à 40 000 tokens a été refusée.
 */

const inputsSchema = z.object({
  version: z.literal(1),
  context: contextSchema,
  policy: z.unknown(),
  catalog: z.object({
    fixtures: z.record(z.string(), z.string()),
    roles: z.array(z.string()),
    visuals: z.array(z.string()),
  }),
  evidence: z.object({ url: z.string(), aria: z.string() }),
  model: z.record(z.string(), z.unknown()),
  source: z.record(z.string(), z.unknown()),
  validationConfig: z.object({
    QA_MAX_SCENARIOS: z.number().int().positive(),
    QA_MAX_STEPS: z.number().int().positive(),
    QA_PER_SCENARIO_COVERAGE: z.boolean(),
  }),
});

const recordSchema = z.object({
  call: z.number().int().nonnegative(),
  constrained: z.boolean(),
  content: z.string(),
  contentChars: z.number().int().nonnegative(),
  contentTruncated: z.boolean(),
  finishReason: z.string().optional(),
  maxTokens: z.number().int().positive(),
  purpose: z.string(),
  usage: z.object({ completion_tokens: z.number().optional() }).optional(),
  verdict: z.object({ kind: z.string() }).passthrough().optional(),
});

type Rejudged =
  | ResponseVerdict
  | { kind: "skipped"; reason: string }
  | {
      kind: "accepted" | "gate";
      refusal?: string;
      /** La porte complète d'avant exécution, au-delà de la correction envoyée. */
      refusals: string[];
      inconclusive: string[];
    };

interface Judged {
  catalog: TrustedCatalog;
  config: Config;
  context: PrContext;
  evidence: { aria: string; url: string };
  policy: z.infer<typeof PolicySchema>;
}

const PLANNER_PURPOSE = purposeOf(PLANNER_PROMPT);

/** Le verdict qu'un run rendrait aujourd'hui sur cette réponse. */
function judge(record: z.infer<typeof recordSchema>, input: Judged): Rejudged {
  if (record.purpose !== PLANNER_PURPOSE || record.constrained) {
    return {
      kind: "skipped",
      reason: record.constrained
        ? "answer to a constrained correction, not a plan"
        : `not a planner response (${record.purpose})`,
    };
  }
  if (record.contentTruncated) {
    return {
      kind: "skipped",
      reason: `content was cut at capture (${record.contentChars} characters); it cannot be re-judged`,
    };
  }
  const overBound = exceededOutputBound(record.usage, record.maxTokens);
  if (!usableResponse(record.content, record.finishReason, overBound)) {
    return {
      kind: "unusable",
      reason: unusableOutputMessage(
        record.content,
        record.finishReason,
        overBound,
        record.maxTokens,
        input.config
      ),
    };
  }
  const read = readModelContent(
    record.content,
    plannerPlanSchema(sourceLineMaterial(input.context)),
    undefined,
    input.config
  );
  if ("invalid" in read) {
    return invalidVerdict(read.invalid);
  }
  if ("discarded" in read) {
    return { kind: "discarded" };
  }
  const gate = { ...input, plan: read.value };
  const validation = replayPlanValidation(gate);
  return {
    ...(gateVerdict(replayPlannerCorrection(gate), input.config) as {
      kind: "accepted" | "gate";
      refusal?: string;
    }),
    refusals: validation.refusals,
    inconclusive: validation.inconclusive,
  };
}

async function responseFiles(
  dir: string,
  only: number | undefined
): Promise<string[]> {
  if (only !== undefined) {
    return [responseFile(only)];
  }
  const names = (await readdir(dir)).filter((name) =>
    /^response-\d+\.json$/.test(name)
  );
  return names.sort(
    (a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, ""))
  );
}

/**
 * Rejuge les réponses enregistrées d'un run : toutes celles du planificateur,
 * ou la seule désignée par `only`.
 */
export async function rejudge(
  runDir: string,
  only: number | undefined,
  config: Config
) {
  const dir = join(resolve(runDir), PLANNER_DIR);
  const inputs = inputsSchema.parse(
    JSON.parse(await readFile(join(dir, "inputs.json"), "utf8"))
  );
  const judged: Judged = {
    catalog: inputs.catalog,
    config: { ...config, ...inputs.validationConfig },
    context: inputs.context as PrContext,
    evidence: inputs.evidence,
    policy: PolicySchema.parse(inputs.policy),
  };
  const responses: {
    call: number;
    contentChars: number;
    file: string;
    finishReason: string | null;
    recordedVerdict: string | null;
    verdict: Rejudged;
  }[] = [];
  for (const file of await responseFiles(dir, only)) {
    const record = recordSchema.parse(
      JSON.parse(await readFile(join(dir, file), "utf8"))
    );
    responses.push({
      call: record.call,
      contentChars: record.contentChars,
      file: `${PLANNER_DIR}/${file}`,
      finishReason: record.finishReason ?? null,
      recordedVerdict: record.verdict?.kind ?? null,
      verdict: judge(record, judged),
    });
  }
  const verdicts = responses
    .map((item) => item.verdict)
    .filter((verdict) => verdict.kind !== "skipped");
  return {
    source: inputs.source,
    model: inputs.model,
    /**
     * Vrai seulement quand chaque réponse jugée serait acceptée aujourd'hui,
     * par la correction du planificateur ET par la porte d'avant exécution.
     */
    accepted:
      verdicts.length > 0 &&
      verdicts.every(
        (verdict) =>
          verdict.kind === "accepted" &&
          !("refusals" in verdict && verdict.refusals.length > 0)
      ),
    responses,
  };
}
