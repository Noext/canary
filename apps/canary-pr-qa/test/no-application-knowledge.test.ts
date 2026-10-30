import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLANNER_PROMPT } from "../src/model.js";

/**
 * La règle du contrat : la validité d'un plan n'est jamais décidée par une
 * connaissance de l'application testée. Ce test la rend exécutable — un
 * identifiant du dépôt mesuré qui revient dans le prompt ou dans les règles fait
 * échouer la CI, au lieu de dépendre de la vigilance d'une relecture.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = (name: string) =>
  readFileSync(join(here, "..", "src", name), "utf8");

/** Les identifiants du dépôt qui a servi à mesurer — aucun n'est une règle. */
const FORBIDDEN = [
  "pharmania",
  "arpilabe",
  "data-cash",
  "CASH_JUSTIFICATION",
  "cashJustificationProblem",
  "canAttemptClose",
  "apps/web/",
  "packages/domain/",
];

describe("aucune connaissance de l'application testée dans la règle", () => {
  it("le prompt ne nomme ni le dépôt mesuré, ni ses attributs, ni ses chemins", () => {
    for (const token of FORBIDDEN) {
      expect(PLANNER_PROMPT).not.toContain(token);
    }
  });

  it("le témoin d'objectif et la recherche de consommateurs ne nomment aucune application", () => {
    // Ces modules ont été mesurés sur le dépôt ci-dessus : leurs règles (jetons,
    // lignes changées, graphe d'imports) doivent rester structurelles.
    for (const name of [
      "objective-witness.ts",
      "consumer-context.ts",
      "consumer-resolution.ts",
    ]) {
      const text = source(name);
      for (const token of FORBIDDEN) {
        expect(text, `${name} ${token}`).not.toContain(token);
      }
    }
  });

  it("la liste des attributs d'état n'énumère aucune application", () => {
    // Le code qui décide ne doit pas contenir d'attribut du dépôt mesuré : la
    // règle se déduit du nom (`data-*-state`), et le test le vérifie littéralement.
    const evidence = source("plan-evidence.ts");
    expect(evidence).not.toContain('"data-cash-state",');
  });

  it("la règle d'attribut d'état se déduit du nom, pas d'une liste d'application", () => {
    // `data-cash-state` reste refusé parce qu'il finit par `state`, pas parce
    // qu'il est écrit dans une liste : la même règle couvre `data-order-state`.
    const evidence = source("plan-evidence.ts");
    expect(evidence).toContain("const STATE_ATTRIBUTE_NAME = /(^|-)state$/;");
    expect(evidence).not.toContain('"data-cash-state",');
  });
});
