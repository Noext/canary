import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Canary } from "../src/canary.js";
import { reportMarkdown } from "../src/report.js";
import { runQa } from "../src/runner.js";
import { fixture, PR_URL, plan } from "./fixture.js";

/** Valeur reconnaissable lue dans la page : elle doit rester dans l'évidence. */
const SENTINEL = "SENTINEL-SECRET-42";

/**
 * Le délai réel d'une assertion dont la cible ne résout jamais : Playwright
 * n'écrit « locator resolved to » que lorsqu'un élément a été trouvé, donc ce
 * message est celui d'un élément absent, pas d'une panne d'infrastructure.
 */
const UNRESOLVED_TARGET =
  "Canary action failed: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('[data-cash-state=\"cloture\"]')";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

/**
 * Le faux Canary n'échoue que sur une étape : le plan du fixture joue `1-fill`,
 * `2-click` puis `3-assert`, et sonde `baseline-saved` avant le clic.
 */
async function runFailingStep(step: string) {
  const f = await fixture();
  cleanups.push(f.close);
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("assertion-target");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_session, label) => {
      if (label === step) {
        throw new Error(UNRESOLVED_TARGET);
      }
      return {
        url: "http://fixture/",
        snapshot: "textbox Name, button Save",
        actual: label.startsWith("baseline-") ? "Welcome" : "Welcome Ada",
      };
    }
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
  return runQa({ prUrl: PR_URL, previewUrl: f.baseUrl }, f.config);
}

/**
 * Le cas `persisted` : la lecture d'avant rechargement aboutit, mais la cible
 * disparaît après le rechargement. La sonde `persistence-*` lève alors le même
 * délai de cible introuvable ; le relevé déjà obtenu ne doit pas être perdu.
 * Le run publie (le commentaire part dans `f.outgoing`), comme une exécution
 * automatique de webhook.
 */
async function runMissingPersistedTarget(observed = "Welcome Ada") {
  const persisted = structuredClone(plan);
  persisted.scenarios[0]!.assertions[0]!.verification = "persisted";
  const f = await fixture({ plans: [persisted] });
  cleanups.push(f.close);
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("assertion-target");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_session, label) => {
      if (label === "persistence-saved") {
        throw new Error(UNRESOLVED_TARGET);
      }
      return {
        url: "http://fixture/",
        snapshot: "textbox Name, button Save",
        actual: label.startsWith("baseline-") ? "Welcome" : observed,
      };
    }
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  return { result, f };
}

it("fails the run when an assertion target never resolves", async () => {
  const result = await runFailingStep("3-assert");
  expect(result.outcome).toBe("failed");
  const scenario = result.scenarios[0];
  expect(scenario?.outcome).toBe("failed");
  expect(scenario?.diagnostic?.code).toBe("TARGET_NOT_FOUND");
  // L'assertion visée est enregistrée une seule fois, comme fausse, sans
  // valeur observée : rien n'a été lu.
  expect(scenario?.assertions).toHaveLength(1);
  expect(scenario?.assertions[0]).toMatchObject({
    id: "saved",
    passed: false,
    baseline: "Welcome",
  });
  expect(scenario?.assertions[0]?.actual).toBeUndefined();
  expect(scenario?.error).toContain("saved");
  expect(scenario?.error).toContain('[data-cash-state="cloture"]');
});

it("keeps the pre-reload value when a persisted target disappears", async () => {
  const { result } = await runMissingPersistedTarget();
  expect(result.outcome).toBe("failed");
  const scenario = result.scenarios[0];
  expect(scenario?.outcome).toBe("failed");
  expect(scenario?.diagnostic?.code).toBe("TARGET_NOT_FOUND");
  // La valeur lue avant le rechargement est conservée : c'est une observation
  // réelle, et l'effacer effacerait la régression.
  expect(scenario?.assertions).toHaveLength(1);
  expect(scenario?.assertions[0]).toMatchObject({
    id: "saved",
    passed: false,
    actual: "Welcome Ada",
    baseline: "Welcome",
  });
  expect(scenario?.error).toContain("persistence");
});

/**
 * Le commentaire de PR est public sur un dépôt, l'artefact ne l'est pas : une
 * valeur lue dans la page ne doit exister que dans l'assertion enregistrée,
 * jamais dans le message repris par `reportMarkdown` puis publié.
 */
it("keeps an observed value out of the error and the published comment", async () => {
  const { result, f } = await runMissingPersistedTarget(SENTINEL);
  const scenario = result.scenarios[0];
  // L'évidence d'assertion garde la valeur : c'est la preuve de la régression.
  expect(scenario?.assertions).toHaveLength(1);
  expect(scenario?.assertions[0]?.actual).toBe(SENTINEL);
  const stored = JSON.parse(
    await readFile(join(f.dataDir, result.id, "result.json"), "utf8")
  );
  expect(stored.scenarios[0].assertions[0].actual).toBe(SENTINEL);
  // Le corps publié existe bien, et aucune surface publiée ne recopie la valeur.
  const published = f.outgoing.find((request) =>
    request.path.endsWith("/comments")
  )?.payload.body;
  expect(typeof published).toBe("string");
  expect(published).toContain("persistence");
  for (const surface of [
    scenario?.error,
    scenario?.diagnostic?.message,
    scenario?.diagnostic?.hint,
    reportMarkdown(result),
    published,
  ]) {
    expect(surface).not.toContain(SENTINEL);
  }
});

it("keeps a click whose target never resolves blocked", async () => {
  const result = await runFailingStep("2-click");
  expect(result.outcome).toBe("blocked");
  const scenario = result.scenarios[0];
  expect(scenario?.outcome).toBe("blocked");
  expect(scenario?.diagnostic?.code).toBe("TARGET_NOT_FOUND");
  // Un clic n'affirme rien : aucune assertion n'est évaluée ni enregistrée.
  expect(scenario?.assertions).toEqual([]);
});
