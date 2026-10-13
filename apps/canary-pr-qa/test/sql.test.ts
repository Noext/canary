import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { completeRun } from "../src/completion.js";
import { doctor } from "../src/doctor.js";
import { GitHub } from "../src/github.js";
import { GitHubSetup, REQUIRED_PERMISSIONS } from "../src/github-setup.js";
import { LocalAuth } from "../src/local-auth.js";
import { startProductionServer } from "../src/production-server.js";
import { Queue, SCHEMA_VERSION } from "../src/queue.js";
import type { RunResult } from "../src/schema.js";
import { processDelivery } from "../src/webhook-inbox.js";
import { startWorker } from "../src/worker.js";
import { BASE_SHA, fixture, PR_URL, pgliteQueue, SHA } from "./fixture.js";
import { githubSetupFixture } from "./github-setup-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});
async function sqlDatabase() {
  return await pgliteQueue(cleanup);
}
it("runs migration, idempotent enqueue, ownership leases, cancellation and crash recovery against PostgreSQL SQL", async () => {
  const q = await sqlDatabase();
  const first = await q.enqueue(
    "fixture/app",
    1,
    SHA,
    "alice",
    { prUrl: PR_URL },
    "one"
  );
  const duplicate = await q.enqueue(
    "fixture/app",
    1,
    SHA,
    "alice",
    { prUrl: PR_URL },
    "one"
  );
  expect(duplicate.id).toBe(first.id);
  expect((await q.list(["FiXtUrE/ApP"])).map((job) => job.id)).toEqual([
    first.id,
  ]);
  expect(await q.list(["other/repo"])).toEqual([]);
  const claimed = await q.claim("worker-a");
  expect(claimed?.id).toBe(first.id);
  expect(await q.heartbeat(first.id, "worker-b")).toBe(false);
  expect(await q.heartbeat(first.id, "worker-a")).toBe(true);
  await q.enqueue(
    "fixture/app",
    1,
    BASE_SHA,
    "alice",
    { prUrl: PR_URL },
    "two"
  );
  expect(await q.heartbeat(first.id, "worker-a")).toBe(false);
  await q.complete(first.id, "worker-a", "blocked");
  expect((await q.get(first.id))?.status).toBe("cancelled");
  const second = await q.claim("worker-b");
  await q.pool.query(
    "UPDATE qa_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",
    [second!.id]
  );
  expect(await q.heartbeat(second!.id, "worker-b")).toBe(false);
  await expect(q.complete(second!.id, "worker-b", "passed")).rejects.toThrow(
    "lost job ownership"
  );
  expect(await q.claim("worker-c")).toBeUndefined();
  expect((await q.get(second!.id))?.status).toBe("interrupted");
  await expect(q.complete(second!.id, "worker-b", "passed")).rejects.toThrow(
    "lost job ownership"
  );
}, 30_000);
it("serves authenticated dashboard, project-scoped API, idempotency and SSE on production routes", async () => {
  const q = await sqlDatabase();
  const f = await fixture();
  cleanup.push(f.close);
  const token = "individual-token-0123456789-abcdef";
  const mixedCaseToken = "mixed-case-viewer-token-0123456789";
  const usersFile = join(f.dataDir, "users.json");
  await writeFile(
    usersFile,
    JSON.stringify([
      {
        id: "viewer",
        role: "viewer",
        repos: ["other/repo"],
        tokenSha256: createHash("sha256").update(token).digest("hex"),
      },
      {
        id: "authorized-viewer",
        role: "viewer",
        repos: ["FiXtUrE/ApP"],
        tokenSha256: createHash("sha256").update(mixedCaseToken).digest("hex"),
      },
    ])
  );
  const server = await startProductionServer({
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
    QA_USERS_FILE: usersFile,
  });
  cleanup.push(() => server.shutdown());
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const admin = { Authorization: `Bearer ${f.config.QA_API_TOKEN}` };
  expect((await fetch(`${url}/`)).status).toBe(200);
  expect((await fetch(`${url}/runs`)).status).toBe(401);
  const run = await q.enqueue(
    "fixture/app",
    1,
    SHA,
    "admin",
    { prUrl: PR_URL },
    "run"
  );
  expect(
    (
      await fetch(`${url}/runs/${run.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status
  ).toBe(403);
  const login = await fetch(`${url}/session`, {
    method: "POST",
    headers: admin,
  });
  expect(login.status).toBe(200);
  expect(await login.clone().json()).toMatchObject({
    role: "admin",
    repos: ["fixture/app"],
  });
  expect(login.headers.get("set-cookie")).toContain("HttpOnly");
  expect(login.headers.get("set-cookie")).toContain("SameSite=Lax");
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (
      await fetch(`${url}/runs/${run.id}/cancel`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://attacker.invalid" },
      })
    ).status
  ).toBe(403);
  expect((await q.get(run.id))?.cancel_requested).toBe(false);
  const list = await fetch(`${url}/runs`, { headers: admin });
  expect(((await list.json()) as unknown[]).length).toBe(1);
  const mixedCaseHeaders = { Authorization: `Bearer ${mixedCaseToken}` };
  expect(
    (await (
      await fetch(`${url}/runs`, { headers: mixedCaseHeaders })
    ).json()) as { id: string }[]
  ).toMatchObject([{ id: run.id }]);
  expect(
    (await fetch(`${url}/runs/${run.id}`, { headers: mixedCaseHeaders })).status
  ).toBe(200);
  // A run this instance does not have answers 404 under its own code, so the
  // dashboard can tell a purged run from a passing outage without parsing a
  // message: only that verdict replaces a detail with a missing state.
  const absent = await fetch(
    `${url}/runs/87654321-1234-1234-1234-123456789012`,
    { headers: admin }
  );
  expect(absent.status).toBe(404);
  expect(await absent.json()).toMatchObject({ code: "RUN_NOT_FOUND" });
  const stream = await fetch(`${url}/runs/${run.id}/events`, {
    headers: admin,
  });
  const reader = stream.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    '"status":"queued"'
  );
  await reader.cancel();
  expect(
    (
      await fetch(`${url}/runs/${run.id}/cancel`, {
        method: "POST",
        headers: admin,
      })
    ).status
  ).toBe(200);
  expect((await q.get(run.id))?.status).toBe("cancelled");
  const captureRoot = join(f.dataDir, run.id, "scenario");
  await mkdir(captureRoot, { recursive: true });
  await writeFile(join(captureRoot, "trace.zip"), "private trace test data");
  for (const path of [
    "scenario/trace.zip",
    "scenario/trace.%7aip",
    "scenario/trace%2ezip",
  ]) {
    expect(
      (
        await fetch(`${url}/artifacts/${run.id}/${path}`, {
          headers: mixedCaseHeaders,
        })
      ).status
    ).toBe(403);
  }
  for (const path of ["scenario/trace.%257aip", "scenario%2ftrace.zip"]) {
    expect(
      (
        await fetch(`${url}/artifacts/${run.id}/${path}`, {
          headers: mixedCaseHeaders,
        })
      ).status
    ).toBe(400);
  }
  expect((await fetch(`${url}/models`)).status).toBe(401);
  expect(
    (await fetch(`${url}/models`, { headers: mixedCaseHeaders })).status
  ).toBe(403);
  const catalog = await fetch(`${url}/models`, { headers: admin });
  expect(catalog.status).toBe(200);
  expect(await catalog.json()).toMatchObject({
    defaultModel: "fixture-scripted-model",
  });
  const denied = await fetch(`${url}/runs`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({
      prUrl: PR_URL,
      previewUrl: f.baseUrl,
      model: "absent-model",
    }),
  });
  expect(denied.status).toBeGreaterThanOrEqual(400);
  expect((await q.list(["fixture/app"])).length).toBe(1);
  const chosen = await fetch(`${url}/runs`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({
      prUrl: PR_URL,
      previewUrl: f.baseUrl,
      model: "fixture-alternate-model",
    }),
  });
  expect(chosen.status).toBe(202);
  const created = (await chosen.json()) as { id: string };
  expect((await q.get(created.id))?.input.model).toBe(
    "fixture-alternate-model"
  );
}, 30_000);

it("accepts only signed webhook bytes, deduplicates deliveries and waits for live SHA provenance before enqueue", async () => {
  const q = await sqlDatabase();
  const f = await fixture();
  cleanup.push(f.close);
  const secret = "webhook-secret-0123456789-abcdef-123456";
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
    GITHUB_WEBHOOK_SECRET: secret,
  };
  const server = await startProductionServer(config);
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/github/webhook`;
  const payload = JSON.stringify({
    action: "synchronize",
    repository: { full_name: "fixture/app" },
    pull_request: {
      number: 1,
      html_url: PR_URL,
      head: { sha: SHA },
      draft: false,
    },
  });
  const headers = {
    "x-github-delivery": "delivery-42",
    "x-github-event": "pull_request",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
  };
  expect(
    (await fetch(url, { method: "POST", headers, body: `${payload} ` })).status
  ).toBe(401);
  expect(
    (await fetch(url, { method: "POST", headers, body: payload })).status
  ).toBe(202);
  expect(
    await (await fetch(url, { method: "POST", headers, body: payload })).json()
  ).toMatchObject({ duplicate: true });
  expect(
    await (
      await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "x-github-delivery": "different-delivery-same-sha",
        },
        body: payload,
      })
    ).json()
  ).toMatchObject({ duplicate: true });
  await processDelivery(q, config);
  expect(await q.list(["fixture/app"])).toEqual([]);
  const held = (
    await q.pool.query(
      "SELECT status,attempts,reason,last_error,round(extract(epoch from deadline_at-now()))::int AS deadline FROM qa_deliveries WHERE id='delivery-42'"
    )
  ).rows[0];
  expect(held).toMatchObject({
    attempts: 1,
    last_error: null,
    reason: "PREVIEW_NOT_FOUND",
    status: "pending",
  });
  // The webhook stored QA_AUTO_PREVIEW_WAIT_SECONDS (1800 by default) as the deadline.
  expect(held.deadline).toBe(1800);
  expect(
    (
      await q.pool.query(
        "SELECT count(*)::int AS count FROM qa_audit WHERE action='automatic.preview_wait'"
      )
    ).rows[0].count
  ).toBe(1);
  await q.pool.query(
    "UPDATE qa_deliveries SET retry_at=now()-interval '1 second'"
  );
  await processDelivery(q, { ...config, PREVIEW_URL_TEMPLATE: f.baseUrl });
  expect((await q.list(["fixture/app"])).length).toBe(1);
  expect(
    (
      await q.pool.query(
        "SELECT status,attempts,run_id FROM qa_deliveries WHERE id='delivery-42'"
      )
    ).rows[0]
  ).toMatchObject({
    attempts: 1,
    run_id: (await q.list(["fixture/app"]))[0]!.id,
    status: "processed",
  });
  expect(
    (
      await q.pool.query(
        "SELECT run_id FROM qa_audit WHERE action='automatic.promoted'"
      )
    ).rows[0].run_id
  ).toBe((await q.list(["fixture/app"]))[0]!.id);
  await processDelivery(q, config);
  expect((await q.list(["fixture/app"])).length).toBe(1);
}, 30_000);

it("deduplicates automatic PR/SHA runs across delivery IDs and applies durable hourly limits", async () => {
  const q = await sqlDatabase();
  const limits = { global: 2, repository: 1 };
  const first = await q.enqueue(
    "fixture/app",
    1,
    SHA,
    "github-app",
    { prUrl: PR_URL },
    "delivery:legacy"
  );
  const duplicate = await q.enqueue(
    "FIXTURE/APP",
    1,
    SHA,
    "github-app",
    { prUrl: PR_URL },
    `webhook:fixture/app:1:${SHA}`,
    limits
  );
  expect(duplicate.id).toBe(first.id);
  await q.cancel(first.id, "test");
  await expect(
    q.enqueue(
      "fixture/app",
      2,
      SHA,
      "github-app",
      { prUrl: PR_URL },
      "webhook:second-pr",
      limits
    )
  ).rejects.toMatchObject({ code: "WEBHOOK_RATE_LIMIT" });
  await q.enqueue(
    "other/repo",
    1,
    SHA,
    "github-app",
    { prUrl: PR_URL },
    "webhook:other-repo",
    limits
  );
  await expect(
    q.enqueue(
      "third/repo",
      1,
      SHA,
      "github-app",
      { prUrl: PR_URL },
      "webhook:third-repo",
      limits
    )
  ).rejects.toMatchObject({ code: "WEBHOOK_RATE_LIMIT" });
  // An authenticated explicit rerun remains possible; failed/cancelled attempts still cost budget.
  await q.enqueue(
    "fixture/app",
    1,
    SHA,
    "operator",
    { prUrl: PR_URL },
    "manual:rerun"
  );
  expect(await q.list(["fixture/app"])).toHaveLength(2);
  await q.pool.query(
    "UPDATE qa_jobs SET created_at=now()-interval '2 hours' WHERE owner='github-app'"
  );
  await q.enqueue(
    "fixture/app",
    2,
    SHA,
    "github-app",
    { prUrl: PR_URL },
    "webhook:second-pr",
    limits
  );
  expect(await q.list(["fixture/app"])).toHaveLength(3);
}, 30_000);

it("records rate-limited webhook work without enqueueing or automatically retrying a model run", async () => {
  const q = await sqlDatabase();
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
  const payload = { repo: "fixture/app", number: 1, sha: SHA, prUrl: PR_URL };
  expect(await q.acceptDelivery("rate-limited", "pull_request", payload)).toBe(
    true
  );
  await processDelivery(q, {
    ...f.config,
    PREVIEW_URL_TEMPLATE: f.baseUrl,
    QA_WEBHOOK_MAX_RUNS_PER_HOUR: 1,
  });
  expect(await q.list(["fixture/app"])).toEqual([]);
  expect(
    (
      await q.pool.query(
        "SELECT status,attempts,reason,last_error,run_id FROM qa_deliveries WHERE id='rate-limited'"
      )
    ).rows[0]
  ).toMatchObject({
    attempts: 0,
    reason: "WEBHOOK_RATE_LIMIT",
    run_id: null,
    status: "rate_limited",
  });
  expect(
    (
      await q.pool.query(
        "SELECT last_error FROM qa_deliveries WHERE id='rate-limited'"
      )
    ).rows[0].last_error
  ).toContain("hourly run limit");
  expect(
    (
      await q.pool.query(
        "SELECT details FROM qa_audit WHERE action='webhook.rate_limited'"
      )
    ).rows
  ).toMatchObject([
    { details: { delivery: "rate-limited", repo: "fixture/app", sha: SHA } },
  ]);
  expect(
    (
      await q.pool.query(
        "SELECT details FROM qa_audit WHERE action='automatic.rate_limited'"
      )
    ).rows
  ).toMatchObject([
    { details: { delivery: "rate-limited", repo: "fixture/app", sha: SHA } },
  ]);
  expect(await q.automatic(["fixture/app"], 1800)).toMatchObject({
    attempts: [{ id: "rate-limited", runId: null, state: "rate_limited" }],
    summary: { expired: 0, rateLimited: 1, waiting: 0 },
  });
  expect(
    await q.acceptDelivery("reopened-same-sha", "pull_request", payload)
  ).toBe(false);
  await processDelivery(q, f.config);
  expect(await q.list(["fixture/app"])).toEqual([]);
}, 30_000);

it("migrates an existing install to the current schema version without losing pending deliveries", async () => {
  expect(SCHEMA_VERSION).toBe(9);
  const q = await sqlDatabase();
  expect(
    await q.acceptDelivery("legacy", "pull_request", {
      number: 1,
      prUrl: PR_URL,
      repo: "fixture/app",
      sha: SHA,
    })
  ).toBe(true);
  for (const column of [
    "attempts",
    "claim_token",
    "deadline_at",
    "reason",
    "last_error",
    "run_id",
    "updated_at",
  ]) {
    await q.pool.query(`ALTER TABLE qa_deliveries DROP COLUMN ${column}`);
  }
  await q.pool.query("DELETE FROM qa_schema WHERE version=$1", [
    SCHEMA_VERSION,
  ]);
  // The audit index rides with the same version: an install that migrates has to
  // get it back too, or the attempt detail would scan the whole audit table.
  await q.pool.query("DROP INDEX IF EXISTS qa_audit_delivery");
  await q.migrate();
  const columns = (
    await q.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='qa_deliveries'"
    )
  ).rows.map((row) => row.column_name);
  expect(columns).toEqual(
    expect.arrayContaining([
      "attempts",
      "claim_token",
      "deadline_at",
      "reason",
      "last_error",
      "run_id",
      "updated_at",
    ])
  );
  expect(
    (
      await q.pool.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE tablename='qa_audit'"
      )
    ).rows.map((row) => row.indexname)
  ).toContain("qa_audit_delivery");
  expect(
    (
      await q.pool.query(
        "SELECT status,attempts,reason,last_error,run_id FROM qa_deliveries WHERE id='legacy'"
      )
    ).rows[0]
  ).toMatchObject({
    attempts: 0,
    last_error: null,
    reason: null,
    run_id: null,
    status: "pending",
  });
  expect(
    (await q.pool.query("SELECT version FROM qa_schema")).rows.map(
      (row) => row.version
    )
  ).toContain(SCHEMA_VERSION);
}, 30_000);

it("keeps doctor aligned with the actual migration version and rejects older schemas", async () => {
  const q = await sqlDatabase();
  const f = await fixture();
  cleanup.push(f.close);
  const config = { ...f.config, DATABASE_URL: "postgres://fixture" };
  const options = { skipBrowser: true, prUrl: PR_URL, previewUrl: f.baseUrl };
  const current = await doctor(config, options);
  expect(
    current.checks.find((check) => check.name === "postgresql")
  ).toMatchObject({
    status: "passed",
    message: `PostgreSQL connection, schema version ${SCHEMA_VERSION} and job-table read verified`,
  });
  await q.pool.query("DELETE FROM qa_schema WHERE version=$1", [
    SCHEMA_VERSION,
  ]);
  const outdated = await doctor(config, options);
  expect(
    outdated.checks.find((check) => check.name === "postgresql")
  ).toMatchObject({
    status: "failed",
    message: expect.stringContaining(`supported version ${SCHEMA_VERSION}`),
  });
}, 30_000);

it("invalidates an already published result when cancellation wins the atomic completion", async () => {
  const q = await sqlDatabase();
  const f = await fixture();
  cleanup.push(f.close);
  const job = await q.enqueue(
    "fixture/app",
    1,
    SHA,
    "admin",
    { prUrl: PR_URL },
    "cancel-after-publication"
  );
  await q.claim("worker");
  const result: RunResult = {
    id: job.id,
    prUrl: PR_URL,
    sha: SHA,
    startedAt: "now",
    outcome: "passed",
    scenarios: [],
    publication: { commentUrl: PR_URL, status: "success" },
  };
  await q.cancel(job.id, "admin");
  await completeRun(q, job.id, "worker", result, f.config);
  expect(await q.get(job.id)).toMatchObject({
    status: "cancelled",
    outcome: "blocked",
  });
  expect(result.outcome).toBe("blocked");
  expect(f.outgoing.find((item) => item.payload.state)?.payload.state).toBe(
    "error"
  );
  expect(
    f.outgoing.find((item) => item.path.endsWith("/comments"))?.payload.body
  ).toContain("BLOCKED");
  expect(
    JSON.parse(await readFile(join(f.dataDir, job.id, "result.json"), "utf8"))
      .outcome
  ).toBe("blocked");
}, 30_000);

it("creates the first local admin once, authenticates without SSO, revokes sessions and preserves jobs across migration", async () => {
  const q = await sqlDatabase();
  const f = await fixture();
  cleanup.push(f.close);
  const existing = await q.enqueue(
    "fixture/app",
    1,
    SHA,
    "admin",
    { prUrl: PR_URL },
    "pre-local-auth"
  );
  const auth = new LocalAuth(q.pool);
  const ticket = await auth.issueSetupTicket();
  const localUsersFile = join(f.dataDir, "legacy-users.json");
  const viewerToken = "legacy-viewer-token-2026-123456789";
  await writeFile(
    localUsersFile,
    JSON.stringify([
      {
        id: "legacy-viewer",
        role: "viewer",
        repos: ["fixture/app"],
        tokenSha256: createHash("sha256").update(viewerToken).digest("hex"),
      },
    ])
  );
  const config = {
    ...f.config,
    QA_USERS_FILE: localUsersFile,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const server = await startProductionServer(config);
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const submit = (path: string, input: unknown) =>
    fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify(input),
    });
  expect(await (await fetch(`${url}/auth/status`)).json()).toEqual({
    initialized: false,
  });
  const credentials = {
    username: "qa-admin",
    password: "test-password-very-long-2026",
  };
  expect(
    (await submit("/auth/setup", { ...credentials, setupCode: "f".repeat(64) }))
      .status
  ).toBe(400);
  const setup = await submit("/auth/setup", {
    ...credentials,
    setupCode: ticket,
  });
  expect(setup.status).toBe(200);
  expect(await setup.json()).toMatchObject({
    username: "qa-admin",
    role: "admin",
    repos: ["fixture/app"],
  });
  const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  expect(cookie).toMatch(/^qa_local_session=/);
  expect(setup.headers.get("set-cookie")).toContain("HttpOnly");
  expect(
    (await fetch(`${url}/me`, { headers: { Cookie: cookie } })).status
  ).toBe(200);
  expect(await (await fetch(`${url}/auth/status`)).json()).toEqual({
    initialized: true,
  });
  const mixed = await fetch(`${url}/me`, {
    headers: { Cookie: cookie, Authorization: `Bearer ${viewerToken}` },
  });
  expect(await mixed.json()).toMatchObject({
    id: "legacy-viewer",
    role: "viewer",
  });
  expect(
    (
      await fetch(`${url}/me`, {
        headers: { Cookie: cookie, Authorization: "Bearer invalid-token" },
      })
    ).status
  ).toBe(401);

  await expect(auth.issueSetupTicket()).rejects.toThrow("existe déjà");
  expect(
    (await submit("/auth/setup", { ...credentials, setupCode: ticket })).status
  ).toBe(400);
  expect(
    (
      await submit("/auth/login", {
        ...credentials,
        password: "incorrect-password-2026",
      })
    ).status
  ).toBe(401);
  expect(
    (
      await submit("/auth/login", {
        username: "unknown-account",
        password: credentials.password,
      })
    ).status
  ).toBe(401);
  const crossSite = await fetch(`${url}/auth/login`, {
    method: "POST",
    headers: { Origin: "https://attacker.invalid" },
    body: JSON.stringify(credentials),
  });
  expect(crossSite.status).toBe(403);
  const login = await submit("/auth/login", {
    ...credentials,
    username: "QA-ADMIN",
  });
  expect(login.status).toBe(200);
  const loginCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (
      await fetch(`${url}/session`, {
        method: "DELETE",
        headers: { Cookie: loginCookie, Origin: url },
      })
    ).status
  ).toBe(200);
  expect(
    (await fetch(`${url}/me`, { headers: { Cookie: loginCookie } })).status
  ).toBe(401);
  const user = await auth.login(credentials);
  expect(user).toBeDefined();
  await auth.resetPassword(credentials.username, "replacement-password-2026");
  expect(
    (await fetch(`${url}/me`, { headers: { Cookie: cookie } })).status
  ).toBe(401);
  await expect(auth.session(user!)).rejects.toThrow("incorrect");
  expect((await submit("/auth/login", credentials)).status).toBe(401);
  expect(
    (
      await submit("/auth/login", {
        ...credentials,
        password: "replacement-password-2026",
      })
    ).status
  ).toBe(200);
  const stored = await q.pool.query("SELECT password_hash FROM qa_local_users");
  expect(stored.rows[0].password_hash).toMatch(/^scrypt-v1:/);
  expect(stored.rows[0].password_hash).not.toContain(
    "replacement-password-2026"
  );
  expect(await q.get(existing.id)).toBeDefined();
  await q.migrate();
  expect(await auth.status()).toEqual({ initialized: true });
  const changedRepos = ["fixture/new-project"];
  const newestLogin = await auth.login({
    username: credentials.username,
    password: "replacement-password-2026",
  });
  const newestToken = await auth.session(newestLogin!);
  const updatedPrincipal = await auth.principal(
    {
      headers: { cookie: `qa_local_session=${newestToken}` },
    } as import("node:http").IncomingMessage,
    changedRepos
  );
  expect(updatedPrincipal?.repos).toEqual(changedRepos);
  const newTicket = await q.pool.query(
    "SELECT token_hash FROM qa_setup_ticket"
  );
  expect(newTicket.rows).toEqual([]);
}, 30_000);

it("expires setup links and shares local login rate limits in SQL", async () => {
  const q = await sqlDatabase();
  const auth = new LocalAuth(q.pool);
  const code = await auth.issueSetupTicket();
  await q.pool.query(
    "UPDATE qa_setup_ticket SET expires_at=now()-interval '1 second'"
  );
  await expect(
    auth.setup(
      { username: "qa-admin", password: "test-password-2026", setupCode: code },
      ["fixture/app"]
    )
  ).rejects.toThrow("expiré");
  const user = await auth.setup(
    {
      username: "qa-admin",
      password: "test-password-2026",
      setupCode: await auth.issueSetupTicket(),
    },
    ["fixture/app"]
  );
  const token = await auth.session(user);
  await q.pool.query(
    "UPDATE qa_local_sessions SET expires_at=now()-interval '1 second'"
  );
  expect(
    await auth.principal(
      {
        headers: { cookie: `qa_local_session=${token}` },
      } as import("node:http").IncomingMessage,
      ["fixture/app"]
    )
  ).toBeUndefined();
  await q.pool.query(
    "INSERT INTO qa_auth_attempts(key,count,expires_at) VALUES('global-login',120,now()+interval '1 minute')"
  );
  await q.pool.query(
    "INSERT INTO qa_auth_attempts(key,count,expires_at) SELECT 'expired-'||n,1,now()-interval '1 minute' FROM generate_series(1,300) n"
  );
  await expect(
    auth.login({ username: "qa-admin", password: "test-password-2026" })
  ).rejects.toMatchObject({ code: "AUTH_RATE_LIMIT" });
  expect(
    (
      await q.pool.query(
        "SELECT count(*)::int AS count FROM qa_auth_attempts WHERE expires_at<now()"
      )
    ).rows[0].count
  ).toBeLessThanOrEqual(50);
  expect(
    (
      await q.pool.query(
        "SELECT key FROM qa_auth_attempts WHERE expires_at>now()"
      )
    ).rows
  ).toEqual([{ key: "global-login" }]);
}, 30_000);

it("connects a GitHub App through admin-only manifest callbacks, encrypts credentials, selects repositories and reloads them", async () => {
  const q = await sqlDatabase();
  const f = await githubSetupFixture();
  cleanup.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const setup = new GitHubSetup(q.pool, config);
  const accounts = new LocalAuth(q.pool);
  const localUser = await accounts.setup(
    {
      username: "github-admin",
      password: "github-admin-password-2026",
      setupCode: await accounts.issueSetupTicket(),
    },
    []
  );
  const token = await accounts.session(localUser);
  const cookie = `qa_local_session=${token}`;
  const server = await startProductionServer(config);
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, method = "GET", value?: unknown) =>
    fetch(`${url}${path}`, {
      method,
      redirect: "manual",
      headers: {
        Cookie: cookie,
        Origin: url,
        "Content-Type": "application/json",
      },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
  expect((await fetch(`${url}/github/app`)).status).toBe(401);
  expect((await call("/github/app")).status).toBe(200);
  const manifestResponse = await call("/github/app/manifest", "POST", {
    name: "Canary team QA",
  });
  const registration = (await manifestResponse.json()) as Awaited<
    ReturnType<GitHubSetup["manifest"]>
  >;
  expect(registration.action).toMatch(
    /^https:\/\/github.com\/settings\/apps\/new/
  );
  expect(registration.manifest.default_permissions).toEqual(
    REQUIRED_PERMISSIONS
  );
  expect(registration.manifest.hook_attributes.url).toBe(
    "https://qa.example.test/github/webhook"
  );
  const state = new URL(registration.action).searchParams.get("state")!;
  expect(
    (
      await call(
        `/github/app/callback?state=${"a".repeat(64)}&code=fixture-manifest-code`
      )
    ).status
  ).toBe(400);
  expect(f.state.conversionCount).toBe(0);
  const callback = `/github/app/callback?state=${state}&code=fixture-manifest-code`;
  expect((await call(callback)).status).toBe(303);
  expect((await call(callback)).status).toBe(400);
  expect(f.state.conversionCount).toBe(1);
  const saved = (await q.pool.query("SELECT credentials FROM qa_github_app"))
    .rows[0].credentials;
  expect(saved).not.toContain(f.pem);
  expect(saved).not.toContain(f.secret);
  const safeStatus = await (await call("/github/app")).text();
  expect(safeStatus).not.toContain(f.secret);
  expect(safeStatus).not.toContain("PRIVATE KEY");
  const install = (await (
    await call("/github/app/install", "POST", {})
  ).json()) as { url: string };
  const installState = new URL(install.url).searchParams.get("state")!;
  expect(
    (
      await call(
        `/github/app/installed?installation_id=999999&state=${installState}`
      )
    ).status
  ).toBe(303);
  expect((await setup.status()).repositories[0]?.installation_id).toBe("42001");
  expect((await setup.effective()).allowedRepos).toEqual([]);
  expect(
    (
      await call("/github/app/repositories", "PUT", {
        repositories: ["other/not-installed"],
      })
    ).status
  ).toBe(400);
  expect(
    (
      await call("/github/app/repositories", "PUT", {
        repositories: ["fixture/app"],
      })
    ).status
  ).toBe(200);
  expect(await (await call("/me")).json()).toMatchObject({
    role: "admin",
    repos: ["fixture/app"],
  });
  const reloaded = new GitHubSetup(q.pool, config);
  const effective = await reloaded.effective();
  expect(effective.GITHUB_TOKEN).toBe("");
  expect((await new GitHub(effective).pr(PR_URL)).data.head.sha).toBe(SHA);
  expect(
    f.requests.find((r) => r.path === "/repos/fixture/app/pulls/1")?.auth
  ).toBe("Bearer fixture-installation-token-42001");
  const payload = JSON.stringify({
    action: "synchronize",
    installation: { id: 42_001 },
    repository: { full_name: "fixture/app" },
    pull_request: {
      number: 1,
      html_url: PR_URL,
      head: { sha: SHA },
      draft: false,
    },
  });
  const webhook = await fetch(`${url}/github/webhook`, {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "app-connected-webhook",
      "x-hub-signature-256": `sha256=${createHmac("sha256", f.secret).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  expect(webhook.status).toBe(202);
  await expect(
    new GitHubSetup(q.pool, {
      ...config,
      QA_API_TOKEN: "a-different-secret-2026-123456789",
    }).effective()
  ).rejects.toMatchObject({ code: "GITHUB_CREDENTIALS_UNREADABLE" });
  f.state.removed = true;
  await setup.refresh();
  expect((await reloaded.effective()).allowedRepos).toEqual([]);
  expect(await (await call("/me")).json()).toMatchObject({ repos: [] });
  await expect(
    new GitHub(await reloaded.effective()).pr(PR_URL)
  ).rejects.toThrow("GITHUB_ALLOWED_REPOS");
  await q.migrate();
  expect((await setup.status()).app?.id).toBe("95001");
}, 30_000);

it("rejects expired or cross-user GitHub states, non-admin changes and missing installation permissions", async () => {
  const q = await sqlDatabase();
  const f = await githubSetupFixture();
  cleanup.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const setup = new GitHubSetup(q.pool, config);
  const registration = await setup.manifest("alice", {
    name: "Canary Org",
    organization: "fixture-org",
  });
  expect(registration.action).toContain(
    "/organizations/fixture-org/settings/apps/new"
  );
  const state = new URL(registration.action).searchParams.get("state")!;
  await expect(
    setup.convert("bob", state, "fixture-manifest-code")
  ).rejects.toMatchObject({ code: "GITHUB_STATE_INVALID" });
  await q.pool.query(
    "UPDATE qa_github_state SET expires_at=now()-interval '1 second'"
  );
  await expect(
    setup.convert("alice", state, "fixture-manifest-code")
  ).rejects.toMatchObject({ code: "GITHUB_STATE_INVALID" });
  await setup.convert(
    "alice",
    await setup.state("alice", "manifest"),
    "fixture-manifest-code"
  );
  f.state.permissions.checks = "read";
  await expect(setup.refresh()).rejects.toMatchObject({
    code: "GITHUB_PERMISSIONS",
  });
  expect((await setup.status()).repositories).toEqual([]);
  const usersFile = join(f.dataDir, "viewer.json");
  const viewerToken = "github-setup-viewer-token-2026";
  await writeFile(
    usersFile,
    JSON.stringify([
      {
        id: "viewer",
        role: "viewer",
        repos: [],
        tokenSha256: createHash("sha256").update(viewerToken).digest("hex"),
      },
    ])
  );
  const server = await startProductionServer({
    ...config,
    QA_USERS_FILE: usersFile,
  });
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  expect(
    (
      await fetch(`${url}/github/app/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${viewerToken}`, Origin: url },
      })
    ).status
  ).toBe(403);
  expect(
    (
      await fetch(`${url}/github/app/manifest`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.QA_API_TOKEN}`,
          Origin: "https://evil.test",
        },
        body: JSON.stringify({ name: "evil" }),
      })
    ).status
  ).toBe(403);
}, 30_000);

it("retains dashboard App credentials through worker completion when cancellation invalidates a published result", async () => {
  const q = await sqlDatabase();
  const f = await githubSetupFixture();
  cleanup.push(f.close);
  const config = { ...f.config, DATABASE_URL: "postgres://fixture" };
  const setup = new GitHubSetup(q.pool, config);
  await setup.convert(
    "admin",
    await setup.state("admin", "manifest"),
    "fixture-manifest-code"
  );
  await setup.select(["fixture/app"]);
  const job = await q.enqueue(
    "fixture/app",
    1,
    SHA,
    "admin",
    { prUrl: PR_URL },
    "app-cancel-after-publish"
  );
  const stop = new AbortController();
  const runner = await import("../src/runner.js");
  vi.spyOn(runner, "runQa").mockImplementation(async (_input, effective) => {
    const github = new GitHub(effective);
    const context = await github.context(PR_URL);
    await github.status(
      context,
      "success",
      "Fixture published before cancellation"
    );
    const commentUrl = await github.comment(
      context,
      "Fixture published success"
    );
    await q.cancel(job.id, "admin");
    stop.abort();
    return {
      id: job.id,
      prUrl: PR_URL,
      sha: SHA,
      startedAt: "now",
      outcome: "passed",
      scenarios: [],
      publication: { commentUrl, status: "success" },
    };
  });
  await startWorker(config, stop);
  expect(await q.get(job.id)).toMatchObject({
    status: "cancelled",
    outcome: "blocked",
  });
  expect(f.outgoing.map((item) => item.payload.state).filter(Boolean)).toEqual([
    "success",
    "error",
  ]);
  expect(
    f.outgoing.find((item) => item.path.includes("/issues/comments/"))?.payload
      .body
  ).toContain("BLOCKED");
  const repaired = JSON.parse(
    await readFile(join(f.dataDir, job.id, "result.json"), "utf8")
  );
  expect(repaired.publication.status).toBe("error");
  expect(repaired.error).not.toContain("repair failed");
  const invalidations = f.requests.filter(
    (item) => item.path === `/repos/fixture/app/statuses/${SHA}`
  );
  expect(invalidations).toHaveLength(2);
  expect(
    invalidations.every(
      (item) => item.auth === "Bearer fixture-installation-token-42001"
    )
  ).toBe(true);
}, 30_000);

it("reads an uninstalled public fork anonymously while keeping base writes installation-scoped and private forks unavailable", async () => {
  const q = await sqlDatabase();
  const f = await githubSetupFixture();
  cleanup.push(f.close);
  const setup = new GitHubSetup(q.pool, f.config);
  await setup.convert(
    "admin",
    await setup.state("admin", "manifest"),
    "fixture-manifest-code"
  );
  await setup.select(["fixture/app"]);
  f.state.forkHead = true;
  const github = new GitHub(await setup.effective());
  const context = await github.context(PR_URL);
  expect(context.headRepo).toBe("external/head");
  expect(
    context.context.some(
      (file) => file.ref === SHA && file.content.includes("Public fork content")
    )
  ).toBe(true);
  const forkReads = f.requests.filter((item) =>
    item.path.startsWith("/repos/external/head/contents/")
  );
  expect(forkReads.length).toBeGreaterThan(0);
  expect(forkReads.every((item) => !item.auth)).toBe(true);
  const before = f.requests.length;
  await expect(
    github.request(`/repos/external/head/statuses/${SHA}`, "POST", {
      state: "error",
    })
  ).rejects.toThrow("not connected");
  expect(f.requests).toHaveLength(before);
  await github.status(context, "pending", "Fixture base write");
  expect(
    f.requests.find(
      (item) => item.path === `/repos/fixture/app/statuses/${SHA}`
    )?.auth
  ).toBe("Bearer fixture-installation-token-42001");
  f.state.privateFork = true;
  const privateContext = await github.context(PR_URL);
  expect(privateContext.context.some((file) => file.ref === SHA)).toBe(false);
  expect(
    privateContext.contextWarnings.some((warning) =>
      warning.includes("Unavailable context")
    )
  ).toBe(true);
}, 30_000);

it("checks PR, model and exact preview version without enqueueing, generating AI content or publishing", async () => {
  const q = await sqlDatabase();
  const f = await fixture();
  cleanup.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const server = await startProductionServer(config);
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    Authorization: `Bearer ${config.QA_API_TOKEN}`,
    "Content-Type": "application/json",
    Origin: url,
  };
  const shell = await fetch(url);
  const csp = shell.headers.get("Content-Security-Policy") || "";
  expect(csp).toContain("script-src 'self'; style-src 'self'");
  expect(csp).not.toContain("unsafe-inline");
  const html = await shell.text();
  expect(html).toContain("/dashboard/assets/client.js");
  const script = await fetch(`${url}/dashboard/assets/client.js`);
  expect(script.status).toBe(200);
  expect(script.headers.get("Content-Type")).toContain("text/javascript");
  expect(script.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await script.text()).toContain("sourceMappingURL=");
  const map = await fetch(`${url}/dashboard/assets/client.js.map`);
  expect(map.status).toBe(200);
  expect(map.headers.get("Content-Type")).toContain("application/json");
  const css = await fetch(`${url}/dashboard/assets/client.css`);
  expect(css.status).toBe(200);
  expect(css.headers.get("Content-Type")).toContain("text/css");
  const status = await fetch(`${url}/dashboard/status`, { headers });
  const statusBody = await status.text();
  expect(statusBody).not.toContain(config.QA_API_TOKEN);
  expect(statusBody).not.toContain(config.GITHUB_TOKEN);
  expect(JSON.parse(statusBody)).toMatchObject({
    github: { mode: "technical", repositories: ["fixture/app"] },
  });
  const response = await fetch(`${url}/runs/preflight`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prUrl: PR_URL,
      previewUrl: f.baseUrl,
      model: "fixture-scripted-model",
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ready: true,
    pr: { repo: "fixture/app", sha: SHA },
    preview: { sha: SHA },
    model: "fixture-scripted-model",
  });
  expect(await q.list(["fixture/app"])).toEqual([]);
  expect(f.modelRequests).toEqual([]);
  expect(f.outgoing).toEqual([]);
  const invalid = await fetch(`${url}/runs/preflight`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prUrl: PR_URL,
      previewUrl: f.baseUrl,
      model: "missing-model",
    }),
  });
  expect(invalid.status).toBe(400);
}, 30_000);

it("refuses a preflight with missing preview provenance and a read-only account", async () => {
  const q = await sqlDatabase();
  const f = await fixture({ noSha: true });
  cleanup.push(f.close);
  const usersFile = join(f.dataDir, "preflight-viewer.json");
  const token = "preflight-viewer-token-2026-abcdefgh";
  await writeFile(
    usersFile,
    JSON.stringify([
      {
        id: "viewer",
        role: "viewer",
        repos: ["fixture/app"],
        tokenSha256: createHash("sha256").update(token).digest("hex"),
      },
    ])
  );
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
    QA_USERS_FILE: usersFile,
  };
  const server = await startProductionServer(config);
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const input = JSON.stringify({
    prUrl: PR_URL,
    previewUrl: f.baseUrl,
    model: "fixture-scripted-model",
  });
  const call = (auth: string) =>
    fetch(`${url}/runs/preflight`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
        Origin: url,
      },
      body: input,
    });
  expect((await call(token)).status).toBe(403);
  const response = await call(config.QA_API_TOKEN);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "PREVIEW_SHA_MISMATCH" });
  expect(await q.list(["fixture/app"])).toEqual([]);
  expect(f.modelRequests).toEqual([]);
  expect(f.outgoing).toEqual([]);
}, 30_000);

it("intersects technical account repositories with the live managed App selection in dashboard readiness", async () => {
  const q = await sqlDatabase();
  const f = await githubSetupFixture();
  cleanup.push(f.close);
  const usersFile = join(f.dataDir, "readiness-users.json");
  const tokens = [
    "readiness-admin-token-2026-abcdefgh",
    "readiness-operator-token-2026-abcdefgh",
  ];
  await writeFile(
    usersFile,
    JSON.stringify(
      tokens.map((token, index) => ({
        id: `readiness-${index}`,
        role: index === 0 ? "admin" : "operator",
        repos:
          index === 0 ? ["unselected/app"] : ["unselected/app", "FiXtUrE/ApP"],
        tokenSha256: createHash("sha256").update(token).digest("hex"),
      }))
    )
  );
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
    QA_USERS_FILE: usersFile,
  };
  const setup = new GitHubSetup(new Queue(config.DATABASE_URL).pool, config);
  await setup.convert(
    "admin",
    await setup.state("admin", "manifest"),
    "fixture-manifest-code"
  );
  await setup.select(["fixture/app"]);
  // A newly selected repository is opted in for automatic runs by default.
  expect((await setup.status()).repositories).toMatchObject([
    { auto_run: true, enabled: true, full_name: "fixture/app" },
  ]);
  expect((await setup.effective()).allowedRepos).toEqual(["fixture/app"]);
  expect((await setup.effective()).automaticRepos).toEqual(["fixture/app"]);
  const server = await startProductionServer(config);
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [index, token] of tokens.entries()) {
    const response = await fetch(`${url}/dashboard/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      github: {
        autoRepos: index === 0 ? [] : ["FiXtUrE/ApP"],
        mode: "app",
        repositories: index === 0 ? [] : ["FiXtUrE/ApP"],
      },
    });
  }
  const admin = {
    Authorization: `Bearer ${tokens[0]}`,
    "Content-Type": "application/json",
    Origin: url,
  };
  // The route opts a selected repository out of automatic runs without unselecting it.
  const optedOut = await fetch(`${url}/github/app/repositories`, {
    method: "PUT",
    headers: admin,
    body: JSON.stringify({ autoRepos: [], repositories: ["fixture/app"] }),
  });
  expect(optedOut.status).toBe(200);
  expect(await optedOut.json()).toMatchObject({
    repositories: [
      { auto_run: false, enabled: true, full_name: "fixture/app" },
    ],
  });
  expect((await setup.effective()).allowedRepos).toEqual(["fixture/app"]);
  expect((await setup.effective()).automaticRepos).toEqual([]);
  expect(
    (
      await q.pool.query(
        "SELECT details FROM qa_audit WHERE action='github.repositories.selected' ORDER BY id DESC LIMIT 1"
      )
    ).rows[0].details
  ).toEqual({ autoRepos: [], repositories: ["fixture/app"] });
  const status = await fetch(`${url}/dashboard/status`, {
    headers: admin,
  });
  expect(await status.json()).toMatchObject({
    github: { autoRepos: [], repositories: [] },
  });
  // Omitting autoRepos preserves the per-repository choice of the previous selection.
  const preserved = await fetch(`${url}/github/app/repositories`, {
    method: "PUT",
    headers: admin,
    body: JSON.stringify({ repositories: ["fixture/app"] }),
  });
  expect(preserved.status).toBe(200);
  expect(await preserved.json()).toMatchObject({
    repositories: [
      { auto_run: false, enabled: true, full_name: "fixture/app" },
    ],
  });
  const restored = await fetch(`${url}/github/app/repositories`, {
    method: "PUT",
    headers: admin,
    body: JSON.stringify({
      autoRepos: ["fixture/app"],
      repositories: ["fixture/app"],
    }),
  });
  expect(restored.status).toBe(200);
  expect((await setup.effective()).automaticRepos).toEqual(["fixture/app"]);
  // A repository cannot run automatically while it stays unselected.
  const denied = await fetch(`${url}/github/app/repositories`, {
    method: "PUT",
    headers: admin,
    body: JSON.stringify({ autoRepos: ["fixture/app"], repositories: [] }),
  });
  expect(denied.status).toBe(400);
  expect((await setup.effective()).automaticRepos).toEqual(["fixture/app"]);
}, 30_000);
it("disconnects the connected GitHub App from the admin API, uninstalls it on GitHub and wipes the local connection", async () => {
  const q = await sqlDatabase();
  const f = await githubSetupFixture();
  cleanup.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const setup = new GitHubSetup(q.pool, config);
  const accounts = new LocalAuth(q.pool);
  const admin = await accounts.setup(
    {
      username: "github-remover",
      password: "github-remover-password-2026",
      setupCode: await accounts.issueSetupTicket(),
    },
    []
  );
  const session = await accounts.session(admin);
  const server = await startProductionServer(config);
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, method = "GET", value?: unknown) =>
    fetch(`${url}${path}`, {
      method,
      redirect: "manual",
      headers: {
        Cookie: `qa_local_session=${session}`,
        Origin: url,
        "Content-Type": "application/json",
      },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
  await setup.convert(
    admin.id,
    await setup.state(admin.id, "manifest"),
    "fixture-manifest-code"
  );
  await setup.select(["fixture/app"]);
  expect((await setup.status()).app?.id).toBe("95001");
  // The dashboard is a React single-page application: the removal controls are
  // rendered by the browser bundle, not present in the served HTML shell.
  const page = await (await call("/")).text();
  expect(page).toContain('id="root"');
  const bundle = await (await call("/dashboard/assets/client.js")).text();
  expect(bundle).toContain("githubUninstall");
  expect(bundle).toContain("githubDeleteApp");
  const response = await call("/github/app", "DELETE", {});
  expect(response.status).toBe(200);
  const body = (await response.json()) as Awaited<
    ReturnType<GitHubSetup["disconnect"]>
  >;
  expect(body.app).toBeNull();
  expect(body.repositories).toEqual([]);
  expect(body.disconnected).toMatchObject({
    appDeleted: false,
    deleteApp: false,
    uninstalled: ["fixture"],
    warnings: [],
  });
  expect(f.state.uninstalls).toBe(1);
  expect(f.state.appDeletions).toBe(0);
  expect(
    f.requests.find((item) => item.path === "/app/installations/42001")?.auth
  ).toMatch(/^Bearer /);
  expect(
    (await q.pool.query("SELECT count(*)::int AS count FROM qa_github_app"))
      .rows[0].count
  ).toBe(0);
  expect(
    (
      await q.pool.query(
        "SELECT count(*)::int AS count FROM qa_github_repositories"
      )
    ).rows[0].count
  ).toBe(0);
  expect(
    (
      await q.pool.query(
        "SELECT count(*)::int AS count FROM qa_audit WHERE action='github.app.disconnected'"
      )
    ).rows[0].count
  ).toBe(1);
  const effective = await new GitHubSetup(q.pool, config).effective();
  expect(effective.githubInstallations).toBeUndefined();
  expect(effective.allowedRepos).toEqual([]);
  expect(await (await call("/me")).json()).toMatchObject({ repos: [] });
  // The connection is gone: a second removal is a client error, not a no-op.
  expect((await call("/github/app", "DELETE")).status).toBe(400);
  const usersFile = join(f.dataDir, "remover-viewer.json");
  const viewerToken = "github-app-remover-viewer-2026";
  await writeFile(
    usersFile,
    JSON.stringify([
      {
        id: "viewer",
        role: "viewer",
        repos: [],
        tokenSha256: createHash("sha256").update(viewerToken).digest("hex"),
      },
    ])
  );
  const viewerServer = await startProductionServer({
    ...config,
    QA_USERS_FILE: usersFile,
  });
  cleanup.push(() => viewerServer.shutdown());
  const viewerUrl = `http://127.0.0.1:${(viewerServer.address() as { port: number }).port}`;
  expect(
    (
      await fetch(`${viewerUrl}/github/app`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${viewerToken}`, Origin: viewerUrl },
      })
    ).status
  ).toBe(403);
}, 30_000);

it("deletes the GitHub App itself on request and reports a refused remote deletion as a warning", async () => {
  const q = await sqlDatabase();
  const f = await githubSetupFixture();
  cleanup.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const setup = new GitHubSetup(q.pool, config);
  await setup.convert(
    "admin",
    await setup.state("admin", "manifest"),
    "fixture-manifest-code"
  );
  await setup.select(["fixture/app"]);
  const deleted = await setup.disconnect({ deleteApp: true });
  expect(deleted.disconnected).toMatchObject({
    appDeleted: true,
    deleteApp: true,
    uninstalled: [],
    warnings: [],
  });
  expect(f.state.appDeletions).toBe(1);
  // GitHub removes every installation with the App: no per-installation call.
  expect(f.state.uninstalls).toBe(0);
  expect((await setup.status()).app).toBeNull();
  await setup.convert(
    "admin",
    await setup.state("admin", "manifest"),
    "fixture-manifest-code"
  );
  // Reinstall the App on the fixture so the refused deletion has something to remove.
  f.state.installed = true;
  await setup.select(["fixture/app"]);
  f.state.deleteFails = true;
  const refused = await setup.disconnect({});
  expect(refused.app).toBeNull();
  expect(refused.repositories).toEqual([]);
  expect(refused.disconnected.uninstalled).toEqual([]);
  expect(refused.disconnected.warnings).toHaveLength(1);
  expect(refused.disconnected.warnings[0]).toMatch(/HTTP 403 from/);
  expect(f.state.uninstalls).toBe(0);
  expect(
    (await q.pool.query("SELECT count(*)::int AS count FROM qa_github_app"))
      .rows[0].count
  ).toBe(0);
  expect(
    (
      await q.pool.query(
        "SELECT count(*)::int AS count FROM qa_github_repositories"
      )
    ).rows[0].count
  ).toBe(0);
}, 30_000);

it("closes pending manifest and install callbacks when the App is disconnected", async () => {
  const q = await sqlDatabase();
  const f = await githubSetupFixture();
  cleanup.push(f.close);
  const setup = new GitHubSetup(q.pool, f.config);
  await setup.convert(
    "admin",
    await setup.state("admin", "manifest"),
    "fixture-manifest-code"
  );
  const installState = await setup.state("admin", "install");
  await setup.disconnect({});
  expect(
    (
      await q.pool.query(
        "SELECT count(*)::int AS count FROM qa_github_state WHERE actor='admin'"
      )
    ).rows[0].count
  ).toBe(0);
  await expect(
    setup.consumeState("admin", installState, "install")
  ).rejects.toMatchObject({ code: "GITHUB_STATE_INVALID" });
  expect(f.state.conversionCount).toBe(1);
}, 30_000);
