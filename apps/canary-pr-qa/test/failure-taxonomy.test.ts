import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La taxonomie publiée, recalculée.
 *
 * Le document se présentait comme « recalculé par les tests » alors qu'aucun test
 * ne le lisait : l'audit l'a relevé, avec deux chiffres faux à l'appui. Ce test
 * ferme la classe — toute ligne de famille ou de catégorie qui diverge du corpus
 * fait échouer la CI.
 */
const here = join(import.meta.dirname, "historical");
interface CorpusRun {
  batch: string;
  outcome: string;
  run: string;
  runDiagnostic?: string | null;
  scenarioCodes?: string[];
}

const corpus = JSON.parse(
  readFileSync(join(here, "campaign-runs.json"), "utf8")
) as CorpusRun[];
const taxonomy = readFileSync(
  join(import.meta.dirname, "../../../docs/pr-qa-failure-taxonomy.md"),
  "utf8"
);

const families = new Map<string, { runs: number; lots: Set<string> }>();
for (const run of corpus) {
  const codes = new Set([
    ...(run.scenarioCodes ?? []),
    ...(run.runDiagnostic ? [run.runDiagnostic] : []),
  ]);
  if (codes.size === 0 && run.outcome !== "passed") {
    codes.add("sans-diagnostic");
  }
  for (const code of codes) {
    const entry = families.get(code) ?? { runs: 0, lots: new Set<string>() };
    entry.runs += 1;
    entry.lots.add(run.batch);
    families.set(code, entry);
  }
}

const INFRA = new Set(["QA_ERROR", "RUN_BUDGET_EXCEEDED", "HTTP_502"]);
const DISCOVERY = new Set(["TARGET_NOT_FOUND", "PLAN_SELECTOR_UNSTABLE"]);
const STATE = new Set(["TRANSITION_NOT_OBSERVED", "TRANSITION_ON_INVARIANT"]);

/** La catégorie d'un run non vert, avec la priorité écrite dans la taxonomie. */
function bucketOf(codes: Set<string>): string {
  if (codes.size === 0) {
    return "sans diagnostic";
  }
  if ([...codes].some((code) => INFRA.has(code))) {
    return "infrastructure";
  }
  if ([...codes].some((code) => DISCOVERY.has(code))) {
    return "découverte de l'interface";
  }
  if ([...codes].some((code) => STATE.has(code))) {
    return "dépendance d'état";
  }
  return "planification";
}

const categories = new Map<string, number>();
for (const run of corpus) {
  if (run.outcome === "passed") {
    continue;
  }
  const codes = new Set([
    ...(run.scenarioCodes ?? []),
    ...(run.runDiagnostic ? [run.runDiagnostic] : []),
  ]);
  const bucket = bucketOf(codes);
  categories.set(bucket, (categories.get(bucket) ?? 0) + 1);
}

describe("la taxonomie publiée est recalculable depuis le corpus", () => {
  it("chaque famille porte le nombre de runs et les lots du corpus", () => {
    for (const [code, entry] of families) {
      const row = new RegExp(
        `^\\| \\\`${code}\\\` \\| ${entry.runs} \\| ([^|]+)\\|`,
        "m"
      ).exec(taxonomy);
      expect(row, code).not.toBeNull();
      const lots = (row?.[1] ?? "").split(",").map((lot) => lot.trim());
      for (const lot of entry.lots) {
        expect(lots, `${code} ${lot}`).toContain(lot);
      }
    }
  });

  it("la répartition par catégorie somme les runs non verts", () => {
    const nonGreen = corpus.filter((run) => run.outcome !== "passed").length;
    for (const [bucket, count] of categories) {
      const row = new RegExp(
        `^\\| [^|]*${bucket}[^|]*\\| ${count} \\|$`,
        "m"
      ).exec(taxonomy);
      expect(row, bucket).not.toBeNull();
    }
    expect(taxonomy).toContain(
      `Total des runs non verts : ${nonGreen} sur ${corpus.length}`
    );
  });

  it("la famille sans diagnostic ne porte aucun scénario", () => {
    // Les quatre runs sans code (JJ, MM, TT) n'ont aucun scénario diagnostiqué ;
    // le scénario sans code observé sur BA est un autre cas, et le confondre
    // attribuait un scénario à une famille qui n'en a pas.
    const row = /^\| `sans-diagnostic` \| 4 \|[^|]*\| (\d+) \|$/m.exec(
      taxonomy
    );
    expect(row).not.toBeNull();
    expect(Number(row?.[1])).toBe(0);
  });
});
