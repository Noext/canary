import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertionMatches,
  Canary,
  compileAction,
  locatorExpression,
} from "../src/canary.js";
import { loadConfig, validatePreviewUrl } from "../src/config.js";
import { GitHub, parsePrUrl } from "../src/github.js";
import { resolvePreview, verifyPreviewUrl } from "../src/preview.js";
import { runQa } from "../src/runner.js";
import { DecisionSchema, PlanSchema } from "../src/schema.js";
import { BASE_SHA, fixture, PR_URL, plan, SHA } from "./fixture.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(close.splice(0).map((fn) => fn()));
});
async function setup(options?: Parameters<typeof fixture>[0]) {
  const f = await fixture(options);
  close.push(f.close);
  return f;
}
function fakeBrowser() {
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("fixture-session");
  vi.spyOn(Canary.prototype, "act").mockImplementation(async (_id, label) => ({
    url: "http://fixture/",
    snapshot: "textbox Name, button Save",
    ...(label.endsWith("assert") ? { actual: "Welcome Ada" } : {}),
  }));
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([
    "video.webm",
    "trace.zip",
  ]);
}

describe("validation and deterministic assertions", () => {
  it("accepts only canonical GitHub PR URLs", () => {
    expect(parsePrUrl(PR_URL).repo).toBe("fixture/app");
    for (const url of [
      "https://github.com.evil.com/o/r/pull/1",
      "https://github.com/o/r/pull/0",
      `${PR_URL}?x=1`,
      "https://github.com/o/r/issues/1",
    ]) {
      expect(() => parsePrUrl(url)).toThrow();
    }
  });
  it("requires an explicit preview host allowlist and no credentials", () => {
    const config = loadConfig({ PREVIEW_ALLOWED_HOSTS: "preview.test" });
    expect(validatePreviewUrl("https://preview.test", config).hostname).toBe(
      "preview.test"
    );
    expect(() =>
      validatePreviewUrl("http://169.254.169.254", config)
    ).toThrow();
    expect(() =>
      validatePreviewUrl("https://user:pass@preview.test", config)
    ).toThrow();
  });
  it("rejects arbitrary code, duplicate assertions, zero-assertion scenarios", () => {
    expect(() =>
      DecisionSchema.parse({
        reason: "bad",
        action: { type: "script", code: "process.exit()" },
      })
    ).toThrow();
    const scenario = plan.scenarios[0]!;
    expect(() =>
      PlanSchema.parse({
        ...plan,
        scenarios: [{ ...scenario, assertions: [] }],
      })
    ).toThrow();
    expect(() =>
      PlanSchema.parse({
        ...plan,
        scenarios: [
          {
            ...scenario,
            assertions: [
              {
                id: "empty",
                description: "invalid oracle",
                kind: "text",
                expected: "  ",
              },
            ],
          },
        ],
      })
    ).toThrow();
    expect(() =>
      PlanSchema.parse({
        ...plan,
        scenarios: [
          {
            ...scenario,
            assertions: [scenario.assertions[0], scenario.assertions[0]],
          },
        ],
      })
    ).toThrow();
  });
  it("escapes model arguments as data, never executable JS", () => {
    const malicious = '"); throw new Error("pwned"); //';
    const expression = locatorExpression({ by: "css", value: malicious });
    expect(expression).toBe(`page.locator(${JSON.stringify(malicious)})`);
    expect(
      compileAction(
        {
          type: "fill",
          locator: { by: "css", value: "input" },
          value: malicious,
        },
        "https://preview.test"
      )
    ).toContain(`.fill(${JSON.stringify(malicious)}`);
    expect(() =>
      compileAction(
        { type: "goto", path: "https://elsewhere.test" },
        "https://preview.test"
      )
    ).toThrow();
    expect(() =>
      compileAction(
        { type: "assert", assertionId: "unknown" },
        "https://preview.test"
      )
    ).toThrow();
  });
  it("checks values, visibility, counts and text without model judgement", () => {
    expect(
      assertionMatches(
        {
          id: "a",
          kind: "text",
          description: "welcome",
          expected: "Welcome Ada",
        },
        " Welcome\nAda "
      )
    ).toBe(true);
    expect(
      assertionMatches(
        { id: "a", kind: "value", description: "exact", expected: "Ada" },
        "Adam"
      )
    ).toBe(false);
    expect(
      assertionMatches(
        { id: "a", kind: "visible", description: "exists" },
        "true"
      )
    ).toBe(false);
    expect(
      assertionMatches(
        { id: "a", kind: "count", description: "count", expected: 1 },
        2
      )
    ).toBe(false);
  });
});

describe("preview and PR provenance", () => {
  it("validates both header and JSON live SHA proofs", async () => {
    const f = await setup();
    expect((await verifyPreviewUrl(f.baseUrl, SHA, f.config)).sha).toBe(SHA);
    expect(
      (
        await verifyPreviewUrl(f.baseUrl, SHA, {
          ...f.config,
          PREVIEW_SHA_PATH: "/version.json",
        })
      ).sha
    ).toBe(SHA);
    await expect(
      verifyPreviewUrl(f.baseUrl, BASE_SHA, f.config)
    ).rejects.toThrow("mismatch");
  });
  it("rejects missing live proof and inactive GitHub deployments", async () => {
    const f = await setup({ noSha: true });
    await expect(verifyPreviewUrl(f.baseUrl, SHA, f.config)).rejects.toThrow(
      "missing provenance"
    );
    const gh = new GitHub(f.config);
    await expect(
      resolvePreview(await gh.context(PR_URL), gh, f.config)
    ).rejects.toThrow("No successful");
  });
  it("retrieves immutable head/base repository context", async () => {
    const f = await setup();
    const context = await new GitHub(f.config).context(PR_URL);
    expect(context.sha).toBe(SHA);
    expect(context.context.some((file) => file.ref === BASE_SHA)).toBe(true);
    expect(context.files[0]?.patch).toContain("Welcome");
  });
});

describe("runner false-green regressions", () => {
  it("blocks a scenario with no readable diff or source versions", async () => {
    const f = await setup({ missingDiffAndContext: true });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("CONTEXT_INCOMPLETE");
    expect(f.outgoing.at(-1)?.payload.state).toBe("error");
    expect(result.scenarios).toEqual([]);
  });
  it("blocks self-declared success without executing planned assertions", async () => {
    const f = await setup({ earlyFinish: true });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.scenarios[0]?.error).toContain(
      "before all planned assertions"
    );
    expect(f.outgoing.at(-1)?.payload.state).toBe("error");
  });
  it("marks updated PR heads stale rather than posting success", async () => {
    const f = await setup({ updatedSha: true });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("stale");
    expect(f.outgoing.at(-1)?.payload.state).toBe("error");
  });
  it("does not greenlight skipped-only plans", async () => {
    const f = await setup({ noScenarios: true });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("skipped");
    expect(f.outgoing.at(-1)?.payload.state).toBe("error");
    expect(
      (await stat(join(f.dataDir, result.id, "report.html"))).size
    ).toBeGreaterThan(0);
  });
  it("cannot pass when video/evidence finalization fails", async () => {
    const f = await setup();
    fakeBrowser();
    vi.mocked(Canary.prototype.end)
      .mockResolvedValueOnce(["trace.zip"])
      .mockRejectedValueOnce(new Error("No video"));
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.scenarios[0]?.error).toContain("No video");
    expect(
      JSON.parse(
        await readFile(join(f.dataDir, result.id, "result.json"), "utf8")
      ).outcome
    ).toBe("blocked");
  });
});
