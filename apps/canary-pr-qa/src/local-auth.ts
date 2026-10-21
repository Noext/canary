import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type pg from "pg";
import type { z } from "zod";
import type { Principal } from "./access.js";
import type { Config } from "./config.js";
import type { LocalAccount } from "./dashboard/contracts.js";
import { QaError } from "./diagnostics.js";
import {
  type AccountCreate,
  type AccountUpdate,
  type AdminSetup,
  type Credentials,
  createLocalAccount,
  deleteLocalAccount,
  listLocalAccounts,
  passwordHash,
  passwordMatches,
  Username,
  updateLocalAccount,
} from "./local-accounts.js";

export const LOCAL_AUTH_MIGRATION = `
CREATE TABLE IF NOT EXISTS qa_local_users (
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('viewer','operator','admin')), repos jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS qa_local_sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES qa_local_users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS qa_local_session_expiry ON qa_local_sessions(expires_at);
CREATE TABLE IF NOT EXISTS qa_setup_ticket (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), token_hash text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS qa_auth_attempts (
 key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS qa_auth_attempt_expiry ON qa_auth_attempts(expires_at,key);
`;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function localCookie(
  token: string,
  config: Config,
  req?: IncomingMessage
) {
  const secure =
    config.ARTIFACT_BASE_URL.startsWith("https:") ||
    req?.headers["x-forwarded-proto"] === "https";
  return `qa_local_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? 3600 : 0}${secure ? "; Secure" : ""}`;
}
function sessionToken(req: IncomingMessage) {
  return /(?:^|;\s*)qa_local_session=([a-zA-Z0-9_-]{43})(?:;|$)/.exec(
    req.headers.cookie ?? ""
  )?.[1];
}
interface UserRow {
  id: string;
  password_hash: string;
  repos: string[];
  role: Principal["role"];
  username: string;
}
export class LocalAuth {
  private readonly pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.pool = pool;
  }
  async status() {
    const result = await this.pool.query(
      "SELECT EXISTS(SELECT 1 FROM qa_local_users) AS initialized"
    );
    return { initialized: result.rows[0].initialized as boolean };
  }
  async issueSetupTicket() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(9287345)");
      if (
        (await client.query("SELECT id FROM qa_local_users LIMIT 1")).rows
          .length
      ) {
        throw new Error(
          "Un compte existe déjà. Utilisez reset-password pour récupérer l'accès."
        );
      }
      const token = randomBytes(32).toString("hex");
      await client.query(
        "INSERT INTO qa_setup_ticket(singleton,token_hash,expires_at) VALUES(true,$1,now()+interval '15 minutes') ON CONFLICT(singleton) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at",
        [hash(token)]
      );
      await client.query("COMMIT");
      return token;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async setup(input: z.infer<typeof AdminSetup>, repos: string[]) {
    const valid = await this.pool.query(
      "SELECT singleton FROM qa_setup_ticket WHERE token_hash=$1 AND expires_at>now()",
      [hash(input.setupCode)]
    );
    if (!valid.rows.length) {
      throw new Error(
        "Lien d'installation invalide ou expiré. Générez un nouveau lien sur le VPS."
      );
    }
    const encoded = await passwordHash(input.password);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(9287345)");
      if (
        (await client.query("SELECT id FROM qa_local_users LIMIT 1")).rows
          .length
      ) {
        throw new Error("Installation déjà terminée.");
      }
      const consumed = await client.query(
        "DELETE FROM qa_setup_ticket WHERE token_hash=$1 AND expires_at>now() RETURNING singleton",
        [hash(input.setupCode)]
      );
      if (!consumed.rowCount) {
        throw new Error("Lien d'installation invalide ou expiré.");
      }
      const id = randomUUID();
      await client.query(
        "INSERT INTO qa_local_users(id,username,password_hash,role,repos) VALUES($1,$2,$3,'admin',$4)",
        [id, input.username, encoded, JSON.stringify(repos)]
      );
      await client.query("COMMIT");
      return {
        id: `local:${id}`,
        role: "admin" as const,
        repos,
        username: input.username,
        passwordProof: encoded,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async login(input: z.infer<typeof Credentials>) {
    const key = hash(input.username);
    await this.pool.query(
      "DELETE FROM qa_auth_attempts WHERE key IN (SELECT key FROM qa_auth_attempts WHERE expires_at<now() ORDER BY expires_at,key LIMIT 250)"
    );
    await this.admitAttempt("global-login", 120);
    await this.admitAttempt(key, 10);
    const row = (
      await this.pool.query<UserRow>(
        "SELECT * FROM qa_local_users WHERE username=$1",
        [input.username]
      )
    ).rows[0];
    if (!(await passwordMatches(input.password, row?.password_hash))) {
      return;
    }
    if (!row) {
      return;
    }
    await this.pool.query("DELETE FROM qa_auth_attempts WHERE key=$1", [key]);
    return {
      id: `local:${row.id}`,
      role: row.role,
      repos: row.repos,
      username: row.username,
      passwordProof: row.password_hash,
    };
  }
  private async admitAttempt(key: string, maximum: number) {
    const attempts = await this.pool.query(
      "INSERT INTO qa_auth_attempts(key,count,expires_at) VALUES($1,1,now()+interval '1 minute') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN qa_auth_attempts.expires_at<now() THEN 1 ELSE qa_auth_attempts.count+1 END,expires_at=CASE WHEN qa_auth_attempts.expires_at<now() THEN EXCLUDED.expires_at ELSE qa_auth_attempts.expires_at END RETURNING count",
      [key]
    );
    if (attempts.rows[0].count > maximum) {
      throw new QaError(
        "AUTH_RATE_LIMIT",
        "Trop de tentatives. Réessayez dans une minute.",
        "Login attempts are limited in PostgreSQL."
      );
    }
  }
  async session(user: Principal & { passwordProof: string }) {
    const token = randomBytes(32).toString("base64url");
    await this.pool.query(
      "DELETE FROM qa_local_sessions WHERE expires_at<now()"
    );
    await this.pool.query(
      "DELETE FROM qa_auth_attempts WHERE expires_at<now()"
    );
    const admitted = await this.pool.query(
      "WITH eligible_user AS (SELECT id FROM qa_local_users WHERE id=$2 AND password_hash=$3 FOR SHARE) INSERT INTO qa_local_sessions(token_hash,user_id,expires_at) SELECT $1,id,now()+interval '1 hour' FROM eligible_user RETURNING user_id",
      [hash(token), user.id.replace(/^local:/, ""), user.passwordProof]
    );
    if (!admitted.rowCount) {
      throw new Error("Identifiant ou mot de passe incorrect.");
    }
    return token;
  }
  async principal(
    req: IncomingMessage,
    allowedRepos: string[]
  ): Promise<Principal | undefined> {
    const token = sessionToken(req);
    if (!token) {
      return;
    }
    const row = (
      await this.pool.query<UserRow>(
        "SELECT u.* FROM qa_local_users u JOIN qa_local_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()",
        [hash(token)]
      )
    ).rows[0];
    if (row) {
      return {
        id: `local:${row.id}`,
        role: row.role,
        repos:
          row.role === "admin"
            ? allowedRepos
            : row.repos.filter((repo) =>
                allowedRepos
                  .map((value) => value.toLowerCase())
                  .includes(repo.toLowerCase())
              ),
        username: row.username,
      };
    }
  }
  async logout(req: IncomingMessage) {
    const token = sessionToken(req);
    if (token) {
      await this.pool.query(
        "DELETE FROM qa_local_sessions WHERE token_hash=$1",
        [hash(token)]
      );
    }
  }
  async resetPassword(username: string, password: string) {
    const encoded = await passwordHash(password);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await client.query(
        "UPDATE qa_local_users SET password_hash=$2 WHERE username=$1 RETURNING id",
        [Username.parse(username), encoded]
      );
      if (!row.rowCount) {
        throw new Error("Compte introuvable.");
      }
      await client.query("DELETE FROM qa_local_sessions WHERE user_id=$1", [
        row.rows[0].id,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  listAccounts(): Promise<LocalAccount[]> {
    return listLocalAccounts(this.pool);
  }
  createAccount(
    input: z.infer<typeof AccountCreate>,
    allowedRepos: string[]
  ): Promise<LocalAccount> {
    return createLocalAccount(this.pool, input, allowedRepos);
  }
  updateAccount(
    id: string,
    input: z.infer<typeof AccountUpdate>,
    allowedRepos: string[]
  ): Promise<LocalAccount> {
    return updateLocalAccount(this.pool, id, input, allowedRepos);
  }
  deleteAccount(id: string, actorId: string) {
    return deleteLocalAccount(this.pool, id, actorId);
  }
}
