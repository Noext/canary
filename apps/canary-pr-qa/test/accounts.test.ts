import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalAuth } from "../src/local-auth.js";
import { startProductionServer } from "../src/production-server.js";
import { fixture, pgliteQueue } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

interface Account {
  createdAt: string;
  id: string;
  repos: string[];
  role: string;
  username: string;
}

it("lets an administrator create, scope, rotate and delete human accounts while the API keeps its refusals", async () => {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  const viewerToken = "accounts-viewer-token-2026-abcdefgh";
  const usersFile = join(f.dataDir, "accounts-users.json");
  await writeFile(
    usersFile,
    JSON.stringify([
      {
        id: "viewer",
        role: "viewer",
        repos: ["fixture/app"],
        tokenSha256: createHash("sha256").update(viewerToken).digest("hex"),
      },
    ])
  );
  const accounts = new LocalAuth(q.pool);
  const first = await accounts.setup(
    {
      username: "qa-admin",
      password: "admin-password-2026",
      setupCode: await accounts.issueSetupTicket(),
    },
    f.config.allowedRepos
  );
  const adminId = first.id.replace(/^local:/, "");
  const cookie = `qa_local_session=${await accounts.session(first)}`;
  const server = await startProductionServer({
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
    QA_USERS_FILE: usersFile,
  });
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (
    path: string,
    method = "GET",
    value?: unknown
  ): Promise<Response> =>
    fetch(`${url}${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: url,
        "Content-Type": "application/json",
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  const login = (value: unknown) =>
    fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  const identity = async (session: string) => {
    const response = await fetch(`${url}/me`, {
      headers: { Cookie: session },
    });
    return { body: await response.json(), status: response.status };
  };
  const accountsOf = async () =>
    ((await (await call("/accounts")).json()) as { accounts: Account[] })
      .accounts;

  const listed = await call("/accounts");
  expect(listed.status).toBe(200);
  const only = (await listed.json()) as { accounts: Account[] };
  expect(only.accounts).toHaveLength(1);
  expect(only.accounts[0]).toMatchObject({
    id: adminId,
    username: "qa-admin",
    role: "admin",
    repos: ["fixture/app"],
  });
  expect(new Date(only.accounts[0]!.createdAt).toISOString()).toBe(
    only.accounts[0]!.createdAt
  );
  // Neither a technical viewer token nor a local operator manages accounts.
  expect(
    (
      await fetch(`${url}/accounts`, {
        headers: { Authorization: `Bearer ${viewerToken}` },
      })
    ).status
  ).toBe(403);
  expect(
    (
      await fetch(`${url}/accounts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${viewerToken}`,
          Origin: url,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: "intruder",
          password: "intruder-password-2026",
          role: "viewer",
          repos: ["fixture/app"],
        }),
      })
    ).status
  ).toBe(403);

  const created = await call("/accounts", "POST", {
    username: "Ops.Team",
    password: "operator-password-2026",
    role: "operator",
    repos: ["FiXtUrE/ApP"],
  });
  expect(created.status).toBe(201);
  const operator = ((await created.json()) as { account: Account }).account;
  expect(operator).toMatchObject({
    username: "ops.team",
    role: "operator",
    repos: ["fixture/app"],
  });
  const operatorLogin = await login({
    username: "ops.team",
    password: "operator-password-2026",
  });
  expect(operatorLogin.status).toBe(200);
  const operatorSession = operatorLogin.headers
    .get("set-cookie")!
    .split(";")[0]!;
  expect(await identity(operatorSession)).toMatchObject({
    body: {
      id: `local:${operator.id}`,
      role: "operator",
      repos: ["fixture/app"],
    },
    status: 200,
  });
  expect(
    (await fetch(`${url}/accounts`, { headers: { Cookie: operatorSession } }))
      .status
  ).toBe(403);

  // A repository outside the effective selection, a taken identifier and a
  // password below the shared minimum are refused with their own code.
  const outside = await call("/accounts", "POST", {
    username: "outsider",
    password: "outsider-password-2026",
    role: "viewer",
    repos: ["other/repo"],
  });
  expect(outside.status).toBe(400);
  expect(await outside.json()).toMatchObject({ code: "ACCOUNT_REPO_DENIED" });
  const taken = await call("/accounts", "POST", {
    username: "OPS.TEAM",
    password: "another-password-2026",
    role: "viewer",
    repos: [],
  });
  expect(taken.status).toBe(400);
  expect(await taken.json()).toMatchObject({ code: "ACCOUNT_EXISTS" });
  expect(
    (
      await call("/accounts", "POST", {
        username: "short-password",
        password: "short",
        role: "viewer",
        repos: [],
      })
    ).status
  ).toBe(400);

  const second = (
    (await (
      await call("/accounts", "POST", {
        username: "second-admin",
        password: "second-admin-password-2026",
        role: "admin",
        repos: [],
      })
    ).json()) as { account: Account }
  ).account;
  const outOfScope = await call(`/accounts/${second.id}`, "PATCH", {
    repos: ["other/repo"],
  });
  expect(outOfScope.status).toBe(400);
  expect(await outOfScope.json()).toMatchObject({
    code: "ACCOUNT_REPO_DENIED",
  });
  expect(
    (
      await login({
        username: "second-admin",
        password: "second-admin-password-2026",
      })
    ).status
  ).toBe(200);
  expect(
    (await accountsOf()).find((account) => account.id === second.id)
  ).toMatchObject({ repos: [], role: "admin" });
  const demotion = await call(`/accounts/${second.id}`, "PATCH", {
    role: "viewer",
  });
  expect(await demotion.json()).toMatchObject({ account: { role: "viewer" } });

  // A new password ends the sessions opened with the previous one.
  const rotated = await call(`/accounts/${operator.id}`, "PATCH", {
    repos: [],
    password: "rotated-password-2026",
  });
  expect(rotated.status).toBe(200);
  expect(await rotated.json()).toMatchObject({
    account: { repos: [], role: "operator" },
  });
  expect((await identity(operatorSession)).status).toBe(401);
  expect(
    (
      await login({
        username: "ops.team",
        password: "operator-password-2026",
      })
    ).status
  ).toBe(401);
  expect(
    (
      await login({
        username: "ops.team",
        password: "rotated-password-2026",
      })
    ).status
  ).toBe(200);

  // The last administrator keeps its role and its account: only another
  // administrator can remove the account it hands over.
  const demoted = await call(`/accounts/${adminId}`, "PATCH", {
    role: "operator",
  });
  expect(demoted.status).toBe(400);
  expect(await demoted.json()).toMatchObject({ code: "ACCOUNT_LAST_ADMIN" });
  expect(
    (
      await fetch(`${url}/accounts/${adminId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${f.config.QA_API_TOKEN}`,
          Origin: url,
        },
      })
    ).status
  ).toBe(400);
  const self = await call(`/accounts/${adminId}`, "DELETE");
  expect(self.status).toBe(400);
  expect(await self.json()).toMatchObject({ code: "ACCOUNT_SELF_DELETE" });
  const survivors = await accountsOf();
  expect(survivors.find((account) => account.id === adminId)?.role).toBe(
    "admin"
  );
  expect(JSON.stringify(survivors)).not.toContain("scrypt-v1:");
  // Who may reach the platform is audited like a policy change, and the trail
  // never carries a password or its hash.
  const trail = (
    await q.pool.query<{ action: string; actor: string; run_id: string }>(
      "SELECT action,actor,run_id FROM qa_audit WHERE action IN ('account.created','account.updated','account.deleted') ORDER BY id"
    )
  ).rows;
  expect(trail.map((entry) => entry.action).join(",")).toBe(
    "account.created,account.created,account.updated,account.updated"
  );
  expect(trail.every((entry) => entry.actor === `local:${adminId}`)).toBe(true);
  expect(trail.some((entry) => entry.run_id === second.id)).toBe(true);

  const removed = await call(`/accounts/${second.id}`, "DELETE");
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({ ok: true });
  expect(
    (
      await login({
        username: "second-admin",
        password: "second-admin-password-2026",
      })
    ).status
  ).toBe(401);
  expect((await call(`/accounts/${second.id}`, "DELETE")).status).toBe(400);
  const lastRemoval = await call(`/accounts/${operator.id}`, "DELETE");
  expect(lastRemoval.status).toBe(200);
  const deleted = (
    await q.pool.query<{ action: string; details: Record<string, unknown> }>(
      "SELECT action,details FROM qa_audit WHERE action='account.deleted' ORDER BY id"
    )
  ).rows;
  expect(deleted).toHaveLength(2);
  expect(deleted[0]!.details).toMatchObject({ username: "second-admin" });
  expect(deleted[1]!.details).toMatchObject({ username: "ops.team" });
  expect(JSON.stringify(deleted)).not.toContain("password");
  expect(
    (
      await login({
        username: "ops.team",
        password: "rotated-password-2026",
      })
    ).status
  ).toBe(401);
  expect((await accountsOf()).map((account) => account.id)).toEqual([adminId]);
}, 30_000);
