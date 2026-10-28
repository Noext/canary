import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Les fréquences par scénario, depuis les rapports encore joignables.
 *
 * Le corpus porte le verdict des 200 runs ; le diagnostic par scénario n'existe
 * que dans deux sources : les 79 plans stockés (BA→II) et les rapports de run
 * encore servis. Chaque scénario non vert est stocké comme un enregistrement
 * (identifiant, verdict, code, refus avant exécution), et les totaux publiés se
 * recalculent depuis ces enregistrements — pas depuis un compteur posé à la main.
 */
const here = join(import.meta.dirname, "historical");
interface Record {
  code: string;
  outcome: string;
  refusedBeforeExecution: boolean;
  scenario: string | null;
}
interface RunRow {
  batch: string | null;
  nonGreenScenarios: Record[];
  outcome: string;
  run: string;
  scenarios: number;
}

const report = JSON.parse(
  readFileSync(join(here, "report-scenarios.json"), "utf8")
) as { runs: RunRow[] };
const corpus = JSON.parse(
  readFileSync(join(here, "campaign-runs.json"), "utf8")
) as { run: string }[];
const doc = readFileSync(
  join(import.meta.dirname, "../../../docs/pr-qa-reliability-decision.md"),
  "utf8"
).replace(/\s+/g, " ");

const codes = new Map<string, number>();
for (const row of report.runs) {
  for (const record of row.nonGreenScenarios) {
    codes.set(record.code, (codes.get(record.code) ?? 0) + 1);
  }
}
const totalScenarios = report.runs.reduce((sum, row) => sum + row.scenarios, 0);
const totalNonGreen = report.runs.reduce(
  (sum, row) => sum + row.nonGreenScenarios.length,
  0
);

describe("fréquences par scénario, seconde source", () => {
  it("chaque run publié appartient au corpus, sans doublon", () => {
    const known = new Set(corpus.map((run) => run.run));
    const seen = new Set<string>();
    for (const row of report.runs) {
      expect(known.has(row.run), row.run).toBe(true);
      expect(seen.has(row.run), row.run).toBe(false);
      seen.add(row.run);
    }
    expect(seen.size).toBeLessThan(corpus.length);
  });

  it("les comptes se dérivent des enregistrements de scénario", () => {
    expect(totalScenarios).toBe(863);
    expect(totalNonGreen).toBe(60);
    expect(codes.get("TARGET_NOT_FOUND")).toBe(28);
    expect(codes.get("MARKER_ORDER_UNREACHABLE")).toBe(13);
    expect(codes.get("TRANSITION_NOT_OBSERVED")).toBe(4);
    // Aucun enregistrement ne prétend être vert : la source ne stocke que les
    // scénarios non verts, ce qui doit rester vrai.
    for (const row of report.runs) {
      for (const record of row.nonGreenScenarios) {
        expect(record.outcome, record.code).not.toBe("passed");
      }
    }
  });

  it("le document publie cette source, avec sa couverture", () => {
    expect(doc).toContain(`${report.runs.length} des 200 runs`);
    expect(doc).toContain(`${totalScenarios} scénarios`);
    for (const code of [
      "TARGET_NOT_FOUND",
      "MARKER_ORDER_UNREACHABLE",
      "TRANSITION_NOT_OBSERVED",
    ]) {
      expect(doc, code).toContain(`\`${code}\` **${codes.get(code)}**`);
    }
    expect(doc).toContain("ne couvrent pas le même sous-ensemble");
  });
});
