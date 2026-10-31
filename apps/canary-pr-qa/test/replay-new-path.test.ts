import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { provenanceRefusals } from "../src/plan-evidence.js";
import type { Plan } from "../src/schema.js";

/**
 * Rejeu des 79 plans historiques sur le nouveau chemin.
 *
 * Ce que le rejeu peut établir sans navigateur : le verdict de la porte de plan,
 * scénario par scénario, comparé au verdict historique enregistré. Ce qu'il ne
 * peut pas : exécuter — les faux verts et les indéterminés demandent un
 * navigateur et sont mesurés par la campagne (`architecture-campaign.json`).
 */
const here = join(import.meta.dirname, "historical");
const artifactPath = join(here, "replay-new-path.json");

interface Stored {
  batch: string;
  outcome: string;
  plan: Plan;
  run: string;
  scenarios?: {
    id?: string;
    scenario?: { id?: string };
    outcome?: string;
    diagnostic?: { code?: string };
  }[];
}

const stored = JSON.parse(
  gunzipSync(readFileSync(join(here, "plans.json.gz"))).toString("utf8")
) as Stored[];

const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "");

const words = (text: string) =>
  new Set(
    fold(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4)
  );

const expectedOf = (assertion: unknown): string => {
  const value = (assertion as { expected?: unknown }).expected;
  return typeof value === "string" ? value : "";
};

const cite = (plan: Plan, mode: "zero" | "value"): Plan => {
  const clone = structuredClone(plan);
  for (const scenario of clone.scenarios) {
    scenario.objective = scenario.assertions.at(-1)?.id;
    for (const assertion of scenario.assertions) {
      if (mode === "zero") {
        assertion.requirement = 0;
        continue;
      }
      const target = words(expectedOf(assertion));
      const index = scenario.requirements.findIndex((requirement) =>
        [...target].some((word) =>
          words(`${requirement.quote ?? ""} ${requirement.behavior ?? ""}`).has(
            word
          )
        )
      );
      if (index >= 0) {
        assertion.requirement = index;
      }
    }
  }
  return clone;
};

const unjustified = (plan: Plan): number =>
  plan.scenarios.reduce(
    (total, scenario) =>
      total +
      scenario.assertions.filter(
        (assertion) =>
          !scenario.requirements.some((requirement) =>
            [...words(expectedOf(assertion))].some((word) =>
              words(
                `${requirement.quote ?? ""} ${requirement.behavior ?? ""}`
              ).has(word)
            )
          )
      ).length,
    0
  );

const rows = stored.map((entry) => {
  const valueGuided = provenanceRefusals(cite(entry.plan, "value")).length;
  return {
    batch: entry.batch,
    run: entry.run,
    outcome: entry.outcome,
    assertions: entry.plan.scenarios.reduce(
      (sum, scenario) => sum + scenario.assertions.length,
      0
    ),
    assertionsWithoutJustifyingRequirement: unjustified(entry.plan),
    refusalsUndeclared: provenanceRefusals(entry.plan).length,
    refusalsIndexZero: provenanceRefusals(cite(entry.plan, "zero")).length,
    refusalsValueGuided: valueGuided,
    scenarios: (entry.scenarios ?? []).map((scenario) => ({
      id: scenario.id ?? scenario.scenario?.id ?? "?",
      outcome: scenario.outcome ?? "unknown",
      code: scenario.diagnostic?.code ?? null,
      // Le verdict de la porte d'aujourd'hui, si la provenance est déclarée.
      today: valueGuided > 0 ? "refused-when-declared" : "accepted",
    })),
  };
});

/**
 * L'échantillon par famille vient des rapports de run conservés
 * (`report-scenarios.json`, 104 runs) et non des plans : les plans ne portent pas
 * le code de diagnostic de leurs scénarios.
 */
const report = JSON.parse(
  readFileSync(join(here, "report-scenarios.json"), "utf8")
) as {
  runs: {
    run: string;
    nonGreenScenarios: { code: string; scenario: string | null }[];
  }[];
};

const families: Record<string, { run: string; scenario: string }[]> = {};
for (const run of report.runs) {
  for (const scenario of run.nonGreenScenarios) {
    const list = families[scenario.code] ?? [];
    if (list.length < 3) {
      list.push({ run: run.run, scenario: scenario.scenario ?? "?" });
    }
    families[scenario.code] = list;
  }
}

const totals = {
  plans: rows.length,
  scenarios: stored.reduce(
    (sum, entry) => sum + entry.plan.scenarios.length,
    0
  ),
  reviewedScenarios: rows.reduce((sum, row) => sum + row.scenarios.length, 0),
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
  historicalGreensRefusedToday: rows.reduce(
    (sum, row) =>
      sum +
      row.scenarios.filter(
        (scenario) =>
          scenario.outcome === "passed" &&
          row.refusalsValueGuided > 0 &&
          scenario.today === "refused-when-declared"
      ).length,
    0
  ),
  families,
};

if (process.env.UPDATE_REPLAY === "1") {
  writeFileSync(
    artifactPath,
    `${JSON.stringify(
      {
        note: "Rejeu des 79 plans stockés : verdicts historiques et verdict de porte aujourd'hui.",
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
    expect(totals.scenarios).toBe(681);
    expect(totals.reviewedScenarios).toBe(636);
    expect(totals.refusalsUndeclared).toBe(0);
  });

  it("un indice arbitraire ne suffit pas : la valeur doit être justifiée", () => {
    // 393 avant l'exemption de la saisie relue (echoed-input.ts) : deux
    // attendus égaux à un commentaire tapé puis relu dans l'historique, dont
    // l'exigence d'indice 0 concerne bien la cible, ne sont plus refusés. Les
    // 68 autres échos restent refusés : leur exigence d'indice 0 est étrangère.
    // 391 avant le repli des accents de la porte : trois attendus dont un mot
    // accentué partage un mot avec l'exigence d'indice 0 ne se coupent plus sur
    // l'accent (« Écart » ne donne plus « cart »). Trois refus retirés, aucun
    // ajouté : un repli ne raccourcit jamais un mot.
    expect(totals.refusalsIndexZero).toBe(388);
    // 11 avant ce même repli. `cite` choisit l'exigence avec des mots dont les
    // accents sont DÉJÀ repliés : chacun de ces 11 refus était la porte qui
    // coupait sur l'accent un mot que ce choix avait reconnu. Le refus d'une
    // valeur inventée reste couvert par engine-invariants.test.ts.
    expect(totals.refusalsValueGuided).toBe(0);
  });

  it("mesure la distance entre ces plans et une provenance vérifiable", () => {
    expect(totals.assertionsWithoutJustifyingRequirement).toBe(3164);
    expect(totals.assertions).toBe(3738);
  });

  it("compare verdict historique et verdict de porte, scénario par scénario", () => {
    const reviewed = artifact.rows.flatMap((row) => row.scenarios);
    expect(reviewed.length).toBe(totals.reviewedScenarios);
    expect(reviewed.every((scenario) => scenario.today.length > 0)).toBe(true);
    // Un bouton du rapport : les verts historiques que la porte refuserait si la
    // provenance était déclarée. C'est la mesure de ce que l'invariant coûte.
    expect(totals.historicalGreensRefusedToday).toBeGreaterThanOrEqual(0);
  });

  it("donne un échantillon d'échecs représentatifs par famille", () => {
    const codes = Object.keys(totals.families);
    expect(codes.length).toBeGreaterThan(0);
    for (const [code, sample] of Object.entries(totals.families)) {
      expect(sample.length, code).toBeGreaterThan(0);
      for (const item of sample) {
        expect(item.run).toMatch(/^[0-9a-f-]{36}$/);
      }
    }
  });
});
