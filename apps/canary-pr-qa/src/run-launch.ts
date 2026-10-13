import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { z } from "zod";
import { mayLaunch, type Principal, requireAccess } from "./access.js";
import { type Config, validatePreviewUrl } from "./config.js";
import { QaError } from "./diagnostics.js";
import { GitHub, parsePrUrl } from "./github.js";
import {
  type ModelCatalog,
  ModelIdSchema,
  runModelConfig,
} from "./model-catalog.js";
import type { Job, Queue } from "./queue.js";

/**
 * What a caller may ask for when starting a run. One schema for the HTTP
 * endpoint and the MCP tool: an agent and the dashboard submit the same
 * contract, so a field cannot exist on one surface only.
 */
export const runInputSchema = z
  .object({
    prUrl: z.string().url(),
    previewUrl: z.string().url().optional(),
    publish: z.boolean().default(true),
    model: ModelIdSchema.optional(),
  })
  .strict();
export type RunInput = z.infer<typeof runInputSchema>;

/** Fewer than this free is refused before a run fills the volume with evidence. */
const MIN_FREE_BYTES = 500_000_000;

/**
 * The answer both surfaces give for an accepted run. The job is queued, not
 * started: the caller follows `statusUrl`, and only a finished run has a report.
 */
export function accepted(job: Job) {
  return {
    id: job.id,
    reportUrl: `/artifacts/${job.id}/report.html`,
    statusUrl: `/runs/${job.id}`,
  };
}

/**
 * A pull-request URL is typed by a caller, so a malformed one is a request error
 * and not a fault of this server. It carries a code of its own so the MCP tool
 * can answer a readable refusal instead of a protocol error, and the HTTP
 * endpoint keeps the message it already returned.
 */
function pullRequest(prUrl: string) {
  try {
    return parsePrUrl(prUrl);
  } catch (error) {
    throw new QaError(
      "PR_URL",
      error instanceof Error ? error.message : "Invalid pull request URL",
      "Expected https://github.com/owner/repo/pull/123"
    );
  }
}
/** The same rule for a preview URL the caller supplied. */
function previewUrl(previewUrl: string, config: Config) {
  try {
    return validatePreviewUrl(previewUrl, config);
  } catch (error) {
    if (error instanceof QaError) {
      throw error;
    }
    throw new QaError(
      "PREVIEW_URL",
      error instanceof Error ? error.message : "Invalid preview URL",
      "Expected an http(s) URL without credentials, on a host the preview policy allows."
    );
  }
}

export interface RunLauncherDeps {
  config: Config;
  /** The GitHub configuration in force, which the dashboard may change at any time. */
  effective: () => Promise<Config>;
  models: ModelCatalog;
  queue: Queue;
}

/**
 * The one way a run is created, shared by `POST /runs` and the MCP `launch_run`
 * tool. Both surfaces must apply the same gates — connected GitHub, repository
 * in scope, model in the catalog, preview host allowed, disk available — or an
 * agent would hold a capability the dashboard does not grant.
 */
export class RunLauncher {
  private readonly config: Config;
  private readonly effective: () => Promise<Config>;
  private readonly models: ModelCatalog;
  private readonly queue: Queue;
  constructor(deps: RunLauncherDeps) {
    this.config = deps.config;
    this.effective = deps.effective;
    this.models = deps.models;
    this.queue = deps.queue;
  }
  /**
   * Create the run and answer its job. `idempotencyKey` is the caller's own
   * retry token: the same key over the same head SHA re-answers the run that
   * already exists instead of paying for a second one.
   */
  async launch(
    user: Principal,
    input: RunInput,
    idempotencyKey?: string
  ): Promise<Job> {
    const effective = await this.effective();
    const github = new GitHub(effective);
    if (
      !(
        (effective.GITHUB_TOKEN || effective.GITHUB_APP_ID) &&
        effective.allowedRepos.length
      )
    ) {
      throw new QaError(
        "GITHUB_NOT_CONNECTED",
        "Connectez GitHub et sélectionnez au moins un dépôt avant de lancer une QA.",
        "Utilisez la section GitHub du dashboard administrateur."
      );
    }
    const ref = pullRequest(input.prUrl);
    // Reading the scope first keeps "not your repository" distinct from "your
    // key may not act", and the capability is what an agent key was issued for.
    requireAccess(user, ref.repo);
    if (!mayLaunch(user)) {
      throw new QaError(
        "LAUNCH_DENIED",
        "Ce compte ne peut pas lancer de test.",
        "Un compte ou une clé API de portée « opérateur » peut lancer un test."
      );
    }
    const selected = runModelConfig(this.config, input.model).OPENAI_MODEL;
    await this.models.require(selected);
    if (!effective.allowedRepos.includes(ref.repo.toLowerCase())) {
      throw new QaError(
        "REPO_NOT_ALLOWED",
        "Repository not allowed",
        "Sélectionnez ce dépôt dans la section GitHub du dashboard, ou visez un dépôt déjà connecté."
      );
    }
    if (input.previewUrl) {
      previewUrl(input.previewUrl, this.config);
    }
    const disk = await statfs(this.config.QA_DATA_DIR);
    if (disk.bavail * disk.bsize < MIN_FREE_BYTES) {
      throw new QaError(
        "STORAGE_LOW",
        "Storage low: fewer than 500 MB available",
        "Libérez de l’espace disque ou ajustez la rétention avant de relancer."
      );
    }
    // The SHA is read from GitHub, never from the caller: a run is bound to the
    // commit the pull request actually has, not to the one an agent claimed.
    const pr = await github.pr(input.prUrl);
    const key = idempotencyKey
      ? `${user.id}:${ref.repo}:${ref.number}:${pr.data.head.sha}:${idempotencyKey}`
      : randomUUID();
    return this.queue.enqueue(
      ref.repo,
      ref.number,
      pr.data.head.sha,
      user.id,
      { ...input, model: selected },
      key
    );
  }
}
