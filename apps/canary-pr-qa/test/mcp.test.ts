import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
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
    tools?: {
      inputSchema?: {
        properties?: Record<string, { format?: string }>;
        type?: string;
      };
      name: string;
    }[];
  };
}

/** A production server on the in-memory PostgreSQL, plus a key to read it. */
async function mcpServer(
  role: "operator" | "viewer" = "viewer",
  extra: Partial<Config> = {}
) {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  const server = await startProductionServer({
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
    ...extra,
  });
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const admin = { Authorization: `Bearer ${f.config.QA_API_TOKEN}` };
  const created = await fetch(`${url}/dashboard/api-keys`, {
    body: JSON.stringify({ name: "agent", role }),
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

/** Une session telle que `list_run_sessions` la publie. */
interface SessionRow {
  artifacts: { bytes: number; kind: string; path: string; url?: string }[];
  dir: string;
  id?: string;
  name?: string;
  outcome?: string;
}
function byArtifactKind(artifacts: SessionRow["artifacts"]) {
  return Object.fromEntries(
    artifacts.map((entry) => [entry.kind, entry])
  ) as Record<string, SessionRow["artifacts"][number] | undefined>;
}
/**
 * Les preuves qu'un scénario laisse sur disque, dans le layout que `canary end`
 * copie : index, rapport, dumps, trace, vidéo et capture. Le HAR dépasse la
 * taille rendue par le MCP pour exercer le lien signé.
 */
async function sessionOnDisk(dataDir: string, id: string) {
  const dir = join(dataDir, id, "welcome");
  await mkdir(join(dir, "video"), { recursive: true });
  await mkdir(join(dir, "screenshots"), { recursive: true });
  await writeFile(
    join(dataDir, id, "result.json"),
    JSON.stringify({
      id,
      outcome: "passed",
      scenarios: [
        {
          outcome: "passed",
          scenario: {
            id: "welcome",
            title: "Submitting the name saves a welcome message",
          },
          sessionId: "session-abc",
        },
      ],
      startedAt: "2026-03-12T09:00:00.000Z",
    })
  );
  await writeFile(
    join(dir, "results.json"),
    JSON.stringify({ id: "session-abc", kind: "canary-session-result" })
  );
  await writeFile(join(dir, "report.html"), "<!doctype html><h1>report</h1>");
  await writeFile(join(dir, "console.log"), "[info] ready\n[error] boom\n");
  await writeFile(join(dir, "network.har"), Buffer.alloc(300_000, 0x20));
  await writeFile(join(dir, "trace.zip"), Buffer.alloc(64));
  await writeFile(join(dir, "video", "page.webm"), Buffer.alloc(32));
  await writeFile(join(dir, "screenshots", "welcome.png"), Buffer.alloc(16));
}

it("answers the MCP handshake and publishes the read tools and the one action", async () => {
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
    "get_session_console",
    "get_session_har",
    "get_session_results",
    "launch_run",
    "list_automatic_attempts",
    "list_run_sessions",
    "list_runs",
  ]);
}, 30_000);

it("filters the attempt history by state and date in the database", async () => {
  const { key, q, url } = await mcpServer();
  const run = await completedRun(q);
  const attempt = (number: number) => ({
    number,
    prUrl: PR_URL,
    repo: "fixture/app",
    sha: SHA,
  });
  await q.acceptDelivery("a-waiting", "pull_request", attempt(1), 1800);
  await q.acceptDelivery("b-promoted", "pull_request", attempt(2), 1800);
  await q.acceptDelivery("c-discarded", "pull_request", attempt(3), 1800);
  await q.acceptDelivery("d-expired", "pull_request", attempt(4), 1800);
  await q.acceptDelivery("e-disabled", "pull_request", attempt(5), 1800);
  await q.pool.query(
    "UPDATE qa_deliveries SET status='processed',run_id=$1 WHERE id='b-promoted'",
    [run]
  );
  await q.pool.query(
    "UPDATE qa_deliveries SET status='processed' WHERE id='c-discarded'"
  );
  await q.pool.query(
    "UPDATE qa_deliveries SET status='expired' WHERE id='d-expired'"
  );
  await q.pool.query(
    "UPDATE qa_deliveries SET status='auto_disabled' WHERE id='e-disabled'"
  );
  const listed = await tool(url, key, "list_automatic_attempts");
  expect(listed.body).toMatchObject({ count: 5 });
  // Every state the tool advertises is reachable, and the filter runs before
  // the cap: five terminal rows would otherwise fill the page and hide the
  // older waiting one.
  for (const state of [
    "waiting",
    "promoted",
    "discarded",
    "expired",
    "disabled",
  ]) {
    const filtered = await tool(url, key, "list_automatic_attempts", {
      limit: 1,
      state,
    });
    expect(filtered.body).toMatchObject({
      attempts: [{ state }],
      count: 1,
    });
  }
  const dated = await tool(url, key, "list_automatic_attempts", {
    since: new Date(Date.now() + 86_400_000).toISOString(),
  });
  expect(dated.body).toMatchObject({ attempts: [], count: 0 });
}, 30_000);

it("separates a run that has not ended from evidence retention removed", async () => {
  const { dataDir, key, q, url } = await mcpServer();
  // Ended without a result file: the evidence is gone.
  const id = await completedRun(q);
  // Queued: the worker has not written a result yet, and retention never
  // touches an active run, so telling the agent the evidence was purged would
  // send it looking for data that is still to come.
  const queued = await q.enqueue(
    "fixture/app",
    9,
    SHA,
    "alice",
    { prUrl: PR_URL },
    "queued-run"
  );
  const running = await tool(url, key, "get_run", { id: queued.id });
  expect(running.isError).toBe(false);
  expect(running.body).toMatchObject({ resultAvailable: false });
  expect(String(running.body.note)).toContain("n'est pas terminé");
  const purged = await tool(url, key, "get_run", { id });
  expect(purged.body).toMatchObject({ resultAvailable: false });
  expect(String(purged.body.note)).toContain("rétention");
  // A result this server cannot read is its own fault, not a lost run: the
  // agent must not be told the evidence was purged.
  await mkdir(join(dataDir, id), { recursive: true });
  await writeFile(join(dataDir, id, "result.json"), "{ not json");
  const malformed = await call(url, key, "tools/call", {
    arguments: { id },
    name: "get_run",
  });
  expect(malformed.status).toBe(500);
  expect(((await malformed.json()) as McpAnswer).error?.code).toBe(-32_603);
}, 30_000);

it("caps a batched request and answers its calls one at a time", async () => {
  const { key, url } = await mcpServer();
  const batch = (count: number) =>
    JSON.stringify(
      Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        jsonrpc: "2.0",
        method: "tools/list",
      }))
    );
  const post = (body: string) =>
    fetch(`${url}/mcp`, {
      body,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
  const refused = await post(batch(9));
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as McpAnswer).error?.code).toBe(-32_600);
  const answered = await post(batch(2));
  expect(answered.status).toBe(200);
  const payload = (await answered.json()) as McpAnswer[];
  expect(payload.map((entry) => entry.result?.tools?.length)).toEqual([9, 9]);
  // A batch of notifications alone is accepted and answers nothing.
  const silent = await post(
    JSON.stringify([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled" },
    ])
  );
  expect(silent.status).toBe(202);
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
  // A timestamp the database would refuse is a bad argument, not a server
  // fault: the published schema carries the format the validator enforces.
  const badDate = (await (
    await call(url, key, "tools/call", {
      arguments: { since: "not-a-date" },
      name: "list_automatic_attempts",
    })
  ).json()) as McpAnswer;
  expect(badDate.error?.code).toBe(-32_602);
  expect(badDate.error?.message).toContain("since");
  const attemptTool = listed.result?.tools?.find(
    (entry) => entry.name === "list_automatic_attempts"
  );
  expect(attemptTool?.inputSchema?.properties?.since?.format).toBe("date-time");
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

it("opens on an API key only: no cookie, no session, no other credential", async () => {
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
  // Credentials that open the whole dashboard do not open the agent endpoint:
  // it exists for a key an administrator issued to an agent.
  for (const credential of [
    admin.Authorization.replace("Bearer ", ""),
    "not-a-key",
  ]) {
    expect((await call(url, credential, "tools/list")).status).toBe(401);
  }
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

it("refuses a launch to a read-only key and leaves the queue untouched", async () => {
  const { key, q, url } = await mcpServer();
  const refused = await tool(url, key, "launch_run", { prUrl: PR_URL });
  expect(refused.isError).toBe(true);
  expect(String(refused.body.message)).toContain("lecture seule");
  expect(await q.list(["fixture/app"])).toEqual([]);
}, 30_000);

it("queues a run for an operator key, through the gates the dashboard applies", async () => {
  const { key, q, url } = await mcpServer("operator");
  const launched = await tool(url, key, "launch_run", {
    model: "fixture-alternate-model",
    prUrl: PR_URL,
  });
  expect(launched.isError).toBe(false);
  expect(launched.body).toMatchObject({
    model: "fixture-alternate-model",
    pr: 1,
    repo: "fixture/app",
    sha: SHA,
    status: "queued",
  });
  expect(launched.body.statusUrl).toBe(`/runs/${String(launched.body.id)}`);
  // The run the action names is the run the read surface lists: the two tools
  // must not be able to disagree about what was created.
  const listed = await tool(url, key, "list_runs");
  expect(listed.body.runs).toMatchObject([
    {
      id: launched.body.id,
      model: "fixture-alternate-model",
      pr: 1,
      repo: "fixture/app",
      sha: SHA,
      status: "queued",
    },
  ]);
  expect(await q.list(["fixture/app"])).toHaveLength(1);
}, 30_000);

it("answers a refused launch with a diagnostic, not a server fault", async () => {
  const { key, url } = await mcpServer("operator");
  // A model outside the catalog, a URL that is not a pull request and a
  // repository the key does not cover are all caller faults: an agent must read
  // what to fix instead of a protocol error it cannot act on.
  const unknownModel = await tool(url, key, "launch_run", {
    model: "not-in-catalog",
    prUrl: PR_URL,
  });
  expect(unknownModel.isError).toBe(true);
  expect(String(unknownModel.body.message)).toContain(
    "absent from the current provider catalog"
  );
  const badUrl = await tool(url, key, "launch_run", {
    prUrl: "https://github.com/fixture/app",
  });
  expect(badUrl.isError).toBe(true);
  expect(String(badUrl.body.message)).toContain("owner/repo/pull");
  const outOfScope = await tool(url, key, "launch_run", {
    prUrl: "https://github.com/other/app/pull/2",
  });
  expect(outOfScope.isError).toBe(true);
  expect(String(outOfScope.body.message)).toContain("access denied");
}, 30_000);

it("lists a run's Canary sessions and keeps raw evidence behind the data policy", async () => {
  const { dataDir, key, q, url } = await mcpServer();
  const id = await completedRun(q);
  await sessionOnDisk(dataDir, id);
  const listed = await tool(url, key, "list_run_sessions", { runId: id });
  expect(listed.isError).toBe(false);
  expect(listed.body).toMatchObject({ count: 1, rawEvidence: false, run: id });
  expect(String(listed.body.note)).toContain("QA_RAW_EVIDENCE");
  const [session] = listed.body.sessions as SessionRow[];
  expect(session).toMatchObject({
    dir: "welcome",
    id: "session-abc",
    name: "Submitting the name saves a welcome message",
    outcome: "passed",
  });
  const byKind = byArtifactKind(session!.artifacts);
  expect(Object.keys(byKind).sort()).toEqual([
    "console",
    "har",
    "report",
    "results",
    "screenshot",
    "trace",
    "video",
  ]);
  // Le rapport, la vidéo et la capture sont la sortie du service, pas des
  // dumps : ils portent un lien signé même politique fermée.
  for (const kind of ["report", "video", "screenshot"] as const) {
    expect(byKind[kind]?.url).toContain(`/artifacts/${id}/welcome/`);
  }
  // La trace et les dumps restent hors de portée : ni lien (l'URL serait
  // refusée par la route HTTP), ni contenu.
  for (const kind of ["trace", "results", "console", "har"] as const) {
    expect(byKind[kind]?.url).toBeUndefined();
  }
  for (const name of [
    "get_session_results",
    "get_session_console",
    "get_session_har",
  ]) {
    const refused = await tool(url, key, name, {
      runId: id,
      session: "welcome",
    });
    expect(refused.isError).toBe(true);
    expect(String(refused.body.message)).toContain("QA_RAW_EVIDENCE");
  }
  // Le refus n'est pas un chemin détourné : rien n'a été audité en lecture.
  const audited = await q.pool.query(
    "SELECT count(*)::int AS count FROM qa_audit WHERE action='artifact.read'"
  );
  expect(audited.rows[0]).toMatchObject({ count: 0 });
  // Une session inconnue est une réponse lisible, pas un protocole en échec.
  const absent = await tool(url, key, "get_session_console", {
    runId: id,
    session: "nope",
  });
  expect(absent.isError).toBe(true);
  expect(String(absent.body.message)).toContain("welcome");
  const missing = await tool(url, key, "list_run_sessions", {
    runId: "87654321-1234-1234-1234-123456789012",
  });
  expect(missing.isError).toBe(true);
}, 30_000);

it("renders session evidence page by page once the data policy opens it", async () => {
  const { dataDir, key, q, url } = await mcpServer("viewer", {
    QA_RAW_EVIDENCE: "true",
  });
  const id = await completedRun(q);
  await sessionOnDisk(dataDir, id);
  const listed = await tool(url, key, "list_run_sessions", { runId: id });
  expect(listed.body).toMatchObject({ rawEvidence: true });
  const [session] = listed.body.sessions as SessionRow[];
  // Ouverte, la politique lie aussi la trace : aucun autre outil ne la rend.
  expect(byArtifactKind(session!.artifacts).trace?.url).toContain(
    `/artifacts/${id}/welcome/trace.zip`
  );
  const console_ = await tool(url, key, "get_session_console", {
    runId: id,
    session: "welcome",
  });
  expect(console_.isError).toBe(false);
  expect(console_.body).toMatchObject({
    artifact: { kind: "console", path: "welcome/console.log" },
    nextOffset: null,
    offset: 0,
    session: { dir: "welcome", id: "session-abc" },
    text: "[info] ready\n[error] boom\n",
    url: null,
  });
  // L'index et le HAR sont lisibles par le même chemin, et le HAR gros rend un
  // lien signé plutôt que plusieurs mégaoctets dans la réponse.
  const results = await tool(url, key, "get_session_results", {
    runId: id,
    session: "session-abc",
  });
  expect(JSON.parse(String(results.body.text))).toMatchObject({
    id: "session-abc",
  });
  const har = await tool(url, key, "get_session_har", {
    runId: id,
    session: "welcome",
  });
  expect(har.body).toMatchObject({ text: null });
  const harUrl = String(har.body.url);
  expect(harUrl).toContain(`/artifacts/${id}/welcome/network.har`);
  // Le contenu n'est pas passé par la réponse : rien n'a été lu, donc rien n'est
  // journalisé comme une lecture. Le lien sert le fichier, et cette lecture-là
  // est auditée sans clé, car ce qui compte est le fichier servi.
  const downloaded = await fetch(`${url}${harUrl}`);
  expect(downloaded.status).toBe(200);
  expect((await downloaded.arrayBuffer()).byteLength).toBe(300_000);
  // La pagination ne coupe pas un caractère : la suite recolle l'original.
  const head = await tool(url, key, "get_session_console", {
    limit: 8,
    runId: id,
    session: "welcome",
  });
  const tail = await tool(url, key, "get_session_console", {
    offset: head.body.nextOffset as number,
    runId: id,
    session: "welcome",
  });
  expect(head.body.nextOffset).toBe(8);
  expect(`${head.body.text}${tail.body.text}`).toBe(
    "[info] ready\n[error] boom\n"
  );
  expect(tail.body.nextOffset).toBeNull();
  const reads = await q.pool.query(
    "SELECT actor, details FROM qa_audit WHERE action='artifact.read' ORDER BY id"
  );
  expect(
    reads.rows.map((row) => (row as { details: { path: string } }).details.path)
  ).toEqual([
    "welcome/console.log",
    "welcome/results.json",
    "welcome/network.har",
    "welcome/console.log",
    "welcome/console.log",
  ]);
  // Les lectures rendues par le MCP portent leur mode de livraison ; celle du
  // lien signé nomme son porteur, qui n'a pas de compte.
  expect(
    reads.rows.map(
      (row) =>
        (row as { details: { delivery?: string } }).details.delivery ?? null
    )
  ).toEqual(["inline", "inline", null, "inline", "inline"]);
  expect((reads.rows[2] as { actor: string }).actor).toBe("artifact-signature");
}, 30_000);

it("renders a whole character when the page is shorter than it", async () => {
  const { dataDir, key, q, url } = await mcpServer("viewer", {
    QA_RAW_EVIDENCE: "true",
  });
  const id = await completedRun(q);
  await sessionOnDisk(dataDir, id);
  // Trois caractères de deux octets : une page d'un octet ne peut pas les
  // découper. Sans progression garantie, l'appelant qui suit `nextOffset`
  // relirait la même page vide à l'infini.
  await writeFile(join(dataDir, id, "welcome", "console.log"), "ééé");
  const first = await tool(url, key, "get_session_console", {
    limit: 1,
    runId: id,
    session: "welcome",
  });
  expect(first.body.text).toBe("é");
  expect(first.body.nextOffset).toBe(2);
  const rest = await tool(url, key, "get_session_console", {
    offset: 2,
    runId: id,
    session: "welcome",
  });
  expect(`${first.body.text}${rest.body.text}`).toBe("ééé");
  expect(rest.body.nextOffset).toBeNull();
}, 30_000);

it("reports an unreadable session layout as a fault, not as an empty run", async () => {
  const { dataDir, key, q, url } = await mcpServer();
  const id = await completedRun(q);
  await sessionOnDisk(dataDir, id);
  // Un fichier là où la copie des preuves attend un dossier : la panne doit
  // remonter, sinon `count: 0` ferait passer la perte d'accès pour un test sans
  // session et l'agent chercherait des preuves qui existent.
  await rm(join(dataDir, id, "welcome", "video"), { recursive: true });
  await writeFile(join(dataDir, id, "welcome", "video"), "not a directory");
  const broken = await call(url, key, "tools/call", {
    arguments: { runId: id },
    name: "list_run_sessions",
  });
  expect(broken.status).toBe(500);
  expect(((await broken.json()) as McpAnswer).error?.code).toBe(-32_603);
}, 30_000);

it("refuses a session of a run the key does not cover", async () => {
  const { dataDir, key, q, url } = await mcpServer("viewer", {
    QA_RAW_EVIDENCE: "true",
  });
  const secret = await completedRun(q, "other/secret");
  await sessionOnDisk(dataDir, secret);
  for (const name of ["list_run_sessions", "get_session_console"]) {
    const refused = await tool(url, key, name, {
      runId: secret,
      ...(name === "list_run_sessions" ? {} : { session: "welcome" }),
    });
    expect(refused.isError).toBe(true);
    expect(String(refused.body.message)).toContain("access denied");
  }
}, 30_000);

it("re-answers a retried launch instead of paying for a second run", async () => {
  const { key, q, url } = await mcpServer("operator");
  const args = { idempotencyKey: "retry-1", prUrl: PR_URL };
  const first = await tool(url, key, "launch_run", args);
  const retried = await tool(url, key, "launch_run", args);
  expect(retried.isError).toBe(false);
  expect(retried.body.id).toBe(first.body.id);
  expect(await q.list(["fixture/app"])).toHaveLength(1);
}, 30_000);
