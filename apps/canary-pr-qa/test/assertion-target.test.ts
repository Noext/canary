import { afterEach, expect, it, vi } from "vitest";
import { Canary } from "../src/canary.js";
import { runQa } from "../src/runner.js";
import { fixture, PR_URL } from "./fixture.js";

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

it("keeps a click whose target never resolves blocked", async () => {
  const result = await runFailingStep("2-click");
  expect(result.outcome).toBe("blocked");
  const scenario = result.scenarios[0];
  expect(scenario?.outcome).toBe("blocked");
  expect(scenario?.diagnostic?.code).toBe("TARGET_NOT_FOUND");
  // Un clic n'affirme rien : aucune assertion n'est évaluée ni enregistrée.
  expect(scenario?.assertions).toEqual([]);
});
