import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { armMetrics } from "../src/campaign-metrics.js";
import { loadConfig } from "../src/config.js";
import { classifyFailure, QaError } from "../src/diagnostics.js";
import type { TrustedCatalog } from "../src/fixtures.js";
import type { PrContext } from "../src/github.js";
import { PLANNER_PROMPT } from "../src/model.js";
import { objectiveWitnessRefusals } from "../src/objective-witness.js";
import { classifyScenarioResult } from "../src/observe-act.js";
import { preExecutionRefusalTable } from "../src/plan-evidence.js";
import { PolicySchema } from "../src/policy.js";
import { rejudge } from "../src/rejudge.js";
import { runReplay } from "../src/replay.js";
import { type Plan, PlanSchema, type Scenario } from "../src/schema.js";

/**
 * Le témoin d'objectif : un scénario n'est pas prouvé par un objectif de
 * présence ou d'adresse qui ne lit rien de ce que le diff ajoute ou retire.
 *
 * Fixtures réelles (aucune règle n'y lit un nom d'application) :
 * - `pr21` : le run payé d'une PR d'une ligne qui inverse le signe d'un écart,
 *   publié vert sur l'objectif « le titre de la vue d'accueil est masqué après le
 *   clic de navigation » — le bundle de rejeu (contexte réduit au fichier
 *   modifié, à ses deux révisions), et la réponse brute du planificateur ;
 * - `regression` : les plans réels des runs 16, 15 et 11 de la PR 20, verts ;
 * - `plans.json.gz` : les 79 plans historiques de la PR 20.
 */
const historical = join(import.meta.dirname, "historical");
const read = (name: string) =>
  JSON.parse(gunzipSync(readFileSync(join(historical, name))).toString());

interface Bundle {
  catalog: TrustedCatalog;
  context: PrContext;
  evidence: { aria: string; url: string };
  plan: Plan;
  policy: unknown;
  source: Record<string, unknown>;
  validationConfig: Record<string, unknown>;
}
const fixture = read("objective-witness.json.gz") as {
  pr21: {
    bundle: Bundle;
    outcome: string;
    response: Record<string, unknown>;
    scenarios: { classification: string; id: string; outcome: string }[];
  };
  regression: {
    outcome: string;
    plan: unknown;
    run: string;
    scenarios: { id: string; outcome: string }[];
  }[];
};
const pr20 = read("pr20.json.gz") as { files: PrContext["files"] };
const historicalPlans = read("plans.json.gz") as {
  plan: { scenarios: Scenario[] };
}[];

const bundle = fixture.pr21.bundle;
const realPlan = PlanSchema.parse(bundle.plan);
const real = realPlan.scenarios[0] as Scenario;
const CHANGED_LINE =
  "  const varianceCents = input.expectedCents - input.countedCents;";
const WITNESS_PHRASE =
  "nothing the diff adds or removes in its sourceFiles nor the quote it cites";

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(
    cleanup.map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "objective-witness-"));
  cleanup.push(directory);
  return directory;
}

/** Le rejeu offline de la porte (mode `gate`) sur le bundle réel, plan remplacé. */
async function gate(scenario: Scenario = real) {
  const directory = await scratch();
  const plan = { ...realPlan, scenarios: [scenario] };
  const path = join(directory, "bundle.json");
  await writeFile(
    path,
    JSON.stringify({
      ...bundle,
      createdAt: "2026-10-01T00:00:00.000Z",
      generatedPlan: plan,
      payload: null,
      plan,
      version: 1,
    })
  );
  return await runReplay(path, "gate", loadConfig({ QA_DATA_DIR: directory }));
}

const witnessRefusals = (refusals: readonly string[]) =>
  refusals.filter((item) => item.includes(WITNESS_PHRASE));

/** Une variante du scénario réel, son unique assertion modifiée. */
function mutant(edit: (scenario: Scenario) => void): Scenario {
  const scenario = structuredClone(real);
  edit(scenario);
  return scenario;
}
const objective = (scenario: Scenario) =>
  scenario.assertions[0] as Scenario["assertions"][number];

describe("PR 21 : l'objectif de navigation ne prouve pas le changement", () => {
  it("le run réel a publié passed/proven sur ce plan", () => {
    expect(fixture.pr21.outcome).toBe("passed");
    expect(fixture.pr21.scenarios).toEqual([
      { classification: "proven", id: real.id, outcome: "passed" },
    ]);
    expect(real.objective).toBe("pilotage-heading-hidden");
  });

  it("le rejeu de la porte refuse le plan réel : un seul refus, OBJECTIVE_UNWITNESSED", async () => {
    const replay = await gate();
    expect(replay.verdict).toBe("refused");
    expect(replay.refusals).toHaveLength(1);
    const error = preExecutionRefusalTable(realPlan, {
      catalog: bundle.catalog,
      config: loadConfig({ QA_DATA_DIR: tmpdir() }),
      context: bundle.context,
      evidence: bundle.evidence,
      policy: PolicySchema.parse(bundle.policy),
    }).get(real.id);
    expect(error).toBeInstanceOf(QaError);
    expect(error?.code).toBe("OBJECTIVE_UNWITNESSED");
    // La correction du planificateur et la table d'avant exécution disent la
    // même chose, au mot près.
    expect(replay.refusals[0]).toBe(`${error?.message}. ${error?.hint}`);
    expect(replay.refusals[0]).toContain("pilotage-heading-hidden");
    expect(replay.refusals[0]).toContain('"Pilotage"');
    expect(replay.refusals[0]).toContain(WITNESS_PHRASE);
  });

  it("un scénario refusé ainsi est un défaut de plan, jamais un vert ni une régression", () => {
    const result: Parameters<typeof classifyScenarioResult>[0] = {
      diagnostic: { code: "OBJECTIVE_UNWITNESSED" },
      outcome: "blocked",
    };
    classifyScenarioResult(result);
    expect(result.classification).toBe("test-defect");
    expect(classifyFailure({ code: "OBJECTIVE_UNWITNESSED" })).toBe(
      "plan-defective"
    );
    // Et une campagne compte le run parmi les défauts de plan, pas parmi les
    // défaillances du produit.
    const metrics = armMetrics("witness", [
      {
        arm: "witness",
        assertions: [],
        block: 1,
        outcome: "blocked",
        runId: "r",
        scenarios: [
          { code: "OBJECTIVE_UNWITNESSED", outcome: "blocked", refused: true },
        ],
        sha: "s",
      },
    ]);
    expect(metrics.planDefectiveRuns).toBe(1);
  });

  it("le rejugement de la réponse brute met le même message dans la correction", async () => {
    const directory = await scratch();
    await mkdir(join(directory, "_planner"));
    await writeFile(
      join(directory, "_planner", "inputs.json"),
      JSON.stringify({
        catalog: bundle.catalog,
        context: bundle.context,
        evidence: bundle.evidence,
        model: {},
        policy: bundle.policy,
        source: bundle.source,
        validationConfig: bundle.validationConfig,
        version: 1,
      })
    );
    await writeFile(
      join(directory, "_planner", "response-1.json"),
      JSON.stringify(fixture.pr21.response)
    );
    const judged = await rejudge(
      directory,
      undefined,
      loadConfig({ QA_DATA_DIR: directory })
    );
    expect(judged.accepted).toBe(false);
    const [response] = judged.responses;
    // Le run d'origine avait accepté cette réponse ; aujourd'hui, la porte la
    // renvoie au planificateur avec le refus de témoin.
    expect(response?.recordedVerdict).toBe("accepted");
    expect(response?.verdict.kind).toBe("gate");
    const verdict = response?.verdict as { refusal?: string };
    expect(verdict.refusal).toContain(
      `Scenario ${real.id}: objective pilotage-heading-hidden (hidden role heading "Pilotage") reads ${WITNESS_PHRASE}`
    );
  });
});

describe("variantes qui doivent rester refusées", () => {
  it("(a) count du titre quitté, attendu 0 : `count` est une lecture de présence", async () => {
    const scenario = mutant((item) => {
      Object.assign(objective(item), { expected: 0, kind: "count" });
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });

  it("(b) objectif d'adresse « / » : `url` est une lecture d'adresse", async () => {
    const scenario = mutant((item) => {
      const assertion = objective(item) as Record<string, unknown>;
      assertion.target = undefined;
      Object.assign(assertion, { expected: "/", kind: "url" });
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });

  it("(c) objectif retiré : les assertions du scénario forment la preuve", async () => {
    const scenario = mutant((item) => {
      item.objective = undefined;
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });

  it("(d) `behavior` réécrit pour nommer la cible : la prose ne blanchit rien", async () => {
    const scenario = mutant((item) => {
      const requirement = item.requirements[0] as { behavior: string };
      requirement.behavior = `${requirement.behavior} Le titre Pilotage disparaît.`;
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });

  it("(e) littéral présent seulement dans une ligne de contexte du hunk", async () => {
    // `compte-juste` est écrit par une ligne que le diff ne touche pas : elle
    // existe avant comme après le changement.
    expect(bundle.context.files[0]?.patch).toContain('"compte-juste"');
    const scenario = mutant((item) => {
      Object.assign(objective(item), {
        kind: "visible",
        target: { by: "css", value: '[data-x="compte-juste"]' },
      });
    });
    expect(objective(scenario).requirement).toBe(0);
    expect(scenario.requirements[0]?.quote).toBe(CHANGED_LINE);
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });
});

describe("contrôles qui doivent passer toutes les portes", () => {
  it("V2 : le message d'état lu en texte après la clôture (hors périmètre `text`)", async () => {
    const scenario = mutant((item) => {
      item.steps = [
        item.steps[0],
        item.steps[1],
        {
          action: {
            locator: { by: "label", value: "Montant d’espèces attendu" },
            type: "fill",
            value: "1 240,00",
          },
          description: "fill",
          id: "fill-expected",
        },
        {
          action: {
            locator: {
              by: "role",
              name: "Clôturer la session",
              value: "button",
            },
            type: "click",
          },
          description: "close",
          id: "close",
        },
        {
          action: { assertionId: "status-variance", type: "assert" },
          description: "verify",
          id: "verify",
        },
      ] as Scenario["steps"];
      item.assertions = [
        {
          afterStep: "close",
          description: "message d'écart signé",
          expected:
            "Écart de -1 240,00 € : une justification écrite est obligatoire avant clôture.",
          id: "status-variance",
          kind: "text",
          requirement: 0,
          target: { by: "role", name: "", value: "status" },
          verification: "transition",
        },
      ] as Scenario["assertions"];
      item.objective = "status-variance";
    });
    const replay = await gate(scenario);
    expect(replay.refusals).toEqual([]);
    expect(replay.verdict).toBe("accepted");
  });

  it("count sur un attribut dont le nom kebab redonne l'identifiant camelCase changé", async () => {
    const scenario = mutant((item) => {
      Object.assign(objective(item), {
        expected: 1,
        kind: "count",
        target: { by: "css", value: '[data-variance-cents="-4000"]' },
      });
    });
    const replay = await gate(scenario);
    expect(replay.refusals).toEqual([]);
    expect(replay.verdict).toBe("accepted");
  });

  it("présence dont la citation écrit le littéral ciblé", async () => {
    const scenario = mutant((item) => {
      (item.requirements[0] as { quote: string }).quote =
        '    return { varianceCents, status: "compte-juste", blocking: false };';
      Object.assign(objective(item), {
        kind: "visible",
        target: { by: "css", value: '[data-x="compte-juste"]' },
      });
    });
    const replay = await gate(scenario);
    expect(replay.refusals).toEqual([]);
    expect(replay.verdict).toBe("accepted");
  });
});

/** Un scénario synthétique sur un diff d'une ligne, pour le découpage en jetons. */
function tokenCase(added: string, target: Record<string, unknown>) {
  const scenario = mutant((item) => {
    item.sourceFiles = ["src/value.ts"];
    (item.requirements[0] as { quote: string; sourceFile: string }).quote = "}";
    (item.requirements[0] as { sourceFile: string }).sourceFile =
      "src/value.ts";
    Object.assign(objective(item), { kind: "visible", target });
  });
  const context = {
    files: [
      {
        filename: "src/value.ts",
        patch: `@@ -1 +1 @@\n-const previous = 1;\n+${added}`,
        status: "modified",
      },
    ],
  };
  return objectiveWitnessRefusals(
    { ...realPlan, scenarios: [scenario] },
    context
  );
}

describe("découpage en jetons", () => {
  it("« Écart » rejoint `ecart` : accents repliés", () => {
    expect(
      tokenCase('const status = "ecart";', {
        by: "role",
        name: "Écart",
        value: "heading",
      })
    ).toEqual([]);
    expect(
      tokenCase('const status = "cart";', {
        by: "role",
        name: "Écart",
        value: "heading",
      })
    ).toHaveLength(1);
  });

  it("`varianceCents` donne variance et cents", () => {
    for (const value of ["[data-variance]", "[data-cents]"]) {
      expect(
        tokenCase("const varianceCents = 1;", { by: "css", value })
      ).toEqual([]);
    }
  });

  it("`5_000` est le nombre 5000", () => {
    expect(
      tokenCase("const limit = 5_000;", { by: "text", value: "5000" })
    ).toEqual([]);
    expect(
      tokenCase("const limit = 5_001;", { by: "text", value: "5000" })
    ).toHaveLength(1);
  });
});

describe("le jeu de régression reste vert", () => {
  const pr20Context = { files: pr20.files };
  let declared = 0;
  for (const run of fixture.regression) {
    const plan = PlanSchema.parse(run.plan);
    declared += plan.scenarios.filter(
      (scenario) => scenario.objective !== undefined
    ).length;
    it(`run ${run.run.slice(0, 8)} : aucun refus de témoin, avec ou sans objectif déclaré`, () => {
      expect(run.scenarios.length).toBe(7);
      expect(objectiveWitnessRefusals(plan, pr20Context)).toEqual([]);
      const undeclared = {
        ...plan,
        scenarios: plan.scenarios.map((scenario) => ({
          ...scenario,
          objective: undefined,
        })),
      };
      expect(objectiveWitnessRefusals(undeclared, pr20Context)).toEqual([]);
    });
  }

  it("21 objectifs déclarés sur 21 scénarios, tous témoins", () => {
    expect(declared).toBe(21);
  });

  it("79 plans historiques : 0 lecture de présence sans témoin sur 2914, 0 scénario sur 681", () => {
    expect(historicalPlans).toHaveLength(79);
    let scenarios = 0;
    let presence = 0;
    let unwitnessed = 0;
    let fallback = 0;
    for (const entry of historicalPlans) {
      const plan = entry.plan as Plan;
      scenarios += plan.scenarios.length;
      fallback += objectiveWitnessRefusals(plan, pr20).length;
      for (const scenario of plan.scenarios) {
        expect(scenario.objective).toBeUndefined();
        for (const assertion of scenario.assertions) {
          if (!["visible", "hidden", "count"].includes(assertion.kind)) {
            continue;
          }
          presence += 1;
          // Contrefactuel : chaque lecture de présence prise pour objectif.
          unwitnessed += objectiveWitnessRefusals(
            {
              ...plan,
              scenarios: [{ ...scenario, objective: assertion.id }],
            },
            pr20
          ).length;
        }
      }
    }
    expect({ fallback, presence, scenarios, unwitnessed }).toEqual({
      fallback: 0,
      presence: 2914,
      scenarios: 681,
      unwitnessed: 0,
    });
  });
});

it("le prompt énonce le matériel des consommateurs et le refus de témoin", () => {
  expect(PLANNER_PROMPT).toContain(
    "pr.consumers, when present, holds excerpts of UNCHANGED files"
  );
  expect(PLANNER_PROMPT).toContain(
    "is refused (OBJECTIVE_UNWITNESSED): a view title, a navigation control or a heading of the page you left exists with or without the change"
  );
  expect(PLANNER_PROMPT).toContain("never copied from an observed view");
});
