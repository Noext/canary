import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary } from "../src/canary.js";
import {
  provenanceRefusals,
  upgradeEchoedStateReads,
} from "../src/plan-evidence.js";
import { runQa } from "../src/runner.js";
import type { Plan, Scenario } from "../src/schema.js";
import { fixture, plan as fixturePlan, PR_URL } from "./fixture.js";

/**
 * Banc PR #20, run 3 : le commentaire saisi, relu en `state` dans l'historique
 * après « Clôturer la session », était refusé comme valeur inventée. La saisie
 * relue après un clic RÉEL sur un AUTRE élément est désormais lue en
 * `transition` (avant ≠ après), jamais acceptée en `state` : rien ne repose sur
 * STATE_ALREADY_SATISFIED.
 */
type Mutation = (scenario: Scenario) => void;

const echoed = (mutate: Mutation = () => undefined): Plan => {
  const plan = structuredClone(fixturePlan);
  const scenario = plan.scenarios[0]!;
  scenario.objective = "saved";
  (scenario.steps[0]!.action as { value: string }).value = "Ada Lovelace";
  Object.assign(scenario.assertions[0]!, {
    description: "Shows the name saved via the form",
    expected: "Ada Lovelace",
    requirement: 0,
    verification: "state",
  });
  mutate(scenario);
  return plan;
};

/** Le surclassement, puis la porte de provenance sur le plan réglé. */
const settle = (mutate?: Mutation) => {
  const plan = echoed(mutate);
  const upgraded = upgradeEchoedStateReads(plan);
  return {
    upgraded,
    verification: plan.scenarios[0]!.assertions[0]!.verification,
    refusals: provenanceRefusals(plan),
  };
};

describe("surclassement d'une saisie relue en state", () => {
  it("lit en transition la saisie relue après un clic sur le bouton d'envoi", () => {
    const { upgraded, verification, refusals } = settle();
    expect(upgraded).toEqual([{ assertionId: "saved", scenarioId: "welcome" }]);
    expect(verification).toBe("transition");
    expect(refusals).toEqual([]);
  });

  it("refuse toujours une saisie relue sans clic", () => {
    // Ancrée sur la saisie elle-même, puis sur une observation : aucune action
    // réelle sur un autre élément n'a pu produire la valeur.
    const onFill = settle((scenario) => {
      scenario.assertions[0]!.afterStep = "enter";
    });
    expect(onFill.upgraded).toEqual([]);
    expect(onFill.verification).toBe("state");
    expect(onFill.refusals).toHaveLength(1);
    expect(onFill.refusals[0]?.error.message).toContain("does not justify");
    const onObserve = settle((scenario) => {
      scenario.steps[1] = {
        id: "save",
        description: "Look at the page",
        action: { type: "observe" },
      };
    });
    expect(onObserve.upgraded).toEqual([]);
    expect(onObserve.refusals).toHaveLength(1);
  });

  it("refuse toujours un clic sur le champ saisi lui-même", () => {
    const { upgraded, verification, refusals } = settle((scenario) => {
      scenario.steps[1]!.action = {
        type: "click",
        locator: { by: "label", value: "Name" },
      };
    });
    expect(upgraded).toEqual([]);
    expect(verification).toBe("state");
    expect(refusals).toHaveLength(1);
  });

  it("refuse toujours la relecture du champ saisi, même après un vrai clic", () => {
    const { upgraded, refusals } = settle((scenario) => {
      scenario.assertions[0]!.target = { by: "label", value: "Name" };
    });
    expect(upgraded).toEqual([]);
    expect(refusals).toHaveLength(1);
  });

  it("ne surclasse ni un clic ifPresent, ni une intention déclarée", () => {
    const skippable = settle((scenario) => {
      (scenario.steps[1]!.action as { ifPresent?: boolean }).ifPresent = true;
    });
    expect(skippable.upgraded).toEqual([]);
    expect(skippable.refusals).toHaveLength(1);
    for (const intent of ["invariant", "persistence"] as const) {
      const declared = settle((scenario) => {
        scenario.assertions[0]!.assertionIntent = intent;
      });
      expect(declared.upgraded, intent).toEqual([]);
      expect(declared.verification, intent).toBe("state");
    }
  });

  it("ne surclasse pas une saisie placée après le clic", () => {
    const { upgraded, refusals } = settle((scenario) => {
      const [enter, save, verify] = scenario.steps;
      scenario.steps = [save!, enter!, verify!];
    });
    expect(upgraded).toEqual([]);
    expect(refusals).toHaveLength(1);
  });

  it("ne blanchit pas une saisie par une exigence étrangère à la cible", () => {
    const { upgraded, refusals } = settle((scenario) => {
      scenario.requirements[0] = {
        sourceFile: "src/form.ts",
        quote: "publishVarianceCents(total)",
        behavior: "Variance is published in cents",
      };
    });
    expect(upgraded).toEqual([]);
    expect(refusals).toHaveLength(1);
  });

  it("laisse en state une relecture que l'exigence citée justifie déjà", () => {
    const { upgraded, verification, refusals } = settle((scenario) => {
      (scenario.steps[0]!.action as { value: string }).value = "Welcome Ada";
      (scenario.assertions[0] as { expected: string }).expected = "Welcome Ada";
    });
    expect(upgraded).toEqual([]);
    expect(verification).toBe("state");
    expect(refusals).toEqual([]);
  });
});

describe("surclassement au règlement du plan, puis exécution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Exécute le plan surclassé contre une page simulée : `before` est ce que la
   * cible montre avant le clic, la relecture montre toujours la saisie.
   */
  const run = async (before: string) => {
    const f = await fixture({ plans: [echoed()] });
    vi.spyOn(Canary.prototype, "start").mockResolvedValue("session");
    vi.spyOn(Canary.prototype, "act").mockImplementation(
      async (_session, label) =>
        ({
          url: "http://fixture/",
          snapshot: "textbox Name, button Save",
          ...(label.startsWith("baseline-") ? { actual: before } : {}),
          ...(label.endsWith("assert") ? { actual: "Ada Lovelace" } : {}),
        }) as never
    );
    vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
    try {
      return await runQa({ prUrl: PR_URL, previewUrl: f.baseUrl }, f.config);
    } finally {
      await f.close();
    }
  };

  it("passe quand la valeur apparaît après le clic", async () => {
    const result = await run("");
    expect(result.plan?.scenarios[0]?.assertions[0]?.verification).toBe(
      "transition"
    );
    expect(result.scenarios[0]?.assertions[0]).toMatchObject({
      passed: true,
      verification: "transition",
    });
    expect(result.outcome).toBe("passed");
  }, 60_000);

  it("n'est jamais vert quand la valeur était déjà là avant le clic", async () => {
    // Une application inerte, ou un historique qui affichait déjà la saisie :
    // le clic n'a rien produit, la transition n'est pas démontrée.
    const result = await run("Ada Lovelace");
    expect(result.scenarios[0]?.assertions[0]).toMatchObject({
      passed: false,
      verification: "transition",
    });
    expect(result.scenarios[0]?.outcome).not.toBe("passed");
    expect(result.outcome).not.toBe("passed");
  }, 60_000);
});
