import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { type Principal, requireAccess } from "./access.js";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import { GitHub, type PrContext, parsePrUrl } from "./github.js";
import type { GitHubSetup } from "./github-setup.js";
import { type ModelCatalog, ModelIdSchema } from "./model-catalog.js";
import { resolvePreview } from "./preview.js";

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
      const effective = await setup.effective();
      json(res, 200, {
        github: {
          mode: githubMode(effective),
          repositories: user.repos,
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
      });
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
    json(res, 200, {
      ready: true,
      pr: {
        title: context.title,
        repo: ref.repo,
        number: ref.number,
        sha: context.sha,
      },
      preview: { url: preview.url, sha: preview.sha },
      model: input.model,
    });
    return true;
  };
}

function githubMode(config: Config) {
  if (config.githubInstallations) {
    return "app";
  }
  return config.GITHUB_TOKEN || config.GITHUB_APP_ID ? "technical" : "missing";
}
