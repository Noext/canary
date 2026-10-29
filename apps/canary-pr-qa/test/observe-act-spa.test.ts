import { describe, expect, it } from "vitest";
import type { Observation } from "../src/canary.js";
import {
  observedNames,
  resolveObservedName,
  resolveStepFromObservation,
} from "../src/observe-act.js";
import type { Scenario } from "../src/schema.js";

/**
 * Cibles `css[aria-label="…"]` après une navigation SPA.
 *
 * Mesuré sur les 79 plans stockés : 1066 des 3396 locators ont cette forme, et
 * ils sont TOUS utilisés après une interaction. Le chemin observe→act rendait le
 * sélecteur entier comme « nom visé » : l'instantané ne le contenait jamais, et
 * le score de résolution était dilué par les mots de syntaxe (`input`, `aria`,
 * `label`) — 0,40 au mieux sur la forme réelle, donc sous le seuil de 0,5. La
 * résolution échouait toujours, même quand la cible existait.
 */

const LANDING = `- main [ref=e1]:
  - heading "Pilotage" [level=1] [ref=e2]
  - button "Caisse et Coffre" [ref=e3]`;

const CASH = `- main [ref=e1]:
  - heading "Caisse et Coffre" [level=1] [ref=e2]
  - textbox "Quantité · Billet de 20 €" [ref=e3]
  - textbox "Quantité · Pièce de 2 €" [ref=e4]
  - textbox "Quantité · Billet de 50 €" [ref=e5]
  - button "Clôturer la session" [ref=e6]`;

const observation = (snapshot: string): Observation => ({
  actual: undefined,
  snapshot,
  url: "https://preview.example.test/",
});

function fillStep(value: string): Scenario["steps"][number] {
  return {
    action: { locator: { by: "css", value }, type: "fill", value: "1" },
    description: "saisir la quantité",
    id: "fill",
  } as Scenario["steps"][number];
}

const enabled = { QA_OBSERVE_ACT: true };
const disabled = { QA_OBSERVE_ACT: false };

function resolution(
  step: Scenario["steps"][number],
  snapshot: string,
  config = enabled
) {
  return resolveStepFromObservation({
    config,
    index: 1,
    observation: observation(snapshot),
    result: { scenario: { id: "s" }, steps: [] } as never,
    step,
  });
}

describe("le nom visé est le libellé du sélecteur, pas sa syntaxe", () => {
  it("lit le libellé d'un css[aria-label] au lieu du sélecteur brut", () => {
    // Sans cette lecture, le score restait à 0,40 (mots `input`, `aria`,
    // `label`) et aucun candidat n'atteignait le seuil.
    expect(
      resolveObservedName(
        observation(CASH),
        fillStep('input[aria-label="Quantité · Pièce de 2 €"]')
      )
    ).toBe("Quantité · Pièce de 2 €");
  });

  it("accepte aussi la forme sans préfixe de type", () => {
    expect(
      resolveObservedName(
        observation(CASH),
        fillStep('[aria-label="Quantité · Billet de 20 €"]')
      )
    ).toBe("Quantité · Billet de 20 €");
  });
});

describe("une cible présente dans l'observation suivante n'est pas bloquée", () => {
  it("joue le pas tel quel quand la vue SPA expose la cible", () => {
    // La navigation a déjà eu lieu : le pas est jugé sur l'observation vivante,
    // pas sur l'instantané de découverte.
    const step = fillStep('input[aria-label="Quantité · Pièce de 2 €"]');
    const result = resolution(step, CASH);
    expect("blocked" in result).toBe(false);
    // Cible déjà exposée : le pas est joué tel quel, sans ré-ancrage.
    expect("reanchoredTo" in result).toBe(false);
  });

  it("bloque le même pas sur l'instantané d'arrivée, où la cible n'existe pas", () => {
    const step = fillStep('input[aria-label="Quantité · Pièce de 2 €"]');
    expect("blocked" in resolution(step, LANDING)).toBe(true);
  });
});

describe("une cible réellement absente n'est jamais transformée en succès", () => {
  it("refuse de résoudre vers une autre coupure : 5 € n'est pas 2 €", () => {
    // Les mots partagés donneraient 1,00 avec « Quantité · Pièce de 2 € » ;
    // seuls les nombres distinguent les deux contrôles.
    expect(
      resolveObservedName(
        observation(CASH),
        fillStep('input[aria-label="Quantité · Pièce de 5 €"]')
      )
    ).toBeUndefined();
  });

  it("bloque le pas au lieu de cliquer sur le mauvais contrôle", () => {
    const step = fillStep('input[aria-label="Quantité · Pièce de 5 €"]');
    expect("blocked" in resolution(step, CASH)).toBe(true);
  });

  it("n'applique aucune porte quand le drapeau est coupé", () => {
    const step = fillStep('input[aria-label="Quantité · Pièce de 5 €"]');
    expect("blocked" in resolution(step, CASH, disabled)).toBe(false);
  });
});

describe("les correspondances ambiguës restent indéterminées", () => {
  it("refuse deux candidats de même score", () => {
    const ambiguous = `- main [ref=e1]:
  - textbox "Quantité · Pièce de 2 €" [ref=e2]
  - textbox "Quantité · Billet de 2 €" [ref=e3]`;
    expect(
      resolveObservedName(
        observation(ambiguous),
        fillStep('[aria-label="Quantité · Pièce de 5 €"]')
      )
    ).toBeUndefined();
    // Même sans nombre dans la cible, deux candidats à égalité restent ambigus.
    expect(
      resolveObservedName(
        observation(ambiguous),
        fillStep('[aria-label="Quantité · Pièce"]')
      )
    ).toBeUndefined();
  });

  it("refuse un nom observé porté par deux éléments", () => {
    const duplicated = `- main [ref=e1]:
  - textbox "Quantité · Billet de 20 €" [ref=e2]
  - textbox "Quantité · Billet de 20 €" [ref=e3]`;
    expect(observedNames(observation(duplicated))).toEqual([
      "Quantité · Billet de 20 €",
    ]);
    expect(
      resolveObservedName(
        observation(duplicated),
        fillStep('[aria-label="Quantité · Pièce de 20 €"]')
      )
    ).toBeUndefined();
  });
});

describe("les réparations légitimes restent possibles", () => {
  it("ré-ancre une graphie voisine qui garde le même nombre", () => {
    // Cas documenté (run 287e0f0c) : le plan écrit « Pièce de 20 € », la page
    // expose « Billet de 20 € ». Même nombre, un mot partagé sur deux.
    expect(
      resolveObservedName(
        observation(CASH),
        fillStep('input[aria-label="Quantité · Pièce de 20 €"]')
      )
    ).toBe("Quantité · Billet de 20 €");
  });

  it("ré-ancre un libellé sans nombre quand un seul candidat domine", () => {
    const single = `- main [ref=e1]:
  - textbox "Quantité · Billet de 20 €" [ref=e2]
  - button "Clôturer la session" [ref=e3]`;
    expect(
      resolveObservedName(
        observation(single),
        fillStep('input[aria-label="Quantité · Pièce de 20 €"]')
      )
    ).toBe("Quantité · Billet de 20 €");
  });

  it("expose la cible réellement retenue sur le pas rejoué", () => {
    const step = fillStep('input[aria-label="Quantité · Pièce de 20 €"]');
    const result = resolution(step, CASH);
    expect("blocked" in result).toBe(false);
    if ("blocked" in result) {
      return;
    }
    expect(result.reanchoredTo).toBe("Quantité · Billet de 20 €");
    // Un locator `css` ne porte pas de `name` : c'est le SÉLECTEUR qui doit
    // viser le libellé observé, sinon le pas rejoue l'ancien et expire.
    expect(
      (result.step.action as { locator: { value: string } }).locator.value
    ).toBe('input[aria-label="Quantité · Billet de 20 €"]');
  });
});
