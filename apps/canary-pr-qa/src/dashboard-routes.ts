import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { type Principal, requireAccess } from "./access.js";
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
/**
 * Delivery ids are opaque webhook identifiers. The bound is what the caller may
 * put in a path segment; it is not a claim about their shape, so an id the
 * server never issued simply matches nothing.
 */
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
export function dashboardRoutes(
  setup: GitHubSetup,
  config: Config,
  models: ModelCatalog,
  queue: Queue,
  previewHosts: PreviewHosts,
  read: (req: IncomingMessage) => Promise<Buffer>,
  json: (res: ServerResponse, status: number, value: unknown) => void
) {
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
    if (req.method !== "GET") {
      return false;
    }
    if (url.pathname === "/dashboard/automatic") {
      json(res, 200, await automaticStatus(setup, queue, user));
      return true;
    }
    const prefix = "/dashboard/automatic/";
    if (!url.pathname.startsWith(prefix)) {
      return false;
    }
    json(
      res,
      200,
      await automaticDetail(
        config,
        queue,
        user,
        url.pathname.slice(prefix.length)
      )
    );
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
  const row = DELIVERY_ID.test(id)
    ? await queue.delivery(id, config.QA_AUTO_PREVIEW_WAIT_SECONDS)
    : undefined;
  const repo = row?.payload.repo;
  if (!(row && repo) || row.payload.ignored) {
    throw new QaError(
      "AUTOMATIC_UNKNOWN",
      "Cette tentative automatique est introuvable.",
      "Elle a peut-être été purgée. Rouvrez l’accueil pour voir les tentatives en cours."
    );
  }
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

function githubMode(config: Config) {
  if (config.githubInstallations) {
    return "app";
  }
  return config.GITHUB_TOKEN || config.GITHUB_APP_ID ? "technical" : "missing";
}
