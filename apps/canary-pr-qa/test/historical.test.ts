import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type PrContext, parsePrUrl } from "../src/github.js";
import {
  PolicySchema,
  repairRequirementAttribution,
  requirementSourceRefusal,
  unwitnessedPlanRefusals,
} from "../src/policy.js";
import { type Plan, PlanSchema } from "../src/schema.js";

/**
 * Le harnais de rejeu historique : sept plans réellement produits par le
 * planificateur, rejoués contre la porte SANS génération LLM.
 *
 * Les fixtures portent ce que les runs ont laissé (`test/historical/cases.json`)
 * et un instantané du diff de la PR au SHA testé (`test/historical/pr20.json`).
 * Chaque cas est un défaut mesuré : le test dit quelle garantie le refuse
 * aujourd'hui, et ce que le défaut demandait.
 *
 * Aucun nom de l'application n'entre dans la *règle* : ces fixtures ne servent
 * qu'à prouver que les règles génériques attrapent des plans réels.
 */
const here = dirname(fileURLToPath(import.meta.url));

interface SnapshotFile {
  additions?: number;
  changes?: number;
  deletions?: number;
  filename: string;
  patch?: string;
  status: string;
}

interface Snapshot {
  baseSha: string;
  files: SnapshotFile[];
  headSha: string;
  number: number;
  title: string;
}

interface HistoricalCase {
  failing: {
    assertionResults?: unknown[];
    diagnostic?: { code?: string; hint?: string; message?: string } | null;
    id: string | null;
    outcome: string;
  }[];
  outcome: string;
  plan: { scenarios: Record<string, unknown>[]; summary: string };
  run: string;
  runDiagnostic?: { code?: string; hint?: string; message?: string } | null;
  sha: string;
}

const snapshot: Snapshot = JSON.parse(
  gunzipSync(readFileSync(join(here, "historical", "pr20.json.gz"))).toString(
    "utf8"
  )
);
const cases: Record<string, HistoricalCase> = JSON.parse(
  gunzipSync(readFileSync(join(here, "historical", "cases.json.gz"))).toString(
    "utf8"
  )
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
  ref: parsePrUrl("https://github.com/pharmania/arpilabe-pilotage/pull/20"),
  sha: snapshot.headSha,
  title: snapshot.title,
};
const policy = PolicySchema.parse({ version: 1 });

/**
 * Le plan complet du run : la porte l'a vu entier, donc le rejeu doit aussi.
 * Rejouer un seul scénario isolé rendrait fausses les obligations de couverture
 * que les autres scénarios satisfaisaient.
 */
function planOf(entry: HistoricalCase): Plan {
  return PlanSchema.parse({
    scenarios: entry.plan.scenarios.map((scenario) => ({
      preconditions: [],
      ...scenario,
    })),
    skipped: [],
    summary: entry.plan.summary,
  });
}

/**
 * Ce que la porte ferait de ce plan avant d'exécuter : la réparation
 * d'attribution d'abord (elle modifie le plan), puis le refus de source, puis
 * les refus de témoin, d'ordre des marqueurs et de longueur.
 */
function verdictOf(entry: HistoricalCase): {
  refusals: string[];
  repaired: string[];
  sourceRefusal?: string;
} {
  const plan = planOf(entry);
  const repaired = repairRequirementAttribution(plan, context).map(
    (repair) => `${repair.from} -> ${repair.to}`
  );
  const source = requirementSourceRefusal(plan, context);
  return {
    refusals: unwitnessedPlanRefusals(plan, context, policy),
    repaired,
    ...(source ? { sourceRefusal: source.message } : {}),
  };
}

describe("rejeu des plans historiques contre la porte, sans modèle", () => {
  it("expose les sept cas et leurs défauts d'origine", () => {
    expect(Object.keys(cases).sort()).toEqual([
      "24db19b8",
      "3c51455f",
      "790fde72",
      "afcc9846",
      "b933cf08",
      "dd1030c1",
      "f83f0762",
    ]);
    const codes = Object.values(cases).map(
      (entry) =>
        entry.runDiagnostic?.code ??
        entry.failing[0]?.diagnostic?.code ??
        entry.failing[0]?.outcome
    );
    expect(codes.filter(Boolean).length).toBe(7);
  });

  /**
   * Les verdicts attendus, cas par cas. Ce fichier est le contrat : chaque ligne
   * dit ce que la porte prouve sur un plan réellement produit par le modèle, et
   * ce qu'elle ne peut pas prouver sans observation du navigateur.
   */
  const expected: Record<
    string,
    { refusal?: RegExp; repairedTo?: string; why: string }
  > = {
    "3c51455f": {
      refusal:
        /holds \d+ characters and the limit that decides this value is 280/,
      why: "le commentaire écrit ne dépasse pas la borne alors que le plan attend l'état « trop long »",
    },
    b933cf08: {
      refusal:
        /holds 284 characters and the limit that decides this value is 280/,
      why: "284 caractères écrits là où 280 sont attendus : la capture du run le montre (284/280)",
    },
    "790fde72": {
      why: "transition sur invariant : la porte ne peut pas la prouver, l'exécuteur la classe en bloqué",
    },
    f83f0762: {
      refusal:
        /holds 281 characters and the limit that decides this value is 280/,
      why: "281 caractères assertés contre la valeur de repli",
    },
    afcc9846: {
      why: "cible absente après navigation : seule l'exécution peut la constater",
    },
    "24db19b8": {
      refusal:
        /holds 290 characters and the limit that decides this value is 280/,
      why: "290 caractères assertés contre la valeur de repli",
    },
    dd1030c1: {
      repairedTo: "apps/web/lib/cash-session.ts",
      why: "citation mal attribuée, réparée vers le fichier qui la porte",
    },
  };

  for (const [tag, contract] of Object.entries(expected)) {
    it(`rejoue ${tag} : ${contract.why}`, () => {
      const entry = cases[tag];
      expect(entry, `fixture ${tag} absente`).toBeDefined();
      const verdict = verdictOf(entry as HistoricalCase);
      if (contract.repairedTo) {
        expect(verdict.repaired).toContain(
          `packages/domain/src/cash.ts -> ${contract.repairedTo}`
        );
        return;
      }
      if (contract.refusal) {
        expect(verdict.refusals.length).toBeGreaterThanOrEqual(1);
        expect(verdict.refusals.join("\n")).toMatch(contract.refusal);
        return;
      }
      // Aucune preuve statique possible : la porte ne doit PAS inventer un refus.
      expect(verdict.refusals).toEqual([]);
    });
  }
});
