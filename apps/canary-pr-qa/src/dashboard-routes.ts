import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { type Principal, requireAccess } from "./access.js";
import type { ApiKeys } from "./api-keys.js";
import type { Config } from "./config.js";
import type {
  AutomaticDetail,
  Preflight,
  PreviewSettings,
  SetupStatus,
} from "./dashboard/contracts.js";
import { QaError } from "./diagnostics.js";
import { GitHub, type PrContext, parsePrUrl } from "./github.js";
import type { GitHubSetup } from "./github-setup.js";
import { type ModelCatalog, ModelIdSchema } from "./model-catalog.js";
import { resolvePreview } from "./preview.js";
import {
  MAX_HOST_LENGTH,
  type PreviewHosts,
  PreviewPolicyUnpublishedError,
} from "./preview-hosts.js";
import type { Queue } from "./queue.js";
import { automaticAttempt } from "./queue.js";

const preflightSchema = z
  .object({
    prUrl: z.string().url(),
    previewUrl: z.string().url().optional(),
    model: ModelIdSchema,
  })
  .strict();
const previewHostsSchema = z
  .object({
    // Request-level cap only: `normalizePreviewHosts` deduplicates and enforces
    // the stored limit with a message the dashboard can show.
    hosts: z.array(z.string().max(MAX_HOST_LENGTH)).max(400),
  })
  .strict();
const apiKeyNameSchema = z.object({ name: z.string().min(1).max(60) }).strict();
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
   * Administrator-only key management. A key is a read-only viewer for agents,
   * so the list and the copy action are the administrator's only way to see what
   * an agent was granted.
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
        json(res, 200, await keys.list());
        return true;
      }
      if (req.method === "POST") {
        json(
          res,
          201,
          await keys.create(user, apiKeyName(await read(req)), [
            ...new Set(await effectiveRepos()),
          ])
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

/** A name the dashboard can show; a refused body is a request error, not a 500. */
function apiKeyName(body: Buffer) {
  const parsed = apiKeyNameSchema.safeParse(
    JSON.parse(body.toString()) as unknown
  );
  if (!parsed.success) {
    throw new QaError(
      "API_KEY_NAME",
      "Le nom de la clé doit contenir 1 à 60 caractères.",
      "Donnez un nom court qui rappelle l’usage de la clé."
    );
  }
  return parsed.data.name;
}
/**
 * Delivery ids are opaque webhook identifiers. The bound is what the caller may
 * put in a path segment; it is not a claim about their shape, so an id the
 * server never issued simply matches nothing.
 */
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** Path suffix that re-arms an attempt instead of reading it. */
const RETRY_SUFFIX = "/retry";
export function dashboardRoutes(
  setup: GitHubSetup,
  config: Config,
  models: ModelCatalog,
  queue: Queue,
  previewHosts: PreviewHosts,
  read: (req: IncomingMessage) => Promise<Buffer>,
  json: (res: ServerResponse, status: number, value: unknown) => void,
  keys: ApiKeys
) {
  const apiKeyRoute = apiKeysRoute(keys, read, json, async () =>
    (await setup.effective()).allowedRepos.map((repo) => repo.toLowerCase())
  );
  /**
   * Administrator-only host list editor. The stored list becomes the list in
   * force for this process and is published for the browser and egress services.
   */
  async function previewHostRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal
  ) {
    if (
      url.pathname !== "/dashboard/preview-hosts" ||
      !["DELETE", "PUT"].includes(req.method ?? "")
    ) {
      return false;
    }
    if (user.role !== "admin") {
      json(res, 403, { error: "Administrator required" });
      return true;
    }
    const action =
      req.method === "DELETE" ? "preview.hosts.reset" : "preview.hosts.updated";
    try {
      const hosts =
        req.method === "DELETE"
          ? await previewHosts.reset(user.id)
          : await previewHosts.set(
              user.id,
              previewHostsSchema.parse(JSON.parse((await read(req)).toString()))
                .hosts
            );
      await queue.audit(user.id, action, undefined, { hosts, published: true });
      json(res, 200, previewSettings(config, previewHosts, hosts));
    } catch (error) {
      if (error instanceof PreviewPolicyUnpublishedError) {
        // The row and the API configuration already changed, so the edit is
        // audited even though the request fails: a policy-volume incident must
        // not leave an allowlist change with no trace. A failed audit must not
        // replace the diagnostic that tells the operator what to fix.
        await queue
          .audit(user.id, action, undefined, {
            hosts: error.hosts,
            published: false,
          })
          .catch(() => undefined);
      }
      throw error;
    }
    return true;
  }
  /**
   * The automatic-run probes, split out of the main handler so its branch count
   * stays readable. The list and one attempt answer the same shape of request;
   * only their scope check differs.
   */
  async function automaticRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal
  ) {
    if (url.pathname === "/dashboard/automatic") {
      if (req.method !== "GET") {
        return false;
      }
      json(res, 200, await automaticStatus(setup, queue, user));
      return true;
    }
    const prefix = "/dashboard/automatic/";
    if (!url.pathname.startsWith(prefix)) {
      return false;
    }
    const rest = url.pathname.slice(prefix.length);
    // `:id/retry` re-arms a failed attempt. Ids are opaque and never contain a
    // slash, so the two shapes cannot be confused by a path a caller invented.
    if (req.method === "POST" && rest.endsWith(RETRY_SUFFIX)) {
      json(
        res,
        200,
        await retryAutomatic(
          setup,
          config,
          queue,
          user,
          rest.slice(0, -RETRY_SUFFIX.length)
        )
      );
      return true;
    }
    if (req.method !== "GET") {
      return false;
    }
    json(res, 200, await automaticDetail(config, queue, user, rest));
    return true;
  }
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal
  ) => {
    if (req.method === "GET" && url.pathname === "/dashboard/status") {
      json(res, 200, await setupStatus(setup, config, previewHosts, user));
      return true;
    }
    if (await automaticRoute(req, res, url, user)) {
      return true;
    }
    if (await apiKeyRoute(req, res, url, user)) {
      return true;
    }
    if (await previewHostRoute(req, res, url, user)) {
      return true;
    }
    if (req.method !== "POST" || url.pathname !== "/runs/preflight") {
      return false;
    }
    const input = preflightSchema.parse(
      JSON.parse((await read(req)).toString())
    );
    const ref = parsePrUrl(input.prUrl);
    requireAccess(user, ref.repo, true);
    const effective = await setup.effective();
    if (!effective.allowedRepos.includes(ref.repo.toLowerCase())) {
      throw new QaError(
        "GITHUB_REPOSITORY_DENIED",
        "Ce dépôt n'est pas connecté à votre espace QA.",
        "Sélectionnez-le dans les réglages GitHub."
      );
    }
    await models.require(input.model);
    const github = new GitHub(effective);
    const pr = await github.pr(input.prUrl);
    if (pr.data.state !== "open") {
      throw new QaError(
        "PR_CLOSED",
        "Cette pull request est fermée.",
        "Utilisez l'URL d'une pull request ouverte."
      );
    }
    const context: PrContext = {
      ref: pr.ref,
      sha: pr.data.head.sha,
      baseSha: pr.data.base.sha,
      headRepo: pr.data.head.repo?.full_name ?? ref.repo,
      title: pr.data.title,
      body: pr.data.body ?? "",
      files: [],
      context: [],
      contextWarnings: [],
    };
    const preview = await resolvePreview(
      context,
      github,
      effective,
      input.previewUrl
    );
    const latest = await github.pr(input.prUrl);
    if (latest.data.head.sha !== context.sha) {
      throw new QaError(
        "PR_CHANGED",
        "La pull request a changé pendant la vérification.",
        "Vérifiez à nouveau sa dernière version."
      );
    }
    const result = {
      ready: true,
      pr: {
        title: context.title,
        repo: ref.repo,
        number: ref.number,
        sha: context.sha,
      },
      preview: { url: preview.url, sha: preview.sha },
      model: input.model,
    } satisfies Preflight;
    json(res, 200, result);
    return true;
  };
}

/** Repositories where automatic runs are switched on; legacy mode allows every repository. */
function automaticRepos(config: Config) {
  // The global switch wins over every per-repository opt-in: reporting them as
  // active would tell an operator that automation is running while the probe loop
  // refuses each delivery with `auto_disabled`.
  return config.autoRuns ? (config.automaticRepos ?? config.allowedRepos) : [];
}

function scopedRepos(user: Principal, repos: string[]) {
  return user.repos.filter((repo) => repos.includes(repo.toLowerCase()));
}

async function setupStatus(
  setup: GitHubSetup,
  config: Config,
  previewHosts: PreviewHosts,
  user: Principal
) {
  const effective = await setup.effective();
  return {
    github: {
      autoRepos: scopedRepos(user, automaticRepos(effective)),
      mode: githubMode(effective),
      repositories: scopedRepos(user, effective.allowedRepos),
    },
    ai: {
      endpoint: new URL(config.OPENAI_BASE_URL).host,
      defaultModel: config.OPENAI_MODEL,
    },
    preview: previewStatus(config, previewHosts, user),
  } satisfies SetupStatus;
}

/**
 * Preview settings for one principal. The host list identifies the test
 * environments of this instance, so it is only reported to an administrator.
 */
function previewStatus(
  config: Config,
  previewHosts: PreviewHosts,
  user: Principal
): SetupStatus["preview"] {
  return {
    automatic: Boolean(config.PREVIEW_URL_TEMPLATE),
    ...(user.role === "admin"
      ? previewSettings(config, previewHosts, config.allowedHosts)
      : {}),
  };
}

function previewSettings(
  config: Config,
  previewHosts: PreviewHosts,
  hosts: string[]
): PreviewSettings {
  return {
    hosts,
    hostsDefault: previewHosts.defaults(),
    shaHeader: config.PREVIEW_SHA_HEADER,
    shaPath: config.PREVIEW_SHA_PATH,
  };
}

/** Automatic attempts of the repositories the principal may read, newest first. */
async function automaticStatus(
  setup: GitHubSetup,
  queue: Queue,
  user: Principal
) {
  const effective = await setup.effective();
  const enabledRepos = scopedRepos(user, automaticRepos(effective));
  for (const repo of enabledRepos) {
    requireAccess(user, repo);
  }
  const { attempts, summary } = await queue.automatic(
    enabledRepos,
    effective.QA_AUTO_PREVIEW_WAIT_SECONDS
  );
  return { attempts, enabledRepos, summary };
}

/**
 * The delivery behind an attempt id. An attempt belongs to a repository, so the
 * id alone is not a capability: an unknown, malformed or parked record gets the
 * same verdict, and the caller still has to be able to read that repository.
 */
async function attemptRow(queue: Queue, id: string, deadlineSeconds: number) {
  const row = DELIVERY_ID.test(id)
    ? await queue.delivery(id, deadlineSeconds)
    : undefined;
  if (!row?.payload.repo || row.payload.ignored) {
    throw new QaError(
      "AUTOMATIC_UNKNOWN",
      "Cette tentative automatique est introuvable.",
      "Elle a peut-être été purgée. Rouvrez l’accueil pour voir les tentatives en cours."
    );
  }
  return row;
}

/**
 * One automatic attempt and the evidence of why it never produced a run: what
 * it was pinned to, how many probes it spent, and the audit trail of those
 * probes. An attempt belongs to a repository, so the id alone is not a
 * capability — the caller must already be able to read that repository.
 */
async function automaticDetail(
  config: Config,
  queue: Queue,
  user: Principal,
  id: string
): Promise<AutomaticDetail> {
  const row = await attemptRow(queue, id, config.QA_AUTO_PREVIEW_WAIT_SECONDS);
  const repo = row.payload.repo ?? "";
  requireAccess(user, repo);
  return {
    attempt: automaticAttempt(row),
    // The preview template and the version proof describe this instance’s
    // deployment topology, so they are reported to administrators only.
    ...(user.role === "admin"
      ? {
          preview: {
            shaHeader: config.PREVIEW_SHA_HEADER,
            ...(config.PREVIEW_SHA_PATH
              ? { shaPath: config.PREVIEW_SHA_PATH }
              : {}),
            ...(config.PREVIEW_URL_TEMPLATE
              ? { template: config.PREVIEW_URL_TEMPLATE }
              : {}),
          },
        }
      : {}),
    timeline: await queue.deliveryTimeline(id),
  };
}

/**
 * Re-arms a failed attempt on the same pinned SHA, from the dashboard.
 *
 * The delivery goes back to the probe loop with a fresh waiting window, so
 * Canary verifies the same preview again and can promote it into a run. Only the
 * two failures that stopped without a run can be re-armed: a promoted attempt
 * has its run, a discarded one would be discarded again on the same facts, and a
 * refused one is a server-side switch rather than a missed probe. The retry is a
 * write, so a viewer is refused here and not only in the UI.
 *
 * An attempt that is no longer re-armable is not an error: it is a state of its
 * own, and the screen renders every one of them. That is what a second operator
 * sees when the first retry already had its probe — the answer is the attempt as
 * it stands, promoted run included, never a "nothing to relaunch" that would
 * hide the run the retry produced.
 */
async function retryAutomatic(
  setup: GitHubSetup,
  config: Config,
  queue: Queue,
  user: Principal,
  id: string
): Promise<AutomaticDetail> {
  const effective = await setup.effective();
  const row = await attemptRow(
    queue,
    id,
    effective.QA_AUTO_PREVIEW_WAIT_SECONDS
  );
  const repo = row.payload.repo ?? "";
  requireAccess(user, repo, true);
  if (!automaticRepos(effective).includes(repo.toLowerCase())) {
    throw new QaError(
      "AUTOMATIC_DISABLED",
      "Les lancements automatiques sont désactivés pour ce dépôt : rien ne serait vérifié.",
      "Réactivez ce dépôt dans Réglages → GitHub, ou lancez le test depuis « Nouveau test »."
    );
  }
  const updated = await queue.retryDelivery(
    id,
    effective.QA_AUTO_PREVIEW_WAIT_SECONDS
  );
  if (updated) {
    // The audit trail is what the detail screen renders: the operator who
    // re-armed the attempt, and the window it was given, belong in it.
    await queue.audit(user.id, "automatic.retried", undefined, {
      attempts: row.attempts,
      delivery: id,
      pr: updated.payload.number ?? 0,
      repo,
      sha: updated.payload.sha ?? "",
    });
  }
  return automaticDetail(config, queue, user, id);
}

function githubMode(config: Config) {
  if (config.githubInstallations) {
    return "app";
  }
  return config.GITHUB_TOKEN || config.GITHUB_APP_ID ? "technical" : "missing";
}
