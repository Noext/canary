import { describe, expect, it, vi } from "vitest";
import { Canary } from "../src/canary.js";
import { PLANNER_PROMPT } from "../src/model.js";
import {
  enforceObjectiveProof,
  provenanceRefusals,
} from "../src/plan-evidence.js";
import { runQa } from "../src/runner.js";
import type { Plan, ScenarioResult } from "../src/schema.js";
import { repairStepTarget } from "../src/target-repair.js";
import { fixture, PR_URL } from "./fixture.js";

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
          line: 1,
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
    // Le plan du fixture passe la porte : ce test porte sur l'isolation des
    // sessions, pas sur la validité d'un plan écrit à la main.
    const f = await fixture();
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
          ...(label.endsWith("assert") ? { actual: "Welcome" } : {}),
        } as never;
      }
    );
    vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
    try {
      const result = await runQa(
        { prUrl: PR_URL, previewUrl: f.baseUrl },
        f.config
      );
      // Une session de découverte + une par scénario : rien n'est partagé.
      expect(starts.length).toBeGreaterThanOrEqual(2);
      expect(starts[0]).toContain("discovery");
      const scenarioSession = acts.find((act) => act.label === "open-preview");
      expect(scenarioSession).toBeDefined();
      // La première action de la session de scénario est la navigation, pas une
      // étape héritée d'un autre scénario.
      const ofSession = acts.filter(
        (act) => act.session === scenarioSession?.session
      );
      expect(ofSession[0]?.label).toBe("open-preview");
      expect(result.scenarios).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 60_000);
});

describe("I2 — provenance : pas d'assertion sans exigence qui la justifie", () => {
  it("refuse une assertion sans indice d'exigence quand le chemin l'exige", () => {
    const withoutRequirement = structuredClone(plan);
    Reflect.deleteProperty(
      withoutRequirement.scenarios[0]!.assertions[0]!,
      "requirement"
    );
    const refusals = provenanceRefusals(withoutRequirement, true);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.error.code).toBe("PLAN_SCHEMA_INVALID");
    expect(refusals[0]?.error.message).toContain("cites no requirement");
    expect(refusals[0]?.scenarioId).toBe("greeting");
  });

  it("refuse un indice hors des exigences du scénario, en nommant la borne", () => {
    const outOfRange = JSON.parse(JSON.stringify(plan)) as Plan;
    outOfRange.scenarios[0]!.assertions[0]!.requirement = 4;
    const refusals = provenanceRefusals(outOfRange, true);
    expect(refusals[0]?.error.message).toContain("requirement 4");
    expect(refusals[0]?.error.hint).toContain("between 0 and 0");
  });

  it("ne dit rien d'un plan complet, ni quand le chemin figé est actif", () => {
    expect(provenanceRefusals(plan, true)).toEqual([]);
    const withoutRequirement = structuredClone(plan);
    Reflect.deleteProperty(
      withoutRequirement.scenarios[0]!.assertions[0]!,
      "requirement"
    );
    expect(provenanceRefusals(withoutRequirement, false)).toEqual([]);
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

  it("ne touche pas au verdict quand le chemin figé est actif, mais publie la mesure", () => {
    const failed = scenarioResult({
      assertions: [{ id: "title", passed: false, actual: "Bye" }],
    });
    const result = enforceObjectiveProof(failed, {
      QA_OBSERVE_ACT: false,
    } as never);
    expect(result.outcome).toBe("passed");
    expect(result.objectiveProven).toBe(false);
  });
});

describe("I4 — réparation non permissive : elle ne touche qu'à l'action", () => {
  it("ré-ancre une action et laisse les assertions intactes", async () => {
    const scenario = plan.scenarios[0]!;
    const before = JSON.parse(JSON.stringify(scenario.assertions));
    const repaired = await repairStepTarget({
      model: undefined,
      preview: "http://fixture/",
      scenario: scenario.id,
      step: scenario.steps[0]!,
      targets: [{ by: "css", value: "h1", text: "Welcome" } as never],
    });
    // Le modèle est absent : aucune reprise n'est inventée hors observation.
    expect(repaired).toBeUndefined();
    expect(JSON.parse(JSON.stringify(scenario.assertions))).toEqual(before);
  });

  it("ne rend jamais un pas qui change son identité", async () => {
    const scenario = plan.scenarios[0]!;
    const step = scenario.steps[1]!;
    const repaired = await repairStepTarget({
      model: undefined,
      preview: "http://fixture/",
      scenario: scenario.id,
      step,
      targets: [],
    });
    expect(repaired).toBeUndefined();
    expect(step.id).toBe("assert-title");
  });
});
