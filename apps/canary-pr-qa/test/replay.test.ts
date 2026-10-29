import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Model } from "../src/model.js";
import { parseReplayBundle, runReplay } from "../src/replay.js";
import { BASE_SHA, plan, PR_URL, SHA } from "./fixture.js";

const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  );
});

function bundle() {
  return {
    version: 1,
    createdAt: "2026-10-29T00:00:00.000Z",
    source: {
      prUrl: PR_URL,
      repo: "fixture/app",
      number: 1,
      headSha: SHA,
      baseSha: BASE_SHA,
      model: "opencode-go/deepseek-v4.1-flash",
    },
    validationConfig: {
      QA_MAX_SCENARIOS: 8,
      QA_MAX_STEPS: 25,
      QA_PER_SCENARIO_COVERAGE: false,
    },
    context: {
      baseSha: BASE_SHA,
      body: "",
      context: [
        { path: "src/form.ts", ref: SHA, content: "show('Welcome '+name)" },
        { path: "src/form.ts", ref: BASE_SHA, content: "show('Welcome '+name)" },
      ],
      contextWarnings: [],
      files: [
        {
          filename: "src/form.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: "@@ -1 +1 @@\\n-show('Hello '+name)\\n+show('Welcome '+name)",
        },
      ],
      headRepo: "fixture/app",
      ref: { repo: "fixture/app", number: 1, url: PR_URL },
      sha: SHA,
      title: "Update welcome form",
    },
    policy: { version: 1 },
    catalog: { fixtures: {}, roles: [], visuals: [] },
    payload: { fixed: true },
    generatedPlan: plan,
    plan,
    evidence: {
      url: "https://preview.example.test/",
      aria: '- main [ref=e1]:\n  - heading "Welcome" [level=1] [ref=e2]',
    },
  };
}

describe("Canary Replay bundle", () => {
  it("validates the bundle contract and pins both PR revisions", () => {
    const parsed = parseReplayBundle(JSON.stringify(bundle()));
    expect(parsed.source.headSha).toBe(SHA);
    expect(parsed.source.baseSha).toBe(BASE_SHA);
    expect(parsed.version).toBe(1);
  });

  it("runs gate replay without calling the model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "canary-replay-test-"));
    cleanup.push(directory);
    const path = join(directory, "bundle.json");
    await writeFile(path, JSON.stringify(bundle()), {
      encoding: "utf8",
      mode: 0o600,
    });
    const modelCall = vi.spyOn(Model.prototype, "json").mockRejectedValue(
      new Error("gate replay must not call the model")
    );

    const result = await runReplay(
      path,
      "gate",
      loadConfig({ QA_DATA_DIR: directory })
    );

    expect(result.mode).toBe("gate");
    expect(result.source.headSha).toBe(SHA);
    expect(result.plan).toEqual(plan);
    expect(modelCall).not.toHaveBeenCalled();
    expect(Array.isArray(result.refusals)).toBe(true);
    expect(Array.isArray(result.inconclusive)).toBe(true);
  });

  it("rejects unknown bundle versions instead of silently replaying them", () => {
    expect(() =>
      parseReplayBundle(JSON.stringify({ ...bundle(), version: 2 }))
    ).toThrow();
  });
});
