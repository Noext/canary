import { describe, expect, it } from "vitest";
import {
  invariantObservations,
  replannedScenarios,
  replanPayload,
  targetObservations,
} from "../src/plan-evidence.js";
import type { Plan, ScenarioResult } from "../src/schema.js";

function result(
  id: string,
  code: string | undefined,
  assertion = "banner-after"
): ScenarioResult {
  return {
    artifacts: [],
    assertions: [
      {
        actual: "Aperçu · vérifié",
        baseline: "Aperçu · vérifié",
        id: assertion,
        passed: false,
      },
    ],
    diagnostic: code
      ? {
          code,
          hint: "",
          message: `Assertion ${assertion}: the plan requires a change on a value that does not change`,
        }
      : undefined,
    outcome: code ? "blocked" : "passed",
    scenario: { id } as ScenarioResult["scenario"],
    steps: [],
  };
}

describe("re-planification après observation", () => {
  it("ne retient que les vérifications que l'exécution a démenties", () => {
    const observations = invariantObservations([
      result("a", "TRANSITION_ON_INVARIANT"),
      result("b", "TRANSITION_NOT_OBSERVED"),
      result("c", undefined),
      result("d", "TARGET_NOT_FOUND"),
    ]);
    expect(observations.map((item) => item.scenarioId)).toEqual(["a", "b"]);
    expect(observations[0]).toMatchObject({
      assertionId: "banner-after",
      baseline: "Aperçu · vérifié",
      effective: "Aperçu · vérifié",
    });
  });

  it("demande une réécriture au planificateur, sans toucher au plan lui-même", () => {
    const plan = {
      scenarios: [{ id: "a" }, { id: "z" }],
      skipped: [],
      summary: "s",
    } as unknown as Plan;
    const payload = replanPayload({
      observations: invariantObservations([
        result("a", "TRANSITION_ON_INVARIANT"),
      ]),
      plan,
    });
    // Le plan part tel quel : c'est le modèle qui change la vérification.
    expect(payload.plan).toBe(plan);
    expect(payload.observations).toHaveLength(1);
    expect(payload.instruction).toMatch(/Rewrite ONLY what is wrong/);
    expect(payload.instruction).toMatch(/state with afterStep/);
    expect(payload.instruction).not.toMatch(/transition into state/);
  });

  it("ne réexécute que les scénarios réécrits", () => {
    const plan = {
      scenarios: [{ id: "a" }, { id: "b" }, { id: "c" }],
    } as unknown as Plan;
    const selected = replannedScenarios(plan, [{ scenarioId: "b" }]);
    expect(selected.map((scenario) => scenario.id)).toEqual(["b"]);
  });
});

describe("re-planification d'une cible absente", () => {
  it("remonte ce que la page offrait, sans nouvelle visite", () => {
    const observations = targetObservations([
      {
        artifacts: [],
        assertions: [],
        diagnostic: {
          code: "TARGET_NOT_FOUND",
          hint: "",
          message: "Canary action failed: Timeout",
        },
        outcome: "blocked",
        scenario: { id: "caisse" } as ScenarioResult["scenario"],
        steps: [
          {
            action: { type: "fill" } as never,
            index: 1,
            observation: "",
            observedTargets: "role=button name=Piece de 5 EUR",
            ok: false,
            reason: "timeout",
          },
        ],
      },
      {
        artifacts: [],
        assertions: [],
        outcome: "passed",
        scenario: { id: "sain" } as ScenarioResult["scenario"],
        steps: [],
      },
    ]);
    expect(observations).toEqual([
      {
        code: "TARGET_NOT_FOUND",
        offered: "role=button name=Piece de 5 EUR",
        scenarioId: "caisse",
        stepId: "1",
      },
    ]);
  });

  it("transmet les deux familles dans la même réécriture", () => {
    const payload = replanPayload({
      observations: [],
      plan: { scenarios: [] } as unknown as Plan,
      targets: [
        {
          code: "TARGET_NOT_FOUND",
          offered: "role=button name=Save",
          scenarioId: "s",
          stepId: "s1",
        },
      ],
    });
    expect(payload.targets).toHaveLength(1);
    expect(payload.instruction).toContain(
      "copy a target from it character by character"
    );
  });
});
