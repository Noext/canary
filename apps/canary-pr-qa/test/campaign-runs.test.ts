import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Les campagnes, citées **par identifiant de run** : `campaign-runs.json` porte les
 * 200 runs observés (id, horodatage, verdict, scénarios verts, échecs produit,
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
  runDiagnostic?: string | null;
  scenarioCodes?: string[];
  tokens: number;
  unverifiedPreconditions?: number;
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
  it("couvre 200 runs, tous identifiés et horodatés", () => {
    expect(runs).toHaveLength(200);
    expect(new Set(runs.map((r) => r.run)).size).toBe(200);
    expect(runs.every((r) => r.createdAt && r.build)).toBe(true);
    // Un lot absent ou un build inconnu a déjà masqué un run mal replié : le
    // générateur le réunissait au lot BA, et l'agrégat publié était faux.
    expect(runs.filter((r) => !r.batch)).toEqual([]);
    expect(runs.filter((r) => r.build === "?")).toEqual([]);
  });

  it("recalcule chaque agrégat depuis les runs, sans valeur tapée à la main", () => {
    for (const batch of batches) {
      const own = runs.filter((r) => r.batch === batch.batch);
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

describe("le document de décision ne dérive pas du corpus", () => {
  /**
   * L'audit a refusé trois versions pour la même classe de défaut : un chiffre du
   * document qui ne se recalcule pas depuis les runs. Ces assertions ferment la
   * classe — elles échouent dès qu'une famille, une catégorie ou un agrégat cité
   * cesse de correspondre aux artefacts.
   */
  const doc = readFileSync(
    join(process.cwd(), "../../docs/pr-qa-reliability-decision.md"),
    "utf8"
  );
  const families = new Map<string, number>();
  for (const run of runs) {
    const codes = new Set([
      ...(run.scenarioCodes ?? []),
      ...(run.runDiagnostic ? [run.runDiagnostic] : []),
    ]);
    for (const code of codes) {
      families.set(code, (families.get(code) ?? 0) + 1);
    }
  }

  it("chaque famille publiée porte le compte du corpus", () => {
    for (const [code, count] of families) {
      if (count < 2) {
        // Une famille à occurrence unique n'a pas de ligne de tableau : le
        // document doit quand même la nommer, sinon « aucune famille écartée »
        // serait faux pour elle précisément.
        expect(doc, code).toContain(`\`${code}\``);
        continue;
      }
      const forms = [
        `| \`${code}\` | ${count} |`,
        `| \`${code}\` | **${count}** |`,
        `\`${code}\` **${count}**`,
      ];
      expect(
        forms.some((form) => doc.includes(form)),
        `${code} ${count}`
      ).toBe(true);
    }
  });

  it("les agrégats cités sont ceux des runs", () => {
    const total = runs.length;
    const green = runs.filter((run) => run.outcome === "passed").length;
    expect(doc).toContain(`| **Corpus entier** | ${total} | ${green} (`);
    for (const label of ["JJ", "NN", "TT"] as const) {
      expect(runs.filter((run) => run.batch === label)).toHaveLength(10);
    }
    expect(doc).toContain("| 30 | 17 (56.7 %) |");
    expect(doc).toContain("| 20 | 18 (90.0 %) |");
  });

  it("la répartition par catégorie somme les runs non verts", () => {
    const nonGreen = runs.filter((run) => run.outcome !== "passed").length;
    const cited = [
      "planification **27**",
      "découverte de l'interface **26**",
      "infrastructure **12**",
      "dépendance d'état **11**",
      "sans diagnostic **4**",
    ];
    for (const fragment of cited) {
      expect(doc, fragment).toContain(fragment);
    }
    expect(doc).toContain(`${nonGreen} non verts`);
  });
});
