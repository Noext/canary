import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * L'essai contrôlé du 2026-10-27, dans un artefact versionné : même service, même
 * PR, même modèle, même oracle, deux lots dos à dos sur deux builds. Tous les
 * runs sont comptés — les échecs et les blocages compris — et le test recalcule
 * les agrégats publiés, pour qu'aucun lot défavorable ne puisse être retiré.
 */
interface PairRun {
  codes: string[];
  greenScenarios: number;
  outcome: string;
  productFailures: number;
  run: string;
  tokens: number;
}

const pair = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "historical/reliability-pair.json"),
    "utf8"
  )
) as {
  pr: string;
  blocks: { lot: string; build: string; runs: PairRun[] }[];
};

const total = (runs: PairRun[], key: keyof PairRun) =>
  runs.reduce((sum, run) => sum + (run[key] as number), 0);
const green = (runs: PairRun[]) =>
  runs.filter((run) => run.outcome === "passed").length;

describe("essai contrôlé baseline contre build courant", () => {
  it("les deux lots sont complets et de taille égale", () => {
    expect(pair.blocks).toHaveLength(2);
    const [base, current] = pair.blocks;
    expect(base?.runs).toHaveLength(10);
    expect(current?.runs).toHaveLength(10);
    expect(base?.build).toBe("8143ac9");
    expect(current?.build).toBe("e698deb");
    for (const block of pair.blocks) {
      expect(new Set(block.runs.map((run) => run.run)).size).toBe(
        block.runs.length
      );
      for (const run of block.runs) {
        expect(["passed", "failed", "blocked"], run.run).toContain(run.outcome);
        expect(run.tokens).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("recalcule les agrégats cités par le document", () => {
    const [base, current] = pair.blocks as [
      (typeof pair.blocks)[0],
      (typeof pair.blocks)[0],
    ];
    // Le document publie ces six nombres : 5/10 → 8/10, 80 scénarios de chaque
    // côté, 2 échecs produit de chaque côté, et le coût par run qui monte.
    expect(green(base.runs)).toBe(5);
    expect(green(current.runs)).toBe(8);
    expect(total(base.runs, "greenScenarios")).toBe(80);
    expect(total(current.runs, "greenScenarios")).toBe(80);
    expect(total(base.runs, "productFailures")).toBe(2);
    expect(total(current.runs, "productFailures")).toBe(2);
    const baseTokens = Math.round(total(base.runs, "tokens") / 10);
    const currentTokens = Math.round(total(current.runs, "tokens") / 10);
    expect(baseTokens).toBe(209_381);
    expect(currentTokens).toBe(303_470);
    // La hausse de coût est publiée comme une régression, pas passée sous silence.
    expect(currentTokens / baseTokens).toBeGreaterThan(1.2);
  });

  it("aucun run non vert n'est écarté du lot", () => {
    const [base, current] = pair.blocks;
    expect(base?.runs.filter((run) => run.outcome !== "passed")).toHaveLength(
      5
    );
    expect(
      current?.runs.filter((run) => run.outcome !== "passed")
    ).toHaveLength(2);
    const coded = (base?.runs ?? [])
      .flatMap((run) => run.codes)
      .filter((code) => code.length > 0);
    expect(coded).toContain("TRANSITION_ON_INVARIANT");
    expect(coded).toContain("TARGET_NOT_FOUND");
  });
});
