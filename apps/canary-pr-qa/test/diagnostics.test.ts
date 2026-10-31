import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, validateConfiguration } from "../src/config.js";
import { diagnose, redact } from "../src/diagnostics.js";
import { doctor, supportSummary } from "../src/doctor.js";
import { fetchText } from "../src/http.js";
import { Model } from "../src/model.js";
import { plannerInputBudget } from "../src/plan-evidence.js";
import { Progress } from "../src/progress.js";
import { fixture, PR_URL } from "./fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((fn) => fn()));
});
async function setup() {
  const f = await fixture();
  closers.push(f.close);
  return f;
}

describe("production configuration and useful diagnostics", () => {
  it("rejects example defaults, placeholder auth, endpoint credentials and invalid artifact origins", async () => {
    expect(() =>
      validateConfiguration(
        loadConfig({ OPENAI_MODEL: "your-model-name" }),
        true
      )
    ).toThrow("OPENAI_MODEL");
    const f = await setup();
    for (const override of [
      { QA_API_TOKEN: "replace-with-at-least-24-random-characters" },
      { OPENAI_BASE_URL: "http://user:secret@localhost/v1" },
      { ARTIFACT_BASE_URL: "https://qa.test/artifacts" },
      { ARTIFACT_BASE_URL: "not-a-url" },
    ]) {
      expect(() =>
        validateConfiguration({ ...f.config, ...override }, true)
      ).toThrow();
    }
    expect(() => validateConfiguration(f.config, true)).not.toThrow();
    expect(() =>
      validateConfiguration(
        {
          ...f.config,
          GITHUB_TOKEN: "",
          DATABASE_URL: "postgres://fixture",
          allowedRepos: [],
        },
        true
      )
    ).not.toThrow();
  });
  it("redacts provider/API secrets including URL-encoded and JSON-escaped forms", async () => {
    const f = await setup();
    const secret = 'secret-"-with-a-quote';
    const config = { ...f.config, OPENAI_API_KEY: secret };
    const text = `${secret} ${encodeURIComponent(secret)} ${JSON.stringify(secret)} Bearer unknown-token https://user:pass@host.test`;
    const safe = redact(text, config);
    expect(safe).not.toContain(secret);
    expect(safe).not.toContain(encodeURIComponent(secret));
    expect(safe).not.toContain("unknown-token");
    expect(safe).not.toContain("user:pass");
    expect(
      JSON.stringify(
        diagnose(new Error(`Failure ${f.config.GITHUB_TOKEN}`), f.config)
      )
    ).not.toContain(f.config.GITHUB_TOKEN);
  });
  it("redacts *_TOKEN environment secrets but never the *_TOKENS budget counts", () => {
    vi.stubEnv("QA_PLAN_MAX_TOKENS", "98304");
    vi.stubEnv("QA_RUN_MAX_TOKENS", "400000");
    vi.stubEnv("SOME_SERVICE_TOKEN", "svc-secret-value");
    const text = JSON.stringify({
      QA_PLAN_MAX_TOKENS: 98_304,
      QA_RUN_MAX_TOKENS: 400_000,
      service: "svc-secret-value",
    });
    const safe = redact(text);
    expect(JSON.parse(safe)).toEqual({
      QA_PLAN_MAX_TOKENS: 98_304,
      QA_RUN_MAX_TOKENS: 400_000,
      service: "[REDACTED]",
    });
    vi.unstubAllEnvs();
  });
  it("explains network causes and filesystem failures instead of an opaque fetch failed", () => {
    expect(
      diagnose(
        new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })
      ).hint
    ).toContain("localhost");
    expect(
      diagnose(Object.assign(new Error("full"), { code: "ENOSPC" })).hint
    ).toContain("df -h");
  });
  it.each([
    401, 403, 404, 429,
  ])("retains HTTP %i and the provider request id without echoing its body", async (code) => {
    const f = await setup();
    try {
      await fetchText(`${f.baseUrl}/http-${code}`);
      throw new Error("Expected HTTP failure");
    } catch (error) {
      const diagnostic = diagnose(error, f.config);
      expect(diagnostic.code).toBe(`HTTP_${code}`);
      expect(diagnostic.message).toContain("fixture-request-42");
      expect(diagnostic.message).not.toContain("fixture-token");
      expect(diagnostic.hint.length).toBeGreaterThan(20);
    }
  });
  it("times out a hung HTTP request and bounds oversized responses", async () => {
    const f = await setup();
    await expect(fetchText(`${f.baseUrl}/slow`, {}, 25)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    await expect(fetchText(f.baseUrl, {}, 1000, 50)).rejects.toThrow("exceeds");
  });
});
describe("installation doctor and safe support summaries", () => {
  it("checks actual REST/model compatibility and exact preview without making GitHub writes", async () => {
    const f = await setup();
    const result = await doctor(
      { ...f.config, OPENAI_TOKEN_PARAMETER: "max_completion_tokens" },
      { skipBrowser: true, prUrl: PR_URL, previewUrl: f.baseUrl }
    );
    expect(result.healthy, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.find((c) => c.name === "preview")?.status).toBe(
      "passed"
    );
    expect(f.outgoing).toEqual([]);
    expect(f.modelRequests[0]).toHaveProperty(
      "max_completion_tokens",
      f.config.QA_DOCTOR_MAX_TOKENS
    );
    expect(f.modelRequests[0]).not.toHaveProperty("max_tokens");
    expect(f.modelRequests[0]).not.toHaveProperty("temperature");
    const json = JSON.stringify(result);
    expect(json).not.toContain(f.config.QA_API_TOKEN);
    expect(json).not.toContain(f.config.GITHUB_TOKEN);
  });
  it("bounds each connectivity attempt by the pre-raise timeout, not the plan timeout", async () => {
    // Le délai d'un plan (600 s par défaut, relevé pour le raisonnement) ne
    // s'applique pas au contrôle de connectivité, qui ne tourne dans aucune
    // enveloppe de run : 4 essais × 600 s tiendraient le doctor ~40 minutes
    // sur un endpoint muet. Un délai déjà plus court est gardé tel quel.
    const f = await setup();
    const seen: number[] = [];
    vi.spyOn(Model.prototype, "json").mockImplementation(async function (
      this: Model
    ) {
      seen.push(
        (this as unknown as { config: { QA_MODEL_TIMEOUT_SECONDS: number } })
          .config.QA_MODEL_TIMEOUT_SECONDS
      );
      return { ok: true };
    } as unknown as Model["json"]);
    for (const timeout of [600, 30]) {
      const result = await doctor(
        { ...f.config, QA_MODEL_TIMEOUT_SECONDS: timeout },
        { skipBrowser: true }
      );
      expect(result.checks.find((c) => c.name === "model")?.status).toBe(
        "passed"
      );
    }
    expect(seen).toEqual([120, 30]);
  });
  it("marks skipped external checks explicitly and diagnoses a missing CLI", async () => {
    const f = await setup();
    const result = await doctor(
      { ...f.config, CANARY_CLI_PATH: join(f.dataDir, "missing-cli.js") },
      { offline: true }
    );
    expect(result.healthy).toBe(false);
    expect(
      result.checks.find((c) => c.name === "canary-cli")?.diagnostic?.code
    ).toBe("ENOENT");
    expect(result.checks.find((c) => c.name === "model")?.status).toBe(
      "skipped"
    );
    expect(f.modelRequests).toEqual([]);
  });
  it("shows the planner material and the bound that refuses it", async () => {
    const f = await setup();
    const defaults = loadConfig({
      QA_API_TOKEN: "fixture-api-token-123456789012345",
    });
    const result = await doctor(
      { ...f.config, QA_VIEW_PROBE: defaults.QA_VIEW_PROBE },
      { offline: true, skipBrowser: true }
    );
    // Les défauts : fichiers entiers et sonde de vues actifs, sous une borne
    // d'envoi dérivée de la fenêtre déclarée, jamais du payload.
    expect(result.config.planner).toEqual({
      contextTokens: 1_000_000,
      payloadLimitChars: plannerInputBudget(defaults).limit,
      wholeFileChars: 120_000,
      viewProbe: true,
      runMaxTokens: 1_000_000,
    });
  });
  it("persists ordered action progress without snapshots or typed values", async () => {
    const f = await setup();
    const id = "12345678-1234-1234-1234-123456789012";
    const root = join(f.dataDir, id);
    const progress = new Progress(root, id);
    await progress.record({ phase: "planning" });
    await progress.record({
      phase: "execution",
      scenarioId: "welcome",
      step: 1,
      action: "fill",
    });
    const current = JSON.parse(
      await readFile(join(root, "progress.json"), "utf8")
    );
    expect(current).toMatchObject({ phase: "execution", step: 1, sequence: 2 });
    const events = (await readFile(join(root, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events[1]).not.toHaveProperty("value");
    expect(events[1]).not.toHaveProperty("snapshot");
  });
  it("omits browser secrets and raw assertions from a support summary and rejects unsafe IDs", async () => {
    const f = await setup();
    const id = "12345678-1234-1234-1234-123456789012";
    const root = join(f.dataDir, id);
    await mkdir(root);
    await writeFile(
      join(root, "result.json"),
      JSON.stringify({
        outcome: "blocked",
        error: `Failure ${f.config.GITHUB_TOKEN}`,
        scenarios: [
          {
            scenario: { id: "example" },
            outcome: "blocked",
            steps: [{ value: "private-form-value" }],
            assertions: [
              { id: "a", passed: false, actual: "private-actual-value" },
            ],
            artifacts: [],
          },
        ],
      })
    );
    const summary = JSON.stringify(await supportSummary(id, f.config));
    for (const secret of [
      f.config.GITHUB_TOKEN,
      "private-form-value",
      "private-actual-value",
    ]) {
      expect(summary).not.toContain(secret);
    }
    expect(summary).toContain("[REDACTED]");
    await expect(supportSummary("../../.env", f.config)).rejects.toMatchObject({
      code: "RUN_ID_INVALID",
    });
    await expect(
      supportSummary("87654321-1234-1234-1234-123456789012", f.config)
    ).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });
});
