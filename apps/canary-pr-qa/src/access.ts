import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { ApiKeys } from "./api-keys.js";
import type { Config } from "./config.js";
import type { LocalAuth } from "./local-auth.js";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function keySet(url: string) {
  let keys = keySets.get(url);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(url));
    keySets.set(url, keys);
  }
  return keys;
}
const UsersSchema = z.array(
  z
    .object({
      id: z.string().min(1),
      tokenSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      role: z.enum(["viewer", "operator", "admin"]),
      repos: z.array(z.string()),
      oidcSubject: z.string().optional(),
    })
    .strict()
);
export interface Principal {
  /**
   * Set only on the principal an API key stands for. Every other credential —
   * the service token, a `users.json` token, an OIDC JWT, a session cookie —
   * leaves it unset, so a surface reserved to agents can tell them apart.
   */
  apiKeyId?: string;
  /**
   * The one capability a service key may hold beyond reading: starting a run.
   * It is deliberately not the principal's `role` — a key is never a dashboard
   * operator, so every write surface of the dashboard (cancel a run, re-arm an
   * automatic attempt, share an artifact) refuses it by role, including those
   * added later. Only this declared capability opens a launch.
   */
  canLaunch?: boolean;
  id: string;
  repos: string[];
  role: "viewer" | "operator" | "admin";
  username?: string;
}
/** The one refusal every surface reports the same way: a repository out of scope. */
export const ACCESS_DENIED = "Project access denied";
/** Constant-time comparison for secrets of equal length. */
export function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function users(config: Config) {
  return config.QA_USERS_FILE
    ? UsersSchema.parse(
        JSON.parse(await readFile(config.QA_USERS_FILE, "utf8"))
      )
    : [];
}
export function sessionCookie(user: Principal, config: Config) {
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, exp: Date.now() + 3_600_000 })
  ).toString("base64url");
  const signature = createHmac("sha256", config.QA_API_TOKEN)
    .update(payload)
    .digest("base64url");
  return `qa_session=${payload}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${config.ARTIFACT_BASE_URL.startsWith("https:") ? "; Secure" : ""}`;
}
export async function principal(
  req: IncomingMessage,
  config: Config,
  local?: LocalAuth,
  keys?: ApiKeys
): Promise<Principal | undefined> {
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const account = token
    ? undefined
    : await local?.principal(req, config.allowedRepos);
  if (account) {
    return account;
  }
  const records = await users(config);
  // A request that carries a token is answered by that token alone: a browser
  // session cookie is never used to rescue a bearer token that matches nothing.
  return token
    ? await tokenPrincipal(token, config, records, keys)
    : cookiePrincipal(req, config, records);
}
/** The principal a bearer token stands for, or `undefined` when it stands for none. */
async function tokenPrincipal(
  token: string,
  config: Config,
  records: Awaited<ReturnType<typeof users>>,
  keys?: ApiKeys
): Promise<Principal | undefined> {
  if (equal(token, config.QA_API_TOKEN)) {
    return { id: "bootstrap-admin", role: "admin", repos: config.allowedRepos };
  }
  // A service key is checked before `users.json` credentials: this server issued
  // it, so it alone decides what the agent carrying it may read.
  const key = await keys?.verify(token);
  if (key) {
    return key;
  }
  const hash = createHash("sha256").update(token).digest("hex");
  const user = records.find((u) => u.tokenSha256 && equal(hash, u.tokenSha256));
  if (user) {
    return user;
  }
  if (config.QA_OIDC_ISSUER && config.QA_OIDC_JWKS_URL) {
    const verified = await jwtVerify(token, keySet(config.QA_OIDC_JWKS_URL), {
      issuer: config.QA_OIDC_ISSUER,
      audience: config.QA_OIDC_AUDIENCE,
      algorithms: ["RS256", "ES256"],
    }).catch(() => undefined);
    if (verified) {
      return records.find((u) => u.oidcSubject === verified.payload.sub);
    }
  }
}
function cookiePrincipal(
  req: IncomingMessage,
  config: Config,
  records: Principal[]
): Principal | undefined {
  const cookie = /(?:^|;\s*)qa_session=([\w-]+)\.([\w-]+)/.exec(
    req.headers.cookie ?? ""
  );
  if (!(cookie?.[1] && cookie[2])) {
    return;
  }
  if (
    !equal(
      cookie[2],
      createHmac("sha256", config.QA_API_TOKEN)
        .update(cookie[1])
        .digest("base64url")
    )
  ) {
    return;
  }
  const payload = JSON.parse(
    Buffer.from(cookie[1], "base64url").toString()
  ) as { id: string; exp: number };
  if (payload.exp < Date.now()) {
    return;
  }
  return payload.id === "bootstrap-admin"
    ? { id: payload.id, role: "admin", repos: config.allowedRepos }
    : records.find((u) => u.id === payload.id);
}
export function requireAccess(user: Principal, repo: string, write = false) {
  if (
    !user.repos.map((r) => r.toLowerCase()).includes(repo.toLowerCase()) ||
    (write && user.role === "viewer")
  ) {
    throw new Error(ACCESS_DENIED);
  }
}
/**
 * Whether this principal may start a run. An agent key carries exactly the
 * capability it was issued with, whatever its repositories; a dashboard session
 * follows its role, as it always has.
 */
export function mayLaunch(user: Principal) {
  return user.apiKeyId ? user.canLaunch === true : user.role !== "viewer";
}
export function artifactSignature(
  id: string,
  path: string,
  expires: number,
  config: Config
) {
  return createHmac("sha256", config.QA_API_TOKEN)
    .update(`${id}\n${path}\n${expires}`)
    .digest("hex");
}
export function signedArtifact(id: string, path: string, config: Config) {
  const expires = Date.now() + 300_000;
  return `/artifacts/${id}/${path}?expires=${expires}&signature=${artifactSignature(id, path, expires, config)}`;
}
export function validArtifactSignature(
  id: string,
  path: string,
  url: URL,
  config: Config
) {
  const expires = Number(url.searchParams.get("expires"));
  return (
    expires > Date.now() &&
    expires <= Date.now() + 300_000 &&
    equal(
      url.searchParams.get("signature") ?? "",
      artifactSignature(id, path, expires, config)
    )
  );
}
