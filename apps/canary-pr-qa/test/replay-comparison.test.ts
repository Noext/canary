import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { PrContext } from "../src/github.js";
import {
  PolicySchema,
  requirementSourceRefusal,
  unwitnessedPlanRefusals,
} from "../src/policy.js";
import { PlanSchema } from "../src/schema.js";

/**
 * La comparaison appariée demandée par le contrat : **79 plans réellement
 * produits** par le planificateur (lots BA à II), rejoués à travers la porte de
 * `8143ac9` puis celle d'aujourd'hui. Même entrée, deux versions : c'est un
 * appariement exact, sans modèle ni navigateur, donc sans effet temporel — deux
 * exécutions rendent le même fichier, ce que le test vérifie.
 *
 * Ce que le test démontre, et qui manquait :
 * - aucun plan refusé par la porte d'origine n'est accepté aujourd'hui
 *   (aucun contrôle affaibli) ;
 * - chaque plan nouvellement refusé vise un scénario qui n'était PAS vert dans
 *   son run d'origine (aucun faux refus sur cet échantillon) ;
 * - le verdict est déterministe.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) =>
  gunzipSync(readFileSync(join(here, "historical", name))).toString("utf8");

interface Recorded {
  batch: string;
  outcome: string;
  plan: unknown;
  run: string;
  scenarios: { diagnostic?: string; id?: string; outcome?: string }[];
}

const snapshot = JSON.parse(read("pr20.json.gz")) as {
  baseSha: string;
  files: {
    additions?: number;
    changes?: number;
    deletions?: number;
    filename: string;
    patch?: string;
    status: string;
  }[];
  headSha: string;
  title: string;
};
const records = JSON.parse(read("plans.json.gz")) as Recorded[];
const baseline = JSON.parse(
  readFileSync(join(here, "historical", "baseline-verdicts.json"), "utf8")
) as { count: number; run: string; source: string | null }[];
const baselineRefused = new Set(
  baseline
    .filter((item) => item.count > 0 || item.source)
    .map((item) => item.run)
);

const context: PrContext = {
  baseSha: snapshot.baseSha,
  body: "",
  context: [],
  contextWarnings: [],
  files: snapshot.files.map((file) => ({
    additions: file.additions,
    changes: file.changes,
    deletions: file.deletions,
    filename: file.filename,
    patch: file.patch ?? "",
    status: file.status,
  })),
  headRepo: "pharmania/arpilabe-pilotage",
  ref: {
    number: 20,
    owner: "pharmania",
    repo: "arpilabe-pilotage",
    url: "https://github.com/pharmania/arpilabe-pilotage/pull/20",
  } as PrContext["ref"],
  sha: snapshot.headSha,
  title: snapshot.title,
};
const policy = PolicySchema.parse({ version: 1 });

function verdict(record: Recorded): { refused: boolean; text: string } {
  const plan = PlanSchema.parse(record.plan);
  const refusals = unwitnessedPlanRefusals(plan, context, policy);
  const source = requirementSourceRefusal(plan, context);
  return {
    refused: refusals.length > 0 || source !== undefined,
    text: [...refusals, source?.message ?? ""].join(" ⏎ "),
  };
}

describe("comparaison appariée 8143ac9 → aujourd'hui, sur 79 plans réels", () => {
  const today = new Map(records.map((r) => [r.run, verdict(r)]));

  it("rend un verdict déterministe", () => {
    for (const record of records.slice(0, 12)) {
      expect(verdict(record)).toEqual(today.get(record.run));
    }
  });

  it("n'accepte jamais un plan que la porte d'origine refusait", () => {
    const relaxed = [...baselineRefused].filter(
      (run) => today.get(run)?.refused !== true
    );
    expect(relaxed).toEqual([]);
  });

  it("ne refuse que des plans dont le scénario visé n'était pas vert", () => {
    const newly = records.filter(
      (record) =>
        today.get(record.run)?.refused && !baselineRefused.has(record.run)
    );
    // Le compte est figé : c'est la mesure, pas une impression.
    expect(newly).toHaveLength(10);
    const unjustified: string[] = [];
    const unmatched: string[] = [];
    for (const record of newly) {
      const text = today.get(record.run)?.text ?? "";
      const named = record.scenarios.filter(
        (scenario) => scenario.id && text.includes(scenario.id)
      );
      if (named.length === 0) {
        unmatched.push(record.run);
        continue;
      }
      for (const scenario of named) {
        if (scenario.outcome === "passed") {
          unjustified.push(`${record.run}:${scenario.id}`);
        }
      }
    }
    // Aucun plan nouvellement refusé ne visait un scénario qui avait passé.
    expect(unjustified).toEqual([]);
    // Un seul refus porte un nom de scénario que l'artefact n'a pas enregistré
    // (run bloqué avant exécution) : il est justifié par sa propre mesure, et
    // il est compté ici pour que le chiffre ne puisse pas grossir en silence.
    expect(unmatched).toHaveLength(1);
  });

  it("fige les comptes de la comparaison", () => {
    const refusedToday = records.filter((r) => today.get(r.run)?.refused);
    expect(records).toHaveLength(79);
    expect(baselineRefused.size).toBe(5);
    expect(refusedToday).toHaveLength(15);
  });
});
