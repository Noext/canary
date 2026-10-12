import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AutomaticStatus } from "../src/dashboard/contracts.js";
import { startProductionServer } from "../src/production-server.js";
import type { Queue } from "../src/queue.js";
import { retain } from "../src/retention.js";
import { processDelivery } from "../src/webhook-inbox.js";
import { fixture, PR_URL, pgliteQueue, SHA } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

/** One delivery record per `(repo, pr, sha)`, as accepted from the webhook. */
const attempt = {
  number: 1,
  prUrl: PR_URL,
  repo: "fixture/app",
  sha: SHA,
};

interface DeliveryRow {
  attempts: number;
  last_error: string | null;
  reason: string | null;
  retry_in: number;
  run_id: string | null;
  status: string;
}

async function delivery(q: Queue, id: string) {
  const row = (
    await q.pool.query<DeliveryRow>(
      "SELECT status,attempts,reason,last_error,run_id,round(extract(epoch from retry_at-now()))::int AS retry_in FROM qa_deliveries WHERE id=$1",
      [id]
    )
  ).rows[0];
  if (!row) {
    throw new Error(`Delivery ${id} is missing`);
  }
  return row;
}

/** Makes the next pending probe due without waiting for its backoff. */
async function due(q: Queue) {
  await q.pool.query(
    "UPDATE qa_deliveries SET retry_at=now()-interval '1 second' WHERE status='pending'"
  );
}

function audits(q: Queue, action: string) {
  return q.pool
    .query<{ details: Record<string, unknown>; run_id: string | null }>(
      "SELECT details,run_id FROM qa_audit WHERE action=$1 ORDER BY id",
      [action]
    )
    .then((result) => result.rows);
}

it("waits durably for a verifiable preview, then promotes the attempt into a real job", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  expect(await q.acceptDelivery("attempt", "pull_request", attempt, 1800)).toBe(
    true
  );
  // No preview template and no successful deployment: the SHA stays unproven.
  await processDelivery(q, f.config);
  expect(await delivery(q, "attempt")).toMatchObject({
    attempts: 1,
    last_error: null,
    reason: "PREVIEW_NOT_FOUND",
    run_id: null,
    status: "pending",
  });
  expect(await q.list(["fixture/app"])).toEqual([]);
  const waiting = await q.automatic(["FIXTURE/APP"], 1800);
  expect(waiting.attempts).toMatchObject([
    {
      attempts: 1,
      id: "attempt",
      pr: 1,
      reason: "PREVIEW_NOT_FOUND",
      repo: "fixture/app",
      runId: null,
      sha: SHA,
      state: "waiting",
    },
  ]);
  expect(waiting.summary).toEqual({ expired: 0, rateLimited: 0, waiting: 1 });
  expect(Date.parse(waiting.attempts[0]!.deadlineAt)).toBeGreaterThan(
    Date.now()
  );
  expect((await audits(q, "automatic.preview_wait")).length).toBe(1);
  // A repeated probe with the same cause stays quiet in the audit log.
  await due(q);
  await processDelivery(q, f.config);
  expect((await delivery(q, "attempt")).attempts).toBe(2);
  expect((await audits(q, "automatic.preview_wait")).length).toBe(1);
  await due(q);
  await processDelivery(q, { ...f.config, PREVIEW_URL_TEMPLATE: f.baseUrl });
  const promoted = await delivery(q, "attempt");
  const jobs = await q.list(["fixture/app"]);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    owner: "github-app",
    pr: 1,
    sha: SHA,
    status: "queued",
  });
  expect(promoted).toMatchObject({
    attempts: 2,
    run_id: jobs[0]!.id,
    status: "processed",
  });
  expect(await audits(q, "automatic.promoted")).toMatchObject([
    { run_id: jobs[0]!.id },
  ]);
  // A promoted attempt is no longer reported as waiting.
  expect(await q.automatic(["fixture/app"], 1800)).toEqual({
    attempts: [],
    summary: { expired: 0, rateLimited: 0, waiting: 0 },
  });
}, 30_000);

it("reports the effective deadline of a delivery accepted without one", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  expect(await q.acceptDelivery("legacy", "pull_request", attempt, 1800)).toBe(
    true
  );
  // A delivery stored before `deadline_at` existed (schema v5) keeps a null
  // deadline: the worker still waits `created_at + QA_AUTO_PREVIEW_WAIT_SECONDS`,
  // and the dashboard must show that same instant, never `created_at`.
  await q.pool.query(
    "UPDATE qa_deliveries SET deadline_at=NULL,created_at=now()-interval '10 seconds' WHERE id='legacy'"
  );
  const created = (
    await q.pool.query<{ created_at: Date }>(
      "SELECT created_at FROM qa_deliveries WHERE id='legacy'"
    )
  ).rows[0]!.created_at;
  const waiting = await q.automatic(["fixture/app"], 900);
  expect(Date.parse(waiting.attempts[0]!.deadlineAt)).toBe(
    created.getTime() + 900_000
  );
  // The same rule keeps the worker waiting instead of expiring the attempt.
  await processDelivery(q, f.config);
  expect(await delivery(q, "legacy")).toMatchObject({ status: "pending" });
}, 30_000);

it("lets only the owning worker promote, expire or reschedule an attempt", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  expect(await q.acceptDelivery("owned", "pull_request", attempt, 1800)).toBe(
    true
  );
  const first = await q.claimDelivery("token-one", 90);
  expect(first).toMatchObject({ id: "owned" });
  // The lease expires (a probe that took longer than 90 s, or a restarted
  // worker): a second worker takes the same delivery over.
  await due(q);
  expect(await q.claimDelivery("token-two", 90)).toMatchObject({
    id: "owned",
  });
  const job = await q.enqueue(
    "fixture/app",
    1,
    SHA,
    "github-app",
    { prUrl: PR_URL, publish: true, model: "fixture/model" },
    "webhook:owned"
  );
  // Every write from the stale owner is refused, so no run can appear after
  // another worker already decided what happened to the attempt.
  expect(await q.deliveryClaim("owned", "token-one")).toBeUndefined();
  expect(
    await q.holdDelivery("owned", "token-one", "PREVIEW_NOT_FOUND", 30, 1800)
  ).toBe(false);
  expect(
    await q.failDelivery("owned", "token-one", "expired", "PREVIEW_NOT_FOUND")
  ).toBe(false);
  expect(await q.promoteDelivery("owned", "token-one", job.id, 1800)).toBe(
    false
  );
  expect(await delivery(q, "owned")).toMatchObject({
    run_id: null,
    status: "pending",
  });
  // The current owner promotes it normally.
  expect(await q.promoteDelivery("owned", "token-two", job.id, 1800)).toBe(
    true
  );
  expect(await delivery(q, "owned")).toMatchObject({
    run_id: job.id,
    status: "processed",
  });
}, 30_000);

it("refuses to promote an attempt whose deadline closed during the probe", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  expect(
    await q.acceptDelivery("late-promotion", "pull_request", attempt, 1800)
  ).toBe(true);
  await q.claimDelivery("token", 90);
  const job = await q.enqueue(
    "fixture/app",
    1,
    SHA,
    "github-app",
    { prUrl: PR_URL, publish: true, model: "fixture/model" },
    "webhook:late-promotion"
  );
  // The preview only proved the exact SHA after the wait window elapsed.
  await q.pool.query(
    "UPDATE qa_deliveries SET deadline_at=now()-interval '1 second' WHERE id='late-promotion'"
  );
  expect(await q.promoteDelivery("late-promotion", "token", job.id, 1800)).toBe(
    false
  );
  expect(await delivery(q, "late-promotion")).toMatchObject({
    run_id: null,
    status: "pending",
  });
}, 30_000);

it("purges terminal deliveries, including auto-disabled ones, during retention", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  const ids = ["old-auto-disabled", "old-expired", "old-processed"];
  // Distinct PRs: `acceptDelivery` deduplicates one row per (repo, pr, sha).
  for (const [index, id] of [...ids, "recent-auto-disabled"].entries()) {
    await q.acceptDelivery(
      id,
      "pull_request",
      {
        ...attempt,
        number: index + 1,
        sha: String(index + 1).repeat(40),
      },
      1800
    );
  }
  await q.pool.query(
    `UPDATE qa_deliveries SET status=CASE id WHEN 'old-auto-disabled' THEN 'auto_disabled' WHEN 'old-expired' THEN 'expired' ELSE 'processed' END,created_at=now()-interval '31 days' WHERE id = ANY($1::text[])`,
    [ids]
  );
  await q.pool.query(
    "UPDATE qa_deliveries SET status='auto_disabled' WHERE id='recent-auto-disabled'"
  );
  await retain(q, f.config);
  expect(
    (
      await q.pool.query<{ id: string }>(
        "SELECT id FROM qa_deliveries ORDER BY id"
      )
    ).rows.map((row) => row.id)
  ).toEqual(["recent-auto-disabled"]);
}, 30_000);

it("never reports an ignored webhook as a waiting attempt", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  // A non-triggering `pull_request` action (`labeled`, `closed`, ...) is stored
  // for deduplication only: it has no pull request to test.
  expect(
    await q.acceptDelivery(
      "ignored",
      "pull_request",
      { ignored: true, repo: "fixture/app" },
      1800
    )
  ).toBe(true);
  expect(await q.automatic(["fixture/app"], 1800)).toEqual({
    attempts: [],
    summary: { expired: 0, rateLimited: 0, waiting: 0 },
  });
  // The probe loop still clears it, so retention can delete the row.
  expect(await delivery(q, "ignored")).toMatchObject({ status: "pending" });
  await processDelivery(q, f.config);
  expect(await delivery(q, "ignored")).toMatchObject({ status: "processed" });
}, 30_000);

it("schedules the next probe at the deadline instead of past it", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  expect(await q.acceptDelivery("capped", "pull_request", attempt, 60)).toBe(
    true
  );
  // Three failed probes already: the next backoff (300 s) is far past the
  // 60 s deadline, which must still bound the schedule.
  await q.pool.query("UPDATE qa_deliveries SET attempts=3 WHERE id='capped'");
  await processDelivery(q, f.config);
  expect(await delivery(q, "capped")).toMatchObject({
    attempts: 4,
    reason: "PREVIEW_NOT_FOUND",
    status: "pending",
  });
  const schedule = (
    await q.pool.query<{ overdue: boolean; retry_in: number }>(
      "SELECT retry_at<=deadline_at AS overdue,round(extract(epoch from deadline_at-now()))::int AS retry_in FROM qa_deliveries WHERE id='capped'"
    )
  ).rows[0]!;
  expect(schedule.overdue).toBe(true);
  expect(schedule.retry_in).toBeLessThanOrEqual(60);
  // At the deadline the attempt expires at the next probe instead of waiting
  // for the long backoff it would otherwise have been given.
  await q.pool.query(
    "UPDATE qa_deliveries SET deadline_at=now()-interval '1 second' WHERE id='capped'"
  );
  await due(q);
  await processDelivery(q, f.config);
  expect(await delivery(q, "capped")).toMatchObject({ status: "expired" });
  expect((await audits(q, "automatic.preview_expired")).length).toBe(1);
}, 30_000);

it("expires an attempt past its deadline, warns once and never replays it", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  expect(await q.acceptDelivery("late", "pull_request", attempt, -1)).toBe(
    true
  );
  await processDelivery(q, f.config);
  expect(await delivery(q, "late")).toMatchObject({
    attempts: 0,
    last_error: null,
    reason: "PREVIEW_UNAVAILABLE",
    run_id: null,
    status: "expired",
  });
  expect(await q.list(["fixture/app"])).toEqual([]);
  expect(await audits(q, "automatic.preview_expired")).toMatchObject([
    {
      details: {
        attempts: 0,
        delivery: "late",
        pr: 1,
        repo: "fixture/app",
        sha: SHA,
      },
    },
  ]);
  const automatic = await q.automatic(["fixture/app"], 1800);
  expect(automatic.attempts).toMatchObject([
    {
      id: "late",
      reason: "PREVIEW_UNAVAILABLE",
      repo: "fixture/app",
      runId: null,
      state: "expired",
    },
  ]);
  expect(automatic.summary).toEqual({ expired: 1, rateLimited: 0, waiting: 0 });
  // Even a verifiable preview cannot revive an expired attempt.
  await due(q);
  await processDelivery(q, { ...f.config, PREVIEW_URL_TEMPLATE: f.baseUrl });
  expect(await delivery(q, "late")).toMatchObject({
    attempts: 0,
    status: "expired",
  });
  expect(await q.list(["fixture/app"])).toEqual([]);
}, 30_000);

it("records auto_disabled attempts when automatic runs are switched off", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  expect(
    await q.acceptDelivery("disabled", "pull_request", attempt, 1800)
  ).toBe(true);
  const config = { ...f.config, autoRuns: false };
  await processDelivery(q, config);
  expect(await delivery(q, "disabled")).toMatchObject({
    attempts: 0,
    last_error: null,
    reason: "AUTO_RUNS_DISABLED",
    status: "auto_disabled",
  });
  expect(await audits(q, "automatic.disabled")).toMatchObject([
    { details: { delivery: "disabled", repo: "fixture/app", sha: SHA } },
  ]);
  expect(await q.list(["fixture/app"])).toEqual([]);
  // No probe loop: the attempt stays out of the waiting list and is not probed again.
  await due(q);
  await processDelivery(q, config);
  expect(await delivery(q, "disabled")).toMatchObject({
    attempts: 0,
    status: "auto_disabled",
  });
  expect(await q.automatic(["fixture/app"], 1800)).toEqual({
    attempts: [],
    summary: { expired: 0, rateLimited: 0, waiting: 0 },
  });
}, 30_000);

it("records auto_disabled when the repository is not opted in for automatic runs", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  expect(
    await q.acceptDelivery("opted-out", "pull_request", attempt, 1800)
  ).toBe(true);
  await processDelivery(q, { ...f.config, automaticRepos: ["other/repo"] });
  expect(await delivery(q, "opted-out")).toMatchObject({
    attempts: 0,
    reason: "AUTO_REPO_DISABLED",
    status: "auto_disabled",
  });
  expect(await audits(q, "automatic.repo_disabled")).toMatchObject([
    { details: { delivery: "opted-out", repo: "fixture/app", sha: SHA } },
  ]);
  expect(await q.list(["fixture/app"])).toEqual([]);
  // Legacy mode (`automaticRepos` undefined) keeps every allowed repository automatic.
  expect(
    await q.acceptDelivery(
      "legacy",
      "pull_request",
      { ...attempt, sha: "3".repeat(40) },
      -1
    )
  ).toBe(true);
  await processDelivery(q, { ...f.config, automaticRepos: undefined });
  expect(await delivery(q, "legacy")).toMatchObject({ status: "expired" });
}, 30_000);

it("fails the attempt as rate_limited when the durable hourly budget is spent", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  await q.enqueue(
    "other/repo",
    1,
    SHA,
    "github-app",
    { prUrl: PR_URL },
    "delivery:spent-budget"
  );
  expect(await q.acceptDelivery("limited", "pull_request", attempt, 1800)).toBe(
    true
  );
  await processDelivery(q, {
    ...f.config,
    PREVIEW_URL_TEMPLATE: f.baseUrl,
    QA_WEBHOOK_MAX_RUNS_PER_HOUR: 1,
  });
  expect(await delivery(q, "limited")).toMatchObject({
    attempts: 0,
    reason: "WEBHOOK_RATE_LIMIT",
    run_id: null,
    status: "rate_limited",
  });
  expect((await delivery(q, "limited")).last_error).toContain(
    "hourly run limit"
  );
  expect(await q.list(["fixture/app"])).toEqual([]);
  expect(await audits(q, "automatic.rate_limited")).toMatchObject([
    { details: { delivery: "limited", repo: "fixture/app", sha: SHA } },
  ]);
  expect(await q.automatic(["fixture/app"], 1800)).toMatchObject({
    attempts: [{ id: "limited", runId: null, state: "rate_limited" }],
    summary: { expired: 0, rateLimited: 1, waiting: 0 },
  });
}, 30_000);

it("grows the probe backoff 30/60/120/300 and audits only a change of cause", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  expect(
    await q.acceptDelivery("backoff", "pull_request", attempt, 86_400)
  ).toBe(true);
  const delays: number[] = [];
  for (let probe = 0; probe < 6; probe++) {
    await due(q);
    await processDelivery(q, f.config);
    delays.push((await delivery(q, "backoff")).retry_in);
  }
  expect(delays).toEqual([30, 60, 120, 300, 300, 300]);
  expect((await delivery(q, "backoff")).attempts).toBe(6);
  expect((await audits(q, "automatic.preview_wait")).length).toBe(1);
  // A different failure cause is a new transition and is audited again.
  await due(q);
  await processDelivery(q, {
    ...f.config,
    allowedHosts: ["preview.example.test"],
    PREVIEW_URL_TEMPLATE: f.baseUrl,
  });
  const changed = await delivery(q, "backoff");
  expect(changed).toMatchObject({
    attempts: 7,
    reason: "PREVIEW_HOST_NOT_ALLOWED",
    status: "pending",
  });
  expect((await audits(q, "automatic.preview_wait")).length).toBe(2);
}, 30_000);

it("serves /dashboard/automatic scoped to the repositories of the requesting principal", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  const tokens = {
    fixture: "automatic-fixture-viewer-token-0123456789",
    other: "automatic-other-viewer-token-0123456789",
  };
  const usersFile = join(f.dataDir, "automatic-users.json");
  await writeFile(
    usersFile,
    JSON.stringify([
      {
        id: "fixture-viewer",
        repos: ["fixture/app"],
        role: "viewer",
        tokenSha256: createHash("sha256").update(tokens.fixture).digest("hex"),
      },
      {
        id: "other-viewer",
        repos: ["other/repo"],
        role: "viewer",
        tokenSha256: createHash("sha256").update(tokens.other).digest("hex"),
      },
    ])
  );
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    GITHUB_ALLOWED_REPOS: "fixture/app,other/repo",
    QA_PORT: 0,
    QA_USERS_FILE: usersFile,
    allowedRepos: ["fixture/app", "other/repo"],
  };
  await q.acceptDelivery("expired-attempt", "pull_request", attempt, -1);
  await processDelivery(q, config);
  await q.acceptDelivery(
    "waiting-attempt",
    "pull_request",
    { ...attempt, repo: "other/repo" },
    1800
  );
  const server = await startProductionServer(config);
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const read = async (token: string): Promise<AutomaticStatus> =>
    (await (
      await fetch(`${url}/dashboard/automatic`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as AutomaticStatus;
  expect(await read(tokens.fixture)).toEqual({
    attempts: [
      expect.objectContaining({
        id: "expired-attempt",
        repo: "fixture/app",
        runId: null,
        state: "expired",
      }),
    ],
    enabledRepos: ["fixture/app"],
    summary: { expired: 1, rateLimited: 0, waiting: 0 },
  });
  expect(await read(tokens.other)).toEqual({
    attempts: [
      expect.objectContaining({
        id: "waiting-attempt",
        repo: "other/repo",
        runId: null,
        state: "waiting",
      }),
    ],
    enabledRepos: ["other/repo"],
    summary: { expired: 0, rateLimited: 0, waiting: 1 },
  });
  const admin = await read(config.QA_API_TOKEN);
  expect(admin.enabledRepos).toEqual(["fixture/app", "other/repo"]);
  expect(admin.summary).toEqual({ expired: 1, rateLimited: 0, waiting: 1 });
  expect(admin.attempts.map((item) => item.id).sort()).toEqual([
    "expired-attempt",
    "waiting-attempt",
  ]);
  const status = (await (
    await fetch(`${url}/dashboard/status`, {
      headers: { Authorization: `Bearer ${config.QA_API_TOKEN}` },
    })
  ).json()) as { github: { autoRepos: string[]; repositories: string[] } };
  expect(status.github).toEqual({
    autoRepos: ["fixture/app", "other/repo"],
    mode: "technical",
    repositories: ["fixture/app", "other/repo"],
  });
}, 30_000);
