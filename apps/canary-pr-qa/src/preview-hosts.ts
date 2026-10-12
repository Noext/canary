import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@usecanary/logger";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "./config.js";
import { diagnose, QaError } from "./diagnostics.js";

const logger = createLogger({ name: "qa-preview-hosts" });

/**
 * The dashboard-managed preview host allowlist.
 *
 * `PREVIEW_ALLOWED_HOSTS` stays the server default: it seeds the UI, it is the
 * fallback whenever no dashboard list was saved, and it is what the deployment
 * validates at boot. Once an administrator saves a list, that list wins in every
 * process this module runs in:
 *
 * - the API and the worker read it from PostgreSQL (the source of truth);
 * - the browser and egress containers cannot reach the database, so the API
 *   publishes the effective list to a small policy file they poll. The EGRESS
 *   proxy is the network boundary that actually enforces it, which is why the
 *   published copy - not an in-memory broadcast - is what the containers read.
 */
export const PREVIEW_HOSTS_MIGRATION = `
CREATE TABLE IF NOT EXISTS qa_preview_hosts (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), hosts jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by text NOT NULL
);
`;
/** File the API publishes for the browser and egress containers (inside `QA_POLICY_DIR`). */
export const PREVIEW_POLICY_FILE = "preview-hosts.json";
export const MAX_PREVIEW_HOSTS = 50;
export const MAX_HOST_LENGTH = 253;
const HOST =
  /^(?<name>\[[0-9a-f:.]+\]|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::(?<port>\d{1,5}))?$/;
export const previewPolicySchema = z
  .object({
    hosts: z.array(z.string()),
    updatedAt: z.string(),
    updatedBy: z.string(),
  })
  .strict();

function validHost(host: string) {
  if (!host || host.length > MAX_HOST_LENGTH) {
    return false;
  }
  const match = HOST.exec(host);
  if (!match?.groups) {
    return false;
  }
  const port = match.groups.port;
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
}

/**
 * Normalizes and validates an administrator-supplied host list. Hosts are exact
 * `host` or `host:port` matches without scheme, path, credentials or wildcard:
 * the list decides which destinations the QA browser may reach.
 */
export function normalizePreviewHosts(value: unknown): string[] {
  const items = z
    .array(z.string().max(MAX_HOST_LENGTH))
    .max(400)
    .parse(value ?? []);
  const hosts = [
    ...new Set(items.map((item) => item.trim().toLowerCase()).filter(Boolean)),
  ];
  if (!hosts.length) {
    throw new QaError(
      "PREVIEW_HOSTS_EMPTY",
      "La liste des hôtes autorisés ne peut pas être vide.",
      "Ajoutez au moins un hôte, ou rétablissez la liste du serveur."
    );
  }
  if (hosts.length > MAX_PREVIEW_HOSTS) {
    throw new QaError(
      "PREVIEW_HOSTS_LIMIT",
      `La liste est limitée à ${MAX_PREVIEW_HOSTS} hôtes.`,
      "Retirez les hôtes inutilisés et limitez la liste aux environnements de test réellement nécessaires."
    );
  }
  const invalid = hosts.filter((host) => !validHost(host));
  if (invalid.length) {
    throw new QaError(
      "PREVIEW_HOSTS_INVALID",
      `Hôte(s) invalide(s) : ${invalid.slice(0, 5).join(", ")}`,
      "Format attendu : hôte ou hôte:port, sans schéma, chemin, identifiants ni joker."
    );
  }
  return hosts;
}

/**
 * Applies an effective host list to a process configuration.
 *
 * `Config` is shared by reference - `GitHubSetup` keeps the same object and
 * spreads it on every `effective()` - so mutating it keeps every synchronous
 * validator (`validatePreviewUrl`, the egress policy, the Canary session
 * arguments) on the same list instead of threading a second parameter through
 * the run pipeline.
 */
export function applyPreviewHosts(config: Config, hosts: string[]): Config {
  config.allowedHosts = hosts;
  config.PREVIEW_ALLOWED_HOSTS = hosts.join(",");
  return config;
}

function policyPath(config: Config) {
  return config.QA_POLICY_DIR
    ? join(config.QA_POLICY_DIR, PREVIEW_POLICY_FILE)
    : undefined;
}

/**
 * Publishes the effective list for the containers that enforce it. A failure is
 * reported to the caller: the EGRESS proxy would keep refusing a host the
 * dashboard now accepts, which must not be silent.
 */
export async function publishPreviewPolicy(
  config: Config,
  hosts: string[],
  actor: string
) {
  const path = policyPath(config);
  if (!path) {
    return;
  }
  const body = `${JSON.stringify({ hosts, updatedAt: new Date().toISOString(), updatedBy: actor })}\n`;
  const temporary = `${path}.${randomUUID()}`;
  try {
    await mkdir(config.QA_POLICY_DIR, { recursive: true });
    await writeFile(temporary, body, { mode: 0o644 });
    await rename(temporary, path);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new QaError(
      "PREVIEW_POLICY_UNWRITABLE",
      "Liste enregistrée, mais la politique réseau n'a pas pu être publiée.",
      "Vérifiez que QA_POLICY_DIR existe et est accessible en écriture par l'UID du service, puis réenregistrez la liste."
    );
  }
}

async function readPolicy(config: Config): Promise<string[] | undefined> {
  const path = policyPath(config);
  if (!path) {
    return;
  }
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) {
    return;
  }
  return normalizePreviewHosts(
    previewPolicySchema.parse(JSON.parse(raw)).hosts
  );
}

/**
 * Verifies that the enforcement containers can read what the API publishes.
 * The real policy file is never rewritten here: doctor may run offline, without
 * the dashboard list, and must not roll a saved list back to the default.
 */
export async function verifyPreviewPolicyTarget(
  config: Config
): Promise<string> {
  if (!config.QA_POLICY_DIR) {
    return "QA_POLICY_DIR is not set; preview hosts stay environment-only";
  }
  const probe = join(
    config.QA_POLICY_DIR,
    `${PREVIEW_POLICY_FILE}.${randomUUID()}.probe`
  );
  try {
    await mkdir(config.QA_POLICY_DIR, { recursive: true });
    await writeFile(probe, "probe", { mode: 0o644 });
    if ((await readFile(probe, "utf8")) !== "probe") {
      throw new Error("Preview policy readback differs from the written data");
    }
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
  return `Preview policy directory write verified; the browser and egress services read ${PREVIEW_POLICY_FILE} there`;
}

export interface PreviewPolicyWatch {
  stop: () => void;
  /** Applies the published list immediately; exposed for tests. */
  sync: () => Promise<void>;
}

/**
 * Keeps an enforcement process (`browser`, `egress`) on the published list. The
 * policy is re-read on a short interval: the containers have no database access
 * and a change must reach the network boundary in seconds, not on restart.
 */
export function watchPreviewPolicy(
  config: Config,
  intervalMs = 2000
): PreviewPolicyWatch {
  const path = policyPath(config);
  let applied = "";
  let warned = false;
  const sync = async () => {
    if (!path) {
      return;
    }
    let hosts: string[] | undefined;
    try {
      hosts = await readPolicy(config);
    } catch {
      if (!warned) {
        warned = true;
        logger.warn(
          { code: "PREVIEW_POLICY_INVALID" },
          "Published preview policy is unreadable; the current host list is kept"
        );
      }
      return;
    }
    if (!hosts) {
      return;
    }
    const fingerprint = hosts.join(",");
    if (fingerprint === applied) {
      return;
    }
    applyPreviewHosts(config, hosts);
    applied = fingerprint;
    warned = false;
    logger.info(
      { code: "PREVIEW_POLICY_APPLIED", hosts: hosts.length },
      "Preview host allowlist applied from the dashboard policy"
    );
  };
  const timer = setInterval(() => {
    void sync();
  }, intervalMs);
  timer.unref();
  void sync();
  return { sync, stop: () => clearInterval(timer) };
}

interface PreviewHostsRow {
  hosts: unknown;
  updated_at: Date;
  updated_by: string;
}

export class PreviewHosts {
  readonly pool: pg.Pool;
  readonly config: Config;
  /** The `PREVIEW_ALLOWED_HOSTS` default, captured before any override is applied. */
  private readonly environment: string[];

  constructor(pool: pg.Pool, config: Config) {
    this.pool = pool;
    this.config = config;
    this.environment = [...config.allowedHosts];
  }

  /** The server default, offered in the dashboard as the list to restore. */
  defaults(): string[] {
    return [...this.environment];
  }

  /** Whether a dashboard list is stored instead of the environment default. */
  async managed(): Promise<boolean> {
    return Boolean(await this.row());
  }

  private async row(): Promise<PreviewHostsRow | undefined> {
    return (
      await this.pool.query<PreviewHostsRow>(
        "SELECT hosts,updated_at,updated_by FROM qa_preview_hosts WHERE singleton=true"
      )
    ).rows[0];
  }

  /** The list in force: the stored list, or the server default. */
  async effective(): Promise<string[]> {
    const row = await this.row();
    if (!row) {
      return this.defaults();
    }
    try {
      return normalizePreviewHosts(row.hosts);
    } catch {
      // An unreadable stored list keeps the server default rather than widening
      // the allowlist or refusing to start.
      logger.warn(
        { code: "PREVIEW_HOSTS_UNREADABLE" },
        "Stored preview host list is invalid; the server default is used"
      );
      return this.defaults();
    }
  }

  /** Applies the stored list to this process and returns it. */
  async load(): Promise<string[]> {
    const hosts = await this.effective();
    applyPreviewHosts(this.config, hosts);
    return hosts;
  }

  async set(actor: string, value: unknown): Promise<string[]> {
    const hosts = normalizePreviewHosts(value);
    await this.pool.query(
      "INSERT INTO qa_preview_hosts(singleton,hosts,updated_at,updated_by) VALUES(true,$1::jsonb,now(),$2) ON CONFLICT(singleton) DO UPDATE SET hosts=EXCLUDED.hosts,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by",
      [JSON.stringify(hosts), actor]
    );
    applyPreviewHosts(this.config, hosts);
    await publishPreviewPolicy(this.config, hosts, actor);
    return hosts;
  }

  /** Drops the dashboard list and returns to the `PREVIEW_ALLOWED_HOSTS` default. */
  async reset(actor: string): Promise<string[]> {
    await this.pool.query("DELETE FROM qa_preview_hosts");
    const hosts = this.defaults();
    applyPreviewHosts(this.config, hosts);
    await publishPreviewPolicy(this.config, hosts, actor);
    return hosts;
  }

  /**
   * Publishes the list in force at boot so the enforcement containers match.
   * A boot-time failure is logged instead of fatal: the containers keep the last
   * published policy and `doctor` reports the unwritable directory.
   */
  async publish(actor: string) {
    await publishPreviewPolicy(
      this.config,
      this.config.allowedHosts,
      actor
    ).catch((error) =>
      logger.warn(
        { code: "PREVIEW_POLICY_UNWRITABLE", diagnostic: diagnose(error) },
        "Preview policy could not be published at startup"
      )
    );
  }
}
