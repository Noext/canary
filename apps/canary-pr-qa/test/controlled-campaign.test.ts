import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La campagne contrôlée entrelacée, dans un artefact versionné.
 *
 * Lots alternés baseline/courant sur le même service, la même PR, le même modèle
 * et le même oracle : P1 → Q1 → P2 → Q2, cinq runs par lot, dix par bras. Le test
 * recalcule les six indicateurs publiés et refuse qu'un run non vert soit écarté.
 * Le résultat est défavorable au build courant, et il est figé ici pour qu'aucune
 * réécriture du document ne puisse le présenter comme un gain.
 */
interface CampaignRun {
  assertions: number;
  codes: string[];
  endedAt: string;
  greenScenarios: number;
  outcome: string;
  preMatchedAssertions: number;
  productFailures: number;
  refusedButAllScenariosPassed: boolean;
  run: string;
  startedAt: string;
  tokens: number;
  unverifiedPreconditions: number;
}

interface CampaignBlock {
  arm: string;
  branch: string;
  build: string;
  lot: string;
  runs: CampaignRun[];
}

const campaign = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "historical/controlled-campaign.json"),
    "utf8"
  )
) as { blocks: CampaignBlock[]; protocol: string };

const arms = new Map<string, CampaignRun[]>();
for (const block of campaign.blocks) {
  arms.set(block.arm, [...(arms.get(block.arm) ?? []), ...block.runs]);
}

const summary = (runs: CampaignRun[]) => ({
  runs: runs.length,
  green: runs.filter((run) => run.outcome === "passed").length,
  scenarios: runs.reduce((total, run) => total + run.greenScenarios, 0),
  product: runs.reduce((total, run) => total + run.productFailures, 0),
  tokens: Math.round(
    runs.reduce((total, run) => total + run.tokens, 0) / runs.length
  ),
  assertions: runs.reduce((total, run) => total + run.assertions, 0),
  preMatched: runs.reduce((total, run) => total + run.preMatchedAssertions, 0),
});

describe("campagne contrôlée entrelacée", () => {
  it("alterne les deux bras et donne dix runs par bras", () => {
    expect(campaign.blocks.map((block) => block.lot)).toEqual([
      "P1",
      "Q1",
      "P2",
      "Q2",
    ]);
    expect(campaign.blocks.map((block) => block.arm)).toEqual([
      "baseline",
      "current",
      "baseline",
      "current",
    ]);
    for (const block of campaign.blocks) {
      expect(block.runs).toHaveLength(5);
    }
    expect(arms.get("baseline")).toHaveLength(10);
    expect(arms.get("current")).toHaveLength(10);
    expect(campaign.blocks[0]?.build).toBe("8143ac9");
    expect(campaign.blocks[1]?.build).toBe("e698deb");
  });

  it("recalcule les six indicateurs publiés, par bras", () => {
    const baseline = summary(arms.get("baseline") ?? []);
    const current = summary(arms.get("current") ?? []);
    expect(baseline).toMatchObject({
      runs: 10,
      green: 9,
      scenarios: 82,
      product: 1,
      tokens: 256_746,
      assertions: 471,
    });
    expect(current).toMatchObject({
      runs: 10,
      green: 5,
      scenarios: 88,
      product: 3,
      tokens: 246_981,
      assertions: 505,
    });
    // Faux refus : aucun run bloqué dont tous les scénarios passent, dans cette
    // campagne — l'indicateur est mesuré à zéro, pas supposé.
    for (const runs of arms.values()) {
      expect(runs.filter((run) => run.refusedButAllScenariosPassed)).toEqual(
        []
      );
    }
    // Durées : collectées pour chaque run de la campagne.
    for (const runs of arms.values()) {
      for (const run of runs) {
        expect(Number.isNaN(Date.parse(run.startedAt))).toBe(false);
        expect(Number.isNaN(Date.parse(run.endedAt))).toBe(false);
      }
    }
  });

  it("le build courant ne fait pas mieux que la baseline : la conclusion est figée", () => {
    const baseline = summary(arms.get("baseline") ?? []);
    const current = summary(arms.get("current") ?? []);
    expect(current.green).toBeLessThan(baseline.green);
    expect(current.scenarios).toBeGreaterThan(baseline.scenarios);
    expect(current.product).toBeGreaterThan(baseline.product);
  });
});
