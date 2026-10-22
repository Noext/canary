import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary } from "../src/canary.js";
import type { Config } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { executeScenario } from "../src/executor.js";
import {
  type Assertion,
  type Plan,
  PlanSchema,
  type Scenario,
} from "../src/schema.js";
import { fixture } from "./fixture.js";
import { LOT_AH_PLAN } from "./lot-ah-plan.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/**
 * La valeur que le navigateur rend pour une assertion satisfaite : `visible` et
 * `hidden` se comparent à un booléen, `text` à une inclusion, les autres kinds à
 * l'égalité stricte. Le rejeu ne simule pas l'application — les runs de
 * production l'ont fait — il ne vérifie que le compte des étapes du contrat.
 */
function satisfied(assertion: Assertion): unknown {
  if (assertion.kind === "visible") {
    return true;
  }
  if (assertion.kind === "hidden") {
    return false;
  }
  if (assertion.kind === "text") {
    return `préambule ${assertion.expected} épilogue`;
  }
  return assertion.expected;
}

/**
 * Le navigateur du rejeu, étiqueté comme l'exécuteur étiquette ses appels :
 * `N-<action>` pour l'étape N, `baseline-<assertion>` pour la sonde qui précède
 * une transition. La sonde de référence rend une valeur qui n'est pas celle de
 * l'assertion : une transition attend un changement, et un rejeu qui rendrait la
 * même valeur ferait échouer le scénario pour une autre raison que celle qu'on
 * mesure ici.
 */
function browserFor(scenario: Scenario) {
  return async (_sessionId: string, label: string) => {
    if (label.startsWith("baseline-")) {
      return { url: "", snapshot: "", actual: "état d'avant l'interaction" };
    }
    const step = scenario.steps[Number.parseInt(label, 10) - 1];
    const action = step?.action;
    if (action?.type !== "assert") {
      return { url: "", snapshot: "" };
    }
    const assertion = scenario.assertions.find(
      (item) => item.id === action.assertionId
    );
    return {
      url: "",
      snapshot: "",
      ...(assertion ? { actual: satisfied(assertion) } : {}),
    };
  };
}

async function play(
  scenario: Scenario,
  config: Config,
  root: string,
  preview: string
) {
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("test");
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
  vi.spyOn(Canary.prototype, "act").mockImplementation(browserFor(scenario));
  return executeScenario(scenario, preview, root, config, new Canary(config));
}

describe("contrat joué en entier et refusé comme incomplet (run 91fb1e35)", () => {
  const plan: Plan = PlanSchema.parse(LOT_AH_PLAN);

  it("ne garde du run que ce que l'artefact porte : six scénarios, une étape observe en tête", () => {
    expect(plan.scenarios).toHaveLength(6);
    expect(
      plan.scenarios.map((scenario) => scenario.steps[0]?.action.type)
    ).toEqual(Array.from({ length: 6 }, () => "observe"));
    expect(
      plan.scenarios.reduce(
        (total, scenario) => total + scenario.steps.length,
        0
      )
    ).toBe(50);
  });

  it("rejoue les six scénarios bloqués sans en bloquer un seul", async () => {
    const f = await fixture();
    closers.push(f.close);
    for (const scenario of plan.scenarios) {
      const result = await play(scenario, f.config, f.dataDir, f.baseUrl);
      expect(result.outcome, `${scenario.id}: ${result.error ?? ""}`).toBe(
        "passed"
      );
      // Le contrat relevé est le contrat planifié, étape par étape et dans
      // l'ordre : `observe` en fait partie, comme les douze autres du scénario
      // de clôture.
      expect(result.contract?.completedSteps).toEqual(
        scenario.steps.map((step) => step.id)
      );
      expect(result.contract?.totalSteps).toBe(scenario.steps.length);
      expect(result.assertions.every((item) => item.passed)).toBe(true);
      vi.restoreAllMocks();
    }
  });

  it("ne déclare pas joué un contrat interrompu par une étape en échec", async () => {
    // Un contrat interrompu n'est pas un contrat joué : le relevé s'arrête à
    // l'étape qui a échoué, et le diagnostic reste bloquant.
    const f = await fixture();
    closers.push(f.close);
    const scenario = plan.scenarios[0]!;
    vi.spyOn(Canary.prototype, "start").mockResolvedValue("test");
    vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
    vi.spyOn(Canary.prototype, "act").mockImplementation(
      async (sessionId, label) => {
        if (label === "2-click") {
          throw new QaError(
            "TARGET_NOT_FOUND",
            "locator resolved to nothing",
            "Check the target."
          );
        }
        return browserFor(scenario)(sessionId, label);
      }
    );
    const result = await executeScenario(
      scenario,
      f.baseUrl,
      f.dataDir,
      f.config,
      new Canary(f.config)
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("TARGET_NOT_FOUND");
    expect(result.contract?.completedSteps).toEqual(["open"]);
    expect(result.contract?.completedSteps).not.toEqual(
      scenario.steps.map((step) => step.id)
    );
  });
});
