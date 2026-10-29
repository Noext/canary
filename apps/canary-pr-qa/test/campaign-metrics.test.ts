import { describe, expect, it } from "vitest";
import {
  armMetrics,
  campaignDecision,
  compareArms,
  isFalseRefusal,
  isInfrastructureRun,
  proportionInterval,
  type RecordedRun,
} from "../src/campaign-metrics.js";

function assertion(
  verification: "state" | "transition" | "persisted",
  options: { preMatched?: boolean; passed?: boolean; changed?: boolean } = {}
) {
  return {
    changed: options.changed,
    passed: options.passed ?? true,
    preMatched: options.preMatched,
    verification,
  };
}

function greenRun(
  arm: string,
  overrides: Partial<RecordedRun> = {}
): RecordedRun {
  return run(arm, true, overrides);
}

/**
 * Un run cohérent : un run non vert porte un scénario qui a échoué. Sans cela,
 * un run « failed » dont tous les scénarios sont verts serait — à juste titre —
 * compté comme un faux refus.
 */
function run(
  arm: string,
  green: boolean,
  overrides: Partial<RecordedRun> = {}
): RecordedRun {
  return {
    arm,
    assertions: [assertion("transition", { changed: true })],
    block: 1,
    outcome: green ? "passed" : "failed",
    runId: `${arm}-${green ? "green" : "red"}`,
    scenarios: [{ outcome: green ? "passed" : "failed" }],
    sha: "a".repeat(40),
    ...overrides,
  };
}

describe("les compteurs par type d'assertion", () => {
  it("ventile les assertions par type de vérification", () => {
    const metrics = armMetrics("candidate", [
      greenRun("candidate", {
        assertions: [
          assertion("state", {
            changed: false,
            preMatched: true,
            passed: false,
          }),
          assertion("state", { changed: true }),
          assertion("transition", { changed: true }),
          assertion("persisted", { changed: true }),
        ],
      }),
    ]);
    expect(metrics.assertions).toEqual({
      assertions: 4,
      preMatched: 1,
      preMatchedPassed: 0,
      unchanged: 1,
    });
    expect(metrics.byVerification.state).toEqual({
      assertions: 2,
      preMatched: 1,
      preMatchedPassed: 0,
      unchanged: 1,
    });
    expect(metrics.byVerification.transition?.assertions).toBe(1);
    expect(metrics.byVerification.persisted?.assertions).toBe(1);
  });

  it("compte un faux vert comme une assertion pré-satisfaite qui a passé", () => {
    // C'est la définition du document : `preMatched` ET `passed`. Une assertion
    // pré-satisfaite bloquée n'est pas un faux vert — c'est le défaut corrigé.
    const metrics = armMetrics("candidate", [
      greenRun("candidate", {
        assertions: [
          assertion("state", { changed: true, preMatched: true, passed: true }),
          assertion("state", {
            changed: false,
            preMatched: true,
            passed: false,
          }),
        ],
      }),
    ]);
    expect(metrics.assertions.preMatched).toBe(2);
    expect(metrics.assertions.preMatchedPassed).toBe(1);
  });

  it("ne compte pas un run incomplet comme évaluable ni comme vert", () => {
    const metrics = armMetrics("candidate", [
      greenRun("candidate"),
      { ...greenRun("candidate"), incomplete: true, outcome: "incomplete" },
    ]);
    expect(metrics.runs).toBe(2);
    expect(metrics.incompleteRuns).toBe(1);
    expect(metrics.evaluableRuns).toBe(1);
    expect(metrics.greenRuns).toBe(1);
    expect(metrics.greenRate).toBe(1);
  });

  it("exclut de l'évaluable un run dont un code est une panne d'infrastructure", () => {
    const run = greenRun("candidate", {
      outcome: "blocked",
      scenarios: [{ code: "HTTP_429", outcome: "blocked" }],
    });
    expect(isInfrastructureRun(run)).toBe(true);
    const metrics = armMetrics("candidate", [greenRun("candidate"), run]);
    expect(metrics.infrastructureRuns).toBe(1);
    expect(metrics.evaluableRuns).toBe(1);
    expect(metrics.greenRate).toBe(1);
  });

  it("rend un taux indéfini plutôt que zéro quand aucun run n'est évaluable", () => {
    expect(armMetrics("candidate", []).greenRate).toBeUndefined();
    expect(
      armMetrics("candidate", [
        { ...greenRun("candidate"), incomplete: true, outcome: "incomplete" },
      ]).greenRate
    ).toBeUndefined();
  });
});

describe("les faux refus, tels que le document les définit", () => {
  it("reconnaît un run bloqué dont tous les scénarios exécutés passent", () => {
    expect(
      isFalseRefusal({
        ...greenRun("candidate"),
        outcome: "blocked",
        scenarios: [
          { outcome: "passed" },
          {
            code: "MARKER_ORDER_UNREACHABLE",
            outcome: "blocked",
            refused: true,
          },
        ],
      })
    ).toBe(true);
  });

  it("ne confond pas un échec produit avec un faux refus", () => {
    expect(
      isFalseRefusal({
        ...greenRun("candidate"),
        outcome: "failed",
        scenarios: [{ outcome: "failed" }],
      })
    ).toBe(false);
  });

  it("ne compte pas un run vert comme un faux refus", () => {
    expect(isFalseRefusal(greenRun("candidate"))).toBe(false);
  });
});

describe("la comparaison des deux bras", () => {
  it("calcule l'écart de taux de runs verts et son intervalle", () => {
    const reference = armMetrics(
      "reference",
      Array.from({ length: 10 }, (_, index) => run("reference", index < 6))
    );
    const candidate = armMetrics(
      "candidate",
      Array.from({ length: 10 }, (_, index) => run("candidate", index < 8))
    );
    const comparison = compareArms(reference, candidate);
    expect(comparison.greenRateDelta).toBeCloseTo(0.2, 6);
    expect(comparison.greenRateDeltaInterval).toBeDefined();
    // 2 runs d'écart sur 10 par bras ne suffit pas à exclure zéro.
    expect(comparison.significant).toBe(false);
  });

  it("ne rend aucun écart quand un bras n'a aucun run évaluable", () => {
    const comparison = compareArms(
      armMetrics("reference", []),
      armMetrics("candidate", [])
    );
    expect(comparison.greenRateDelta).toBeUndefined();
    expect(comparison.greenRateDeltaInterval).toBeUndefined();
    expect(comparison.falseGreenDelta).toBeUndefined();
  });

  it("rend un intervalle de proportion vide pour un dénominateur nul", () => {
    expect(proportionInterval(0, 0)).toBeUndefined();
    const interval = proportionInterval(5, 10);
    // 1,96 × √(0,5·0,5/10) ≈ 0,31 : l'intervalle est large, et c'est le point.
    expect(interval?.low).toBeCloseTo(0.19, 3);
    expect(interval?.high).toBeCloseTo(0.81, 3);
  });
});

describe("la décision applique les seuils figés, sans les redéfinir", () => {
  function arms(referenceGreen: number, candidateGreen: number, size = 50) {
    const reference = armMetrics(
      "reference",
      Array.from({ length: size }, (_, index) =>
        run("reference", index < referenceGreen)
      )
    );
    const candidate = armMetrics(
      "candidate",
      Array.from({ length: size }, (_, index) =>
        run("candidate", index < candidateGreen)
      )
    );
    return {
      candidate,
      comparison: compareArms(reference, candidate),
      reference,
    };
  }

  it("ne conclut rien sans run évaluable", () => {
    const decision = campaignDecision(arms(0, 0, 0));
    expect(decision.verdict).toBe("not-run");
  });

  it("valide au-delà de +20 points avec un intervalle excluant zéro", () => {
    // 50 runs par bras : 20/50 contre 42/50 est un écart très large.
    const decision = campaignDecision(arms(20, 42));
    expect(decision.verdict).toBe("validated");
  });

  it("écrit « amélioration non démontrée » pour un écart sous le seuil", () => {
    const decision = campaignDecision(arms(30, 35));
    expect(decision.verdict).toBe("not-demonstrated");
    expect(decision.reasons.join(" ")).toMatch(/sous le seuil de \+20/);
  });

  it("conclut à la régression quand l'intervalle exclut zéro en faveur de la référence", () => {
    const decision = campaignDecision(arms(42, 20));
    expect(decision.verdict).toBe("regression");
  });

  it("refuse de valider quand un garde-fou est franchi, même avec un écart favorable", () => {
    const base = arms(20, 42);
    const withFalseRefusal = {
      ...base,
      candidate: { ...base.candidate, falseRefusals: 1 },
    };
    const decision = campaignDecision(withFalseRefusal);
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.reasons.join(" ")).toMatch(/faux refus/);
  });

  it("refuse de valider quand les faux verts dépassent +3 points", () => {
    const base = arms(20, 42);
    const decision = campaignDecision({
      ...base,
      comparison: { ...base.comparison, falseGreenDelta: 0.04 },
    });
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.reasons.join(" ")).toMatch(/faux verts/);
  });
});
