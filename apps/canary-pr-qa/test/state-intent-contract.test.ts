import { describe, expect, it } from "vitest";
import { planFindings } from "../src/policy.js";
import { PlanSchema } from "../src/schema.js";
import { stateAlreadySatisfied } from "../src/step-outcome.js";

/**
 * Le contrat d'intention, côté EXÉCUTION.
 *
 * `stateAlreadySatisfied` bloque une assertion `state` dont la valeur était déjà
 * satisfaite avant l'étape et que l'étape laisse identique. Une intention
 * DÉCLARÉE `invariant` est une preuve recevable : l'étape a été jouée, et la
 * valeur qui n'a pas bougé est exactement ce que l'invariant affirme. Sans
 * déclaration, l'intention reste inconnue et la règle s'applique — aucun plan
 * ancien n'est converti, aucune intention n'est devinée.
 */

const saturated = {
  afterStep: "reopen",
  baselineMatches: true,
  baselineMeasured: true,
  steps: [{ stepId: "reopen" }],
  unchanged: true,
  verification: "state" as const,
};

describe("une invariance déclarée est recevable, une intention inconnue ne l'est pas", () => {
  it("bloque toujours un plan ancien sans intention (cas afcc9846 / s9-history-persist)", () => {
    // Plan historique : `state`, même cible, même condition, après `reopen`.
    // Aucun `assertionIntent` conservé → l'intention est inconnue.
    expect(stateAlreadySatisfied(saturated)).toBe(true);
    expect(
      stateAlreadySatisfied({ ...saturated, assertionIntent: undefined })
    ).toBe(true);
  });

  it("accepte la même assertion déclarée invariance (cas 0ce50724)", () => {
    expect(
      stateAlreadySatisfied({ ...saturated, assertionIntent: "invariant" })
    ).toBe(false);
  });

  it("reste bloquant quand l'étape d'ancrage n'a pas été jouée", () => {
    // `ifPresent` sauté : le plan a déclaré son no-op, donc l'assertion d'état
    // constate l'état voulu sans prétendre qu'un clic l'a produit.
    expect(
      stateAlreadySatisfied({
        ...saturated,
        steps: [{ skipped: true, stepId: "reopen" }],
      })
    ).toBe(false);
    // Mais un pas joué qui n'a rien changé, sans déclaration, reste bloqué.
    expect(
      stateAlreadySatisfied({ ...saturated, steps: [{ stepId: "reopen" }] })
    ).toBe(true);
  });

  it("une persistance déclarée n'est pas recevable en `state`", () => {
    // L'invariance est le seul cas que la déclaration débloque ; une persistance
    // exige `persisted` et est refusée avant exécution.
    expect(
      stateAlreadySatisfied({ ...saturated, assertionIntent: "persistence" })
    ).toBe(true);
  });

  it("ne s'applique ni aux transitions ni aux persistances", () => {
    for (const verification of ["transition", "persisted"] as const) {
      expect(
        stateAlreadySatisfied({
          ...saturated,
          assertionIntent: "invariant",
          verification,
        })
      ).toBe(false);
    }
  });
});

describe("le plan porteur d'une invariance déclarée passe la porte de plan", () => {
  const scenario = (intent: "invariant" | "persistence" | undefined) => ({
    assertions: [
      {
        afterStep: "reopen",
        description: "l'entrée d'historique est toujours là après réouverture",
        expected: 1,
        id: "history-kept",
        kind: "count",
        target: { by: "css", value: "[data-cash-history-entry]" },
        verification: "state",
        ...(intent === undefined ? {} : { assertionIntent: intent }),
      },
    ],
    id: "caisse-cloture-reouverture-historique",
    kind: "regression",
    preconditions: [],
    rationale: "r",
    requirements: [
      {
        behavior: "b",
        quote: "show('Welcome '+name)",
        sourceFile: "src/form.ts",
      },
    ],
    sourceFiles: ["src/form.ts"],
    steps: [
      {
        action: { path: "/", type: "goto" },
        description: "ouvrir",
        id: "load",
      },
      {
        action: {
          locator: { by: "role", name: "Rouvrir", value: "button" },
          type: "click",
        },
        description: "réouvrir",
        id: "reopen",
      },
      {
        action: { assertionId: "history-kept", type: "assert" },
        description: "vérifier",
        id: "check",
      },
    ],
    title: "t",
  });

  const findingsFor = (intent: "invariant" | "persistence" | undefined) =>
    planFindings(
      PlanSchema.parse({
        scenarios: [scenario(intent)],
        skipped: [],
        summary: "s",
      }),
      []
    ).refusals;

  it("aucun refus de plan pour une invariance déclarée", () => {
    expect(findingsFor("invariant")).toEqual([]);
  });

  it("aucun refus pour un plan ancien, dont l'intention est inconnue", () => {
    expect(findingsFor(undefined)).toEqual([]);
  });

  it("refus pour une persistance déclarée en `state`", () => {
    const refusals = findingsFor("persistence");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.error.code).toBe("PERSISTENCE_INTENT_MISMATCH");
  });
});

describe("les conseils des diagnostics disent la même chose que l'exécution", () => {
  // Les trois conseils proviennent des trois verdicts non verts d'assertion.
  const hints = async () => {
    const { recordUnprovenAssertion } = await import("../src/step-outcome.js");
    const config = { REDACT: false } as never;
    const collect = (
      verification: string,
      unchanged: boolean,
      matched: boolean,
      alreadySatisfied = false
    ) => {
      const result = {
        assertions: [],
        outcome: "passed",
        scenario: { id: "s" },
        steps: [],
      } as never;
      recordUnprovenAssertion(
        result,
        {
          afterStep: "reopen",
          description: "d",
          expected: 1,
          id: "a",
          kind: "count",
          target: { by: "css", value: "#a" },
          verification,
        } as never,
        verification,
        matched,
        unchanged,
        config,
        alreadySatisfied
      );
      return (
        (result as { diagnostic?: { hint: string } }).diagnostic?.hint ?? ""
      );
    };
    return {
      invariant: collect("transition", true, true),
      notObserved: collect("transition", true, false),
      alreadySatisfied: collect("state", true, true, true),
    };
  };

  it("ne recommande jamais `state` + afterStep sans déclarer l'intention", async () => {
    const { alreadySatisfied, invariant, notObserved } = await hints();
    for (const hint of [alreadySatisfied, invariant, notObserved]) {
      if (/"state"/.test(hint) && /afterStep/.test(hint)) {
        expect(hint).toMatch(/invariant/);
      }
    }
  });

  it("nomme `persisted` et l'intention pour une survie", async () => {
    const { notObserved } = await hints();
    expect(notObserved).toMatch(/"persisted"/);
    expect(notObserved).toMatch(/persistence/);
  });

  it("ne propose jamais `persisted` pour une valeur immobile", async () => {
    // `persisted` exige que la valeur DIFFÈRE de la référence après le
    // rechargement : il ne peut pas exprimer « la même valeur a survécu ».
    const { invariant, notObserved } = await hints();
    expect(notObserved).toMatch(/must CHANGE and then survive/);
    expect(invariant).toMatch(/does NOT fit here/);
  });

  it("nomme la déclaration d'invariance quand l'état était déjà satisfait", async () => {
    const { alreadySatisfied } = await hints();
    expect(alreadySatisfied).toMatch(/STAYS? unchanged/);
    expect(alreadySatisfied).toMatch(/"invariant"/);
    expect(alreadySatisfied).toMatch(/never guessed/);
  });
});
