import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La campagne contrôlée entrelacée, dans un artefact versionné, avec sa provenance.
 *
 * Lots alternés courant/référence : R1 → S1 → R2 → S2, cinq runs par lot, dix par
 * bras. Chaque bloc porte le déploiement Coolify et le commit qu'il a réellement
 * servis, et `preMatchedKeyed` atteste du bras : le build courant écrit ce champ,
 * la référence ne le connaît pas. Le premier essai, dont les déploiements du bras
 * courant avaient échoué, est conservé à part et déclaré invalide.
 *
 * Le résultat est favorable au build courant, mais faiblement : 10/10 contre 8/10.
 * Le test fige les deux chiffres pour qu'aucune réécriture ne les transforme en
 * preuve de gain ni en régression.
 */
interface CampaignRun {
  assertions: number;
  codes: string[];
  endedAt: string;
  greenScenarios: number;
  outcome: string;
  passedScenarios: number;
  preMatchedAssertions: number;
  preMatchedKeyed: number;
  productFailures: number;
  run: string;
  scenarioCount: number;
  startedAt: string;
  tokens: number;
  unverifiedPreconditions: number;
}

interface CampaignBlock {
  arm: string;
  branch: string;
  commit: string;
  deployment: string;
  lot: string;
  preMatchedKeyed: number;
  runs: CampaignRun[];
}

const read = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "historical", name), "utf8")
  ) as { blocks: CampaignBlock[]; protocol: string };

const campaign = read("controlled-campaign.json");
const invalid = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "historical", "campaign-attempt-1-invalid.json"),
    "utf8"
  )
) as { blocks: CampaignBlock[]; invalidated: string };

const arms = new Map<string, CampaignRun[]>();
for (const block of campaign.blocks) {
  arms.set(block.arm, [...(arms.get(block.arm) ?? []), ...block.runs]);
}

const summary = (runs: CampaignRun[]) => ({
  runs: runs.length,
  green: runs.filter((run) => run.outcome === "passed").length,
  scenarios: runs.reduce((total, run) => total + run.greenScenarios, 0),
  scenarioSlots: runs.reduce((total, run) => total + run.scenarioCount, 0),
  product: runs.reduce((total, run) => total + run.productFailures, 0),
  tokens: Math.round(
    runs.reduce((total, run) => total + run.tokens, 0) / runs.length
  ),
  assertions: runs.reduce((total, run) => total + run.assertions, 0),
  preMatchedKeyed: runs.reduce((total, run) => total + run.preMatchedKeyed, 0),
  refusedButAllPassed: runs.filter(
    (run) =>
      run.outcome !== "passed" &&
      run.scenarioCount > 0 &&
      run.passedScenarios === run.scenarioCount &&
      run.codes.length > 0
  ).length,
});

describe("campagne contrôlée entrelacée", () => {
  it("alterne les deux bras et donne dix runs par bras", () => {
    expect(campaign.blocks.map((block) => block.lot)).toEqual([
      "R1",
      "S1",
      "R2",
      "S2",
    ]);
    expect(campaign.blocks.map((block) => block.arm)).toEqual([
      "current",
      "baseline",
      "current",
      "baseline",
    ]);
    for (const block of campaign.blocks) {
      expect(block.runs).toHaveLength(5);
      expect(block.commit).toHaveLength(40);
      expect(block.deployment.length).toBeGreaterThan(10);
    }
    expect(arms.get("current")).toHaveLength(10);
    expect(arms.get("baseline")).toHaveLength(10);
  });

  it("atteste du bras par le champ que seul le build courant écrit", () => {
    const current = campaign.blocks.filter((block) => block.arm === "current");
    const baseline = campaign.blocks.filter(
      (block) => block.arm === "baseline"
    );
    for (const block of current) {
      expect(block.commit.startsWith("6c5a746"), block.lot).toBe(true);
      expect(block.preMatchedKeyed, block.lot).toBeGreaterThan(0);
    }
    for (const block of baseline) {
      expect(block.commit.startsWith("8143ac9"), block.lot).toBe(true);
      // La référence ne connaît pas `preMatched` : son zéro est une absence
      // d'instrumentation, jamais une mesure.
      expect(block.preMatchedKeyed, block.lot).toBe(0);
    }
  });

  it("recalcule les six indicateurs publiés, par bras", () => {
    const baseline = summary(arms.get("baseline") ?? []);
    const current = summary(arms.get("current") ?? []);
    expect(baseline).toMatchObject({
      runs: 10,
      green: 8,
      scenarios: 81,
      scenarioSlots: 84,
      product: 3,
      tokens: 265_128,
      assertions: 468,
      preMatchedKeyed: 0,
      refusedButAllPassed: 0,
    });
    expect(current).toMatchObject({
      runs: 10,
      green: 10,
      scenarios: 88,
      scenarioSlots: 88,
      product: 0,
      tokens: 245_966,
      assertions: 465,
      preMatchedKeyed: 73,
      refusedButAllPassed: 0,
    });
    for (const runs of arms.values()) {
      for (const run of runs) {
        expect(Number.isNaN(Date.parse(run.startedAt)), run.run).toBe(false);
        expect(Number.isNaN(Date.parse(run.endedAt)), run.run).toBe(false);
      }
    }
  });

  it("ne transforme pas 10/10 contre 8/10 en démonstration", () => {
    const baseline = summary(arms.get("baseline") ?? []);
    const current = summary(arms.get("current") ?? []);
    // Deux runs d'écart sur dix par bras : l'intervalle de confiance chevauche.
    // L'assertion fige la mesure, pas une conclusion.
    expect(current.green - baseline.green).toBe(2);
    expect(current.green).toBeLessThanOrEqual(10);
  });

  it("conserve la première tentative et l'explique par la preuve", () => {
    expect(invalid.blocks).toHaveLength(4);
    expect(invalid.invalidated).toContain("w6rceollsm27vvswqr6lsbhb");
    // Le bras dit « courant » de la première tentative n'instrumente pas
    // `preMatched` : il a donc servi la référence, pas le build courant.
    for (const block of invalid.blocks) {
      expect(block.runs.every((run) => run.preMatchedKeyed === undefined)).toBe(
        true
      );
    }
  });
});
