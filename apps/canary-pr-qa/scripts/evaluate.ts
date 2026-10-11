import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import corpus from "../evals/corpus.json" with { type: "json" };
import { loadConfig } from "../src/config.js";
import { EXECUTOR_PROMPT, PLANNER_PROMPT } from "../src/model.js";
import { runQa } from "../src/runner.js";
import { fixture, PR_URL } from "../test/fixture.js";

const schema = z.object({
  version: z.literal(1),
  cases: z.array(
    z.object({
      id: z.string(),
      expected: z.enum(["passed", "failed"]),
      fixture: z
        .object({
          broken: z.boolean().optional(),
          decoy: z.boolean().optional(),
          unchangedState: z.boolean().optional(),
        })
        .optional(),
      prUrl: z.string().url().optional(),
      previewUrl: z.string().url().optional(),
      requiredActions: z.array(z.string()),
      annotation: z.string(),
    })
  ),
});
type Case = z.infer<typeof schema>["cases"][number];
async function evaluateCase(
  item: Case,
  model: string,
  repeat: number,
  configured: ReturnType<typeof loadConfig>,
  output: string
) {
  const local = item.fixture ? await fixture(item.fixture) : undefined;
  try {
    const config = {
      ...(local?.config ?? configured),
      OPENAI_BASE_URL: configured.OPENAI_BASE_URL,
      OPENAI_API_KEY: configured.OPENAI_API_KEY,
      OPENAI_MODEL: model,
      QA_ALLOWED_PROVIDER_HOSTS: configured.QA_ALLOWED_PROVIDER_HOSTS,
      QA_DATA_DIR: output,
    };
    const result = await runQa(
      {
        prUrl: local ? PR_URL : (item.prUrl ?? ""),
        previewUrl: local?.baseUrl ?? item.previewUrl,
        publish: false,
      },
      config
    );
    const actions = result.scenarios.flatMap((s) =>
      s.steps.map((step) => step.action.type)
    );
    const sufficient = item.requiredActions.every((action) =>
      actions.includes(action as (typeof actions)[number])
    );
    return {
      case: item.id,
      model,
      repeat,
      runId: result.id,
      outcome: result.outcome,
      expected: item.expected,
      sufficient,
      correct: result.outcome === item.expected && sufficient,
      annotation: item.annotation,
      diagnostic: result.diagnostic,
    };
  } finally {
    await local?.close();
  }
}
async function main() {
  if (process.env.QA_EVAL_LIVE !== "true") {
    throw new Error(
      "Set QA_EVAL_LIVE=true and a real OPENAI endpoint to run live evaluation. Fixture AI is never an evaluation model."
    );
  }
  const configured = loadConfig();
  if (configured.OPENAI_MODEL === "configured-model") {
    throw new Error("Real model identifier required");
  }
  const dataset = schema.parse(
    process.env.QA_EVAL_CORPUS
      ? JSON.parse(await readFile(process.env.QA_EVAL_CORPUS, "utf8"))
      : corpus
  );
  const models = (process.env.QA_EVAL_MODELS ?? configured.OPENAI_MODEL)
    .split(",")
    .filter(Boolean);
  const repeats = Number(process.env.QA_EVAL_REPEATS ?? 2);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) {
    throw new Error("QA_EVAL_REPEATS must be 1..20");
  }
  const output = resolve(process.env.QA_EVAL_OUTPUT ?? "./qa-data/evaluation");
  await mkdir(output, { recursive: true });
  const rows: Awaited<ReturnType<typeof evaluateCase>>[] = [];
  for (const model of models) {
    for (const item of dataset.cases) {
      for (let repeat = 0; repeat < repeats; repeat++) {
        rows.push(await evaluateCase(item, model, repeat, configured, output));
        await writeFile(
          resolve(output, "results.json"),
          JSON.stringify(rows, null, 2)
        );
      }
    }
  }
  const bugs = rows.filter((r) => r.expected === "failed");
  const healthy = rows.filter((r) => r.expected === "passed");
  const report = {
    at: new Date().toISOString(),
    corpusHash: createHash("sha256")
      .update(JSON.stringify(dataset))
      .digest("hex"),
    promptHash: createHash("sha256")
      .update(PLANNER_PROMPT + EXECUTOR_PROMPT)
      .digest("hex"),
    rows,
    metrics: {
      bugDetectionRate:
        bugs.filter((r) => r.correct).length / Math.max(1, bugs.length),
      falseGreenRate:
        bugs.filter((r) => r.outcome === "passed").length /
        Math.max(1, bugs.length),
      healthyPassRate:
        healthy.filter((r) => r.correct).length / Math.max(1, healthy.length),
      blockedRate:
        rows.filter((r) => ["blocked", "stale", "skipped"].includes(r.outcome))
          .length / rows.length,
    },
  };
  await writeFile(
    resolve(output, "evaluation.json"),
    JSON.stringify(report, null, 2)
  );
  process.stdout.write(`${JSON.stringify(report.metrics, null, 2)}\n`);
  const minimum = Number(process.env.QA_EVAL_MIN_DETECTION ?? 1);
  process.exitCode =
    report.metrics.falseGreenRate > 0 ||
    report.metrics.bugDetectionRate < minimum ||
    report.metrics.healthyPassRate < 1
      ? 1
      : 0;
}
main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 2;
});
