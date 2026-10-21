/**
 * Local accounts: their shapes, their credential hashing, and their
 * administration.
 *
 * Split out of `local-auth.ts`, which keeps the session layer: cookies, login
 * rate limiting and `principal`. Everything here is about an account record
 * and the four administrator operations on it, so the "last administrator"
 * guards live next to the writes they protect and not inside the login code.
 */

import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { Principal } from "./access.js";
import type { LocalAccount } from "./dashboard/contracts.js";
import { QaError } from "./diagnostics.js";

export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9_.@-]{2,63}$/,
    "Identifiant : 3 à 64 caractères (lettres, chiffres, point, tiret ou @)."
  );
const Password = z
  .string()
  .min(12, "Utilisez au moins 12 caractères.")
  .max(128, "Maximum 128 caractères.");
export const Credentials = z
  .object({ username: Username, password: Password })
  .strict();
export const AdminSetup = Credentials.extend({
  setupCode: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const Role = z.enum(["viewer", "operator", "admin"]);
export const AccountCreate = z
  .object({
    username: Username,
    password: Password,
    role: Role,
    repos: z.array(z.string()),
  })
  .strict();
export const AccountUpdate = z
  .object({
    role: Role.optional(),
    repos: z.array(z.string()).optional(),
    password: Password.optional(),
  })
  .strict();

let deriving = 0;
async function derive(password: string, salt: string): Promise<Buffer> {
  if (deriving >= 2) {
    throw new QaError(
      "AUTH_BUSY",
      "Connexion occupée, réessayez dans quelques secondes.",
      "Password hashing concurrency is bounded."
    );
  }
  deriving++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        64,
        { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key))
      )
    );
  } finally {
    deriving--;
  }
}
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1:${salt}:${(await derive(Password.parse(password), salt)).toString("hex")}`;
}
export async function passwordMatches(password: string, encoded?: string) {
  const parts = (
    encoded ?? `scrypt-v1:${"0".repeat(32)}:${"0".repeat(128)}`
  ).split(":");
  const key = await derive(password, parts[1] ?? "0".repeat(32));
  const expected = Buffer.from(parts[2] ?? "0".repeat(128), "hex");
  return (
    Boolean(encoded) &&
    expected.length === key.length &&
    timingSafeEqual(expected, key)
  );
}

interface AccountRow {
  created_at: Date | string;
  id: string;
  repos: string[];
  role: Principal["role"];
  username: string;
}
function accountOf(row: AccountRow): LocalAccount {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    repos: row.repos,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
/**
 * The account's repositories stay inside the effective selection, spelled the
 * way that selection spells them, so a viewer's stored repos survive the
 * case-insensitive intersection `principal` applies at each request.
 */
function selectedRepos(requested: string[], allowed: string[]) {
  const canonical = new Map(
    allowed.map((repo) => [repo.trim().toLowerCase(), repo])
  );
  return requested.map((repo) => {
    const match = canonical.get(repo.trim().toLowerCase());
    if (!match) {
      throw new QaError(
        "ACCOUNT_REPO_DENIED",
        `Dépôt non autorisé : ${repo.trim().slice(0, 120)}.`,
        "Sélectionnez uniquement les dépôts connectés dans Réglages → GitHub."
      );
    }
    return match;
  });
}
async function remainingAdmins(client: pg.PoolClient, id: string) {
  const counted = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM qa_local_users WHERE role='admin' AND id<>$1",
    [id]
  );
  return counted.rows[0]?.count ?? 0;
}
function lastAdmin(action: string) {
  return new QaError(
    "ACCOUNT_LAST_ADMIN",
    `Impossible de ${action} le dernier administrateur local.`,
    "Nommez d'abord un autre administrateur."
  );
}

export async function listLocalAccounts(
  pool: pg.Pool
): Promise<LocalAccount[]> {
  const result = await pool.query<AccountRow>(
    "SELECT id,username,role,repos,created_at FROM qa_local_users ORDER BY username,id"
  );
  return result.rows.map(accountOf);
}
export async function createLocalAccount(
  pool: pg.Pool,
  input: z.infer<typeof AccountCreate>,
  allowedRepos: string[]
): Promise<LocalAccount> {
  const encoded = await passwordHash(input.password);
  const created = await pool.query<AccountRow>(
    "INSERT INTO qa_local_users(id,username,password_hash,role,repos) VALUES($1,$2,$3,$4,$5) ON CONFLICT(username) DO NOTHING RETURNING id,username,role,repos,created_at",
    [
      randomUUID(),
      input.username,
      encoded,
      input.role,
      JSON.stringify(selectedRepos(input.repos, allowedRepos)),
    ]
  );
  if (!created.rows[0]) {
    throw new QaError(
      "ACCOUNT_EXISTS",
      "Cet identifiant est déjà utilisé.",
      "Choisissez un autre identifiant."
    );
  }
  return accountOf(created.rows[0]);
}
export async function updateLocalAccount(
  pool: pg.Pool,
  id: string,
  input: z.infer<typeof AccountUpdate>,
  allowedRepos: string[]
): Promise<LocalAccount> {
  const encoded =
    input.password === undefined
      ? undefined
      : await passwordHash(input.password);
  const repos =
    input.repos === undefined
      ? undefined
      : selectedRepos(input.repos, allowedRepos);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(9287345)");
    const current = (
      await client.query<{ role: Principal["role"] }>(
        "SELECT role FROM qa_local_users WHERE id=$1 FOR UPDATE",
        [id]
      )
    ).rows[0];
    if (!current) {
      throw new QaError(
        "ACCOUNT_NOT_FOUND",
        "Compte introuvable.",
        "Rechargez la liste des comptes."
      );
    }
    const role = input.role ?? current.role;
    if (
      current.role === "admin" &&
      role !== "admin" &&
      !(await remainingAdmins(client, id))
    ) {
      throw lastAdmin("rétrograder");
    }
    const updated = await client.query<AccountRow>(
      "UPDATE qa_local_users SET role=$2, repos=COALESCE($3::jsonb,repos), password_hash=COALESCE($4,password_hash) WHERE id=$1 RETURNING id,username,role,repos,created_at",
      [id, role, repos ? JSON.stringify(repos) : null, encoded ?? null]
    );
    if (encoded) {
      // A new password ends every session opened with the old one.
      await client.query("DELETE FROM qa_local_sessions WHERE user_id=$1", [
        id,
      ]);
    }
    await client.query("COMMIT");
    return accountOf(updated.rows[0] as AccountRow);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function deleteLocalAccount(
  pool: pg.Pool,
  id: string,
  actorId: string
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(9287345)");
    const current = (
      await client.query<{ role: Principal["role"]; username: string }>(
        "SELECT role,username FROM qa_local_users WHERE id=$1 FOR UPDATE",
        [id]
      )
    ).rows[0];
    if (!current) {
      throw new QaError(
        "ACCOUNT_NOT_FOUND",
        "Compte introuvable.",
        "Rechargez la liste des comptes."
      );
    }
    if (actorId.replace(/^local:/, "") === id) {
      throw new QaError(
        "ACCOUNT_SELF_DELETE",
        "Impossible de supprimer votre propre compte.",
        "Demandez à un autre administrateur de le faire."
      );
    }
    if (current.role === "admin" && !(await remainingAdmins(client, id))) {
      throw lastAdmin("supprimer");
    }
    await client.query("DELETE FROM qa_local_users WHERE id=$1", [id]);
    await client.query("COMMIT");
    return { username: current.username, role: current.role };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
