import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { equal, type Principal } from "./access.js";
import type { Config } from "./config.js";
import type { ApiKeyCreated, ApiKeyRow } from "./dashboard/contracts.js";
import { QaError } from "./diagnostics.js";
import { decrypt, encrypt } from "./github-setup.js";

export const API_KEYS_MIGRATION = `
CREATE TABLE IF NOT EXISTS qa_api_keys (
 id uuid PRIMARY KEY, name text NOT NULL, prefix text NOT NULL, token_hash text NOT NULL UNIQUE,
 role text NOT NULL CHECK (role IN ('viewer','operator','admin')), repos jsonb NOT NULL,
 secret_cipher text NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz, revoked_at timestamptz, revoked_by text
);
CREATE INDEX IF NOT EXISTS qa_api_key_live ON qa_api_keys(revoked_at, created_at DESC);
`;
/**
 * Credential class of a service key. Distinct from the GitHub label so one
 * class of ciphertext never decrypts as the other.
 */
export const API_KEYS_LABEL = "api-keys-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * What a key may do. `viewer` reads the runs of its repositories; `operator`
 * also starts one. It is a declared portée, never the principal's dashboard
 * role: a key stays a reader there, so cancelling a run, re-arming an automatic
 * attempt and touching the settings remain out of its reach. `admin` is
 * deliberately absent — an administrator key would be an escalation of the
 * dashboard's own role, and no agent needs it.
 */
export type ApiKeyRole = "operator" | "viewer";
interface KeyRow {
  created_at: Date;
  id: string;
  last_used_at: Date | null;
  name: string;
  prefix: string;
  repos: string[];
  revoked_at: Date | null;
  role: Principal["role"];
  secret_cipher: string;
}
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function unknownKey() {
  return new QaError(
    "API_KEY_UNKNOWN",
    "Cette clé API est introuvable.",
    "Actualisez la liste des clés dans les réglages."
  );
}
function revokedKey() {
  return new QaError(
    "API_KEY_REVOKED",
    "Cette clé API a été révoquée.",
    "Créez une nouvelle clé pour rétablir l’accès."
  );
}
function keyRow(row: KeyRow): ApiKeyRow {
  return {
    createdAt: row.created_at.toISOString(),
    id: row.id,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    name: row.name,
    prefix: row.prefix,
    repos: row.repos,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    role: row.role === "operator" ? "operator" : "viewer",
  };
}

/**
 * Service keys an administrator issues for agents. A key reads the repositories
 * of this instance, and an `operator` key also starts runs; its token is stored
 * as a hash and an encrypted copy, and every use of the management API leaves
 * an audit trail.
 */
export class ApiKeys {
  private readonly pool: pg.Pool;
  private readonly config: Config;
  constructor(pool: pg.Pool, config: Config) {
    this.pool = pool;
    this.config = config;
  }
  /**
   * Issue a key and return its token, the only time it is readable in clear.
   *
   * The caller passes the repositories in force. The environment restriction
   * (`GITHUB_ALLOWED_REPOS`) is only a ceiling: it is deliberately empty when
   * the operator picks repositories in the dashboard, so reading it here would
   * issue a key that can read nothing.
   *
   * The scope is the administrator's choice at creation and never changes after:
   * widening a live key would widen every agent that already holds it.
   */
  async create(
    user: Principal,
    name: string,
    repos: string[],
    role: ApiKeyRole = "viewer"
  ): Promise<ApiKeyCreated> {
    const token = `qa_live_${randomBytes(24).toString("base64url")}`;
    const prefix = token.slice(0, 12);
    const scope = [...repos];
    const id = randomUUID();
    const created = (
      await this.pool.query<{ created_at: Date }>(
        `INSERT INTO qa_api_keys(id,name,prefix,token_hash,role,repos,secret_cipher,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`,
        [
          id,
          name,
          prefix,
          sha256(token),
          role,
          JSON.stringify(scope),
          encrypt(token, this.config, API_KEYS_LABEL),
          user.id,
        ]
      )
    ).rows[0];
    if (!created) {
      throw new Error("API key insert returned no row");
    }
    await this.audit("api_key.created", user.id, {
      id,
      name,
      prefix,
      repos: scope,
      role,
    });
    return {
      createdAt: created.created_at.toISOString(),
      id,
      lastUsedAt: null,
      name,
      prefix,
      repos: scope,
      revokedAt: null,
      role,
      token,
    };
  }
  /**
   * The keys this caller may hold. A key that reaches further than the caller
   * is not the caller's to read, to copy or to revoke: `secret()` hands over a
   * live capability, and copying a wider key would restore exactly the escalation
   * `issuedScope` refuses at creation. A local administrator covers the whole
   * selection, so it still sees every key.
   */
  private withinScope(user: Principal, repos: string[]) {
    const mine = new Set(user.repos.map((repo) => repo.toLowerCase()));
    return repos.every((repo) => mine.has(repo.toLowerCase()));
  }
  /** Active keys first, then the newest of each group. */
  async list(user: Principal): Promise<ApiKeyRow[]> {
    const rows = (
      await this.pool.query<KeyRow>(
        "SELECT id,name,prefix,role,repos,created_at,last_used_at,revoked_at FROM qa_api_keys ORDER BY (revoked_at IS NULL) DESC, created_at DESC"
      )
    ).rows;
    return rows.filter((row) => this.withinScope(user, row.repos)).map(keyRow);
  }
  async revoke(
    user: Principal,
    id: string
  ): Promise<{ id: string; revokedAt: string }> {
    const row = await this.find(user, id);
    const revoked = (
      await this.pool.query<{ revoked_at: Date }>(
        "UPDATE qa_api_keys SET revoked_at=now(),revoked_by=$2 WHERE id=$1 AND revoked_at IS NULL RETURNING revoked_at",
        [id, user.id]
      )
    ).rows[0];
    if (!revoked) {
      throw revokedKey();
    }
    await this.audit("api_key.revoked", user.id, {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
    });
    return { id, revokedAt: revoked.revoked_at.toISOString() };
  }
  /** Decrypt the stored copy, so an administrator can hand the token over again. */
  async secret(user: Principal, id: string): Promise<{ token: string }> {
    const row = await this.find(user, id);
    const token = decrypt<string>(
      row.secret_cipher,
      this.config,
      API_KEYS_LABEL
    );
    await this.audit("api_key.copied", user.id, {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
    });
    return { token };
  }
  /**
   * The principal behind a presented token, if any live key matches it. The
   * hash is compared in constant time against the live keys, and a revoked key
   * never verifies, so revocation takes effect on the next request.
   */
  async verify(token: string): Promise<Principal | undefined> {
    const hash = sha256(token);
    const rows = (
      await this.pool.query<{
        id: string;
        repos: string[];
        role: Principal["role"];
        token_hash: string;
      }>(
        "SELECT id,role,repos,token_hash FROM qa_api_keys WHERE revoked_at IS NULL"
      )
    ).rows;
    const row = rows.find((candidate) => equal(candidate.token_hash, hash));
    if (!row) {
      return;
    }
    // One write per five minutes at most: a chatty agent must not hot-write the row.
    await this.pool.query(
      "UPDATE qa_api_keys SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval '5 minutes')",
      [row.id]
    );
    return {
      apiKeyId: row.id,
      // A key never becomes a dashboard operator. Its declared portée is read,
      // plus `canLaunch` when it was issued to start runs; keeping `role` at
      // `viewer` is what makes every dashboard write surface refuse it without
      // enumerating those surfaces — and forgetting one later.
      canLaunch: row.role === "operator",
      id: `key:${row.id}`,
      repos: row.repos,
      role: "viewer",
    };
  }
  /** A malformed id is not a capability: it matches nothing, like an absent one. */
  private async find(user: Principal, id: string): Promise<KeyRow> {
    const row = UUID.test(id)
      ? (
          await this.pool.query<KeyRow>(
            "SELECT id,name,prefix,role,repos,secret_cipher,created_at,last_used_at,revoked_at FROM qa_api_keys WHERE id=$1",
            [id]
          )
        ).rows[0]
      : undefined;
    if (!row) {
      throw unknownKey();
    }
    // The scope is checked before the revocation state: an out-of-scope key is
    // not this caller's business, whether it is live or already revoked.
    if (!this.withinScope(user, row.repos)) {
      throw new QaError(
        "API_KEY_SCOPE",
        "Cette clé couvre un périmètre plus large que le vôtre.",
        "Demandez à un administrateur qui couvre tous les dépôts de l'instance."
      );
    }
    if (row.revoked_at) {
      throw revokedKey();
    }
    return row;
  }
  private async audit(action: string, actor: string, details: unknown) {
    await this.pool.query(
      "INSERT INTO qa_audit(actor,action,details) VALUES($1,$2,$3)",
      [actor, action, JSON.stringify(details)]
    );
  }
}
