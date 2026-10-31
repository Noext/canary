import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import type { PrContext } from "../src/github.js";
import { restoreDeferredRefusals } from "../src/plan-evidence.js";
import { judgeAgainstBaseline } from "../src/report.js";
import type { RunResult, ScenarioResult } from "../src/schema.js";

/**
 * Banc du 31/10/2026 (33 runs, dont 3 de documentation) : les 30 runs du
 * paquet moteur rejoués en Chromium contre un stub qui sert la réponse
 * enregistrée du planificateur, sans aucun appel payant. La fixture ne garde
 * que la structure : codes moteur, booléens, et des jetons à la place de
 * chaque valeur de page ou de plan (même valeur, même jeton). Le test rejoue le
 * jugement contre la base sur l'état d'avant jugement et vérifie l'invariant :
 * aucun cas de régression ne finit vert.
 */
const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = {} as Config;
const BASE_SHA = "b".repeat(40);

/**
 * Le seul faux vert que le moteur ne peut pas voir : aucun scénario de r2-1
 * n'essaie une quantité négative, le garde retiré par la PR n'est jamais
 * exercé (plan du juge, section D : couverture du planificateur). La liste ne
 * doit que rétrécir.
 */
const PLANNER_COVERAGE_GAPS = ["r2-1"];

interface Recorded {
  actual?: unknown;
  baseline?: unknown;
  changed?: boolean;
  id: string;
  passed: boolean;
  persisted?: unknown;
  preMatched?: boolean;
  verification?: "state" | "transition" | "persisted";
}
interface Side {
  assertions: Recorded[];
  code?: string;
  contract?: string;
  outcome: ScenarioResult["outcome"];
  /** 0 pour une étape jouée telle quelle, [étape, cible substituée] sinon. */
  steps: (0 | [string | number, string])[];
}
interface BenchScenario {
  base?: Side;
  deferred?: string;
  final: ScenarioResult["outcome"];
  finalCode?: string;
  fixtureBacked?: boolean;
  head: Side;
  id: string;
  kind: string;
  objective?: string;
  planned: {
    expected?: unknown;
    id: string;
    kind: string;
    target?: Record<string, unknown>;
  }[];
}
interface BenchRun {
  /** Jetons des littéraux que le vrai diff ajoute ; `null` : diff illisible. */
  addedLiterals?: string[] | null;
  baseline?: "compared" | "unavailable";
  expected: "correct" | "regression";
  outcome: RunResult["outcome"];
  run: string;
  scenarios: BenchScenario[];
  title: "feat" | "refactor";
}

const bench = JSON.parse(
  readFileSync(join(here, "historical", "bench-outcomes.json"), "utf8")
) as { runs: BenchRun[] };

function side(
  recorded: Side,
  plan: ScenarioResult["scenario"]
): ScenarioResult {
  return {
    artifacts: [],
    scenario: plan,
    outcome: recorded.outcome,
    ...(recorded.code
      ? {
          diagnostic: { code: recorded.code, message: recorded.code, hint: "" },
        }
      : {}),
    ...(recorded.contract
      ? {
          contract: {
            completedSteps: [],
            totalSteps: recorded.steps.length,
            hash: recorded.contract,
          },
        }
      : {}),
    steps: recorded.steps.map((step, index) =>
      step === 0
        ? { index }
        : {
            index,
            ...(typeof step[0] === "string" ? { stepId: step[0] } : {}),
            repairedTarget: step[1],
          }
    ) as ScenarioResult["steps"],
    assertions: recorded.assertions.map((item) => ({
      ...item,
      actual: item.actual,
    })),
  };
}

/** L'état d'avant jugement : la tête jouée, la base rejouée, la comparaison à faire. */
function rebuild(run: BenchRun): RunResult {
  const heads = run.scenarios.map((scenario) => {
    const plan = {
      id: scenario.id,
      title: scenario.id,
      kind: scenario.kind,
      rationale: scenario.id,
      sourceFiles: [],
      preconditions: scenario.fixtureBacked ? ["fixture:bench"] : [],
      ...(scenario.objective ? { objective: scenario.objective } : {}),
      steps: [],
      assertions: scenario.planned.map((item) => ({
        ...item,
        description: item.id,
      })),
    } as unknown as ScenarioResult["scenario"];
    return {
      head: side(scenario.head, plan),
      base: scenario.base ? side(scenario.base, plan) : undefined,
    };
  });
  return {
    outcome: "blocked",
    scenarios: heads.map((item) => item.head),
    ...(run.baseline
      ? {
          baseline: {
            sha: BASE_SHA,
            url: "https://base.invalid/",
            ...(run.baseline === "unavailable"
              ? {
                  diagnostic: {
                    code: "BASELINE_UNAVAILABLE",
                    message: "base",
                    hint: "",
                  },
                }
              : {}),
            scenarios: heads.flatMap((item) => (item.base ? [item.base] : [])),
          },
        }
      : {}),
  } as unknown as RunResult;
}

/** Les littéraux ajoutés, rejoués comme lignes ajoutées d'un fichier de code. */
function files(run: BenchRun): PrContext["files"] | undefined {
  if (!run.addedLiterals) {
    return;
  }
  return [
    {
      filename: "src/bench.ts",
      status: "modified",
      additions: run.addedLiterals.length,
      deletions: 0,
      changes: run.addedLiterals.length,
      patch: run.addedLiterals.map((token) => `+ ${token}`).join("\n"),
    },
  ] as PrContext["files"];
}

/** La règle du runner : un seul scénario non vert, et le run n'est pas vert. */
function aggregate(scenarios: ScenarioResult[]): RunResult["outcome"] {
  if (scenarios.length === 0) {
    return "skipped";
  }
  if (scenarios.some((item) => item.outcome === "failed")) {
    return "failed";
  }
  if (scenarios.some((item) => item.outcome !== "passed")) {
    return "blocked";
  }
  return "passed";
}

/** Le jugement du runner après exécution : base, refus différés, agrégat. */
function judge(run: BenchRun): RunResult {
  const result = rebuild(run);
  const title =
    run.title === "refactor" ? "refactor(bench): banc" : "feat(bench): banc";
  judgeAgainstBaseline(result, CONFIG, title, files(run));
  const deferred = new Map(
    run.scenarios.flatMap((scenario) =>
      scenario.deferred
        ? [
            [
              scenario.id,
              new QaError(scenario.deferred, `${scenario.id} différé`, ""),
            ] as const,
          ]
        : []
    )
  );
  restoreDeferredRefusals(result, deferred, CONFIG, { files: [] });
  // Sans plan exploitable (r4-2 : sortie vide du modèle), le runner bloque le
  // run avant tout jugement : son issue est celle de la planification.
  result.outcome =
    run.scenarios.length === 0 ? run.outcome : aggregate(result.scenarios);
  return result;
}

describe("banc du 31/10/2026 rejoué sur le paquet moteur", () => {
  it("couvre les 30 runs qui testent du code", () => {
    expect(bench.runs).toHaveLength(30);
    expect(
      bench.runs.filter((run) => run.expected === "regression")
    ).toHaveLength(18);
    // Un run sans scénario n'a rien prouvé : il n'est jamais vert.
    for (const run of bench.runs.filter(
      (item) => item.scenarios.length === 0
    )) {
      expect(run.outcome, run.run).not.toBe("passed");
    }
  });

  it("retrouve, en rejouant le jugement, l'issue enregistrée de chaque scénario et de chaque run", () => {
    for (const run of bench.runs) {
      const result = judge(run);
      expect(
        result.scenarios.map((item) => `${item.scenario.id}=${item.outcome}`),
        run.run
      ).toEqual(
        run.scenarios.map((scenario) => `${scenario.id}=${scenario.final}`)
      );
      expect(result.outcome, run.run).toBe(run.outcome);
    }
  });

  it("ne finit vert aucun cas de régression, hors le trou de couverture connu du planificateur", () => {
    const green = bench.runs
      .filter((run) => run.expected === "regression")
      .filter((run) => judge(run).outcome === "passed")
      .map((run) => run.run);
    expect(green).toEqual(PLANNER_COVERAGE_GAPS);
  });

  it("ne rend jamais vert un scénario dont le refus a été différé à la base", () => {
    for (const run of bench.runs) {
      const result = judge(run);
      for (const scenario of run.scenarios.filter((item) => item.deferred)) {
        const judged = result.scenarios.find(
          (item) => item.scenario.id === scenario.id
        );
        expect(judged?.outcome, `${run.run} ${scenario.id}`).not.toBe("passed");
      }
    }
  });
});
