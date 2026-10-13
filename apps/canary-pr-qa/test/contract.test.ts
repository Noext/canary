import { afterEach, expect, it, vi } from "vitest";
import { Canary } from "../src/canary.js";
import { executeScenario } from "../src/executor.js";
import { GitHub } from "../src/github.js";
import { Model } from "../src/model.js";
import { resolvePreview } from "../src/preview.js";
import { PlanSchema } from "../src/schema.js";
import { fixture, PR_URL, plan } from "./fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((c) => c()));
});
it("plays the frozen contract target and never reads a decoy, without asking a model", async () => {
  const f = await fixture();
  closers.push(f.close);
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("test");
  const act = vi
    .spyOn(Canary.prototype, "act")
    .mockImplementation(async (_session, label) => ({
      url: f.baseUrl,
      snapshot: "Welcome Ada",
      // La sonde de référence ne voit pas encore la valeur écrite : la seule
      // preuve acceptée reste le changement observé par l'assertion prévue.
      ...(label.startsWith("baseline-") ? {} : { actual: "Welcome Ada" }),
    }));
  vi.spyOn(Canary.prototype, "end").mockResolvedValue(["video.webm"]);
  const json = vi.spyOn(Model.prototype, "json");
  const result = await executeScenario(
    plan.scenarios[0]!,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config)
  );
  expect(json).not.toHaveBeenCalled();
  expect(result.outcome, result.error).toBe("passed");
  expect(result.contract?.completedSteps).toEqual(["enter", "save", "verify"]);
  expect(act.mock.calls.map((call) => call[1])).toEqual([
    "open-preview",
    "1-fill",
    "baseline-saved",
    "2-click",
    "3-assert",
  ]);
  // Le leurre qui affiche le texte attendu n'est jamais lu : la cible de
  // l'assertion vient du plan figé, pas de ce que la page propose.
  const scripts = act.mock.calls.map((call) => call[2]).join("\n");
  expect(scripts).toContain("#saved");
  expect(scripts).not.toContain("#decoy");
});
it("requires frozen targets and ordered prior interactions for transition assertions", () => {
  const invalid = structuredClone(plan);
  invalid.scenarios[0]!.assertions[0]!.target = undefined;
  expect(() => PlanSchema.parse(invalid)).toThrow();
  invalid.scenarios[0]!.assertions[0]!.target = { by: "css", value: "#saved" };
  invalid.scenarios[0]!.assertions[0]!.afterStep = "verify";
  expect(() => PlanSchema.parse(invalid)).toThrow();
});
it("rejects GitHub metadata whose live preview has no SHA proof", async () => {
  const f = await fixture({ noSha: true });
  closers.push(f.close);
  const github = new GitHub(f.config);
  const context = await github.context(PR_URL);
  vi.spyOn(github, "deployments").mockResolvedValue({
    url: f.baseUrl,
    sha: context.sha,
    evidence: "deployment metadata",
  });
  await expect(resolvePreview(context, github, f.config)).rejects.toMatchObject(
    { code: "PREVIEW_SHA_MISMATCH" }
  );
});
