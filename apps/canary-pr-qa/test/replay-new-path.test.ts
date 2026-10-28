import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { provenanceRefusals } from "../src/plan-evidence.js";
import type { Plan } from "../src/schema.js";

/**
 * Rejeu des 79 plans historiques sur le chemin observe→act.
 *
 * Ce que le rejeu peut établir sans navigateur : la couverture des preuves que
 * le nouveau chemin exige. Les plans stockés précèdent les champs `objective` et
 * `requirement`, donc ils sont tous refusés à la lecture — c'est le résultat
 * attendu, et il dit une chose utile : le chemin ne peut pas rejouer un plan
 * ancien, il exige que le planificateur produise la provenance.
 *
 * Le contrôle qui compte est le second : quand on remplit ces deux champs, les
 * mêmes plans repassent la porte sans nouveau refus. La provenance est donc un
 * ajout isolé, pas un durcissement qui emporterait d'autres verdicts.
 */
const here = join(import.meta.dirname, "historical");
const artifactPath = join(here, "replay-new-path.json");

const stored = JSON.parse(
  gunzipSync(readFileSync(join(here, "plans.json.gz"))).toString("utf8")
) as {
  batch: string;
  run: string;
  outcome: string;
  plan: Plan;
}[];

const filled = (plan: Plan): Plan => {
  const clone = structuredClone(plan);
  for (const scenario of clone.scenarios) {
    const last = scenario.assertions.at(-1);
    scenario.objective = last?.id;
    for (const assertion of scenario.assertions) {
      assertion.requirement = 0;
    }
  }
  return clone;
};

const rows = stored.map((entry) => {
  const before = provenanceRefusals(entry.plan, true);
  const after = provenanceRefusals(filled(entry.plan), true);
  return {
    batch: entry.batch,
    run: entry.run,
    outcome: entry.outcome,
    refusalCodesBefore: [...new Set(before.map((item) => item.error.code))],
    refusalsBefore: before.length,
    refusalsFilled: after.length,
    scenarios: entry.plan.scenarios.length,
  };
});

const totals = {
  plans: rows.length,
  plansRefusedBefore: rows.filter((row) => row.refusalsBefore > 0).length,
  plansRefusedFilled: rows.filter((row) => row.refusalsFilled > 0).length,
  refusalsBefore: rows.reduce((sum, row) => sum + row.refusalsBefore, 0),
  refusalsFilled: rows.reduce((sum, row) => sum + row.refusalsFilled, 0),
  scenarios: rows.reduce((sum, row) => sum + row.scenarios, 0),
};

if (process.env.UPDATE_REPLAY === "1") {
  writeFileSync(
    artifactPath,
    `${JSON.stringify({ note: "Rejeu des 79 plans stockés : couverture de provenance avant/après remplissage des deux champs.", totals, rows }, null, 1)}\n`
  );
}

const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
  totals: typeof totals;
  rows: typeof rows;
};

describe("rejeu des plans historiques sur le nouveau chemin", () => {
  it("les plans stockés n'ont aucune provenance : tous sont refusés à la lecture", () => {
    expect(totals.plans).toBe(79);
    expect(totals.plansRefusedBefore).toBe(79);
    expect(totals.refusalsBefore).toBeGreaterThanOrEqual(79);
    expect(artifact.totals).toEqual(totals);
  });

  it("remplir les deux champs suffit à repasser la porte, sans autre refus", () => {
    expect(totals.refusalsFilled).toBe(0);
    expect(totals.plansRefusedFilled).toBe(0);
  });

  it("l'artefact porte une ligne par plan, recalculable", () => {
    expect(artifact.rows).toHaveLength(79);
    for (const [index, row] of artifact.rows.entries()) {
      expect(row.run).toBe(rows[index]?.run);
      expect(row.refusalsBefore).toBe(rows[index]?.refusalsBefore);
      expect(row.refusalsFilled).toBe(rows[index]?.refusalsFilled);
    }
  });
});
