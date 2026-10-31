import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary, MODEL_SNAPSHOT_CHARS } from "../src/canary.js";
import type * as Policy from "../src/policy.js";
import { runQa } from "../src/runner.js";
import type { Plan } from "../src/schema.js";
import { fixture, PR_URL } from "./fixture.js";

/**
 * Les préconditions non tranchées sont publiées sur le plan qui S'EXÉCUTE :
 * quand la sonde de navigation fait réécrire le plan, ce sont celles du plan
 * réécrit, jamais celles du premier jet. La règle qui les trouve
 * (`planFindings`) a ses propres tests ; ici, chaque scénario du plan en porte
 * une, pour que la publication dise de quel plan elle vient.
 */
vi.mock("../src/policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Policy>();
  return {
    ...actual,
    planFindings: (...args: Parameters<typeof actual.planFindings>) => ({
      ...actual.planFindings(...args),
      unverified: args[0].scenarios.map((scenario) => ({
        assertionId: scenario.assertions[0]?.id ?? "",
        attribute: "data-fixture-state",
        condition: "required",
        scenarioId: scenario.id,
      })),
    }),
  };
});

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(close.splice(0).map((fn) => fn()));
});

const PATCH =
  "- show('Hello')\n+ show('Welcome '+name)\n+ <h1>Pilotage</h1>\n+ <p id=\"saved\"></p>";

const ARIA = `- main [ref=e1]:
  - navigation [ref=e2]:
    - button "Pilotage" [ref=e3]
    - button "P&L" [ref=e4]
  - heading "Pilotage" [level=1] [ref=e5]`;

/** Un clic de navigation avant l'assertion : la sonde observe la vue atteinte. */
function clickedPlan(id: string): Plan {
  return {
    summary: "Le titre de la vue est affiché",
    scenarios: [
      {
        id,
        title: "Le titre de l'en-tête est affiché",
        kind: "regression",
        rationale: "Le titre de page ne doit pas disparaître",
        sourceFiles: ["src/form.ts"],
        preconditions: [],
        steps: [
          {
            id: "load",
            description: "ouvrir la page d'accueil",
            action: { type: "goto", path: "/" },
          },
          {
            id: "open-pl",
            description: "ouvrir l'écran P&L",
            action: {
              type: "click",
              locator: { by: "role", value: "button", name: "P&L" },
            },
          },
          {
            id: "check-heading",
            description: "vérifier le titre",
            action: { type: "assert", assertionId: "heading" },
          },
        ],
        requirements: [
          {
            sourceFile: "src/form.ts",
            quote: "show('Welcome '+name)",
            behavior: "Le titre de la vue par défaut reste affiché",
          },
        ],
        assertions: [
          {
            id: "heading",
            description: "Le titre de l'en-tête est visible",
            kind: "visible",
            target: { by: "role", value: "heading", name: "Pilotage" },
            afterStep: "open-pl",
            verification: "transition",
          },
        ],
      },
    ],
    skipped: [],
  };
}

function stubCanary() {
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("fixture-session");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_id: string, label: string) => ({
      url: "http://fixture/",
      snapshot: ARIA.slice(0, MODEL_SNAPSHOT_CHARS),
      evidence: label === "discover-preview" ? ARIA : undefined,
      actual: label.endsWith("assert") ? true : undefined,
    })
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
}

describe("préconditions non tranchées publiées sur le plan exécuté", () => {
  it("publie celles du plan réécrit par la sonde, pas du premier jet", async () => {
    const f = await fixture({
      formPatch: PATCH,
      plans: [clickedPlan("avant-sonde"), clickedPlan("apres-sonde")],
    });
    close.push(f.close);
    stubCanary();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      { ...f.config, QA_VIEW_PROBE: true }
    );
    expect(result.plan?.scenarios.map((item) => item.id)).toEqual([
      "apres-sonde",
    ]);
    expect(
      result.unverifiedPreconditions?.map((item) => item.scenarioId)
    ).toEqual(["apres-sonde"]);
  });

  it("publie celles du plan unique sans sonde", async () => {
    const f = await fixture({
      formPatch: PATCH,
      plans: [clickedPlan("seul")],
    });
    close.push(f.close);
    stubCanary();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(
      result.unverifiedPreconditions?.map((item) => item.scenarioId)
    ).toEqual(["seul"]);
  });
});
