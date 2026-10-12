import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { completeRun } from "../src/completion.js";
import { doctor } from "../src/doctor.js";
import { startProductionServer } from "../src/production-server.js";
import { Queue, SCHEMA_VERSION } from "../src/queue.js";
import type { RunResult } from "../src/schema.js";
import { processDelivery } from "../src/webhook-inbox.js";
import { BASE_SHA, fixture, PR_URL, SHA } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});
async function sqlDatabase() {
  const db = await PGlite.create();
  cleanup.push(() => db.close());
  // Execute production SQL in PostgreSQL WASM. Multi-process row locking is separately tested on native PostgreSQL in CI.
  const query = async (text: string, values?: unknown[]) => {
    if (!values && text.includes("CREATE TABLE")) {
      await db.exec(text);
      return { rows: [], rowCount: 0 };
    }
    const result = await db.query(text, values);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
    end: async () => undefined,
    on: () => undefined,
  };
  vi.spyOn(pg, "Pool").mockImplementation(
    class {
      query = pool.query;
      connect = pool.connect;
      end = pool.end;
      on = pool.on;
    } as unknown as typeof pg.Pool
  );
  const queue = new Queue("postgres://fixture");
  await queue.migrate();
  return queue;
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
  expect(
    (
      await q.pool.query(
        "SELECT status FROM qa_deliveries WHERE id='delivery-42'"
      )
    ).rows[0].status
  ).toBe("pending");
  await q.pool.query(
    "UPDATE qa_deliveries SET retry_at=now()-interval '1 second'"
  );
  await processDelivery(q, { ...config, PREVIEW_URL_TEMPLATE: f.baseUrl });
  expect((await q.list(["fixture/app"])).length).toBe(1);
  expect(
    (
      await q.pool.query(
        "SELECT status FROM qa_deliveries WHERE id='delivery-42'"
      )
    ).rows[0].status
  ).toBe("processed");
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
        "SELECT status FROM qa_deliveries WHERE id='rate-limited'"
      )
    ).rows[0].status
  ).toBe("rate_limited");
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
    await q.acceptDelivery("reopened-same-sha", "pull_request", payload)
  ).toBe(false);
  await processDelivery(q, f.config);
  expect(await q.list(["fixture/app"])).toEqual([]);
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
