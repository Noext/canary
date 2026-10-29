import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary, type Observation } from "../src/canary.js";
import { loadConfig } from "../src/config.js";
import { executeScenario } from "../src/executor.js";
import { replayScenario } from "../src/replay-scenario.js";
import { type Scenario, ScenarioSchema } from "../src/schema.js";

/**
 * Le rejeu navigateur ciblé : un seul scénario, jamais le plan entier, et rien
 * ne part avant que l'hôte autorisé et le SHA complet de la preview soient
 * vérifiés. Les tests neutralisent la vérification de preview pour les cas qui
 * n'ont pas besoin du réseau ; le cas SHA faux l'utilise telle quelle.
 */

const preview = vi.hoisted(() => ({
  behaviour: "ok" as "ok" | "mismatch",
  sha: "e".repeat(40),
}));

vi.mock("../src/preview.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/preview.js")>();
  const { validatePreviewUrl } = await import("../src/config.js");
  return {
    ...original,
    // La liste d'hôtes autorisés reste RÉELLE (aucun réseau) ; seule la lecture
    // HTTP du SHA est neutralisée.
    verifyPreviewUrl: async (url: string, expected: string, config: never) => {
      const checked = validatePreviewUrl(url, config);
      if (preview.behaviour === "mismatch") {
        const { QaError } = await import("../src/diagnostics.js");
        throw new QaError(
          "PREVIEW_SHA_MISMATCH",
          `Preview SHA mismatch or missing provenance (expected ${expected}, received ${preview.sha})`,
          "Deploy the PR head commit"
        );
      }
      return {
        evidence: `x-commit-sha: ${expected}`,
        sha: expected,
        url: checked.href,
      };
    },
  };
});

const SHA = "a".repeat(40);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  preview.behaviour = "ok";
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function scenario(id: string): Scenario {
  return ScenarioSchema.parse({
    id,
    title: `titre ${id}`,
    rationale: "raison",
    kind: "happy_path",
    sourceFiles: ["src/form.ts"],
    preconditions: [],
    requirements: [
      {
        sourceFile: "src/form.ts",
        quote: "show('Welcome '+name)",
        behavior: "b",
      },
    ],
    steps: [
      {
        id: `${id}-enter`,
        description: "saisir",
        action: {
          type: "fill",
          locator: { by: "label", value: "Name" },
          value: "Ada",
        },
      },
      {
        id: `${id}-check`,
        description: "vérifier",
        action: { type: "assert", assertionId: `${id}-saved` },
      },
    ],
    assertions: [
      {
        id: `${id}-saved`,
        description: "sortie",
        kind: "text",
        expected: "Welcome Ada",
        target: { by: "css", value: "#saved" },
        afterStep: `${id}-enter`,
        verification: "state",
      },
    ],
  });
}

async function bundleFile(ids: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "canary-replay-scenario-"));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const path = join(directory, "bundle.json");
  const plan = {
    scenarios: ids.map((id) => scenario(id)),
    skipped: [],
    summary: "plan historique",
  };
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      createdAt: "2026-10-27T00:00:00.000Z",
      source: {
        prUrl: "https://github.com/fixture/app/pull/1",
        repo: "fixture/app",
        number: 1,
        headSha: SHA,
        baseSha: "b".repeat(40),
        model: "fixture-model",
      },
      validationConfig: {
        QA_MAX_SCENARIOS: 20,
        QA_MAX_STEPS: 40,
        QA_PER_SCENARIO_COVERAGE: false,
      },
      context: {
        baseSha: "b".repeat(40),
        body: "",
        context: [],
        contextWarnings: [],
        files: [{ filename: "src/form.ts", status: "modified" }],
        headRepo: "fixture/app",
        ref: {
          repo: "fixture/app",
          number: 1,
          url: "https://github.com/fixture/app/pull/1",
        },
        sha: SHA,
        title: "t",
      },
      policy: { version: 1 },
      catalog: { fixtures: {}, roles: [], visuals: [] },
      payload: {},
      generatedPlan: plan,
      plan,
      evidence: { url: "https://preview.fixture.test/", aria: "" },
    }),
    "utf8"
  );
  return {
    config: loadConfig({
      PREVIEW_ALLOWED_HOSTS: "preview.fixture.test",
      QA_DATA_DIR: directory,
    }),
    path,
  };
}

describe("le rejeu navigateur ciblé ne joue qu'un scénario", () => {
  it("n'exécute que le scénario demandé, jamais les autres du plan", async () => {
    const { config, path } = await bundleFile(["alpha", "beta", "gamma"]);
    const executed: string[] = [];
    const fake = (async (chosen: Scenario) => {
      executed.push(chosen.id);
      return {
        assertions: [],
        outcome: "passed",
        scenario: chosen,
        steps: [],
      };
    }) as unknown as typeof executeScenario;

    const outcome = await replayScenario({
      bundlePath: path,
      config,
      execute: fake,
      scenarioId: "beta",
    });

    expect(executed).toEqual(["beta"]);
    expect(outcome.scenarioId).toBe("beta");
    // Le plan en porte trois : le rejeu n'en joue qu'un, et le dit.
    expect(outcome.planScenarios).toBe(3);
    expect(outcome.sha).toBe(SHA);
  });

  it("refuse un scénario absent du plan, sans rien exécuter", async () => {
    const { config, path } = await bundleFile(["alpha"]);
    const fake = vi.fn() as unknown as typeof executeScenario;
    await expect(
      replayScenario({
        bundlePath: path,
        config,
        execute: fake,
        scenarioId: "zeta",
      })
    ).rejects.toMatchObject({ code: "REPLAY_SCENARIO_MISSING" });
    expect(fake).not.toHaveBeenCalled();
  });

  it("bloque sur un SHA de preview incorrect, avant toute interaction", async () => {
    const { config, path } = await bundleFile(["alpha"]);
    preview.behaviour = "mismatch";
    const act = vi.spyOn(Canary.prototype, "act");
    await expect(
      replayScenario({ bundlePath: path, config, scenarioId: "alpha" })
    ).rejects.toMatchObject({ code: "PREVIEW_SHA_MISMATCH" });
    // Aucun clic, aucune navigation : la vérification passe avant l'exécution.
    expect(act).not.toHaveBeenCalled();
  });

  it("bloque sur un hôte de preview non autorisé", async () => {
    const { path } = await bundleFile(["alpha"]);
    const restricted = loadConfig({
      PREVIEW_ALLOWED_HOSTS: "autre.fixture.test",
      QA_DATA_DIR: "/tmp/canary-replay-scenario-host",
    });
    await expect(
      replayScenario({
        bundlePath: path,
        config: restricted,
        scenarioId: "alpha",
      })
    ).rejects.toThrow(/not in PREVIEW_ALLOWED_HOSTS|preview/i);
  });
});

describe("une `transition` sur une cible apparue est satisfaite par son apparition", () => {
  const APPEARING = ScenarioSchema.parse({
    id: "appearing",
    title: "l'entrée d'historique expose le commentaire",
    rationale: "r",
    kind: "regression",
    sourceFiles: ["src/form.ts"],
    preconditions: [],
    requirements: [
      {
        sourceFile: "src/form.ts",
        quote: "show('Welcome '+name)",
        behavior: "b",
      },
    ],
    steps: [
      {
        id: "close",
        description: "clôturer",
        action: {
          type: "click",
          locator: { by: "role", value: "button", name: "Close" },
        },
      },
      {
        id: "check",
        description: "relire",
        action: { type: "assert", assertionId: "history-comment" },
      },
    ],
    assertions: [
      {
        id: "history-comment",
        description: "le commentaire est dans l'historique",
        kind: "text",
        expected: "Erreur de rendu de monnaie",
        target: { by: "css", value: "[data-cash-history-comment]" },
        afterStep: "close",
        verification: "transition",
      },
    ],
  });

  async function run(probeError: string | null) {
    const directory = await mkdtemp(join(tmpdir(), "canary-appearing-"));
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    const config = loadConfig({
      OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
      QA_ALLOW_PRIVATE_PREVIEWS: "true",
      QA_API_TOKEN: "fixture-api-token-123456789012345",
      QA_DATA_DIR: directory,
    });
    const observation = (actual: unknown): Observation => ({
      actual,
      snapshot: String(actual),
      url: "http://127.0.0.1:9/preview",
    });
    vi.spyOn(Canary.prototype, "start").mockResolvedValue("appearing");
    vi.spyOn(Canary.prototype, "act").mockImplementation(
      async (_session, label) => {
        if (label.startsWith("baseline-")) {
          // La cible n'existe pas avant l'étape : Playwright expire en la cherchant.
          throw new Error(
            probeError ??
              "Timeout 5000ms exceeded. Call log: - waiting for locator('[data-cash-history-comment]')"
          );
        }
        return observation("Erreur de rendu de monnaie");
      }
    );
    vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
    return executeScenario(
      APPEARING,
      "http://127.0.0.1:9/preview",
      directory,
      config,
      new Canary(config)
    );
  }

  it("passe quand la cible absente avant l'étape apparaît avec la valeur attendue", async () => {
    const result = await run(null);
    expect(result.outcome, result.error ?? "").toBe("passed");
    expect(result.assertions[0]).toMatchObject({
      actual: "Erreur de rendu de monnaie",
      baseline: null,
      passed: true,
      verification: "transition",
    });
    // L'apparition n'est pas une pré-satisfaction : rien n'était là avant.
    expect(result.assertions[0]).not.toHaveProperty("preMatched");
  });

  it("ne passe pas quand la sonde échoue pour une autre raison que l'absence", async () => {
    // Une panne de sonde qui n'est pas « cible introuvable » reste une preuve
    // inconnue : rien n'est enregistré, et la transition n'est pas démontrée.
    const result = await run(
      "net::ERR_CONNECTION_RESET while reading the page"
    );
    expect(result.outcome).not.toBe("passed");
    expect(result.assertions[0]?.baseline).toBeUndefined();
    expect(result.assertions[0]?.passed).toBe(false);
  });
});
