import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Canary, type Observation } from "../src/canary.js";
import { loadConfig } from "../src/config.js";
import { executeScenario } from "../src/executor.js";
import { PLANNER_PROMPT } from "../src/model.js";
import { type Scenario, ScenarioSchema } from "../src/schema.js";

/**
 * The banner assertion of pharmania/arpilabe-pilotage#9
 * (`preview-banner-after-view-change`): the plan asked for a `transition` on an
 * element that must not change, so the value probed before and after the click
 * was identical and the scenario failed while `actual` and `baseline` agreed.
 */
const BANNER = "Aperçu de PR · vérifié par Canary";
const DESCRIPTION =
  "le repère affiche toujours « Aperçu de PR · vérifié par Canary » après le changement de vue";

function bannerScenario(
  verification: "transition" | "persisted" = "transition"
): Scenario {
  return ScenarioSchema.parse({
    id: "preview-banner-after-view-change",
    title: "Le repère d'aperçu survit au changement de vue",
    rationale: "La PR change la vue sans toucher au repère de preview",
    kind: "regression",
    sourceFiles: ["src/view.ts"],
    preconditions: [],
    requirements: [
      {
        sourceFile: "src/view.ts",
        quote: "preview banner",
        behavior:
          "Le repère de preview reste affiché après le changement de vue",
      },
    ],
    steps: [
      {
        id: "go-pnl",
        description: "afficher la vue P&L",
        action: {
          type: "click",
          locator: { by: "text", value: "P&L" },
        },
      },
      {
        id: "banner-after",
        description: "relire le repère",
        action: { type: "assert", assertionId: "banner-text-after" },
      },
    ],
    assertions: [
      {
        id: "banner-text-after",
        description: DESCRIPTION,
        kind: "text",
        expected: BANNER,
        target: { by: "css", value: '[data-canary-preview="pr"]' },
        afterStep: "go-pnl",
        verification,
      },
    ],
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

async function runBanner(
  verification: "transition" | "persisted",
  values: { actual: string; baseline: string; persisted?: string }
) {
  const dataDir = await mkdtemp(join(tmpdir(), "canary-transition-"));
  cleanups.push(() => rm(dataDir, { force: true, recursive: true }));
  const preview = "http://127.0.0.1:9/preview";
  const config = loadConfig({
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    OPENAI_MODEL: "fixture-scripted-model",
    QA_ALLOW_PRIVATE_PREVIEWS: "true",
    QA_API_TOKEN: "fixture-api-token-123456789012345",
    QA_DATA_DIR: dataDir,
  });
  const observation = (actual: string): Observation => ({
    actual,
    snapshot: `repère : ${actual}`,
    url: preview,
  });
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("transition-evidence");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_session, label) => {
      if (label.startsWith("baseline-")) {
        return observation(values.baseline);
      }
      if (label.startsWith("persistence-")) {
        return observation(values.persisted ?? values.actual);
      }
      return observation(values.actual);
    }
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
  return executeScenario(
    bannerScenario(verification),
    preview,
    dataDir,
    config,
    new Canary(config)
  );
}

it("explains an unchanged transition instead of recopying the assertion description", async () => {
  const result = await runBanner("transition", {
    actual: BANNER,
    baseline: BANNER,
  });
  expect(result.outcome).toBe("failed");
  expect(result.assertions[0]).toMatchObject({
    actual: BANNER,
    baseline: BANNER,
    passed: false,
  });
  expect(result.diagnostic?.code).toBe("TRANSITION_NOT_OBSERVED");
  expect(result.error).toBe(result.diagnostic?.message);
  expect(result.error).toMatch(/banner-text-after/);
  expect(result.error).toMatch(/go-pnl/);
  expect(result.error).toMatch(/identical to the baseline/);
  expect(result.error).not.toContain(DESCRIPTION);
  expect(result.diagnostic?.hint).toMatch(/"state"/);
  expect(result.diagnostic?.hint).toMatch(/afterStep/);
});

it("passes a transition whose value changed to the expected one", async () => {
  const result = await runBanner("transition", {
    actual: BANNER,
    baseline: "Aperçu de PR",
  });
  expect(result.outcome, result.error).toBe("passed");
  expect(result.assertions[0]).toMatchObject({
    actual: BANNER,
    baseline: "Aperçu de PR",
    passed: true,
  });
  expect(result.diagnostic).toBeUndefined();
  expect(result.error).toBeUndefined();
});

it("still fails a changed value that does not match the expected one", async () => {
  const result = await runBanner("transition", {
    actual: "Tableau P&L",
    baseline: BANNER,
  });
  expect(result.outcome).toBe("failed");
  expect(result.assertions[0]).toMatchObject({
    actual: "Tableau P&L",
    baseline: BANNER,
    passed: false,
  });
  expect(result.diagnostic).toBeUndefined();
  expect(result.error).toBe(
    `Assertion banner-text-after failed: ${DESCRIPTION}`
  );
});

it("explains an unchanged persisted value the same way after the reload", async () => {
  const result = await runBanner("persisted", {
    actual: BANNER,
    baseline: BANNER,
    persisted: BANNER,
  });
  expect(result.outcome).toBe("failed");
  expect(result.assertions[0]).toMatchObject({
    actual: BANNER,
    baseline: BANNER,
    passed: false,
    persisted: BANNER,
  });
  expect(result.diagnostic?.code).toBe("TRANSITION_NOT_OBSERVED");
  expect(result.error).not.toContain(DESCRIPTION);
});

it("states the three verification semantics to the planner", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  expect(prompt).toMatch(/state means the value must match expected/i);
  expect(prompt).toMatch(
    /transition means the value must differ from the value probed before the step/i
  );
  expect(prompt).toMatch(
    /persisted means the value must survive the reload and differ from the baseline/i
  );
  expect(prompt).toMatch(
    /use state with afterStep set to the interaction step/i
  );
});

it("teaches that a text assertion never reads an attribute value", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // Défaut mesuré du run 1b49d751 : `text` sur `[data-cash-state]` attendant
  // « ouvert », alors que `innerText` de ce conteneur rend toute la vue et que
  // l'attribut n'y figure jamais. La consigne nomme la lecture réelle, la voie
  // correcte (présence sur la valeur de l'attribut, ou texte visible) et
  // l'établissement de l'état par une étape observable.
  expect(prompt).toMatch(
    /kind "text" reads the visible text INSIDE the target \(innerText\), never one of its attributes/i
  );
  expect(prompt).toMatch(
    /Never plan kind "value" on an element that is not an input/i
  );
  expect(prompt).toMatch(
    /\[data-cash-state="ouvert"\] with kind "visible", or kind "count" expecting 1/i
  );
  expect(prompt).toMatch(
    /must ESTABLISH that state with an observable step before asserting it/i
  );
  expect(prompt).toMatch(/put the "ouvert" assertion AFTER that step/i);
});

it("teaches the two readable forms and when a transition is provable", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // Sonde P3 : une étape d'établissement vérifiée en `transition` échoue en
  // TRANSITION_NOT_OBSERVED quand l'état est déjà le bon. Sonde P5 : la règle
  // ne doit pas confondre un sélecteur d'attribut d'état avec un rôle dont le
  // texte visible est le contenu.
  expect(prompt).toMatch(
    /put the "ouvert" assertion AFTER that step, with verification "state" on the step that established it/i
  );
  expect(prompt).toMatch(
    /verification "transition" is only for a step that genuinely moves the value/i
  );
  expect(prompt).toMatch(
    /\[role="status"\] is a region whose visible text IS its content, so kind "text" on it is fine/i
  );
});

it("limits ifPresent to an establishing step and names its two consequences", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // L'option rend un clic tolérant à l'absence, ce qui est vrai seulement pour
  // une étape qui établit un état : sur une action métier, elle masquerait un
  // vrai défaut. Son étape sautée ne démontre pas de transition.
  expect(prompt).toMatch(
    /Declare that establishing click with "ifPresent": true on the click action/i
  );
  expect(prompt).toMatch(
    /Use "ifPresent" ONLY on such an establishing step, never on a business action that must happen/i
  );
  expect(prompt).toMatch(
    /A skipped establishing step cannot demonstrate a transition/i
  );
});
