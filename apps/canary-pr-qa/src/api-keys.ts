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
  };
}

/**
 * Service keys an administrator issues for agents. A key is a read-only viewer
 * of the repositories of this instance, its token is stored as a hash and an
 * encrypted copy, and every use of the management API leaves an audit trail.
 */
export class ApiKeys {
  private readonly pool: pg.Pool;
  private readonly config: Config;
  constructor(pool: pg.Pool, config: Config) {
    this.pool = pool;
    this.config = config;
  }
  /** Issue a key and return its token, the only time it is readable in clear. */
  async create(user: Principal, name: string): Promise<ApiKeyCreated> {
    const token = `qa_live_${randomBytes(24).toString("base64url")}`;
    const prefix = token.slice(0, 12);
    const repos = [...this.config.allowedRepos];
    const id = randomUUID();
    const created = (
      await this.pool.query<{ created_at: Date }>(
        `INSERT INTO qa_api_keys(id,name,prefix,token_hash,role,repos,secret_cipher,created_by)
         VALUES($1,$2,$3,$4,'viewer',$5,$6,$7) RETURNING created_at`,
        [
          id,
          name,
          prefix,
          sha256(token),
          JSON.stringify(repos),
          encrypt(token, this.config, API_KEYS_LABEL),
          user.id,
        ]
      )
    ).rows[0];
    if (!created) {
      throw new Error("API key insert returned no row");
    }
    await this.audit("api_key.created", user.id, { id, name, prefix });
    return {
      createdAt: created.created_at.toISOString(),
      id,
      lastUsedAt: null,
      name,
      prefix,
      repos,
      revokedAt: null,
      token,
    };
  }
  /** Active keys first, then the newest of each group. */
  async list(): Promise<ApiKeyRow[]> {
    const rows = (
      await this.pool.query<KeyRow>(
        "SELECT id,name,prefix,role,repos,created_at,last_used_at,revoked_at FROM qa_api_keys ORDER BY (revoked_at IS NULL) DESC, created_at DESC"
      )
    ).rows;
    return rows.map(keyRow);
  }
  async revoke(
    user: Principal,
    id: string
  ): Promise<{ id: string; revokedAt: string }> {
    const row = await this.find(id);
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
    const row = await this.find(id);
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
    return { id: `key:${row.id}`, role: row.role, repos: row.repos };
  }
  /** A malformed id is not a capability: it matches nothing, like an absent one. */
  private async find(id: string): Promise<KeyRow> {
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
