import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiKeyCreated, ApiKeyRow } from "../src/dashboard/contracts.js";
import { GitHubSetup } from "../src/github-setup.js";
import { LocalAuth } from "../src/local-auth.js";
import { startProductionServer } from "../src/production-server.js";
import { fixture, PR_URL, pgliteQueue, SHA } from "./fixture.js";
import { githubSetupFixture } from "./github-setup-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

/**
 * A production server on the in-memory PostgreSQL, the administrator token, and
 * a `users.json` viewer to prove the key routes stay administrator-only.
 */
async function apiKeysServer(options: { allowedRepos?: string[] } = {}) {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  const viewerToken = "viewer-token-0123456789-abcdef";
  // A `users.json` administrator limited to one project: it proves the scope a
  // new key inherits, which a local administrator (always instance-wide) cannot.
  const scopedAdminToken = "scoped-admin-token-0123456789";
  const usersFile = join(f.dataDir, "users.json");
  await writeFile(
    usersFile,
    JSON.stringify([
      {
        id: "viewer",
        role: "viewer",
        repos: ["fixture/app"],
        tokenSha256: createHash("sha256").update(viewerToken).digest("hex"),
      },
      {
        id: "scoped-admin",
        role: "admin",
        repos: ["fixture/app"],
        tokenSha256: createHash("sha256")
          .update(scopedAdminToken)
          .digest("hex"),
      },
    ])
  );
  const server = await startProductionServer({
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
    QA_USERS_FILE: usersFile,
    // `allowedRepos` is what the instance selection resolves to; the environment
    // string was already parsed when the fixture loaded its config.
    ...(options.allowedRepos ? { allowedRepos: options.allowedRepos } : {}),
  });
  cleanup.push(() => server.shutdown());
  return {
    q,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    admin: { Authorization: `Bearer ${f.config.QA_API_TOKEN}` },
    viewer: { Authorization: `Bearer ${viewerToken}` },
    scopedAdmin: { Authorization: `Bearer ${scopedAdminToken}` },
  };
}

async function createKey(
  url: string,
  admin: Record<string, string>,
  role: "operator" | "viewer" = "viewer"
) {
  const res = await fetch(`${url}/dashboard/api-keys`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ name: "agent", role }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ApiKeyCreated;
}

async function keyState(
  q: Awaited<ReturnType<typeof pgliteQueue>>,
  id: string
) {
  return (
    await q.pool.query<{ last_used_at: Date | null; revoked_at: Date | null }>(
      "SELECT last_used_at,revoked_at FROM qa_api_keys WHERE id=$1",
      [id]
    )
  ).rows[0];
}

it("issues a key once, keeps only a hash and an encrypted copy, and never shows the token again", async () => {
  const { q, url, admin } = await apiKeysServer();
  const created = await createKey(url, admin);
  expect(created.token).toMatch(/^qa_live_[\w-]{32}$/);
  expect(created.prefix).toBe(created.token.slice(0, 12));
  expect(created).toMatchObject({
    lastUsedAt: null,
    name: "agent",
    repos: ["fixture/app"],
    revokedAt: null,
    role: "viewer",
  });
  expect(created.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
  // The stored row holds the fingerprint and a ciphertext, never the token: the
  // encrypted copy is what lets an administrator hand the key over again.
  const row = (
    await q.pool.query<{
      created_by: string;
      repos: string[];
      role: string;
      secret_cipher: string;
      token_hash: string;
    }>(
      "SELECT created_by,repos,role,secret_cipher,token_hash FROM qa_api_keys WHERE id=$1",
      [created.id]
    )
  ).rows[0]!;
  expect(row.token_hash).toBe(
    createHash("sha256").update(created.token).digest("hex")
  );
  expect(row.created_by).toBe("bootstrap-admin");
  expect(row.role).toBe("viewer");
  expect(row.repos).toEqual(["fixture/app"]);
  expect(row.secret_cipher).toMatch(/^v1\./);
  expect(JSON.stringify(row)).not.toContain(created.token);
  const list = await fetch(`${url}/dashboard/api-keys`, { headers: admin });
  expect(list.status).toBe(200);
  const rows = (await list.json()) as ApiKeyRow[];
  expect(rows).toMatchObject([
    {
      createdAt: created.createdAt,
      id: created.id,
      lastUsedAt: null,
      name: "agent",
      prefix: created.prefix,
      repos: ["fixture/app"],
      revokedAt: null,
      role: "viewer",
    },
  ]);
  expect(JSON.stringify(rows)).not.toContain(created.token);
  // Copying returns the original token, which only a successful decryption of
  // that ciphertext can produce.
  const copied = await fetch(`${url}/dashboard/api-keys/${created.id}/secret`, {
    method: "POST",
    headers: admin,
  });
  expect(copied.status).toBe(200);
  expect(await copied.json()).toEqual({ token: created.token });
}, 30_000);

it("verifies a key as a read-only principal, refuses revoked or unknown tokens, and never falls back to the cookie", async () => {
  const { url, admin } = await apiKeysServer();
  const created = await createKey(url, admin);
  const key = { Authorization: `Bearer ${created.token}` };
  const me = await fetch(`${url}/me`, { headers: key });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({
    id: `key:${created.id}`,
    repos: ["fixture/app"],
    role: "viewer",
  });
  // A key reads; it never writes.
  expect(
    (
      await fetch(`${url}/runs`, {
        method: "POST",
        headers: key,
        body: JSON.stringify({ prUrl: PR_URL }),
      })
    ).status
  ).toBe(403);
  const unknown = {
    Authorization: `Bearer qa_live_${"A".repeat(32)}`,
  };
  expect((await fetch(`${url}/me`, { headers: unknown })).status).toBe(401);
  const login = await fetch(`${url}/session`, {
    method: "POST",
    headers: admin,
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (await fetch(`${url}/me`, { headers: { Cookie: cookie } })).status
  ).toBe(200);
  // A bearer token that matches nothing is never rescued by the session cookie:
  // an MCP client or an agent presents a key, not an ambient browser session.
  expect(
    (
      await fetch(`${url}/me`, {
        headers: { Cookie: cookie, ...unknown },
      })
    ).status
  ).toBe(401);
  const revoked = await fetch(`${url}/dashboard/api-keys/${created.id}`, {
    method: "DELETE",
    headers: admin,
  });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toMatchObject({ id: created.id });
  expect((await fetch(`${url}/me`, { headers: key })).status).toBe(401);
  expect((await fetch(`${url}/runs`, { headers: key })).status).toBe(401);
  const copy = await fetch(`${url}/dashboard/api-keys/${created.id}/secret`, {
    method: "POST",
    headers: admin,
  });
  expect(copy.status).toBe(409);
  expect(await copy.json()).toMatchObject({ code: "API_KEY_REVOKED" });
  expect(
    (
      await fetch(`${url}/dashboard/api-keys/${created.id}`, {
        method: "DELETE",
        headers: admin,
      })
    ).status
  ).toBe(409);
  const absent = await fetch(
    `${url}/dashboard/api-keys/87654321-1234-1234-1234-123456789012`,
    { method: "DELETE", headers: admin }
  );
  expect(absent.status).toBe(404);
  expect(await absent.json()).toMatchObject({ code: "API_KEY_UNKNOWN" });
  const list = await fetch(`${url}/dashboard/api-keys`, { headers: admin });
  expect(await list.json()).toMatchObject([
    { id: created.id, revokedAt: expect.any(String) },
  ]);
}, 30_000);

it("accepts a well-formed name, records a use at most once per window, and audits create, copy and revoke", async () => {
  const { q, url, admin } = await apiKeysServer();
  const invalid = await fetch(`${url}/dashboard/api-keys`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ name: "" }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ code: "API_KEY_NAME" });
  expect(
    (
      await fetch(`${url}/dashboard/api-keys`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ name: "x".repeat(61) }),
      })
    ).status
  ).toBe(400);
  const created = await createKey(url, admin);
  const key = { Authorization: `Bearer ${created.token}` };
  expect((await fetch(`${url}/me`, { headers: key })).status).toBe(200);
  const firstUse = (await keyState(q, created.id))!.last_used_at;
  expect(firstUse!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  // Inside the window the row is left alone, so a chatty agent cannot make the
  // key table hot; past it, the use is recorded again.
  await q.pool.query(
    "UPDATE qa_api_keys SET last_used_at=now()-interval '2 minutes' WHERE id=$1",
    [created.id]
  );
  const inside = (await keyState(q, created.id))!.last_used_at;
  expect((await fetch(`${url}/me`, { headers: key })).status).toBe(200);
  expect((await keyState(q, created.id))!.last_used_at?.toISOString()).toBe(
    inside!.toISOString()
  );
  await q.pool.query(
    "UPDATE qa_api_keys SET last_used_at=now()-interval '10 minutes' WHERE id=$1",
    [created.id]
  );
  const stale = (await keyState(q, created.id))!.last_used_at;
  expect((await fetch(`${url}/me`, { headers: key })).status).toBe(200);
  const refreshed = (await keyState(q, created.id))!.last_used_at;
  expect(refreshed!.getTime()).toBeGreaterThan(stale!.getTime());
  expect(refreshed!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  await fetch(`${url}/dashboard/api-keys/${created.id}/secret`, {
    method: "POST",
    headers: admin,
  });
  await fetch(`${url}/dashboard/api-keys/${created.id}`, {
    method: "DELETE",
    headers: admin,
  });
  const audit = (
    await q.pool.query<{ action: string; actor: string; details: unknown }>(
      "SELECT action,actor,details FROM qa_audit WHERE action LIKE 'api_key.%' ORDER BY id"
    )
  ).rows;
  expect(audit.map((entry) => entry.action)).toEqual([
    "api_key.created",
    "api_key.copied",
    "api_key.revoked",
  ]);
  expect(audit).toMatchObject(
    audit.map(() => ({
      actor: "bootstrap-admin",
      details: { id: created.id, name: "agent", prefix: created.prefix },
    }))
  );
  // The trail describes the key without publishing its token.
  expect(JSON.stringify(audit)).not.toContain(created.token);
}, 30_000);

it("gives a new key the repositories in force, not the startup restriction", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await githubSetupFixture();
  cleanup.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    GITHUB_ALLOWED_REPOS: "",
    QA_PORT: 0,
  };
  const server = await startProductionServer(config);
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const accounts = new LocalAuth(q.pool);
  const user = await accounts.setup(
    {
      password: "key-scope-2026-abcdef",
      setupCode: await accounts.issueSetupTicket(),
      username: "key-scope",
    },
    []
  );
  const cookie = `qa_local_session=${await accounts.session(user)}`;
  // An operator who picks repositories in the dashboard leaves
  // `GITHUB_ALLOWED_REPOS` empty: the environment variable is only a ceiling, so
  // a key must take the list in force instead of the startup one.
  const setup = new GitHubSetup(q.pool, config);
  await setup.convert(
    user.id,
    await setup.state(user.id, "manifest"),
    "fixture-manifest-code"
  );
  await setup.select(["fixture/app"]);
  const created = await fetch(`${url}/dashboard/api-keys`, {
    body: JSON.stringify({ name: "agent" }),
    headers: { Cookie: cookie },
    method: "POST",
  });
  expect(created.status).toBe(201);
  const key = (await created.json()) as ApiKeyCreated;
  expect(key.repos).toEqual(["fixture/app"]);
  // The key reads straight away: an empty scope would answer nothing at all.
  const me = await fetch(`${url}/me`, {
    headers: { Authorization: `Bearer ${key.token}` },
  });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({
    id: `key:${key.id}`,
    repos: ["fixture/app"],
    role: "viewer",
  });
}, 30_000);

it("refuses a non-administrator on every key route", async () => {
  const { url, admin, viewer } = await apiKeysServer();
  const created = await createKey(url, admin);
  const routes = [
    { headers: viewer, method: "GET", path: "/dashboard/api-keys" },
    { headers: viewer, method: "POST", path: "/dashboard/api-keys" },
    {
      headers: viewer,
      method: "DELETE",
      path: `/dashboard/api-keys/${created.id}`,
    },
    {
      headers: viewer,
      method: "POST",
      path: `/dashboard/api-keys/${created.id}/secret`,
    },
  ];
  for (const route of routes) {
    const res = await fetch(`${url}${route.path}`, {
      method: route.method,
      headers: route.headers,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "Administrator required" });
  }
  // A refused request changes nothing: the key is still live.
  expect(
    (
      await fetch(`${url}/me`, {
        headers: { Authorization: `Bearer ${created.token}` },
      })
    ).status
  ).toBe(200);
}, 30_000);

it("issues an operator key that starts a run, and keeps the read-only default", async () => {
  const { url, admin } = await apiKeysServer();
  const operator = await createKey(url, admin, "operator");
  expect(operator.role).toBe("operator");
  const launched = await fetch(`${url}/runs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${operator.token}` },
    body: JSON.stringify({ prUrl: PR_URL }),
  });
  expect(launched.status).toBe(202);
  const accepted = (await launched.json()) as { id: string };
  expect(accepted.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
  // The run is owned by the key that asked for it, so the audit trail names an
  // agent and not the administrator who issued the key.
  const listed = await fetch(`${url}/runs`, {
    headers: { Authorization: `Bearer ${operator.token}` },
  });
  expect(await listed.json()).toMatchObject([
    { id: accepted.id, owner: `key:${operator.id}`, repo: "fixture/app" },
  ]);
}, 30_000);

it("refuses an unknown key scope and defaults an omitted one to read-only", async () => {
  const { url, admin } = await apiKeysServer();
  const refused = await fetch(`${url}/dashboard/api-keys`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ name: "agent", role: "admin" }),
  });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ code: "API_KEY_NAME" });
  const omitted = await fetch(`${url}/dashboard/api-keys`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ name: "agent" }),
  });
  expect(omitted.status).toBe(201);
  expect((await omitted.json()) as ApiKeyCreated).toMatchObject({
    role: "viewer",
  });
  // A key never grants the dashboard's administrator role: an escalation would
  // let an agent manage keys, accounts and the preview policy.
  const rows = (await (
    await fetch(`${url}/dashboard/api-keys`, { headers: admin })
  ).json()) as ApiKeyRow[];
  expect(rows.map((row) => row.role)).toEqual(["viewer"]);
}, 30_000);

it("never lets a key outgrow the administrator who issued it", async () => {
  // The instance covers two repositories; the issuing `users.json` administrator
  // only covers one. The key must inherit the smaller scope, or a scoped
  // administrator could hand an agent a write capability on another project.
  const { q, scopedAdmin, url } = await apiKeysServer({
    allowedRepos: ["fixture/app", "fixture/other"],
  });
  const created = await createKey(url, scopedAdmin, "operator");
  expect(created.repos).toEqual(["fixture/app"]);
  const key = { Authorization: `Bearer ${created.token}` };
  const outOfScope = await fetch(`${url}/runs`, {
    method: "POST",
    headers: key,
    body: JSON.stringify({ prUrl: "https://github.com/fixture/other/pull/1" }),
  });
  expect(outOfScope.status).toBe(403);
  const launched = await fetch(`${url}/runs`, {
    method: "POST",
    headers: key,
    body: JSON.stringify({ prUrl: PR_URL }),
  });
  expect(launched.status).toBe(202);
  // The narrowing is not a silent edit: the audit says what the key received.
  const audit = (
    await q.pool.query<{ details: { repos?: string[]; role?: string } }>(
      "SELECT details FROM qa_audit WHERE action='api_key.created'"
    )
  ).rows;
  expect(audit.map((row) => [row.details.role, row.details.repos])).toEqual([
    ["operator", ["fixture/app"]],
  ]);
}, 30_000);

it("gives an operator key the launch and nothing else the dashboard writes", async () => {
  const { q, url, admin } = await apiKeysServer();
  const operator = await createKey(url, admin, "operator");
  const key = { Authorization: `Bearer ${operator.token}` };
  // The key is not a dashboard operator: `GET /me` reports it as a reader, and
  // every write route of the dashboard refuses it by role.
  expect(
    await (await fetch(`${url}/me`, { headers: key })).json()
  ).toMatchObject({ id: `key:${operator.id}`, role: "viewer" });
  const launched = await fetch(`${url}/runs`, {
    method: "POST",
    headers: key,
    body: JSON.stringify({ prUrl: PR_URL }),
  });
  expect(launched.status).toBe(202);
  const { id } = (await launched.json()) as { id: string };
  await q.acceptDelivery(
    "delivery-1",
    "pull_request",
    { number: 7, prUrl: PR_URL, repo: "fixture/app", sha: SHA },
    1800
  );
  const refused = [
    { method: "POST", path: `/runs/${id}/cancel` },
    { method: "POST", path: `/runs/${id}/links` },
    { method: "POST", path: "/dashboard/automatic/delivery-1/retry" },
  ];
  for (const route of refused) {
    const res = await fetch(`${url}${route.path}`, {
      method: route.method,
      headers: key,
    });
    expect([route.path, res.status]).toEqual([route.path, 403]);
  }
  // Read-only work stays open to it.
  expect((await fetch(`${url}/runs/${id}`, { headers: key })).status).toBe(200);
}, 30_000);

it("hides and refuses a key that reaches beyond the caller's scope", async () => {
  // The instance covers two repositories; the scoped administrator covers one.
  // A wider key belongs to a broader administrator, so copying its secret — and
  // with it a launch capability on the other project — must be out of reach.
  const { admin, scopedAdmin, url } = await apiKeysServer({
    allowedRepos: ["fixture/app", "fixture/other"],
  });
  const wider = await createKey(url, admin, "operator");
  expect(wider.repos).toEqual(["fixture/app", "fixture/other"]);
  const own = await createKey(url, scopedAdmin, "viewer");
  const listed = await (
    await fetch(`${url}/dashboard/api-keys`, { headers: scopedAdmin })
  ).json();
  expect((listed as ApiKeyRow[]).map((row) => row.id)).toEqual([own.id]);
  expect(
    (
      await fetch(`${url}/dashboard/api-keys/${wider.id}/secret`, {
        method: "POST",
        headers: scopedAdmin,
      })
    ).status
  ).toBe(403);
  expect(
    (
      await fetch(`${url}/dashboard/api-keys/${wider.id}`, {
        method: "DELETE",
        headers: scopedAdmin,
      })
    ).status
  ).toBe(403);
  // Its own key stays fully manageable, and the wider one is untouched.
  expect(
    (
      await fetch(`${url}/dashboard/api-keys/${own.id}/secret`, {
        method: "POST",
        headers: scopedAdmin,
      })
    ).status
  ).toBe(200);
  expect(
    (
      await (
        await fetch(`${url}/dashboard/api-keys`, { headers: admin })
      ).json()
    ).length
  ).toBe(2);
}, 30_000);
