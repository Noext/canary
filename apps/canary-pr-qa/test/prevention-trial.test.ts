import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * L'essai du doublon, conservé et requalifié.
 *
 * Deux bras du même build, séparés par la seule variable `QA_PREVENT_MARKER_ORDER`.
 * Ce drapeau n'ajoutait qu'une copie du refus d'ordre, déjà remis au planificateur
 * par `unwitnessedPlanRefusals` depuis #86 : l'essai mesure donc la variable du
 * doublon, et il ne réfute pas la prévention, qui est livrée et que ce drapeau ne
 * change pas. Le fichier porte les identifiants de run et le déploiement de chaque
 * bras, et l'artefact reste dans l'arbre : supprimer un résultat historique n'est
 * pas une option.
 */
interface TrialRun {
  codes: string[];
  greenScenarios: number;
  outcome: string;
  productFailures: number;
  run: string;
}

interface TrialBlock {
  deployment: string;
  flag: boolean;
  lot: string;
  runs: TrialRun[];
}

const trial = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "historical/prevention-trial.json"),
    "utf8"
  )
) as {
  pr: string;
  model: string;
  build: string;
  flag: string;
  blocks: TrialBlock[];
};

const totals = (block: TrialBlock) => ({
  runs: block.runs.length,
  green: block.runs.filter((run) => run.outcome === "passed").length,
  scenarios: block.runs.reduce((sum, run) => sum + run.greenScenarios, 0),
  product: block.runs.reduce((sum, run) => sum + run.productFailures, 0),
});

describe("essai contrôlé du candidat de prévention", () => {
  it("les deux bras portent le même build et ne diffèrent que par le drapeau", () => {
    const arms = new Set(trial.blocks.map((block) => block.flag));
    expect([...arms].sort()).toEqual([false, true]);
    expect(new Set(trial.blocks.map((block) => block.deployment)).size).toBe(
      trial.blocks.length
    );
    for (const block of trial.blocks) {
      expect(block.runs.length).toBeGreaterThan(0);
      expect(new Set(block.runs.map((run) => run.run)).size).toBe(
        block.runs.length
      );
    }
    expect(trial.build).toHaveLength(40);
    expect(trial.flag).toBe("QA_PREVENT_MARKER_ORDER");
  });

  it("chaque run de l'essai est un verdict de run, pas un scénario isolé", () => {
    for (const block of trial.blocks) {
      for (const run of block.runs) {
        expect(["passed", "failed", "blocked"], run.run).toContain(run.outcome);
        expect(run.greenScenarios).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(run.codes)).toBe(true);
      }
    }
  });

  it("le doublon ne change rien sur ce lot, et l'essai ne conclut pas sur la prévention", () => {
    // Constat mesuré, écrit tel quel : à n = 5 par bras, aucune différence
    // n'apparaît entre les deux réglages du doublon, et un run est bloqué par le
    // refus de lecture alors que ses dix scénarios ont passé — un coût que le
    // drapeau ne modifie pas. L'assertion fige la mesure pour qu'aucune
    // réécriture ne la présente comme un gain ni comme une réfutation.
    const [off, on] = trial.blocks;
    const without = totals(off as TrialBlock);
    const withPrevention = totals(on as TrialBlock);
    expect(without.green).toBe(5);
    expect(withPrevention.green).toBe(4);
    expect(withPrevention.green).toBeLessThanOrEqual(without.green);
    const refused = (on as TrialBlock).runs.filter((run) =>
      run.codes.includes("MARKER_ORDER_UNREACHABLE")
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.greenScenarios).toBe(10);
  });
});
