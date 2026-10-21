import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Principal } from "./access.js";
import type { AccountPayload, AccountsPayload } from "./dashboard/contracts.js";
import { QaError } from "./diagnostics.js";
import { AccountCreate, AccountUpdate } from "./local-accounts.js";
import type { LocalAuth } from "./local-auth.js";
import type { Queue } from "./queue.js";

const AccountId = z.string().uuid();

/** The administrator's scope covers every repository this instance enabled. */
function coversInstance(repos: string[], allowed: string[]) {
  const scope = new Set(repos.map((repo) => repo.toLowerCase()));
  return allowed.every((repo) => scope.has(repo.toLowerCase()));
}

/**
 * Administrative CRUD over the human accounts of `qa_local_users`, mounted
 * behind the `LocalAuth` principal. Only an administrator manages accounts, and
 * its own repository scope is the effective selection a new account may use.
 */
export function accountRoutes(
  accounts: LocalAuth,
  queue: Queue,
  read: (req: IncomingMessage) => Promise<Buffer>,
  json: (res: ServerResponse, status: number, value: unknown) => void,
  allowedRepos: () => Promise<string[]>
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
    // Managing accounts is an instance-wide power: it names local
    // administrators, and every local administrator follows the whole
    // selection. A scoped administrator — a `users.json` or OIDC admin limited
    // to one project — could otherwise mint an account that outranks its own
    // scope and reach runs it may not read.
    if (!coversInstance(user.repos, await allowedRepos())) {
      throw new QaError(
        "ACCOUNT_SCOPE_REQUIRED",
        "La gestion des comptes demande un accès à tous les dépôts de l'instance.",
        "Utilisez un compte local administrateur, ou élargissez la portée de cette identité."
      );
    }
    const body = async () => JSON.parse((await read(req)).toString());
    if (req.method === "GET" && url.pathname === prefix) {
      json(res, 200, {
        accounts: await accounts.listAccounts(),
      } satisfies AccountsPayload);
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
      json(res, 201, { account } satisfies AccountPayload);
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
      json(res, 200, { account } satisfies AccountPayload);
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
