import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Les fréquences par scénario, depuis les rapports encore joignables.
 *
 * Le corpus porte le verdict des 200 runs ; le diagnostic par scénario n'existe
 * que dans deux sources : les 79 plans stockés (BA→II) et les rapports de run
 * encore servis par le service. Le document publie les deux mesures au lieu de
 * fusionner deux sous-ensembles différents — et ce fichier les rend recalculables.
 */
const here = join(import.meta.dirname, "historical");
const report = JSON.parse(
  readFileSync(join(here, "report-scenarios.json"), "utf8")
) as {
  runs: {
    run: string;
    batch: string | null;
    scenarios: number;
    nonGreen: number;
    codes: Record<string, number>;
  }[];
  totals: {
    runsWithReport: number;
    scenarios: number;
    nonGreenScenarios: number;
    codes: Record<string, number>;
  };
};
const corpus = JSON.parse(
  readFileSync(join(here, "campaign-runs.json"), "utf8")
) as { run: string }[];
const doc = readFileSync(
  join(import.meta.dirname, "../../../docs/pr-qa-reliability-decision.md"),
  "utf8"
).replace(/\s+/g, " ");

describe("fréquences par scénario, seconde source", () => {
  it("chaque run publié appartient au corpus, et les totaux sont recalculés", () => {
    expect(corpus.length).toBe(200);
    const known = new Set(corpus.map((run) => run.run));
    for (const row of report.runs) {
      expect(known.has(row.run), row.run).toBe(true);
      const fromCodes = Object.values(row.codes).reduce(
        (sum, count) => sum + count,
        0
      );
      expect(fromCodes, row.run).toBe(row.nonGreen);
    }
    // Les totaux du fichier sont la somme de ses lignes, pas un chiffre posé.
    const scenarios = report.runs.reduce((sum, row) => sum + row.scenarios, 0);
    const nonGreen = report.runs.reduce((sum, row) => sum + row.nonGreen, 0);
    const codes: Record<string, number> = {};
    for (const row of report.runs) {
      for (const [code, count] of Object.entries(row.codes)) {
        codes[code] = (codes[code] ?? 0) + count;
      }
    }
    expect(report.totals.runsWithReport).toBe(report.runs.length);
    expect(report.totals.scenarios).toBe(scenarios);
    expect(report.totals.nonGreenScenarios).toBe(nonGreen);
    expect(report.totals.codes).toEqual(codes);
    expect(report.totals.runsWithReport).toBeLessThan(corpus.length);
  });

  it("le document publie les trois premières familles de cette source", () => {
    for (const code of [
      "TARGET_NOT_FOUND",
      "MARKER_ORDER_UNREACHABLE",
      "TRANSITION_NOT_OBSERVED",
    ]) {
      expect(report.totals.codes[code], code).toBeGreaterThan(0);
      expect(doc, code).toContain(
        `\`${code}\` **${report.totals.codes[code]}**`
      );
    }
    expect(doc).toContain(`${report.totals.runsWithReport} des 200 runs`);
    expect(doc).toContain(`${report.totals.scenarios} scénarios`);
  });

  it("la couverture est dite, jamais présentée comme complète", () => {
    expect(report.totals.runsWithReport).toBeLessThan(corpus.length);
    expect(doc).toContain("ne couvrent pas le même sous-ensemble");
  });
});
