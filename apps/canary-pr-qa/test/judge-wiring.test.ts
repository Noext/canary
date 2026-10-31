import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary, MODEL_SNAPSHOT_CHARS } from "../src/canary.js";
import { Model } from "../src/model.js";
import { runQa } from "../src/runner.js";
import type { Plan } from "../src/schema.js";
import { fixture, PR_URL } from "./fixture.js";

/**
 * Le runner transmet le titre et les fichiers de la PR au jugement contre la
 * base : c'est le SEUL chemin de production de la règle `refactor` (point 3
 * du plan du juge) et de l'exemption du littéral ajouté (point 5, correctif
 * 2). Les tests de `compareWithBaseline` passent ces arguments eux-mêmes ;
 * ceux-ci passent par `runQa`, de la requête GitHub au verdict.
 */
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(close.splice(0).map((fn) => fn()));
});

/** Le diff écrit `#saved` (témoin de l'objectif) et le bouton ajouté. */
const PATCH = [
  "- show('Hello')",
  "+ show('Welcome '+name)",
  '+ <p id="saved"></p>',
  "+ <button>Remettre à zéro</button>",
].join("\n");

const ARIA = `- main [ref=e1]:
  - heading "Pilotage" [level=1] [ref=e2]`;

function plan(kind: "happy_path" | "regression", secondary: boolean): Plan {
  return {
    summary: "Le message d'accueil",
    scenarios: [
      {
        id: "accueil",
        title: "Le message d'accueil est affiché",
        kind,
        rationale: "Le diff change le message affiché",
        sourceFiles: ["src/form.ts"],
        preconditions: [],
        objective: "accueil-texte",
        steps: [
          {
            id: "load",
            description: "ouvrir la page d'accueil",
            action: { type: "goto", path: "/" },
          },
          {
            id: "check",
            description: "lire le message",
            action: { type: "assert", assertionId: "accueil-texte" },
          },
          ...(secondary
            ? [
                {
                  id: "check-reset",
                  description: "voir le bouton de remise à zéro",
                  action: { type: "assert", assertionId: "reset" },
                },
              ]
            : []),
        ],
        requirements: [
          {
            sourceFile: "src/form.ts",
            quote: "show('Welcome '+name)",
            behavior: "Le message d'accueil nomme l'utilisateur",
          },
        ],
        assertions: [
          {
            id: "accueil-texte",
            description: "le message d'accueil nomme l'utilisateur",
            kind: "text",
            target: { by: "css", value: "#saved" },
            afterStep: "load",
            verification: "state",
            expected: "Welcome Ada",
            requirement: 0,
          },
          ...(secondary
            ? [
                {
                  id: "reset",
                  description: "le bouton Remettre à zéro est visible",
                  kind: "visible",
                  target: { by: "text", value: "Remettre à zéro" },
                  afterStep: "load",
                  verification: "state",
                },
              ]
            : []),
        ],
      },
    ],
    skipped: [],
  } as unknown as Plan;
}

/**
 * Canary scripté : chaque côté lit sa valeur par étape d'assertion (libellé
 * `<index>-assert`, numéroté à partir de 1). La base est ouverte sur `/baseline`.
 */
function stubSides(
  head: Record<string, unknown>,
  base: Record<string, unknown>
) {
  let onBase = false;
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("wiring-session");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_id: string, label: string, script: string) => {
      if (label === "open-preview") {
        onBase = script.includes("/baseline");
      }
      const discovery = label === "discover-preview";
      return {
        url: "http://fixture/",
        snapshot: ARIA.slice(0, MODEL_SNAPSHOT_CHARS),
        evidence: discovery ? ARIA : undefined,
        actual: discovery ? undefined : (onBase ? base : head)[label],
      };
    }
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
}

async function run(
  title: string,
  scripted: Plan,
  sides: { base: Record<string, unknown>; head: Record<string, unknown> }
) {
  const f = await fixture({ formPatch: PATCH, title });
  close.push(f.close);
  stubSides(sides.head, sides.base);
  vi.spyOn(Model.prototype, "json").mockImplementation((async () =>
    structuredClone(scripted)) as unknown as Model["json"]);
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    { ...f.config, QA_BASELINE_URL_TEMPLATE: `${f.baseUrl}/baseline` }
  );
  return { result, scenario: result.scenarios[0]! };
}

describe("titre et fichiers de la PR jusqu'au jugement contre la base", () => {
  const changed = {
    head: { "2-assert": "Welcome Ada" },
    base: { "2-assert": "Hello" },
  };

  it("un titre `feat` laisse un écart tête≠base en changement", async () => {
    const { result, scenario } = await run(
      "feat: accueil nominatif",
      plan("happy_path", false),
      changed
    );
    expect(scenario.diagnostic?.code).toBeUndefined();
    expect(scenario.outcome).toBe("passed");
    expect(result.baselineComparison?.changes).toHaveLength(1);
  });

  it("un titre `refactor` juge le même écart comme une régression", async () => {
    const { result, scenario } = await run(
      "refactor(accueil): extraire le message",
      plan("happy_path", false),
      changed
    );
    expect(scenario.outcome).toBe("failed");
    expect(scenario.diagnostic?.code).toBe("BASELINE_REGRESSION");
    expect(result.outcome).toBe("failed");
  });

  it("le littéral que le diff ajoute exempte l'assertion annexe d'un scénario `regression`", async () => {
    // L'objectif est inchangé des deux côtés ; le bouton ajouté est absent
    // de la base. Sans les fichiers transmis, l'annexe serait escaladée.
    const { result, scenario } = await run(
      "feat(caisse): remise à zéro",
      plan("regression", true),
      {
        head: { "2-assert": "Welcome Ada", "3-assert": true },
        base: { "2-assert": "Welcome Ada", "3-assert": false },
      }
    );
    expect(scenario.diagnostic?.code).toBeUndefined();
    expect(scenario.outcome).toBe("passed");
    expect(result.baselineComparison?.regressions).toEqual([]);
    expect(
      result.baselineComparison?.changes.map((item) => item.assertionId)
    ).toEqual(["reset"]);
  });
});
