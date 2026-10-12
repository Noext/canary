import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { type Principal, requireAccess } from "./access.js";
import type { Config } from "./config.js";
import type { Preflight, SetupStatus } from "./dashboard/contracts.js";
import { QaError } from "./diagnostics.js";
import { GitHub, type PrContext, parsePrUrl } from "./github.js";
import type { GitHubSetup } from "./github-setup.js";
import { type ModelCatalog, ModelIdSchema } from "./model-catalog.js";
import { resolvePreview } from "./preview.js";
import type { Queue } from "./queue.js";

const preflightSchema = z
  .object({
    prUrl: z.string().url(),
    previewUrl: z.string().url().optional(),
    model: ModelIdSchema,
  })
  .strict();
export function dashboardRoutes(
  setup: GitHubSetup,
  config: Config,
  models: ModelCatalog,
  queue: Queue,
  read: (req: IncomingMessage) => Promise<Buffer>,
  json: (res: ServerResponse, status: number, value: unknown) => void
) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal
  ) => {
    if (req.method === "GET" && url.pathname === "/dashboard/status") {
      json(res, 200, await setupStatus(setup, config, user));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/dashboard/automatic") {
      json(res, 200, await automaticStatus(setup, queue, user));
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
  return config.automaticRepos ?? config.allowedRepos;
}

function scopedRepos(user: Principal, repos: string[]) {
  return user.repos.filter((repo) => repos.includes(repo.toLowerCase()));
}

async function setupStatus(
  setup: GitHubSetup,
  config: Config,
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
    preview: {
      automatic: Boolean(config.PREVIEW_URL_TEMPLATE),
      ...(user.role === "admin"
        ? {
            hosts: config.allowedHosts,
            shaHeader: config.PREVIEW_SHA_HEADER,
            shaPath: config.PREVIEW_SHA_PATH,
          }
        : {}),
    },
  } satisfies SetupStatus;
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
