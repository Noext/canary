import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary, type Observation } from "../src/canary.js";
import { loadConfig } from "../src/config.js";
import { executeScenario } from "../src/executor.js";
import { type Scenario, ScenarioSchema } from "../src/schema.js";

/**
 * Faux vert mesuré par la campagne entrelacée (73/465 assertions, 15,7 %) : une
 * assertion `state` ancrée sur une interaction dont la valeur satisfaisait déjà
 * l'attendu AVANT l'étape, et que l'étape laisse identique, était comptée
 * `passed`. Le scénario était donc vert sans que l'interaction ait produit quoi
 * que ce soit — la valeur venait de l'état initial de la page.
 *
 * Ces tests fixent les deux côtés de la règle : ce cas doit cesser de passer, et
 * les formes légitimes d'une assertion déjà satisfaite doivent continuer de
 * passer. Les formes visées sont celles que le code distingue déjà : pas de
 * valeur d'avant pour une navigation, sonde d'avant en échec (cible rendue après
 * l'interaction), étape `ifPresent` sautée (le plan a déclaré le no-op), valeur
 * réellement déplacée par l'étape, valeur identique qui n'atteint pas l'attendu.
 */

const BANNER = "Aperçu de PR · vérifié par Canary";
const OTHER = "Aperçu de PR";

interface Shape {
  /** Ancre de l'assertion : l'étape dont elle prétend prouver l'effet. */
  afterStep?: string;
  /** Étape de clic déclarée `ifPresent`, donc susceptible d'être sautée. */
  ifPresent?: boolean;
}

function scenario(shape: Shape): Scenario {
  return ScenarioSchema.parse({
    id: "banner-state",
    title: "Le repère d'aperçu est présent après le changement de vue",
    rationale: "La PR déplace le repère d'aperçu",
    kind: "regression",
    sourceFiles: ["src/view.ts"],
    preconditions: [],
    requirements: [
      {
        sourceFile: "src/view.ts",
        quote: "preview banner",
        behavior: "Le repère d'aperçu est affiché",
      },
    ],
    steps: [
      {
        id: "load",
        description: "ouvrir la page",
        action: { type: "goto", path: "/" },
      },
      {
        id: "open",
        description: "afficher la vue P&L",
        action: {
          type: "click",
          ...(shape.ifPresent ? { ifPresent: true } : {}),
          locator: { by: "text", value: "P&L" },
        },
      },
      {
        id: "check",
        description: "relire le repère",
        action: { type: "assert", assertionId: "banner" },
      },
    ],
    assertions: [
      {
        id: "banner",
        description: "le repère d'aperçu est lisible",
        kind: "text",
        expected: BANNER,
        target: { by: "css", value: '[data-canary-preview="pr"]' },
        ...(shape.afterStep === undefined
          ? {}
          : { afterStep: shape.afterStep }),
        verification: "state",
      },
    ],
  });
}

interface Probes {
  /** Valeur lue après l'étape. */
  actual: string;
  /** Valeur lue avant l'étape, par la sonde d'avant. */
  baseline?: string;
  /** Vrai quand la sonde d'avant échoue (cible absente avant l'interaction). */
  baselineFails?: boolean;
  /** Cible du clic `ifPresent` absente : l'étape est sautée. */
  targetAbsent?: boolean;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

async function run(value: Scenario, probes: Probes) {
  const dataDir = await mkdtemp(join(tmpdir(), "canary-state-evidence-"));
  cleanups.push(() => rm(dataDir, { force: true, recursive: true }));
  const preview = "http://127.0.0.1:9/preview";
  const config = loadConfig({
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    OPENAI_MODEL: "fixture-scripted-model",
    QA_ALLOW_PRIVATE_PREVIEWS: "true",
    QA_API_TOKEN: "fixture-api-token-123456789012345",
    QA_DATA_DIR: dataDir,
  });
  const observation = (actual: unknown): Observation => ({
    actual,
    snapshot: `repère : ${String(actual)}`,
    url: preview,
  });
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("state-evidence");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_session, label) => {
      if (label.startsWith("baseline-")) {
        if (probes.baselineFails) {
          throw new Error("Timeout 5000ms exceeded waiting for the target");
        }
        return observation(probes.baseline);
      }
      if (label.endsWith("-click") && probes.targetAbsent) {
        // `ifPresent` rend false quand la cible est absente : l'étape est sautée.
        return observation(false);
      }
      return observation(probes.actual);
    }
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
  return executeScenario(value, preview, dataDir, config, new Canary(config));
}

describe("une assertion d'état déjà satisfaite avant l'étape ne prouve pas l'étape", () => {
  it("ne passe plus quand l'interaction laisse la valeur identique", async () => {
    // La forme mesurée : le repère était déjà là avant le clic, et le clic ne le
    // déplace pas. Avant ce correctif, `outcome` valait `passed` et l'assertion
    // `passed: true` — le run était vert sans preuve d'exécution.
    const result = await run(scenario({ afterStep: "open" }), {
      actual: BANNER,
      baseline: BANNER,
    });

    expect(result.outcome).toBe("blocked");
    expect(result.assertions[0]).toMatchObject({
      actual: BANNER,
      baseline: BANNER,
      passed: false,
      preMatched: true,
    });
    expect(result.diagnostic?.code).toBe("STATE_ALREADY_SATISFIED");
    expect(result.error).toBe(result.diagnostic?.message);
    expect(result.error).toMatch(/banner/);
    expect(result.error).toMatch(/open/);
    expect(result.error).toMatch(/identical to the baseline/);
    expect(result.error).toMatch(/the state is proven, the interaction is not/);
    expect(result.diagnostic?.hint).toMatch(/ifPresent/);
  });

  it("classe le défaut dans les plans, jamais dans les régressions produit", async () => {
    const result = await run(scenario({ afterStep: "open" }), {
      actual: BANNER,
      baseline: BANNER,
    });
    expect(result.outcome).toBe("blocked");
    // `blocked` n'est pas `failed` : l'application montre ce que l'assertion
    // demande, c'est la preuve qui manque. Le code le dit explicitement.
    expect(result.diagnostic?.code).not.toBe("TRANSITION_NOT_OBSERVED");
  });
});

describe("les formes légitimes d'une assertion déjà satisfaite restent vertes", () => {
  it("passe quand l'étape `ifPresent` a été sautée : le plan a déclaré le no-op", async () => {
    const result = await run(scenario({ afterStep: "open", ifPresent: true }), {
      actual: BANNER,
      baseline: BANNER,
      targetAbsent: true,
    });

    expect(result.outcome, result.error ?? "").toBe("passed");
    expect(result.assertions[0]).toMatchObject({ passed: true });
    expect(result.diagnostic).toBeUndefined();
    expect(result.steps.find((step) => step.stepId === "open")?.skipped).toBe(
      true
    );
  });

  it("passe quand l'étape a réellement déplacé la valeur vers l'attendu", async () => {
    const result = await run(scenario({ afterStep: "open" }), {
      actual: BANNER,
      baseline: OTHER,
    });

    expect(result.outcome, result.error ?? "").toBe("passed");
    expect(result.assertions[0]).toMatchObject({ passed: true });
    expect(result.assertions[0]).not.toHaveProperty("preMatched");
  });

  it("passe quand la sonde d'avant n'a pas pu mesurer : la cible apparaît après l'étape", async () => {
    const result = await run(scenario({ afterStep: "open" }), {
      actual: BANNER,
      baselineFails: true,
    });

    expect(result.outcome, result.error ?? "").toBe("passed");
    expect(result.assertions[0]).toMatchObject({ passed: true });
    // Sans mesure, la pré-satisfaction reste inconnue — jamais « pas héritée ».
    expect(result.assertions[0]).not.toHaveProperty("preMatched");
    expect(result.assertions[0]?.baseline).toBeUndefined();
  });

  it("passe quand l'assertion est ancrée sur la navigation, sans valeur d'avant", async () => {
    const result = await run(scenario({ afterStep: "load" }), {
      actual: BANNER,
      baseline: BANNER,
    });

    expect(result.outcome, result.error ?? "").toBe("passed");
    expect(result.assertions[0]).toMatchObject({ passed: true });
    expect(result.assertions[0]).not.toHaveProperty("preMatched");
  });

  it("reste un échec produit quand la valeur identique n'atteint pas l'attendu", async () => {
    const result = await run(scenario({ afterStep: "open" }), {
      actual: OTHER,
      baseline: OTHER,
    });

    // Rien n'a bougé ET l'attendu n'est pas atteint : ce n'est pas un défaut de
    // preuve mais une régression, et le reclassement ne doit jamais la couvrir.
    expect(result.outcome).toBe("failed");
    expect(result.assertions[0]).toMatchObject({ passed: false });
    expect(result.diagnostic?.code).not.toBe("STATE_ALREADY_SATISFIED");
  });
});
