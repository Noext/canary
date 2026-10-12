import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
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
  id: string;
  repos: string[];
  role: "viewer" | "operator" | "admin";
  username?: string;
}
function equal(a: string, b: string) {
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
  local?: LocalAuth
): Promise<Principal | undefined> {
  const account = await local?.principal(req);
  if (account) {
    return account;
  }
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const records = await users(config);
  if (token && equal(token, config.QA_API_TOKEN)) {
    return { id: "bootstrap-admin", role: "admin", repos: config.allowedRepos };
  }
  if (token) {
    const hash = createHash("sha256").update(token).digest("hex");
    const user = records.find(
      (u) => u.tokenSha256 && equal(hash, u.tokenSha256)
    );
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
        const oidc = records.find(
          (u) => u.oidcSubject === verified.payload.sub
        );
        if (oidc) {
          return oidc;
        }
      }
    }
  }
  return cookiePrincipal(req, config, records);
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
    throw new Error("Project access denied");
  }
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
