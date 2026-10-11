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
it("refuses a decoy target or skipped interaction even if it displays expected text", async () => {
  const f = await fixture();
  closers.push(f.close);
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("test");
  const act = vi.spyOn(Canary.prototype, "act").mockResolvedValue({
    url: f.baseUrl,
    snapshot: "Welcome Ada",
    actual: "Welcome Ada",
  });
  vi.spyOn(Canary.prototype, "end").mockResolvedValue(["video.webm"]);
  vi.spyOn(Model.prototype, "json").mockResolvedValue({
    reason: "decoy",
    stepId: "verify",
    action: {
      type: "assert",
      assertionId: "saved",
      locator: { by: "css", value: "#decoy" },
    },
  });
  const result = await executeScenario(
    plan.scenarios[0]!,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config),
    new Model(f.config)
  );
  expect(result.outcome).toBe("blocked");
  expect(result.diagnostic?.code).toBe("CONTRACT_VIOLATION");
  expect(act).toHaveBeenCalledTimes(1);
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
