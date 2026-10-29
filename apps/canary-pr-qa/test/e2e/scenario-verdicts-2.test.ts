import { afterEach, expect, it, vi } from "vitest";
import { Canary } from "../../src/canary.js";
import { classifyFailure } from "../../src/diagnostics.js";
import { executeScenario } from "../../src/executor.js";
import { fixture, plan } from "../fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

it("blames the plan for a state assertion already satisfied before a real click", async () => {
  const f = await fixture({ unchangedState: true });
  closers.push(f.close);
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.id = "already-satisfied-state";
  scenario.assertions[0]!.verification = "state";
  const result = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config)
  );
  // La valeur d'arrivée est identique à celle d'avant, et celle d'avant
  // satisfaisait déjà l'attendu : l'étape n'a rien produit de vérifiable.
  expect(result.outcome, result.error).toBe("blocked");
  expect(result.diagnostic?.code).toBe("STATE_ALREADY_SATISFIED");
  expect(result.assertions[0]).toMatchObject({
    actual: "Welcome Ada",
    baseline: "Welcome Ada",
    passed: false,
    preMatched: true,
  });
  // Le blâme va au plan dans les DEUX taxonomies : `classifyFailure` (rapport et
  // mesures) et `classifyScenarioResult` (chemin observe→act, lu par
  // `enforceObjectiveProof`). Un code de défaut de plan absent de la seconde
  // faisait sortir le scénario `indeterminate`.
  expect(classifyFailure({ code: result.diagnostic?.code })).toBe(
    "plan-defective"
  );
  expect(result.classification).toBe("test-defect");
}, 180_000);
it("keeps a skipped ifPresent establishment green in real Chromium", async () => {
  // L'établissement tolérant : le contrôle n'existe pas sur cette page, l'étape
  // est sautée et l'assertion d'état constate l'état voulu. Le plan a déclaré le
  // no-op, donc la pré-satisfaction reste légitime.
  const f = await fixture({ unchangedState: true });
  closers.push(f.close);
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.id = "skipped-establishment";
  scenario.steps = [
    scenario.steps[0]!,
    {
      id: "reopen",
      description: "réouvrir le comptage si le contrôle est présent",
      action: {
        type: "click",
        ifPresent: true,
        locator: { by: "role", value: "button", name: "Réouvrir le comptage" },
      },
    },
    {
      id: "verify",
      description: "relire l'état",
      action: { type: "assert", assertionId: "saved" },
    },
  ];
  const assertion = scenario.assertions[0]!;
  assertion.afterStep = "reopen";
  assertion.verification = "state";
  const result = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config)
  );
  expect(result.outcome, result.error).toBe("passed");
  expect(result.steps.find((step) => step.stepId === "reopen")?.skipped).toBe(
    true
  );
  expect(result.assertions[0]).toMatchObject({ passed: true });
}, 180_000);
it("keeps an assertion anchored on the initial navigation green in real Chromium", async () => {
  // Ancre navigation : aucune valeur d'avant n'est relevée, donc aucune
  // pré-satisfaction ne peut être inventée, même quand la page porte déjà
  // l'attendu au chargement.
  const f = await fixture({ unchangedState: true });
  closers.push(f.close);
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.id = "navigation-anchor";
  scenario.steps = [
    {
      id: "load",
      description: "ouvrir la page",
      action: { type: "goto", path: "/" },
    },
    {
      id: "verify",
      description: "relire l'état",
      action: { type: "assert", assertionId: "saved" },
    },
  ];
  const assertion = scenario.assertions[0]!;
  assertion.afterStep = "load";
  assertion.verification = "state";
  const result = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config)
  );
  expect(result.outcome, result.error).toBe("passed");
  expect(result.assertions[0]).toMatchObject({ passed: true });
  expect(result.assertions[0]).not.toHaveProperty("preMatched");
}, 180_000);
