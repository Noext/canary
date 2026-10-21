import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@usecanary/logger";
import type pg from "pg";
import { getPublicSuffix } from "tldts";
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
const MAX_PREVIEW_HOSTS = 50;
export const MAX_HOST_LENGTH = 253;
const HOST =
  /^(?:\*\.)?(?<name>\[[0-9a-f:.]+\]|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::(?<port>\d{1,5}))?$/;
const previewPolicySchema = z
  .object({
    hosts: z.array(z.string()),
    updatedAt: z.string(),
    updatedBy: z.string(),
  })
  .strict();

/**
 * Whether one entry is usable, i.e. a `host`, `host:port`, `*.domain` or
 * `*.domain:port` without scheme, path or credentials. Exported because
 * `PREVIEW_ALLOWED_HOSTS` is the one list that does not pass
 * {@link normalizePreviewHosts}, and must be held to the same rule.
 */
export function isValidPreviewHost(host: string) {
  if (!host || host.length > MAX_HOST_LENGTH) {
    return false;
  }
  const match = HOST.exec(host);
  if (!match?.groups) {
    return false;
  }
  const port = match.groups.port;
  if (port !== undefined && !(Number(port) >= 1 && Number(port) <= 65_535)) {
    return false;
  }
  if (!host.startsWith("*.")) {
    return true;
  }
  // A wildcard hands one whole label to whoever registers it, so its suffix
  // must be a domain the administrator controls rather than a shared public
  // suffix: `*.com`, `*.co.uk` or `*.github.io` would otherwise authorize every
  // registrant under it. The Public Suffix List answers that question, private
  // section included (shared hosting counts as shared).
  const suffix = (match.groups.name ?? "").replace(/^\[|\]$/g, "");
  const publicSuffix = getPublicSuffix(suffix, { allowPrivateDomains: true });
  return Boolean(publicSuffix) && publicSuffix !== suffix;
}

/**
 * Normalizes and validates an administrator-supplied host list. Entries are
 * exact `host` or `host:port` matches, or a `*.domain` / `*.domain:port`
 * wildcard covering that domain's subdomains at any depth (never the bare
 * domain, never a shared public suffix, and only for the entry's port). Hosts
 * carry no scheme, path or credentials: the list decides which destinations the
 * QA browser may reach.
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
  const invalid = hosts.filter((host) => !isValidPreviewHost(host));
  if (invalid.length) {
    throw new QaError(
      "PREVIEW_HOSTS_INVALID",
      `Hôte(s) invalide(s) : ${invalid.slice(0, 5).join(", ")}`,
      "Format attendu : hôte, hôte:port ou *.domaine (sous-domaines), sans schéma, chemin ni identifiants. Un joker doit porter sur un domaine que vous contrôlez : un suffixe public (*.com, *.co.uk, *.github.io) est refusé."
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
 *
 * An entry the loader would refuse never reaches a network boundary: the
 * environment list is sanitized by `loadConfig`, a dashboard list by
 * {@link normalizePreviewHosts}, and a published policy by the read that feeds
 * this call. The filter here is the boundary's own guarantee - `browser` and
 * `egress` start without the boot-time configuration check that reports a bad
 * `.env` entry.
 */
export function applyPreviewHosts(config: Config, hosts: string[]): Config {
  const allowed = hosts.filter(isValidPreviewHost);
  config.allowedHosts = allowed;
  config.PREVIEW_ALLOWED_HOSTS = allowed.join(",");
  return config;
}

function policyPath(config: Config) {
  return config.QA_POLICY_DIR
    ? join(config.QA_POLICY_DIR, PREVIEW_POLICY_FILE)
    : undefined;
}

/**
 * A stored host list whose publication failed.
 *
 * The row and the in-process configuration already changed by the time this is
 * thrown, so the caller must still record the edit: a policy-volume incident
 * cannot be allowed to hide an allowlist change.
 */
export class PreviewPolicyUnpublishedError extends QaError {
  readonly hosts: string[];

  constructor(hosts: string[]) {
    super(
      "PREVIEW_POLICY_UNWRITABLE",
      "Liste enregistrée, mais la politique réseau n'a pas pu être publiée.",
      "Vérifiez que QA_POLICY_DIR existe et est accessible en écriture par l'UID du service, puis réenregistrez la liste."
    );
    this.name = "PreviewPolicyUnpublishedError";
    this.hosts = hosts;
  }
}

/**
 * Publishes the effective list for the containers that enforce it. A failure is
 * reported to the caller: the EGRESS proxy would keep refusing a host the
 * dashboard now accepts, which must not be silent.
 */
async function publishPreviewPolicy(
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
    throw new PreviewPolicyUnpublishedError(hosts);
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
 * Fails when the published file and the list in force disagree, which is exactly
 * the state a failed publication leaves behind: the API accepts a host the
 * enforcement containers do not (or the reverse).
 */
export async function verifyPublishedPreviewHosts(
  config: Config
): Promise<string> {
  const published = await readPolicy(config).catch(() => {
    throw new QaError(
      "PREVIEW_POLICY_INVALID",
      `Published ${PREVIEW_POLICY_FILE} is not a valid host list`,
      "The browser and egress services deny every destination while the file is unreadable; let the API republish it or fix the policy volume."
    );
  });
  if (!published) {
    throw new QaError(
      "PREVIEW_POLICY_MISSING",
      `No published ${PREVIEW_POLICY_FILE} in QA_POLICY_DIR`,
      "The browser and egress services deny every destination until the API publishes the list; restart the API or re-save the list in Réglages."
    );
  }
  const file = [...published].sort();
  const inForce = [...config.allowedHosts].sort();
  if (
    file.length !== inForce.length ||
    file.some((host, index) => host !== inForce[index])
  ) {
    throw new QaError(
      "PREVIEW_POLICY_STALE",
      `Published hosts (${file.join(", ")}) differ from the list in force (${inForce.join(", ")})`,
      "The browser and egress services enforce the published list; re-save the list in Réglages, or restart the API so it republishes the stored one."
    );
  }
  return `${file.length} host(s) published and matching the list in force`;
}

/**
 * Verifies the shared policy directory from the process that runs doctor.
 *
 * Compose runs `./scripts/pr-qa doctor` inside `worker`, which mounts the
 * `qa-policy` volume like the API: the probe therefore tests the volume the API
 * publishes into, and the published file is read back the way `browser` and
 * `egress` read it. The real policy file is never rewritten here - doctor may run
 * offline, without the dashboard list, and must not roll a saved list back to the
 * default.
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
  const published = await readPolicy(config).catch(() => {
    throw new QaError(
      "PREVIEW_POLICY_INVALID",
      `Published ${PREVIEW_POLICY_FILE} is not a valid host list`,
      "The browser and egress services deny every destination while the file is unreadable; let the API republish it or fix the policy volume."
    );
  });
  const state = published
    ? `${published.length} host(s) published and readable`
    : "no list published yet; the API publishes it at startup";
  return `Shared policy directory is writable by this UID; ${state}`;
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
  let warned = "";
  const sync = async () => {
    if (!path) {
      return;
    }
    let hosts: string[] | undefined;
    let unreadable = false;
    try {
      hosts = await readPolicy(config);
    } catch {
      unreadable = true;
    }
    if (!hosts) {
      // Fail closed. Falling back to the environment default would re-open a host
      // an administrator removed, and the file is the only list this process can
      // trust; the API republishes the effective list, which this poll picks up.
      const state = unreadable ? "invalid" : "missing";
      if (warned !== state) {
        warned = state;
        logger.warn(
          {
            code: unreadable
              ? "PREVIEW_POLICY_INVALID"
              : "PREVIEW_POLICY_MISSING",
          },
          "Published preview policy is unreadable; every destination is denied until the API republishes it"
        );
      }
      applyPreviewHosts(config, []);
      applied = "";
      return;
    }
    const fingerprint = hosts.join(",");
    if (fingerprint === applied) {
      return;
    }
    applyPreviewHosts(config, hosts);
    applied = fingerprint;
    warned = "";
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

/** Session advisory lock key for one update-and-publish critical section. */
export const PREVIEW_HOSTS_LOCK = 9_287_347;

export class PreviewHosts {
  readonly pool: pg.Pool;
  readonly config: Config;
  /**
   * The `PREVIEW_ALLOWED_HOSTS` default, captured before any override is applied
   * and already sanitized by `loadConfig`, so a bad `.env` entry can never be
   * published back as the list to restore.
   */
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

  /**
   * Runs one stored-list change together with its publication.
   *
   * PostgreSQL serializes the row, but the file rename has to follow the same
   * order: without a shared lock, an earlier request can publish after a later
   * one and leave `browser`/`egress` enforcing a list the API no longer has -
   * removed destinations stay reachable and new previews stay blocked. The lock
   * is a session advisory lock, so it also serializes another API process and
   * the boot publication.
   */
  private async serialized<T>(
    operation: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [PREVIEW_HOSTS_LOCK]);
      return await operation(client);
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [PREVIEW_HOSTS_LOCK])
        .catch(() => undefined);
      client.release();
    }
  }

  async set(actor: string, value: unknown): Promise<string[]> {
    const hosts = normalizePreviewHosts(value);
    return await this.serialized(async (client) => {
      await client.query(
        "INSERT INTO qa_preview_hosts(singleton,hosts,updated_at,updated_by) VALUES(true,$1::jsonb,now(),$2) ON CONFLICT(singleton) DO UPDATE SET hosts=EXCLUDED.hosts,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by",
        [JSON.stringify(hosts), actor]
      );
      applyPreviewHosts(this.config, hosts);
      await publishPreviewPolicy(this.config, hosts, actor);
      return hosts;
    });
  }

  /** Drops the dashboard list and returns to the `PREVIEW_ALLOWED_HOSTS` default. */
  async reset(actor: string): Promise<string[]> {
    const hosts = this.defaults();
    return await this.serialized(async (client) => {
      await client.query("DELETE FROM qa_preview_hosts");
      applyPreviewHosts(this.config, hosts);
      await publishPreviewPolicy(this.config, hosts, actor);
      return hosts;
    });
  }

  /**
   * Publishes the list in force at boot so the enforcement containers match.
   * A boot-time failure is logged instead of fatal: the containers keep the last
   * published policy and `doctor` reports the unwritable directory.
   */
  async publish(actor: string) {
    await this.serialized(() =>
      publishPreviewPolicy(this.config, this.config.allowedHosts, actor)
    ).catch((error) =>
      logger.warn(
        { code: "PREVIEW_POLICY_UNWRITABLE", diagnostic: diagnose(error) },
        "Preview policy could not be published at startup"
      )
    );
  }
}
