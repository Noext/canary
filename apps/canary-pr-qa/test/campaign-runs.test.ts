import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Les campagnes, citées **par identifiant de run** : `campaign-runs.json` porte les
 * 181 runs observés (id, horodatage, verdict, scénarios verts, échecs produit,
 * tokens, diagnostics), et `interleaved.json` n'est plus qu'un agrégat recalculable.
 * Ce test recalcule chaque ligne d'agrégat depuis les runs : un chiffre tapé à la
 * main qui divergerait des artefacts fait échouer la CI.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) =>
  readFileSync(join(here, "historical", name), "utf8");
const runs = JSON.parse(read("campaign-runs.json")) as {
  batch: string | null;
  build: string;
  createdAt: string;
  assertions: number;
  greenScenarios: number;
  preMatchedAssertions: number;
  outcome: string;
  productFailures: number;
  run: string;
  tokens: number;
}[];
const batches = JSON.parse(read("interleaved.json")) as {
  batch: string;
  build: string;
  green: number;
  phase: string;
  product: number;
  runIds: string[];
  runs: number;
  tokens: number;
  verts: number;
}[];

const sum = (
  rows: typeof runs,
  key: "greenScenarios" | "productFailures" | "tokens"
) => rows.reduce((total, row) => total + row[key], 0);

describe("campagnes citées par identifiant de run", () => {
  it("couvre 181 runs, tous identifiés et horodatés", () => {
    expect(runs).toHaveLength(181);
    expect(new Set(runs.map((r) => r.run)).size).toBe(181);
    expect(runs.every((r) => r.createdAt && r.build)).toBe(true);
  });

  it("recalcule chaque agrégat depuis les runs, sans valeur tapée à la main", () => {
    for (const batch of batches) {
      const own = runs.filter((r) => (r.batch ?? "BA") === batch.batch);
      expect(own.map((r) => r.run).sort(), batch.batch).toEqual(
        [...batch.runIds].sort()
      );
      expect(own.length, batch.batch).toBe(batch.runs);
      expect(
        own.filter((r) => r.outcome === "passed").length,
        batch.batch
      ).toBe(batch.verts);
      expect(sum(own, "greenScenarios"), batch.batch).toBe(batch.green);
      expect(sum(own, "productFailures"), batch.batch).toBe(batch.product);
      expect(sum(own, "tokens"), batch.batch).toBe(batch.tokens);
    }
  });

  it("mesure les faux verts : assertions déjà satisfaites avant leur étape", () => {
    // Un faux vert potentiel = une assertion dont la valeur satisfaisait déjà
    // l'attendu avant l'étape qu'elle prétend prouver. Le compte est stocké par
    // run, pas seulement publié en prose.
    const current = runs.filter((r) => ["SS", "UU"].includes(r.batch ?? ""));
    const assertions = current.reduce((t, r) => t + r.assertions, 0);
    const preMatched = current.reduce((t, r) => t + r.preMatchedAssertions, 0);
    expect(assertions).toBe(996);
    expect(preMatched).toBe(173);
    // La référence ne porte pas le champ (il n'existait pas) : 0 n'est pas un
    // résultat, c'est une absence, et le test le dit explicitement.
    const baseline = runs.filter((r) =>
      ["JJ", "NN", "TT"].includes(r.batch ?? "")
    );
    expect(baseline.every((r) => r.preMatchedAssertions === 0)).toBe(true);
  });

  it("public les trois périmètres avec leurs propres identifiants", () => {
    const of = (phase: string) => batches.filter((b) => b.phase === phase);
    const verts = (phase: string) => of(phase).reduce((t, b) => t + b.verts, 0);
    const count = (phase: string) => of(phase).reduce((t, b) => t + b.runs, 0);
    // Référence : 17/30 (57 %). Build courant : 18/20 (90 %).
    expect([verts("baseline"), count("baseline")]).toEqual([17, 30]);
    expect([verts("current"), count("current")]).toEqual([18, 20]);
    // Chaque lot du build courant porte ses identifiants, aucun agrégat anonyme.
    expect(of("current").every((b) => b.runIds.length === b.runs)).toBe(true);
  });
});
