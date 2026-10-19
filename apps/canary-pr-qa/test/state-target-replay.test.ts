import { describe, expect, it } from "vitest";
import { stateTargetReadRefusals } from "../src/plan-evidence.js";
import { type Plan, PlanSchema } from "../src/schema.js";
import { LOT_U_PLAN } from "./lot-u-plan.js";

/**
 * Instantané de découverte de la vue « Caisse et Coffre » dans l'état où le run
 * 210357d8 l'a rencontrée : la barre de navigation, le titre de la pharmacie
 * courante, une région `status` unique qui porte le statut du comptage, et les
 * paragraphes de la vue. Le libellé du statut est donc rendu par un nœud
 * unique, ceux des lignes de comptage par des paragraphes nombreux — c'est la
 * différence que le refus doit savoir lire.
 */
const VIEW_ARIA = `- main [ref=e1]:
  - navigation [ref=e2]:
    - button "Pilotage" [ref=e3]
    - button "Caisse et Coffre" [ref=e4]
  - heading "Caisse et Coffre · DEMO17" [ref=e5]
  - status [ref=e6]: Comptage juste
  - paragraph: Coupures et pièces
  - paragraph: Quantités comptées dans le tiroir et le coffre. Un champ vide compte pour zéro.
  - paragraph: 6 unités comptées
  - paragraph: Total compté
  - paragraph: 1 240,00 €
  - paragraph: Session en cours`;

/** Attribution d'état épinglé, la seule forme que la règle vise. */
const PINNED =
  /\[\s*(?:aria-(?:checked|current|disabled|expanded|hidden|invalid|pressed|selected)|data-(?:state|cash-state))\s*[*^$~|]?=\s*(?:"[^"]*"|'[^']*'|[^\]]*)\]/i;

function plan(): Plan {
  return PlanSchema.parse(LOT_U_PLAN);
}

interface Fault {
  assertion: string;
  expected: string;
  scenario: string;
  selector: string;
}

/** Les lectures fautives du run, relevées dans le plan mesuré lui-même. */
function faults(): Fault[] {
  const found: Fault[] = [];
  for (const scenario of plan().scenarios) {
    for (const assertion of scenario.assertions) {
      const target = assertion.target;
      if (assertion.kind !== "text" || !(target && target.by === "css")) {
        continue;
      }
      if (!PINNED.test(target.value)) {
        continue;
      }
      found.push({
        assertion: assertion.id,
        expected: String(assertion.expected),
        selector: target.value,
        scenario: scenario.id,
      });
    }
  }
  return found;
}

describe("rejeu du run 210357d8 (lot U), six scénarios bloqués", () => {
  it("compte les lectures fautives du run : six scénarios, dix-sept assertions", () => {
    // La mesure du lot U, refaite sur l'artefact : six scénarios bloqués, et
    // dix-sept assertions qui lisent un sélecteur d'état épinglé comme du
    // texte — `result.json` nomme 3, 2, 2, 3, 5 et 2 assertions par scénario.
    expect(plan().scenarios).toHaveLength(6);
    expect(faults()).toHaveLength(17);
    expect([...new Set(faults().map((fault) => fault.scenario))]).toHaveLength(
      6
    );
  });

  it.each(
    [
      "cash-balanced-close-reopen",
      "cash-variance-justification",
      "cash-invalid-quantity",
      "cash-view-state-retention",
      "cash-per-pharmacy-separation",
      "cash-invalid-expected-amount",
    ].map((id) => [id] as const)
  )("refuse le scénario %s et nomme sa lecture d'origine", (id) => {
    const refused = stateTargetReadRefusals(plan(), VIEW_ARIA);
    const scenario = refused.find((item) => item.scenario.id === id);
    expect(scenario?.error.code).toBe("PLAN_STATE_TARGET_READ_AS_TEXT");
    for (const fault of faults().filter((item) => item.scenario === id)) {
      expect(scenario?.error.message).toContain(fault.assertion);
      expect(scenario?.error.message).toContain(fault.selector);
      expect(scenario?.error.message).toContain(JSON.stringify(fault.expected));
    }
  });

  it.each(
    faults().map(
      (fault) => [`${fault.scenario}/${fault.assertion}`, fault] as const
    )
  )("nomme la cible visible de %s", (_id, fault) => {
    const refused = stateTargetReadRefusals(plan(), VIEW_ARIA);
    const scenario = refused.find(
      (item) => item.scenario.id === fault.scenario
    );
    const hint = scenario?.error.hint ?? "";
    // Le libellé attendu est l'indice : le refus nomme l'assertion, son
    // libellé, et la cible qui le rend sans dépendre de l'état.
    expect(hint).toContain(`assertion ${fault.assertion}`);
    expect(hint).toContain(JSON.stringify(fault.expected));
    expect(hint).toContain(
      `assertion ${fault.assertion} expecting ${JSON.stringify(fault.expected)} → read [data-cash-state]`
    );
  });

  it("nomme le rôle et le nom que l'instantané rend, quand il les rend", () => {
    const refused = stateTargetReadRefusals(plan(), VIEW_ARIA);
    const hintOf = (scenario: string) =>
      refused.find((item) => item.scenario.id === scenario)?.error.hint ?? "";
    // Le statut du comptage est rendu par l'unique région `status` de la vue :
    // le contenu qui suit ses attributs EST le texte que `text` lit, et le
    // refus la nomme.
    expect(hintOf("cash-balanced-close-reopen")).toContain(
      'assertion status expecting "Comptage juste" → read [data-cash-state] or role=status name=""'
    );
    // Le titre de la pharmacie n'est porté que par le NOM accessible de son
    // `heading`, sans contenu rendu : ce nom n'est pas ce que `innerText` lit,
    // donc le refus ne le propose pas (mesuré : un bouton
    // `aria-label="Enregistrer le comptage"` rend « 💾 »).
    expect(hintOf("cash-per-pharmacy-separation")).toContain(
      'assertion demo17-label expecting "Caisse et Coffre · DEMO17" → read [data-cash-state]'
    );
    expect(hintOf("cash-per-pharmacy-separation")).not.toContain(
      "role=heading"
    );
    // Un libellé que l'instantané ne rend pas, ou qu'un rôle nombreux rend
    // (« 6 unités comptées » dans un paragraphe), n'invente aucune cible.
    expect(hintOf("cash-balanced-close-reopen")).toContain(
      'assertion units expecting "6 unités comptées" → read [data-cash-state] ;'
    );
    expect(hintOf("cash-invalid-quantity")).toContain(
      'assertion invalid-status expecting "Quantité à corriger" → read [data-cash-state] ;'
    );
  });

  it("n'offre ni un nœud texte ni un nom accessible comme cible de lecture", () => {
    // Deux formes que l'instantané porte et qui ne sont PAS une cible `text` :
    // `- text:` n'est pas un rôle (`role=text` résout 0 élément sur la page de
    // référence), et un nom accessible peut différer du contenu rendu. Le refus
    // ne doit nommer que le nœud dont le contenu porte le libellé.
    const snapshot = [
      "- main:",
      "  - text: Comptage juste",
      '  - button "Comptage juste": ⚙️',
      "  - status: Comptage juste",
    ].join("\n");
    const refused = stateTargetReadRefusals(plan(), snapshot);
    const hint = refused[0]?.error.hint ?? "";
    expect(hint).toContain(
      'expecting "Comptage juste" → read [data-cash-state] or role=status name=""'
    );
    expect(hint).not.toContain("role=text");
    expect(hint).not.toContain("role=button");
    // Le refus reste prononcé : la règle ne s'ouvre pas avec ce matériel.
    expect(refused).toHaveLength(6);
  });

  it("refuse la cible épinglée avec ou sans matériel : la règle ne s'ouvre pas", () => {
    // Le gate n'accepte toujours AUCUNE lecture sur un sélecteur d'état
    // épinglé : le matériel enrichit le message, il ne relâche pas le refus.
    const withViews = stateTargetReadRefusals(plan(), VIEW_ARIA);
    const withoutViews = stateTargetReadRefusals(plan());
    expect(withViews).toHaveLength(6);
    expect(withoutViews).toHaveLength(6);
    expect(withoutViews.map((item) => item.error.message)).toEqual(
      withViews.map((item) => item.error.message)
    );
    // Sans instantané, la cible de présence se déduit encore du sélecteur.
    for (const refused of withoutViews) {
      expect(refused.error.hint).toContain("→ read [data-cash-state]");
    }
  });

  it("accepte la cible corrigée qu'il propose, pour chacune des dix-sept lectures", () => {
    // La correction que le refus nomme est jouable : la même assertion, portée
    // sur le conteneur sans sa valeur épinglée, ne rencontre plus aucun refus.
    const corrected = plan();
    corrected.scenarios = corrected.scenarios.map((scenario) => ({
      ...scenario,
      assertions: scenario.assertions.map((assertion) => {
        const target = assertion.target;
        return assertion.kind === "text" &&
          target &&
          target.by === "css" &&
          PINNED.test(target.value)
          ? {
              ...assertion,
              target: { by: "css" as const, value: "[data-cash-state]" },
            }
          : assertion;
      }),
    }));
    expect(
      stateTargetReadRefusals(PlanSchema.parse(corrected), VIEW_ARIA)
    ).toEqual([]);
    // Aucune assertion du plan corrigé ne lit plus un attribut d'état épinglé,
    // et la forme qui les remplace est celle que le corpus mesure : 924
    // assertions `text` y lisent [data-cash-state], 885 passent.
    expect(
      corrected.scenarios
        .flatMap((scenario) => scenario.assertions)
        .filter(
          (assertion) =>
            // Une assertion `visible` sur la valeur épinglée est la PREUVE de
            // l'état, pas une lecture : elle reste.
            assertion.kind === "text" &&
            assertion.target?.by === "css" &&
            PINNED.test(assertion.target.value)
        )
    ).toEqual([]);
  });
});
