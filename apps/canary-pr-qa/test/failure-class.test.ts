import { describe, expect, it } from "vitest";
import { classifyFailure, summarizeFailures } from "../src/diagnostics.js";

describe("la classe d'un échec est une règle, pas une appréciation", () => {
  it("un plan que le gate refuse est un défaut de plan démontrable", () => {
    // Les deux « échecs produit » du lot BA sont exactement ce cas : le gate
    // d'aujourd'hui refuse ces plans (borne fausse), donc l'assertion fausse
    // venait du plan, pas du produit.
    expect(
      classifyFailure({ code: "TRANSITION_NOT_OBSERVED", refusedByGate: true })
    ).toBe("plan-impossible");
  });

  it("classe les défauts de plan que rien de statique ne tranche", () => {
    expect(classifyFailure({ code: "TARGET_NOT_FOUND" })).toBe(
      "plan-defective"
    );
    expect(classifyFailure({ code: "TRANSITION_ON_INVARIANT" })).toBe(
      "plan-defective"
    );
    expect(classifyFailure({ code: "REQUIREMENT_UNGROUNDED" })).toBe(
      "plan-defective"
    );
  });

  it("sépare l'infrastructure du produit", () => {
    expect(classifyFailure({ code: "QA_ERROR" })).toBe("infrastructure");
    expect(classifyFailure({ code: "RUN_BUDGET_EXCEEDED" })).toBe(
      "infrastructure"
    );
    expect(classifyFailure({ code: "MODEL_JSON_INVALID" })).toBe(
      "infrastructure"
    );
  });

  it("une assertion fausse sur un plan accepté est une régression produit", () => {
    expect(classifyFailure({ code: "ASSERTION_FAILED" })).toBe(
      "product-regression"
    );
  });

  it("ne devine jamais : sans diagnostic, la classe est inconnue", () => {
    expect(classifyFailure({})).toBe("unclassified");
  });

  it("résume un run en cinq compteurs stables", () => {
    expect(
      summarizeFailures([
        "plan-impossible",
        "plan-defective",
        "plan-defective",
        "infrastructure",
      ])
    ).toEqual({
      infrastructure: 1,
      "plan-defective": 2,
      "plan-impossible": 1,
      "product-regression": 0,
      unclassified: 0,
    });
  });
});
