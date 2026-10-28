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
  runsWithReport: number;
  scenarios: number;
  nonGreenScenarios: number;
  codes: Record<string, number>;
};
const corpus = JSON.parse(
  readFileSync(join(here, "campaign-runs.json"), "utf8")
) as { run: string }[];
const doc = readFileSync(
  join(import.meta.dirname, "../../../docs/pr-qa-reliability-decision.md"),
  "utf8"
).replace(/\s+/g, " ");

describe("fréquences par scénario, seconde source", () => {
  it("la couverture est celle du corpus, et les comptes se recoupent", () => {
    expect(corpus.length).toBe(200);
    expect(report.runsWithReport).toBeGreaterThan(90);
    expect(report.runsWithReport).toBeLessThanOrEqual(corpus.length);
    expect(report.scenarios).toBeGreaterThan(500);
    const total = Object.values(report.codes).reduce(
      (sum, count) => sum + count,
      0
    );
    expect(total).toBe(report.nonGreenScenarios);
  });

  it("le document publie les trois premières familles de cette source", () => {
    for (const code of [
      "TARGET_NOT_FOUND",
      "MARKER_ORDER_UNREACHABLE",
      "TRANSITION_NOT_OBSERVED",
    ]) {
      expect(report.codes[code], code).toBeGreaterThan(0);
      expect(doc, code).toContain(`\`${code}\` **${report.codes[code]}**`);
    }
    expect(doc).toContain(`${report.runsWithReport} des 200 runs`);
    expect(doc).toContain(`${report.scenarios} scénarios`);
  });

  it("la couverture est dite, jamais présentée comme complète", () => {
    expect(report.runsWithReport).toBeLessThan(corpus.length);
    expect(doc).toContain("ne couvrent pas le même sous-ensemble");
  });
});
