import { describe, expect, it } from "vitest";
import {
  invariantObservations,
  replannedScenarios,
  replanPayload,
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
    const selected = replannedScenarios(plan, [
      { assertionId: "a1", code: "TRANSITION_ON_INVARIANT", scenarioId: "b" },
    ]);
    expect(selected.map((scenario) => scenario.id)).toEqual(["b"]);
  });
});
