import { describe, expect, it } from "vitest";
import { PLANNER_PROMPT } from "../src/model.js";
import { PlanSchema, plannerPlanSchema } from "../src/schema.js";
import { stateAlreadySatisfied } from "../src/step-outcome.js";

/**
 * Le contrat sémantique entre le prompt, le schéma et l'exécution.
 *
 * Le prompt recommandait « pour un invariant après interaction, utilisez `state`
 * avec `afterStep` sur l'étape d'interaction ». L'exécuteur refuse exactement ce
 * cas (`stateAlreadySatisfied` → STATE_ALREADY_SATISFIED) sauf si l'étape est un
 * `ifPresent` sauté. Ce test empêche la consigne contradictoire de revenir et
 * fixe ce que chaque mode garantit réellement.
 */

describe("le prompt ne recommande plus un motif que l'exécuteur refuse", () => {
  it("ne contient plus la consigne contradictoire", () => {
    // Formulation retirée : « use state with afterStep set to the interaction
    // step » pour un invariant après interaction.
    expect(PLANNER_PROMPT).not.toMatch(
      /To assert an invariance after an interaction[^.]*use state with afterStep/i
    );
    expect(PLANNER_PROMPT).not.toMatch(/its text did not change\), use state/i);
  });

  it("dit que `afterStep` n'ancre que la lecture, sans causalité", () => {
    expect(PLANNER_PROMPT).toMatch(
      /afterStep only anchors WHERE an assertion is read/
    );
    expect(PLANNER_PROMPT).toMatch(
      /never proves that the step caused the state/
    );
  });

  it("nomme le refus d'exécution d'une assertion d'état pré-satisfaite", () => {
    expect(PLANNER_PROMPT).toMatch(/STATE_ALREADY_SATISFIED/);
  });

  it("donne les motifs réellement supportés : pas d'interaction, ifPresent sauté, persisted", () => {
    expect(PLANNER_PROMPT).toMatch(
      /do not interact with it: keep the initial goto and verify it with a state assertion/
    );
    expect(PLANNER_PROMPT).toMatch(/declared ifPresent, and actually skipped/);
    expect(PLANNER_PROMPT).toMatch(/use persisted and declare assertionIntent/);
  });

  it("distingue la lecture de l'intention", () => {
    expect(PLANNER_PROMPT).toMatch(/assertionIntent/);
    expect(PLANNER_PROMPT).toMatch(
      /says nothing about what produced that value/
    );
  });
});

describe("le schéma porte le contrat, pas seulement le prompt", () => {
  it("accepte les trois lectures, et refuse tout autre mode", () => {
    const withMode = (verification: string) => ({
      scenarios: [
        {
          assertions: [
            {
              afterStep: "c",
              description: "d",
              expected: 1,
              id: "a",
              kind: "count",
              target: { by: "css", value: "#a" },
              verification,
            },
          ],
          id: "s",
          kind: "happy_path",
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
              action: {
                locator: { by: "role", name: "Save", value: "button" },
                type: "click",
              },
              description: "c",
              id: "c",
            },
            {
              action: { assertionId: "a", type: "assert" },
              description: "v",
              id: "v",
            },
          ],
          title: "t",
        },
      ],
      skipped: [],
      summary: "s",
    });
    for (const mode of ["state", "transition", "persisted"] as const) {
      expect(
        PlanSchema.parse(withMode(mode)).scenarios[0]?.assertions[0]
          ?.verification
      ).toBe(mode);
    }
    expect(() => PlanSchema.parse(withMode("sometimes"))).toThrow();
  });

  it("accepte un plan complet avec intention et la restitue", () => {
    const parsed = plannerPlanSchema([]).parse({
      scenarios: [
        {
          assertions: [
            {
              afterStep: "save",
              assertionIntent: "persistence",
              description: "l'entrée persiste",
              expected: 1,
              id: "kept",
              kind: "count",
              target: { by: "css", value: "[data-history-entry]" },
              verification: "persisted",
            },
          ],
          id: "s",
          kind: "regression",
          objective: "kept",
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
              action: {
                locator: { by: "role", name: "Save", value: "button" },
                type: "click",
              },
              description: "enregistrer",
              id: "save",
            },
            {
              action: { assertionId: "kept", type: "assert" },
              description: "vérifier",
              id: "check",
            },
          ],
          title: "t",
        },
      ],
      skipped: [],
      summary: "s",
    });
    expect(parsed.scenarios[0]?.assertions[0]?.assertionIntent).toBe(
      "persistence"
    );
    expect(parsed.scenarios[0]?.assertions[0]?.verification).toBe("persisted");
  });

  it("accepte un plan ancien, sans intention", () => {
    const parsed = PlanSchema.parse({
      scenarios: [
        {
          assertions: [
            {
              afterStep: "save",
              description: "sortie",
              expected: "Welcome Ada",
              id: "saved",
              kind: "text",
              target: { by: "css", value: "#saved" },
              verification: "state",
            },
          ],
          id: "s",
          kind: "happy_path",
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
              action: {
                locator: { by: "role", name: "Save", value: "button" },
                type: "click",
              },
              description: "enregistrer",
              id: "save",
            },
            {
              action: { assertionId: "saved", type: "assert" },
              description: "vérifier",
              id: "check",
            },
          ],
          title: "t",
        },
      ],
      skipped: [],
      summary: "s",
    });
    expect(parsed.scenarios[0]?.assertions[0]?.assertionIntent).toBeUndefined();
  });
});

describe("la règle d'exécution que le prompt décrit", () => {
  const base = {
    afterStep: "click",
    baselineMatches: true,
    baselineMeasured: true,
    steps: [{ stepId: "click" }],
    unchanged: true,
    verification: "state",
  };

  it("bloque un état pré-satisfait laissé inchangé par l'interaction", () => {
    expect(stateAlreadySatisfied(base)).toBe(true);
  });

  it("laisse passer la même assertion quand l'étape ifPresent a été sautée", () => {
    expect(
      stateAlreadySatisfied({
        ...base,
        steps: [{ skipped: true, stepId: "click" }],
      })
    ).toBe(false);
  });

  it("laisse passer dès que la valeur a bougé", () => {
    expect(stateAlreadySatisfied({ ...base, unchanged: false })).toBe(false);
  });

  it("ne s'applique pas aux transitions ni aux persistances", () => {
    for (const verification of ["transition", "persisted"] as const) {
      expect(stateAlreadySatisfied({ ...base, verification })).toBe(false);
    }
  });

  it("ne s'applique pas quand la valeur d'avant n'a pas été mesurée", () => {
    expect(stateAlreadySatisfied({ ...base, baselineMeasured: false })).toBe(
      false
    );
  });
});
