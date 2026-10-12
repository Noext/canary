import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { type Principal, requireAccess } from "./access.js";
import type { Config } from "./config.js";
import type {
  Preflight,
  PreviewSettings,
  SetupStatus,
} from "./dashboard/contracts.js";
import { QaError } from "./diagnostics.js";
import { GitHub, type PrContext, parsePrUrl } from "./github.js";
import type { GitHubSetup } from "./github-setup.js";
import { type ModelCatalog, ModelIdSchema } from "./model-catalog.js";
import { resolvePreview } from "./preview.js";
import { MAX_HOST_LENGTH, type PreviewHosts } from "./preview-hosts.js";
import type { Queue } from "./queue.js";

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
    if (req.method === "DELETE") {
      const hosts = await previewHosts.reset(user.id);
      await queue.audit(user.id, "preview.hosts.reset", undefined, { hosts });
      json(res, 200, previewSettings(config, previewHosts, hosts));
      return true;
    }
    const input = previewHostsSchema.parse(
      JSON.parse((await read(req)).toString())
    );
    const hosts = await previewHosts.set(user.id, input.hosts);
    await queue.audit(user.id, "preview.hosts.updated", undefined, { hosts });
    json(res, 200, previewSettings(config, previewHosts, hosts));
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
    if (req.method === "GET" && url.pathname === "/dashboard/automatic") {
      json(res, 200, await automaticStatus(setup, queue, user));
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

function githubMode(config: Config) {
  if (config.githubInstallations) {
    return "app";
  }
  return config.GITHUB_TOKEN || config.GITHUB_APP_ID ? "technical" : "missing";
}
