import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La campagne de vérification sur le build **livré**.
 *
 * La campagne contrôlée précédente avait mesuré `6c5a746`, un build qui portait
 * encore le doublon `QA_PREVENT_MARKER_ORDER`, alors que le code livré l'a retiré.
 * Cette campagne mesure donc le code réellement livré (`52ff4d0`), alterné avec la
 * référence : D1 → B1 → D2 → B2, cinq runs par lot, dix par bras, déploiement et
 * commit par bloc.
 *
 * Deux runs du bras livré sont des pannes d'infrastructure (`HTTP_429`) : elles
 * sont comptées, nommées, et exclues du seul calcul « évaluable » — jamais
 * supprimées de l'artefact.
 */
interface Run {
  codes: string[];
  endedAt: string;
  greenScenarios: number;
  infrastructure: boolean;
  outcome: string;
  preMatchedKeyed: number;
  productFailures: number;
  run: string;
  scenarioCount: number;
  startedAt: string;
  tokens: number;
}

interface Block {
  arm: string;
  branch: string;
  commit: string;
  deployment: string;
  lot: string;
  preMatchedKeyed: number;
  runs: Run[];
}

const campaign = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "historical/delivered-campaign.json"),
    "utf8"
  )
) as { blocks: Block[]; protocol: string };

const arms = new Map<string, Run[]>();
for (const block of campaign.blocks) {
  arms.set(block.arm, [...(arms.get(block.arm) ?? []), ...block.runs]);
}

const summary = (runs: Run[]) => {
  const evaluable = runs.filter((run) => !run.infrastructure);
  const seconds = (run: Run) =>
    (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000;
  return {
    runs: runs.length,
    green: runs.filter((run) => run.outcome === "passed").length,
    evaluable: evaluable.length,
    evaluableGreen: evaluable.filter((run) => run.outcome === "passed").length,
    scenarios: evaluable.reduce((sum, run) => sum + run.greenScenarios, 0),
    product: evaluable.reduce((sum, run) => sum + run.productFailures, 0),
    tokens: Math.round(
      evaluable.reduce((sum, run) => sum + run.tokens, 0) / evaluable.length
    ),
    seconds: Math.round(
      evaluable.reduce((sum, run) => sum + seconds(run), 0) / evaluable.length
    ),
    infrastructure: runs.filter((run) => run.infrastructure).length,
  };
};

describe("campagne de vérification sur le build livré", () => {
  it("alterne les deux bras et atteste du build servi", () => {
    expect(campaign.blocks.map((block) => block.lot)).toEqual([
      "D1",
      "B1",
      "D2",
      "B2",
    ]);
    expect(campaign.blocks.map((block) => block.arm)).toEqual([
      "delivered",
      "baseline",
      "delivered",
      "baseline",
    ]);
    for (const block of campaign.blocks) {
      expect(block.runs).toHaveLength(5);
      expect(block.commit).toHaveLength(40);
      expect(block.deployment.length).toBeGreaterThan(10);
      if (block.arm === "delivered") {
        expect(block.commit.startsWith("52ff4d0"), block.lot).toBe(true);
        // Instrumentation présente : c'est le build livré, pas la référence.
        expect(block.preMatchedKeyed, block.lot).toBeGreaterThan(0);
      } else {
        expect(block.commit.startsWith("8143ac9"), block.lot).toBe(true);
        expect(block.preMatchedKeyed, block.lot).toBe(0);
      }
    }
    expect(arms.get("delivered")).toHaveLength(10);
    expect(arms.get("baseline")).toHaveLength(10);
  });

  it("compte les pannes d'infrastructure au lieu de les retirer", () => {
    const delivered = summary(arms.get("delivered") ?? []);
    const baseline = summary(arms.get("baseline") ?? []);
    expect(delivered.runs).toBe(10);
    expect(delivered.infrastructure).toBe(2);
    expect(baseline.infrastructure).toBe(0);
    const infraCodes = (arms.get("delivered") ?? [])
      .filter((run) => run.infrastructure)
      .flatMap((run) => run.codes);
    expect(infraCodes).toContain("HTTP_429");
  });

  it("recalcule les agrégats publiés, sur les runs évaluables", () => {
    const delivered = summary(arms.get("delivered") ?? []);
    const baseline = summary(arms.get("baseline") ?? []);
    expect(delivered).toMatchObject({
      green: 7,
      evaluable: 8,
      evaluableGreen: 7,
      scenarios: 56,
      product: 0,
      tokens: 243_738,
      seconds: 415,
    });
    expect(baseline).toMatchObject({
      green: 7,
      evaluable: 10,
      evaluableGreen: 7,
      scenarios: 90,
      product: 2,
      tokens: 285_287,
      seconds: 570,
    });
    // Le code livré exécute moins de scénarios par run : c'est dit, pas caché.
    expect(delivered.scenarios / delivered.evaluable).toBeLessThan(
      baseline.scenarios / baseline.evaluable
    );
  });

  it("n'annonce pas une différence que l'échantillon ne porte pas", () => {
    const delivered = summary(arms.get("delivered") ?? []);
    const baseline = summary(arms.get("baseline") ?? []);
    // 7/8 contre 7/10 : moins d'un sigma d'écart, et des surfaces différentes.
    const p1 = delivered.evaluableGreen / delivered.evaluable;
    const p2 = baseline.evaluableGreen / baseline.evaluable;
    const se = Math.sqrt(
      (p1 * (1 - p1)) / delivered.evaluable +
        (p2 * (1 - p2)) / baseline.evaluable
    );
    expect(Math.abs(p1 - p2) / se).toBeLessThan(2);
  });
});
