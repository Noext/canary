import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiKeyCreated } from "../src/dashboard/contracts.js";
import { startProductionServer } from "../src/production-server.js";
import { fixture, PR_URL, pgliteQueue, SHA } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

interface McpAnswer {
  error?: { code: number; message?: string };
  result?: {
    content?: { text: string }[];
    isError?: boolean;
    serverInfo?: { name: string; version: string };
    tools?: { inputSchema?: { type?: string }; name: string }[];
  };
}

/** A production server on the in-memory PostgreSQL, plus a key to read it. */
async function mcpServer() {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  const server = await startProductionServer({
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  });
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const admin = { Authorization: `Bearer ${f.config.QA_API_TOKEN}` };
  const created = await fetch(`${url}/dashboard/api-keys`, {
    body: JSON.stringify({ name: "agent" }),
    headers: admin,
    method: "POST",
  });
  expect(created.status).toBe(201);
  return {
    admin,
    dataDir: f.dataDir,
    key: ((await created.json()) as ApiKeyCreated).token,
    q,
    url,
  };
}

function call(
  url: string,
  token: string,
  method: string,
  params: unknown = {},
  id = 1
) {
  return fetch(`${url}/mcp`, {
    body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

/** The JSON body a tool answered with, which is what an agent reads. */
async function tool(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
) {
  const res = await call(url, token, "tools/call", { arguments: args, name });
  expect(res.status).toBe(200);
  const answer = (await res.json()) as McpAnswer;
  expect(answer.error).toBeUndefined();
  const isError = answer.result?.isError === true;
  const raw = answer.result?.content?.[0]?.text ?? "";
  const body = (
    isError ? { message: raw } : JSON.parse(raw || "null")
  ) as Record<string, unknown>;
  return { body, isError };
}

/** One completed run with a persisted result, the way the worker leaves it. */
async function completedRun(
  q: Awaited<ReturnType<typeof pgliteQueue>>,
  repo = "fixture/app"
) {
  const queued = await q.enqueue(
    repo,
    7,
    SHA,
    "alice",
    { prUrl: PR_URL },
    repo
  );
  const worker = "mcp-fixture";
  await q.claim(worker);
  await q.complete(queued.id, worker, "passed", undefined, {
    costUsd: 0.84,
    model: "fixture-model",
    tokens: 1200,
  });
  return queued.id;
}

it("answers the MCP handshake and publishes four read-only tools", async () => {
  const { url, key } = await mcpServer();
  const handshake = await call(url, key, "initialize", {
    capabilities: {},
    clientInfo: { name: "fixture-agent", version: "1" },
    protocolVersion: "2025-06-18",
  });
  expect(handshake.status).toBe(200);
  const answer = (await handshake.json()) as McpAnswer;
  expect(answer.result?.serverInfo).toMatchObject({ name: "canary-pr-qa" });
  const listed = (await (
    await call(url, key, "tools/list", {}, 2)
  ).json()) as McpAnswer;
  expect(listed.result?.tools?.map((entry) => entry.name).sort()).toEqual([
    "get_automatic_attempt",
    "get_run",
    "list_automatic_attempts",
    "list_runs",
  ]);
}, 30_000);

it("answers the protocol it serves: bad call, unknown method, notification", async () => {
  const { key, url } = await mcpServer();
  const listed = (await (
    await call(url, key, "tools/list")
  ).json()) as McpAnswer;
  for (const entry of listed.result?.tools ?? []) {
    expect(entry).toMatchObject({ inputSchema: { type: "object" } });
  }
  const unknownMethod = (await (
    await call(url, key, "resources/list")
  ).json()) as McpAnswer;
  expect(unknownMethod.error?.code).toBe(-32_601);
  const unknownTool = (await (
    await call(url, key, "tools/call", { arguments: {}, name: "nope" })
  ).json()) as McpAnswer;
  expect(unknownTool.error?.code).toBe(-32_602);
  // The published schema is the one the server enforces: a limit over the
  // maximum is a protocol error, not an empty answer an agent would read as
  // "there is nothing".
  const badArguments = (await (
    await call(url, key, "tools/call", {
      arguments: { limit: 5000 },
      name: "list_runs",
    })
  ).json()) as McpAnswer;
  expect(badArguments.error?.code).toBe(-32_602);
  expect(badArguments.error?.message).toContain("limit");
  const notification = await call(url, key, "notifications/initialized");
  expect(notification.status).toBe(202);
  expect(await notification.text()).toBe("");
  const malformed = await fetch(`${url}/mcp`, {
    body: "{",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  expect(malformed.status).toBe(400);
  expect(((await malformed.json()) as McpAnswer).error?.code).toBe(-32_700);
}, 30_000);

it("opens on a bearer key only: no cookie, no session, no other method", async () => {
  const { admin, key, url } = await mcpServer();
  const body = JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/list",
  });
  const anonymous = await fetch(`${url}/mcp`, { body, method: "POST" });
  expect(anonymous.status).toBe(401);
  // A method the stateless endpoint does not serve is refused once the caller
  // is identified: the route never opens a stream to a client.
  for (const method of ["GET", "DELETE"] as const) {
    expect(
      (
        await fetch(`${url}/mcp`, {
          headers: { authorization: `Bearer ${key}` },
          method,
        })
      ).status
    ).toBe(405);
  }
  const unknown = await call(url, `qa_live_${"A".repeat(32)}`, "tools/list");
  expect(unknown.status).toBe(401);
  // A dashboard session is ambient authority: it must not open the agent
  // endpoint, even when the caller also sends an unrelated bearer token.
  const login = await fetch(`${url}/session`, {
    headers: admin,
    method: "POST",
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const sessionOnly = await fetch(`${url}/mcp`, {
    body,
    headers: { cookie },
    method: "POST",
  });
  expect(sessionOnly.status).toBe(401);
  const withCookie = await fetch(`${url}/mcp`, {
    body,
    headers: { authorization: `Bearer qa_live_${"A".repeat(32)}`, cookie },
    method: "POST",
  });
  expect(withCookie.status).toBe(401);
  // Revoking the key closes the endpoint on the next request.
  const listed = await fetch(`${url}/dashboard/api-keys`, { headers: admin });
  const [row] = (await listed.json()) as { id: string }[];
  await fetch(`${url}/dashboard/api-keys/${row!.id}`, {
    headers: admin,
    method: "DELETE",
  });
  expect((await call(url, key, "tools/list")).status).toBe(401);
}, 30_000);

it("lists runs with status, outcome and cost, and returns one run's whole result", async () => {
  const { dataDir, key, q, url } = await mcpServer();
  const id = await completedRun(q);
  const before = await tool(url, key, "list_runs");
  expect(before.body.runs).toMatchObject([
    {
      costUsd: 0.84,
      model: "fixture-model",
      outcome: "passed",
      pr: 7,
      repo: "fixture/app",
      sha: SHA,
      status: "completed",
    },
  ]);
  expect(before.body).toMatchObject({ count: 1, limit: 50 });
  const missing = await tool(url, key, "get_run", { id });
  expect(missing.body).toMatchObject({ resultAvailable: false });
  await mkdir(join(dataDir, id), { recursive: true });
  await writeFile(
    join(dataDir, id, "result.json"),
    JSON.stringify({
      id,
      outcome: "passed",
      scenarios: [{ scenario: { id: "welcome" } }],
      startedAt: "2026-03-12T09:00:00.000Z",
    })
  );
  const found = await tool(url, key, "get_run", { id });
  expect(found.isError).toBe(false);
  expect(found.body).toMatchObject({
    result: { outcome: "passed", scenarios: [{ scenario: { id: "welcome" } }] },
    resultAvailable: true,
    run: { id, outcome: "passed", status: "completed" },
  });
  const absent = await tool(url, key, "get_run", {
    id: "87654321-1234-1234-1234-123456789012",
  });
  expect(absent.isError).toBe(true);
}, 30_000);

it("refuses a run of a repository the key does not cover", async () => {
  const { key, q, url } = await mcpServer();
  const secret = await completedRun(q, "other/secret");
  const listed = await tool(url, key, "list_runs");
  expect(listed.body.runs).toEqual([]);
  const refused = await tool(url, key, "get_run", { id: secret });
  expect(refused.isError).toBe(true);
  // The record exists, so the refusal is the key's scope, not a missing run.
  expect(await q.get(secret)).toMatchObject({ repo: "other/secret" });
}, 30_000);

it("gives the automatic attempts and the audit trail of one attempt", async () => {
  const { key, q, url } = await mcpServer();
  expect(
    await q.acceptDelivery(
      "delivery-1",
      "pull_request",
      {
        number: 12,
        prUrl: PR_URL,
        repo: "fixture/app",
        sha: SHA,
      },
      1800
    )
  ).toBe(true);
  await q.audit("webhook", "automatic.preview_wait", undefined, {
    backoffSeconds: 60,
    delivery: "delivery-1",
  });
  const listed = await tool(url, key, "list_automatic_attempts");
  expect(listed.body.attempts).toMatchObject([
    {
      id: "delivery-1",
      pr: 12,
      repo: "fixture/app",
      sha: SHA,
      state: "waiting",
    },
  ]);
  const filtered = await tool(url, key, "list_automatic_attempts", {
    state: "expired",
  });
  expect(filtered.body).toMatchObject({ count: 0 });
  const detail = await tool(url, key, "get_automatic_attempt", {
    id: "delivery-1",
  });
  expect(detail.body).toMatchObject({
    attempt: { id: "delivery-1", state: "waiting" },
    timeline: [{ action: "automatic.preview_wait", seconds: 60 }],
  });
  const absent = await tool(url, key, "get_automatic_attempt", {
    id: "delivery-absent",
  });
  expect(absent.isError).toBe(true);
}, 30_000);
