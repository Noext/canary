import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Principal } from "./access.js";
import { AccountCreate, AccountUpdate, type LocalAuth } from "./local-auth.js";
import type { Queue } from "./queue.js";

const AccountId = z.string().uuid();

/**
 * Administrative CRUD over the human accounts of `qa_local_users`, mounted
 * behind the `LocalAuth` principal. Only an administrator manages accounts, and
 * its own repository scope is the effective selection a new account may use.
 */
export function accountRoutes(
  accounts: LocalAuth,
  queue: Queue,
  read: (req: IncomingMessage) => Promise<Buffer>,
  json: (res: ServerResponse, status: number, value: unknown) => void
) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal
  ) => {
    const prefix = "/accounts";
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      return false;
    }
    if (user.role !== "admin") {
      json(res, 403, { error: "Administrator required" });
      return true;
    }
    const body = async () => JSON.parse((await read(req)).toString());
    if (req.method === "GET" && url.pathname === prefix) {
      json(res, 200, { accounts: await accounts.listAccounts() });
      return true;
    }
    if (req.method === "POST" && url.pathname === prefix) {
      const account = await accounts.createAccount(
        AccountCreate.parse(await body()),
        user.repos
      );
      // Who may reach the platform is a security decision: it is audited like a
      // policy change. The password never enters the trail.
      await queue.audit(user.id, "account.created", account.id, {
        username: account.username,
        role: account.role,
        repos: account.repos,
      });
      json(res, 201, { account });
      return true;
    }
    const id = AccountId.safeParse(url.pathname.slice(`${prefix}/`.length));
    if (id.success && req.method === "PATCH") {
      const input = AccountUpdate.parse(await body());
      const account = await accounts.updateAccount(id.data, input, user.repos);
      await queue.audit(user.id, "account.updated", account.id, {
        username: account.username,
        role: account.role,
        repos: account.repos,
        passwordChanged: input.password !== undefined,
      });
      json(res, 200, { account });
      return true;
    }
    if (id.success && req.method === "DELETE") {
      const removed = await accounts.deleteAccount(id.data, user.id);
      await queue.audit(user.id, "account.deleted", id.data, removed);
      json(res, 200, { ok: true });
      return true;
    }
    json(res, 404, { error: "Not found" });
    return true;
  };
}
