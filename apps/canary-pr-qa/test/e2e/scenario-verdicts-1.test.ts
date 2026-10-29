import { afterEach, expect, it, vi } from "vitest";
import { Canary } from "../../src/canary.js";
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
