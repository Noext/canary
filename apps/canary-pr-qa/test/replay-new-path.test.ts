import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { provenanceRefusals } from "../src/plan-evidence.js";
import type { Plan } from "../src/schema.js";

/**
 * Rejeu des 79 plans historiques sur le nouveau chemin.
 *
 * Le contrat du moteur a une forme précise : ce qui n'est pas déclaré n'est pas
 * refusé — l'absence de preuve est publiée et comptée —, mais ce qui est déclaré
 * est contrôlé. Le rejeu mesure donc trois choses sur des plans réels :
 *
 * 1. sans déclaration, aucun refus (ils s'exécutent, et le rapport les marque
 *    non prouvés) ;
 * 2. en déclarant un indice arbitraire, les refus apparaissent : l'indice seul
 *    ne suffit pas, la valeur doit être justifiée par la ligne citée ;
 * 3. en cherchant l'exigence qui porte réellement la valeur, on mesure combien
 *    d'attendus n'en ont aucune — c'est la distance entre ces plans et une
 *    provenance vérifiable.
 */
const here = join(import.meta.dirname, "historical");
const artifactPath = join(here, "replay-new-path.json");

const stored = JSON.parse(
  gunzipSync(readFileSync(join(here, "plans.json.gz"))).toString("utf8")
) as { batch: string; run: string; outcome: string; plan: Plan }[];

const words = (text: string) =>
  new Set(
    fold(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4)
  );

function fold(text: string) {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

const expectedOf = (assertion: unknown): string => {
  const value = (assertion as { expected?: unknown }).expected;
  return typeof value === "string" ? value : "";
};

const cite = (plan: Plan, pick: "zero" | "value"): Plan => {
  const clone = structuredClone(plan);
  for (const scenario of clone.scenarios) {
    scenario.objective = scenario.assertions.at(-1)?.id;
    for (const assertion of scenario.assertions) {
      if (pick === "zero") {
        assertion.requirement = 0;
        continue;
      }
      const target = words(expectedOf(assertion));
      const index = scenario.requirements.findIndex((requirement) => {
        const source = words(
          `${requirement.quote ?? ""} ${requirement.behavior ?? ""}`
        );
        return [...target].some((word) => source.has(word));
      });
      if (index >= 0) {
        assertion.requirement = index;
      }
    }
  }
  return clone;
};

const unjustified = (plan: Plan): number => {
  let count = 0;
  for (const scenario of plan.scenarios) {
    for (const assertion of scenario.assertions) {
      const target = words(expectedOf(assertion));
      const matched = scenario.requirements.some((requirement) => {
        const source = words(
          `${requirement.quote ?? ""} ${requirement.behavior ?? ""}`
        );
        return [...target].some((word) => source.has(word));
      });
      if (!matched) {
        count += 1;
      }
    }
  }
  return count;
};

const rows = stored.map((entry) => ({
  batch: entry.batch,
  run: entry.run,
  outcome: entry.outcome,
  scenarios: entry.plan.scenarios.length,
  assertions: entry.plan.scenarios.reduce(
    (sum, scenario) => sum + scenario.assertions.length,
    0
  ),
  assertionsWithoutJustifyingRequirement: unjustified(entry.plan),
  refusalsUndeclared: provenanceRefusals(entry.plan).length,
  refusalsIndexZero: provenanceRefusals(cite(entry.plan, "zero")).length,
  refusalsValueGuided: provenanceRefusals(cite(entry.plan, "value")).length,
}));

const totals = {
  plans: rows.length,
  scenarios: rows.reduce((sum, row) => sum + row.scenarios, 0),
  assertions: rows.reduce((sum, row) => sum + row.assertions, 0),
  assertionsWithoutJustifyingRequirement: rows.reduce(
    (sum, row) => sum + row.assertionsWithoutJustifyingRequirement,
    0
  ),
  refusalsUndeclared: rows.reduce(
    (sum, row) => sum + row.refusalsUndeclared,
    0
  ),
  refusalsIndexZero: rows.reduce((sum, row) => sum + row.refusalsIndexZero, 0),
  refusalsValueGuided: rows.reduce(
    (sum, row) => sum + row.refusalsValueGuided,
    0
  ),
};

if (process.env.UPDATE_REPLAY === "1") {
  writeFileSync(
    artifactPath,
    `${JSON.stringify(
      {
        note: "Rejeu des 79 plans stockés : ce que le moteur refuse selon la provenance déclarée.",
        totals,
        rows,
      },
      null,
      1
    )}\n`
  );
}

const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
  totals: typeof totals;
  rows: typeof rows;
};

describe("rejeu des plans historiques sur le nouveau chemin", () => {
  it("sans déclaration, le moteur ne refuse rien : il instrumente", () => {
    expect(totals.plans).toBe(79);
    expect(totals.refusalsUndeclared).toBe(0);
    expect(totals.scenarios).toBe(681);
  });

  it("un indice arbitraire ne suffit pas : la valeur doit être justifiée", () => {
    expect(totals.refusalsIndexZero).toBeGreaterThan(0);
  });

  it("mesure la distance entre ces plans et une provenance vérifiable", () => {
    // Beaucoup d'attendus n'ont aucune exigence qui porte leur valeur : c'est la
    // cause racine, chiffrée sur des plans réels.
    expect(totals.assertionsWithoutJustifyingRequirement).toBeGreaterThan(1000);
    expect(totals.refusalsValueGuided).toBe(11);
  });

  it("l'artefact porte une ligne par plan, recalculable", () => {
    expect(artifact.rows).toHaveLength(79);
    expect(artifact.totals).toEqual(totals);
    for (const [index, row] of artifact.rows.entries()) {
      expect(row.run).toBe(rows[index]?.run);
      expect(row.refusalsIndexZero).toBe(rows[index]?.refusalsIndexZero);
    }
  });
});
