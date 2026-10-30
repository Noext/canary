import { describe, expect, it, vi } from "vitest";
import { Canary } from "../src/canary.js";
import { PLANNER_PROMPT } from "../src/model.js";
import {
  enforceObjectiveProof,
  provenanceRefusals,
} from "../src/plan-evidence.js";
import { runQa } from "../src/runner.js";
import type { Plan, Scenario, ScenarioResult } from "../src/schema.js";
import { repairStepTarget } from "../src/target-repair.js";
import { fixture, plan as fixturePlan, PR_URL } from "./fixture.js";

/**
 * Les quatre invariants que le moteur doit garantir, dans les deux directions :
 * le cas qui passe et le cas qui doit échouer. Un invariant sans test de rupture
 * n'est qu'une intention.
 */
const plan: Plan = {
  scenarios: [
    {
      assertions: [
        {
          afterStep: "open",
          description: "the title is shown",
          expected: "Welcome",
          id: "title",
          kind: "text",
          requirement: 0,
          target: { by: "css", value: "h1" },
          verification: "state",
        },
      ],
      id: "greeting",
      kind: "happy_path",
      objective: "title",
      rationale: "the diff changes the greeting",
      requirements: [
        {
          behavior: "the greeting is rendered",
          quote: "show('Welcome '+name)",
          sourceFile: "src/form.ts",
        },
      ],
      sourceFiles: ["src/form.ts"],
      steps: [
        {
          action: { path: "/", type: "goto" },
          description: "open",
          id: "open",
        },
        {
          action: { assertionId: "title", type: "assert" },
          description: "assert the title",
          id: "assert-title",
        },
      ],
      title: "the greeting is displayed",
    },
  ],
  skipped: [],
  summary: "one scenario",
} as unknown as Plan;

/** Le plan du fixture, complété pour satisfaire l'invariant de provenance. */
const withProvenance = (base: Plan): Plan => {
  const clone = structuredClone(base);
  clone.scenarios[0]!.objective = "saved";
  (clone.scenarios[0]!.assertions[0] as { requirement?: number }).requirement =
    0;
  return clone;
};

const scenarioResult = (overrides: Partial<ScenarioResult> = {}) =>
  ({
    artifacts: [],
    assertions: [{ id: "title", passed: true, actual: "Welcome" }],
    outcome: "passed",
    scenario: plan.scenarios[0],
    steps: [],
    ...overrides,
  }) as ScenarioResult;

describe("I1 — isolation : chaque scénario part d'une session neuve", () => {
  it("ouvre une session par scénario et navigue avant la première action", async () => {
    // Deux scénarios, pas un : c'est la seule façon de prouver qu'aucun n'hérite
    // de l'état laissé par le précédent.
    const twoScenarios = structuredClone(withProvenance(fixturePlan));
    const second = structuredClone(twoScenarios.scenarios[0]!);
    second.id = "welcome-bis";
    second.title = "Submitting the name again saves a welcome message";
    twoScenarios.scenarios.push(second);
    const f = await fixture({ plans: [twoScenarios] });
    const starts: string[] = [];
    const acts: { label: string; session: string }[] = [];
    vi.spyOn(Canary.prototype, "start").mockImplementation(async (label) => {
      const id = `session-${starts.length}`;
      starts.push(label);
      return id;
    });
    vi.spyOn(Canary.prototype, "act").mockImplementation(
      async (session, label) => {
        acts.push({ label, session });
        return {
          url: "http://fixture/",
          snapshot: "textbox Name, button Save",
          ...(label.endsWith("assert") ? { actual: "Welcome Ada" } : {}),
        } as never;
      }
    );
    vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
    try {
      const result = await runQa(
        { prUrl: PR_URL, previewUrl: f.baseUrl },
        f.config
      );
      expect(result.scenarios).toHaveLength(2);
      // Découverte + une session par scénario.
      expect(starts).toHaveLength(3);
      const scenarioSessions = [
        ...new Set(
          acts
            .filter((act) => act.label === "open-preview")
            .map((a) => a.session)
        ),
      ];
      expect(scenarioSessions).toHaveLength(2);
      for (const session of scenarioSessions) {
        const first = acts.find((act) => act.session === session);
        expect(first?.label, session).toBe("open-preview");
      }
    } finally {
      await f.close();
    }
  }, 60_000);
});

describe("I2 — provenance : pas d'assertion sans exigence qui la justifie", () => {
  it("n'invente pas de refus quand rien n'est déclaré : l'absence est mesurée", () => {
    const withoutRequirement = structuredClone(plan);
    Reflect.deleteProperty(
      withoutRequirement.scenarios[0]!.assertions[0]!,
      "requirement"
    );
    expect(provenanceRefusals(withoutRequirement)).toEqual([]);
  });

  it("refuse un indice hors des exigences du scénario, en nommant la borne", () => {
    const outOfRange = JSON.parse(JSON.stringify(plan)) as Plan;
    outOfRange.scenarios[0]!.assertions[0]!.requirement = 4;
    const refusals = provenanceRefusals(outOfRange);
    expect(refusals[0]?.error.message).toContain("requirement 4");
    expect(refusals[0]?.error.hint).toContain("between 0 and 0");
  });

  it("accepte un plan dont chaque attendu est justifié par son exigence", () => {
    expect(provenanceRefusals(plan)).toEqual([]);
  });

  it("refuse un attendu que l'exigence citée ne justifie pas", () => {
    const invented = structuredClone(plan);
    (invented.scenarios[0]!.assertions[0] as { expected: string }).expected =
      "quarante-deux palettes";
    const refusals = provenanceRefusals(invented);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.error.message).toContain("does not justify");
  });

  it("le prompt du planificateur demande les deux champs", () => {
    expect(PLANNER_PROMPT).toContain("objective field");
    expect(PLANNER_PROMPT.toLowerCase()).toContain(
      "every assertion states its requirement"
    );
  });
});

describe("I3 — preuve d'objectif : pas de vert sans objectif démontré", () => {
  const config = { QA_OBSERVE_ACT: true } as never;

  it("laisse vert un scénario dont l'assertion d'objectif a passé", () => {
    const result = enforceObjectiveProof(scenarioResult(), config);
    expect(result.outcome).toBe("passed");
    expect(result.objectiveProven).toBe(true);
  });

  it("bloque un scénario dont l'objectif a échoué, avec un code nommé", () => {
    const failed = scenarioResult({
      assertions: [{ id: "title", passed: false, actual: "Bye" }],
    });
    const result = enforceObjectiveProof(failed, config);
    expect(result.outcome).toBe("blocked");
    expect(result.objectiveProven).toBe(false);
    expect(result.diagnostic?.code).toBe("CONTRACT_INCOMPLETE");
    expect(result.diagnostic?.message).toContain("did not prove its objective");
  });

  it("bloque un scénario dont l'objectif n'a jamais été exécuté", () => {
    const missing = scenarioResult({
      assertions: [{ id: "other", passed: true, actual: "x" }],
    });
    const result = enforceObjectiveProof(missing, config);
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.message).toContain("never executed");
  });

  it("bloque l'objectif non prouvé même quand la porte d'observation est coupée", () => {
    const failed = scenarioResult({
      assertions: [{ id: "title", passed: false, actual: "Bye" }],
    });
    const result = enforceObjectiveProof(failed, {
      QA_OBSERVE_ACT: false,
    } as never);
    expect(result.outcome).toBe("blocked");
    expect(result.objectiveProven).toBe(false);
  });
});

describe("I4 — réparation non permissive : elle ne touche qu'à l'action", () => {
  const scenario = (): Plan => structuredClone(plan);

  it("ré-ancre une action, garde l'identité du pas et les assertions intactes", async () => {
    const subject = scenario();
    const scenarioBody = subject.scenarios[0]!;
    const before = structuredClone(scenarioBody.assertions);
    const step = {
      id: "save",
      description: "save the form",
      action: {
        type: "click",
        locator: { by: "role", value: "button", name: "Enregistrer" },
      },
    } as Scenario["steps"][number];
    const stub = {
      json: async () => ({ index: 0 }),
    } as never;
    const repaired = await repairStepTarget({
      model: stub,
      preview: "http://fixture/",
      scenario: scenarioBody.id,
      step,
      targets: [{ by: "role", value: "button", name: "Save" } as never],
    });
    expect(repaired).toBeDefined();
    // La cible a changé, rien d'autre.
    expect(repaired!.step.id).toBe(step.id);
    expect(repaired!.step.description).toBe(step.description);
    expect(repaired!.target.name).toBe("Save");
    // Les assertions du scénario n'ont pas bougé : la reprise ne peut pas
    // relâcher un attendu pour faire passer le test.
    expect(scenarioBody.assertions).toEqual(before);
  });
});

describe("I2 — provenance : une valeur que le scénario a lui-même saisie", () => {
  // Premier plan réel de la PR #20 : le commentaire saisi puis relu dans
  // l'historique après la clôture était refusé comme valeur inventée.
  const echo = (
    mutate: (scenario: Plan["scenarios"][number]) => void = () => undefined
  ) => {
    const echoed = structuredClone(fixturePlan);
    const scenario = echoed.scenarios[0]!;
    (scenario.steps[0]!.action as { value: string }).value = "Ada Lovelace";
    Object.assign(scenario.assertions[0]!, {
      description: "Shows the name saved via the form",
      expected: "Ada Lovelace",
      requirement: 0,
    });
    mutate(scenario);
    return provenanceRefusals(echoed);
  };

  it("accepte l'attendu égal à une saisie faite avant l'étape d'ancrage", () => {
    expect(echo()).toEqual([]);
  });

  it("accepte aussi une option choisie par select avant l'ancrage", () => {
    expect(
      echo((scenario) => {
        scenario.steps[0]!.action = {
          type: "select",
          locator: { by: "label", value: "Name" },
          value: " Ada Lovelace ",
        };
      })
    ).toEqual([]);
  });

  it("refuse toujours une valeur que rien n'a saisie", () => {
    const refusals = echo((scenario) => {
      (scenario.steps[0]!.action as { value: string }).value = "Grace Hopper";
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.error.message).toContain("does not justify");
  });

  it("refuse une relecture ancrée sur la saisie elle-même", () => {
    expect(
      echo((scenario) => {
        scenario.assertions[0]!.afterStep = "enter";
      })
    ).toHaveLength(1);
  });

  it("refuse une assertion sans étape d'ancrage", () => {
    expect(
      echo((scenario) => {
        Reflect.deleteProperty(scenario.assertions[0]!, "afterStep");
      })
    ).toHaveLength(1);
  });

  it("refuse une relecture en state : seule une valeur qui a changé prouve quelque chose", () => {
    // Relire en `state` le champ qu'on vient de remplir passait au vert sur une
    // application inerte (ancrage sur une observation, intention invariant,
    // ifPresent sauté) : l'exemption exige transition ou persisted.
    expect(
      echo((scenario) => {
        scenario.assertions[0]!.verification = "state";
      })
    ).toHaveLength(1);
  });

  it("refuse une saisie justifiée par une exigence étrangère à la cible", () => {
    expect(
      echo((scenario) => {
        scenario.requirements[0] = {
          sourceFile: "src/form.ts",
          quote: "publishVarianceCents(total)",
          behavior: "Variance is published in cents",
        };
      })
    ).toHaveLength(1);
  });

  it("refuse une saisie placée après l'étape d'ancrage", () => {
    expect(
      echo((scenario) => {
        const [enter, save, verify] = scenario.steps;
        scenario.steps = [save!, enter!, verify!];
      })
    ).toHaveLength(1);
  });
});
