/**
 * API-key routes of the dashboard, split out of `dashboard-routes.ts`.
 *
 * A key reads the repositories it was issued for, and an `operator` key also
 * starts runs, so this is the one screen where an administrator sees — and
 * narrows — what an agent was granted. The prefix, the body schema and the
 * scope check move together: a caller cannot add a route under
 * `/dashboard/api-keys` without inheriting the administrator check below.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Principal } from "./access.js";
import type { ApiKeys } from "./api-keys.js";
import { QaError } from "./diagnostics.js";

const apiKeySchema = z
  .object({
    name: z.string().min(1).max(60),
    // Absent means read-only: a caller that never heard of the scope cannot
    // grant more than the default by omission.
    role: z.enum(["operator", "viewer"]).default("viewer"),
  })
  .strict();
/** Path segment that decrypts a stored key instead of revoking it. */
const SECRET_SUFFIX = "/secret";
const API_KEYS_PREFIX = "/dashboard/api-keys";

export function apiKeysRoute(
  keys: ApiKeys,
  read: (req: IncomingMessage) => Promise<Buffer>,
  json: (res: ServerResponse, status: number, value: unknown) => void,
  effectiveRepos: () => Promise<string[]>
) {
  /**
   * Administrator-only key management. A key reads the repositories it was
   * issued for, and an `operator` key also starts runs, so the list and the copy
   * action are the administrator's only way to see what an agent was granted.
   */
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal
  ): Promise<boolean> => {
    if (
      url.pathname !== API_KEYS_PREFIX &&
      !url.pathname.startsWith(`${API_KEYS_PREFIX}/`)
    ) {
      return false;
    }
    if (user.role !== "admin") {
      json(res, 403, { error: "Administrator required" });
      return true;
    }
    if (url.pathname === API_KEYS_PREFIX) {
      if (req.method === "GET") {
        json(res, 200, await keys.list(user));
        return true;
      }
      if (req.method === "POST") {
        const input = apiKeyInput(await read(req));
        json(
          res,
          201,
          await keys.create(
            user,
            input.name,
            issuedScope(user, await effectiveRepos()),
            input.role
          )
        );
        return true;
      }
      return false;
    }
    const rest = url.pathname.slice(API_KEYS_PREFIX.length + 1);
    if (rest.endsWith(SECRET_SUFFIX)) {
      if (req.method !== "POST") {
        return false;
      }
      json(
        res,
        200,
        await keys.secret(user, rest.slice(0, -SECRET_SUFFIX.length))
      );
      return true;
    }
    if (req.method === "DELETE") {
      json(res, 200, await keys.revoke(user, rest));
      return true;
    }
    return false;
  };
}

/**
 * The repositories a new key may carry: the selection in force, never more than
 * the issuer's own scope. A `users.json` or OIDC administrator limited to one
 * project would otherwise mint a key that reads — and now *launches runs on* —
 * repositories it cannot reach itself. Reading outside its scope was already a
 * leak; the `operator` scope turns that leak into paid work on another project.
 * A local administrator always carries the whole selection, so this only ever
 * narrows the scope of an identity that is itself restricted.
 */
function issuedScope(user: Principal, effective: string[]) {
  const mine = new Set(user.repos.map((repo) => repo.toLowerCase()));
  return [...new Set(effective.map((repo) => repo.toLowerCase()))].filter(
    (repo) => mine.has(repo)
  );
}
/** A name and scope the dashboard can show; a refused body is a request error, not a 500. */
function apiKeyInput(body: Buffer) {
  const parsed = apiKeySchema.safeParse(JSON.parse(body.toString()) as unknown);
  if (!parsed.success) {
    throw new QaError(
      "API_KEY_NAME",
      "Le nom de la clé doit contenir 1 à 60 caractères, et sa portée être « viewer » ou « operator ».",
      "Donnez un nom court qui rappelle l’usage de la clé, et une portée connue."
    );
  }
  return parsed.data;
}
