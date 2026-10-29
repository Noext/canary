import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La campagne d'architecture, 2 × 50 runs entrelacés.
 *
 * Cinq blocs de dix par bras, alternés, chacun avec son déploiement et son
 * commit ; l'armement est attesté par `preMatchedKeyed` sur le bras candidat et
 * par son absence côté référence. Les pannes d'infrastructure sont comptées,
 * nommées, et exclues du seul calcul « évaluable » — jamais retirées.
 *
 * Le résultat est un effet nul, et le test le fige : aucune réécriture ne doit
 * pouvoir le présenter comme un gain ni comme une régression démontrée.
 */
interface Run {
  assertions: number;
  calls: number;
  codes: string[];
  costUsd: number;
  greenScenarios: number;
  infrastructure?: boolean;
  objectivesDeclared: number;
  objectivesProven: number;
  outcome: string;
  preMatchedAssertions: number;
  preMatchedKeyed: number;
  productFailures: number;
  refusedButAllScenariosPassed: boolean;
  run: string;
  scenarioCount: number;
  scenarioRefusals: number;
  tokens: number;
}

interface Block {
  arm: string;
  commit: string;
  deployment: string;
  lot: string;
  preMatchedKeyed: number;
  runs: Run[];
}

const campaign = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "historical", "architecture-campaign.json"),
    "utf8"
  )
) as { blocks: Block[]; infrastructure: { failedRuns: string[] } };

const arms = new Map<string, Run[]>();
for (const block of campaign.blocks) {
  arms.set(block.arm, [...(arms.get(block.arm) ?? []), ...block.runs]);
}

const summary = (runs: Run[]) => {
  const evaluable = runs.filter((run) => !run.infrastructure);
  const green = evaluable.filter((run) => run.outcome === "passed").length;
  return {
    runs: runs.length,
    evaluable: evaluable.length,
    green,
    rate: green / evaluable.length,
    scenarios: evaluable.reduce((sum, run) => sum + run.greenScenarios, 0),
    product: evaluable.reduce((sum, run) => sum + run.productFailures, 0),
    tokens: Math.round(
      evaluable.reduce((sum, run) => sum + run.tokens, 0) / evaluable.length
    ),
    assertions: evaluable.reduce((sum, run) => sum + run.assertions, 0),
    preMatched: evaluable.reduce(
      (sum, run) => sum + run.preMatchedAssertions,
      0
    ),
    refusals: runs.reduce((sum, run) => sum + run.scenarioRefusals, 0),
    calls:
      Math.round(
        (evaluable.reduce((sum, run) => sum + run.calls, 0) /
          evaluable.length) *
          10
      ) / 10,
    cost: evaluable.reduce((sum, run) => sum + run.costUsd, 0),
    objectives: evaluable.reduce((sum, run) => sum + run.objectivesDeclared, 0),
    proven: evaluable.reduce((sum, run) => sum + run.objectivesProven, 0),
    falseRefusals: evaluable.filter((run) => run.refusedButAllScenariosPassed)
      .length,
    infrastructure: runs.filter((run) => run.infrastructure).length,
  };
};

const candidate = summary(arms.get("candidate") ?? []);
const baseline = summary(arms.get("baseline") ?? []);

describe("campagne d'architecture 2 × 50 runs", () => {
  it("cinq blocs alternés par bras, chacun avec son déploiement et son commit", () => {
    expect(campaign.blocks.map((block) => block.lot)).toEqual([
      "C1b",
      "R1",
      "C2",
      "R2",
      "C3",
      "R3",
      "C4",
      "R4",
      "C5",
      "R5",
    ]);
    for (const block of campaign.blocks) {
      expect(block.runs).toHaveLength(10);
      expect(block.commit).toHaveLength(40);
      expect(block.deployment.length).toBeGreaterThan(10);
    }
    expect(arms.get("candidate")).toHaveLength(50);
    expect(arms.get("baseline")).toHaveLength(50);
  }, 30_000);

  it("atteste du bras : instrumentation côté candidat, aucune côté référence", () => {
    for (const block of campaign.blocks) {
      if (block.arm === "candidate") {
        expect(block.preMatchedKeyed, block.lot).toBeGreaterThan(0);
      } else {
        expect(block.preMatchedKeyed, block.lot).toBe(0);
        expect(block.commit.startsWith("8143ac9"), block.lot).toBe(true);
      }
    }
  });

  it("recalcule les indicateurs publiés, pannes d'infrastructure comptées à part", () => {
    expect(candidate).toMatchObject({
      runs: 50,
      evaluable: 44,
      green: 29,
      scenarios: 325,
      product: 1,
      tokens: 289_102,
      assertions: 1604,
      preMatched: 252,
      refusals: 33,
      calls: 2.2,
      objectives: 343,
      proven: 319,
      falseRefusals: 5,
      infrastructure: 6,
    });
    expect(baseline).toMatchObject({
      runs: 50,
      evaluable: 44,
      green: 30,
      scenarios: 333,
      product: 15,
      tokens: 267_280,
      assertions: 1916,
      preMatched: 0,
      refusals: 0,
      calls: 2,
      objectives: 0,
      proven: 0,
      falseRefusals: 0,
      infrastructure: 6,
    });
  });

  it("publie le garde-fou franchi : cinq faux refus côté candidat", () => {
    expect(candidate.falseRefusals).toBe(5);
    expect(baseline.falseRefusals).toBe(0);
    // La couverture des objectifs déclarés est mesurée, pas supposée.
    expect(candidate.proven / candidate.objectives).toBeCloseTo(0.93, 2);
  });

  it("l'effet est nul : 65,9 % contre 68,2 %, soit 0,23 σ", () => {
    expect(candidate.rate).toBeCloseTo(0.659, 3);
    expect(baseline.rate).toBeCloseTo(0.682, 3);
    const difference = candidate.rate - baseline.rate;
    const se = Math.sqrt(
      (candidate.rate * (1 - candidate.rate)) / candidate.evaluable +
        (baseline.rate * (1 - baseline.rate)) / baseline.evaluable
    );
    expect(Math.abs(difference) / se).toBeLessThan(1);
    // Aucun gain : l'assertion fige le constat, elle ne l'interprète pas.
    expect(candidate.green).toBeLessThanOrEqual(baseline.green);
  });

  it("conserve la trace de l'incident de publication", () => {
    expect(campaign.infrastructure.failedRuns).toHaveLength(10);
    // Ces runs n'ont jamais exécuté un scénario : ils ne comptent pas comme
    // produit, et ils restent nommés.
    expect(campaign.infrastructure.failedRuns[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
