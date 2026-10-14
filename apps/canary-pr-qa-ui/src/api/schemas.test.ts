import { describe, expect, it } from "vitest";
import { automaticStatusSchema } from "./automatic";
import {
  githubStatusSchema,
  runJobListSchema,
  runJobSchema,
  runResultSchema,
  setupStatusSchema,
} from "./schemas";

/**
 * The server returns nullable columns as JSON `null`, not as a missing key.
 * These cases come from real payloads: `SELECT *` on qa_jobs yields
 * `worker: null`, `outcome: null` and `error: null` for a fresh run.
 */
describe("server payloads", () => {
  it("accepts a queued job whose nullable columns are null", () => {
    const rows = runJobListSchema.parse([
      {
        cancel_requested: false,
        created_at: "2026-01-01T00:00:00.000Z",
        error: null,
        id: "11111111-1111-1111-1111-111111111111",
        idempotency_key: "key",
        input: { prUrl: "https://github.com/o/r/pull/1", publish: true },
        lease_until: null,
        outcome: null,
        owner: "admin",
        pr: 1,
        repo: "o/r",
        sha: "1".repeat(40),
        status: "queued",
        updated_at: "2026-01-01T00:00:00.000Z",
        usage: {},
        worker: null,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.worker).toBeNull();
  });

  it("keeps the transport retry of a running job, and its counter", () => {
    const row = runJobSchema.parse({
      cancel_requested: false,
      created_at: "2026-01-01T00:00:00.000Z",
      error: null,
      id: "11111111-1111-1111-1111-111111111111",
      input: { prUrl: "https://github.com/o/r/pull/1", publish: true },
      outcome: null,
      owner: "admin",
      pr: 1,
      progress: {
        phase: "planning",
        retry: { attempt: 2, code: "ECONNRESET", max: 3 },
      },
      repo: "o/r",
      sha: "1".repeat(40),
      status: "running",
      updated_at: "2026-01-01T00:00:00.000Z",
      usage: { calls: 0, retries: 2 },
      worker: "w",
    });
    // Sans le champ dans le schéma, Zod le retirerait et la reprise resterait
    // invisible pendant l'attente.
    expect(row.progress?.retry).toEqual({
      attempt: 2,
      code: "ECONNRESET",
      max: 3,
    });
    expect(row.usage?.retries).toBe(2);
  });

  it("accepts a running job with a progress snapshot", () => {
    const row = runJobSchema.parse({
      cancel_requested: false,
      created_at: "2026-01-01T00:00:00.000Z",
      id: "22222222-2222-2222-2222-222222222222",
      outcome: "passed",
      owner: "admin",
      pr: 2,
      progress: { action: "fill", phase: "execution", scenarioId: "welcome" },
      repo: "o/r",
      sha: "2".repeat(40),
      status: "running",
      updated_at: "2026-01-01T00:00:00.000Z",
      worker: "worker-1",
    });
    expect(row.progress?.phase).toBe("execution");
  });

  it("accepts a finished run result with absent optionals", () => {
    const result = runResultSchema.parse({
      endedAt: null,
      error: null,
      id: "33333333-3333-3333-3333-333333333333",
      outcome: "passed",
      preview: null,
      prUrl: "https://github.com/o/r/pull/3",
      publication: null,
      scenarios: [
        {
          artifacts: ["video.webm"],
          error: null,
          outcome: "passed",
          scenario: { id: "welcome", title: "Welcome" },
        },
      ],
      sha: "3".repeat(40),
      startedAt: "2026-01-01T00:00:00.000Z",
      usage: null,
    });
    expect(result.scenarios[0]?.artifacts).toEqual(["video.webm"]);
  });

  it("accepts a setup status without the admin-only preview fields", () => {
    const status = setupStatusSchema.parse({
      ai: { defaultModel: "model-x", endpoint: "ai.example.com" },
      github: { autoRepos: ["o/r"], mode: "technical", repositories: ["o/r"] },
      preview: { automatic: false, hosts: null, shaPath: null },
    });
    expect(status.preview.hosts).toBeNull();
    expect(status.github.autoRepos).toEqual(["o/r"]);
  });

  it("accepts a GitHub status before any App exists", () => {
    const status = githubStatusSchema.parse({
      app: null,
      lastDelivery: null,
      legacyConfigured: true,
      repositories: [
        {
          account: "o",
          auto_run: false,
          enabled: true,
          full_name: "o/r",
          installation_id: "42",
          private: true,
        },
      ],
      restriction: [],
    });
    expect(status.app).toBeNull();
    expect(status.repositories[0]?.auto_run).toBe(false);
  });

  it("keeps waiting, expired and rate-limited automatic attempts apart", () => {
    const status = automaticStatusSchema.parse({
      attempts: [
        {
          attempts: 3,
          deadlineAt: "2026-01-02T03:04:05.000Z",
          id: "delivery-1",
          reason: "PREVIEW_NOT_FOUND",
          pr: 7,
          repo: "o/r",
          runId: null,
          sha: "4".repeat(40),
          state: "waiting",
          updatedAt: "2026-01-02T03:04:05.000Z",
        },
        {
          attempts: 6,
          deadlineAt: "2026-01-02T03:34:05.000Z",
          id: "delivery-2",
          reason: "WEBHOOK_RATE_LIMIT",
          pr: 8,
          repo: "o/r",
          runId: null,
          sha: "5".repeat(40),
          state: "rate_limited",
          updatedAt: "2026-01-02T03:34:05.000Z",
        },
      ],
      enabledRepos: ["o/r"],
      summary: { expired: 1, rateLimited: 1, waiting: 1 },
    });
    expect(status.attempts[0]?.state).toBe("waiting");
    expect(status.summary.expired).toBe(1);
  });

  it("keeps the nested diagnostic data of a report", () => {
    const parsed = runResultSchema.parse({
      id: "44444444-4444-4444-4444-444444444444",
      outcome: "failed",
      prUrl: "https://github.com/o/r/pull/3",
      scenarios: [
        {
          artifacts: [],
          assertions: [{ actual: "Ada", id: "saved", passed: false }],
          contract: { completedSteps: ["enter"], hash: "h", totalSteps: 2 },
          diagnostic: { code: "BLOCKED", message: "boom" },
          outcome: "failed",
          scenario: {
            id: "welcome",
            requirements: [{ behavior: "save", quote: "show(name)" }],
            steps: [{ id: "enter" }],
            title: "Welcome",
          },
          sessionId: "session-1",
          steps: [{ index: 0, ok: true, reason: "filled" }],
        },
      ],
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const scenario = parsed.scenarios[0];
    // The <pre id="result"> diagnostic prints this object: nothing may vanish.
    expect(scenario?.sessionId).toBe("session-1");
    expect(scenario?.contract).toEqual({
      completedSteps: ["enter"],
      hash: "h",
      totalSteps: 2,
    });
    expect(scenario?.steps).toEqual([{ index: 0, ok: true, reason: "filled" }]);
    expect(scenario?.scenario.steps).toEqual([{ id: "enter" }]);
  });

  it("rejects a response that breaks the contract", () => {
    expect(() =>
      runJobListSchema.parse([{ id: "not-a-run", status: "unknown" }])
    ).toThrow();
  });
});
