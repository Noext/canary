import { createHash, createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { startProductionServer } from "../src/production-server.js";
import { Queue } from "../src/queue.js";
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
