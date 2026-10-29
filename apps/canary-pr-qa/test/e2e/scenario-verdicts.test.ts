import { afterEach, expect, it, vi } from "vitest";
import { Canary } from "../../src/canary.js";
import { classifyFailure } from "../../src/diagnostics.js";
import { executeScenario } from "../../src/executor.js";
import { runQa } from "../../src/runner.js";
import { fixture, PR_URL, plan } from "../fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

it("blames the plan for a transition on an invariant, and the application for a missed one", async () => {
  const f = await fixture({ unchangedState: true });
  closers.push(f.close);
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  // La page n'a pas bougé ET le libellé attendu est déjà celui qui s'affiche :
  // le plan a exigé un changement sur un invariant, donc le verdict nomme le
  // plan (`blocked`) au lieu d'accuser l'application (`failed`).
  expect(result.outcome, result.scenarios[0]?.error).toBe("blocked");
  expect(result.scenarios[0]?.diagnostic?.code).toBe("TRANSITION_ON_INVARIANT");
  expect(result.scenarios[0]?.assertions[0]).toMatchObject({
    baseline: "Welcome Ada",
    actual: "Welcome Ada",
    passed: false,
  });
  const differentName = structuredClone(plan.scenarios[0]!);
  differentName.id = "unchanged-grace";
  const enter = differentName.steps[0]!.action;
  if (enter.type !== "fill") {
    throw new Error("Expected form input");
  }
  enter.value = "Grace";
  const assertion = differentName.assertions[0]!;
  if (assertion.kind !== "text") {
    throw new Error("Expected text assertion");
  }
  assertion.expected = "Welcome Grace";
  const alternate = await executeScenario(
    differentName,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config)
  );
  // Ici l'attendu n'est pas atteint : l'application n'a pas fait ce que
  // l'étape promettait, et le verdict reste un échec.
  expect(alternate.outcome, alternate.error).toBe("failed");
  expect(alternate.diagnostic?.code).toBe("TRANSITION_NOT_OBSERVED");
  expect(alternate.assertions[0]).toMatchObject({
    baseline: "Welcome Ada",
    actual: "Welcome Ada",
    passed: false,
  });
}, 180_000);
/**
 * Le faux vert de `STATE_ALREADY_SATISFIED`, sur une page réelle : `#saved` porte
 * déjà « Welcome Ada » au chargement, et le gestionnaire de soumission se
 * réécrit lui-même (option `unchangedState`), donc le clic ne déplace rien.
 * L'assertion `state` constatait cet état initial et le scénario sortait vert.
 *
 * Le même plan en `transition` est le test précédent (`TRANSITION_ON_INVARIANT`).
 * L'exécution passe par `executeScenario` directement, comme la seconde moitié
 * de ce test : un scénario qui interagit sans preuve de changement est refusé
 * avant exécution par `writeEvidenceRefusals` (`WRITE_EVIDENCE_MISSING`), ce qui
 * est la politique du plan et n'a pas changé ici.
 */
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
