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

/**
 * Cible role+nom du run f0f24722 : le plan recopie l'apostrophe ASCII de sa
 * source, la page expose l'apostrophe typographique. Playwright compare le nom
 * accessible caractère par caractère avec `exact: true`, donc le locator ne
 * résout rien et le délai expire.
 */
const PLANNED_NAME = "Justification de l'écart";
const EXPOSED_NAME = "Justification de l’écart";
const UNRESOLVED_NAMED_TARGET = `Canary action failed: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole("textbox", { name: ${JSON.stringify(PLANNED_NAME)}, exact: true })`;

/**
 * Le scénario observé : la vue qui porte le contrôle exige un clic, donc la
 * cible n'est pas dans l'instantané de découverte (non concluante, jamais
 * refusée), et l'étape qui la vise est la dernière du contrat.
 */
function typographicPlan() {
  const contract = structuredClone(plan);
  const scenario = contract.scenarios[0]!;
  scenario.steps.push(
    {
      id: "caisse",
      description: "ouvrir la vue Caisse",
      action: {
        type: "click",
        locator: { by: "role", value: "button", name: "Caisse" },
      },
    },
    {
      id: "justification",
      description: "saisir la justification de l'écart",
      action: {
        type: "fill",
        locator: { by: "role", value: "textbox", name: PLANNED_NAME },
        value: "Écart constaté",
      },
    }
  );
  return contract;
}

/**
 * Le faux Canary ne rejoue pas le script : il refuse la dernière étape avec le
 * délai réel d'une cible introuvable, et rend l'arbre d'accessibilité courant au
 * relevé que demande le diagnostic.
 */
async function runMissingNamedTarget(aria: string) {
  const f = await fixture({ plans: [typographicPlan()] });
  cleanups.push(f.close);
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("typographic-name");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_session, label) => {
      if (label === "5-fill") {
        throw new Error(UNRESOLVED_NAMED_TARGET);
      }
      return {
        url: "http://fixture/",
        snapshot: "textbox Name, button Save",
        ...(label === "target-name-check" ? { evidence: aria } : {}),
        actual: label.startsWith("baseline-") ? "Welcome" : "Welcome Ada",
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

it("names both typographic spellings when a role+name target never resolves", async () => {
  const { result, f } = await runMissingNamedTarget(
    `- main [ref=e1]:\n  - button "Caisse" [ref=e2]\n  - textbox "${EXPOSED_NAME}" [ref=e3]`
  );
  expect(result.outcome).toBe("blocked");
  const scenario = result.scenarios[0];
  expect(scenario?.diagnostic?.code).toBe("TARGET_NOT_FOUND");
  // Les deux graphies et leurs codepoints : la cause est nommée, pas devinée.
  expect(scenario?.diagnostic?.message).toContain(
    `le plan vise ${PLANNED_NAME} (U+0027) ; la page expose ${EXPOSED_NAME} (U+2019)`
  );
  expect(scenario?.error).toBe(scenario?.diagnostic?.message);
  // Le commentaire de PR porte la même cause : l'opérateur n'a pas à ouvrir le run.
  const published = f.outgoing.find((request) =>
    request.path.endsWith("/comments")
  )?.payload.body;
  expect(String(published)).toContain(
    `la page expose ${EXPOSED_NAME} (U+2019)`
  );
});

it("keeps the generic message when the page exposes no neighbouring name", async () => {
  const { result } = await runMissingNamedTarget(
    `- main [ref=e1]:\n  - textbox "Recherche" [ref=e3]`
  );
  expect(result.outcome).toBe("blocked");
  const scenario = result.scenarios[0];
  expect(scenario?.diagnostic?.code).toBe("TARGET_NOT_FOUND");
  expect(scenario?.diagnostic?.message).not.toContain("le plan vise");
  expect(scenario?.diagnostic?.message).toContain("Timeout 5000ms exceeded");
});

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
