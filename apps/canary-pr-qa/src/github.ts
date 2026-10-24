import { posix } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { githubToken } from "./github-app.js";
import { fetchText } from "./http.js";

export function parsePrUrl(input: string) {
  const url = new URL(input);
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (url.origin !== "https://github.com" || url.search || url.hash || !match) {
    throw new Error("Expected https://github.com/owner/repo/pull/number");
  }
  const repo = `${match[1]}/${match[2]}`;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error("Invalid repository name");
  }
  if (!Number.isSafeInteger(Number(match[3]))) {
    throw new Error("Invalid PR number");
  }
  return {
    repo,
    number: Number(match[3]),
    url: `https://github.com/${repo}/pull/${match[3]}`,
  };
}
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const prSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  changed_files: z.number().int(),
  head: z.object({ sha, repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ sha, repo: z.object({ full_name: z.string() }) }),
});
const fileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  // Les trois compteurs que l'API rend et que le tri de `changedFileTexts` lit :
  // sans eux, toutes les comparaisons valaient zéro et l'ordre restait celui de
  // l'API, quel que soit le fichier le plus modifié.
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  changes: z.number().int().optional(),
  patch: z.string().optional(),
  previous_filename: z.string().optional(),
});
/**
 * Avertissements de contexte qui disent qu'un fichier du dépôt n'a été lu
 * qu'en partie : contenu coupé au plafond de caractères par fichier, contenu
 * indisponible, ou plafonds de collecte épuisés avant sa lecture. Ils sont
 * nommés ici, une seule fois, parce qu'ils ne servent pas qu'au journal : les
 * lecteurs qui en dépendent les interprètent (voir `completeSource`, runner.ts).
 */
export const DEPENDENCY_CONTEXT_LIMIT_WARNING =
  "Dependency context limit (256) exhausted";
export const CONTEXT_BUDGET_EXHAUSTED_WARNING =
  "Repository context budget exhausted";
export function truncatedContextWarning(path: string, ref: string): string {
  return `Truncated context: ${path} at ${ref}`;
}
export function unavailableContextWarning(path: string, ref: string): string {
  return `Unavailable context: ${path} at ${ref}`;
}
export interface PrContext {
  baseSha: string;
  body: string;
  context: { path: string; ref: string; content: string }[];
  contextWarnings: string[];
  files: z.infer<typeof fileSchema>[];
  headRepo: string;
  ref: ReturnType<typeof parsePrUrl>;
  sha: string;
  title: string;
}

export class GitHub {
  private readonly config: Config;
  constructor(config: Config) {
    this.config = config;
  }

  async request(
    path: string,
    method = "GET",
    body?: unknown
  ): Promise<unknown> {
    const repo = /^\/repos\/([^/]+\/[^/]+)/.exec(path)?.[1];
    const publicRead =
      repo &&
      this.config.githubInstallations &&
      !this.config.githubInstallations[repo.toLowerCase()];
    if (publicRead && method !== "GET") {
      throw new Error(
        "GitHub repository is not connected; uninstalled repositories permit only anonymous public reads"
      );
    }
    const token = publicRead ? "" : await githubToken(this.config, repo);
    const result = await fetchText(
      `${this.config.GITHUB_API_URL.replace(/\/$/, "")}${path}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }
    );
    return JSON.parse(result.text);
  }

  async optionalFile(
    repo: string,
    path: string,
    ref: string
  ): Promise<string | undefined> {
    try {
      const content = z
        .object({ encoding: z.literal("base64"), content: z.string() })
        .parse(
          await this.request(
            `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`
          )
        );
      return Buffer.from(content.content, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof Error && /HTTP 404/.test(error.message)) {
        return;
      }
      throw error;
    }
  }

  async pr(input: string) {
    const ref = parsePrUrl(input);
    if (
      (this.config.githubInstallations || this.config.allowedRepos.length) &&
      !this.config.allowedRepos.includes(ref.repo.toLowerCase())
    ) {
      throw new Error("Repository is not in GITHUB_ALLOWED_REPOS");
    }
    const data = prSchema.parse(
      await this.request(`/repos/${ref.repo}/pulls/${ref.number}`)
    );
    if (!data.head.repo) {
      throw new Error("PR head repository is unavailable");
    }
    return { ref, data };
  }

  async context(input: string): Promise<PrContext> {
    const { ref, data } = await this.pr(input);
    if (data.state !== "open") {
      throw new Error("Only open PRs can be tested");
    }
    if (data.changed_files > 1000) {
      throw new Error(
        "PR exceeds the supported 1000-file analysis limit; refusing incomplete analysis"
      );
    }
    const files: z.infer<typeof fileSchema>[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = z
        .array(fileSchema)
        .parse(
          await this.request(
            `/repos/${ref.repo}/pulls/${ref.number}/files?per_page=100&page=${page}`
          )
        );
      files.push(...batch);
      if (batch.length < 100) {
        break;
      }
    }
    if (files.length !== data.changed_files) {
      throw new Error(
        "PR changed while reading files, or GitHub returned an incomplete diff"
      );
    }
    const headRepo = data.head.repo?.full_name ?? ref.repo;
    // Read only immutable refs. Include both versions of relevant files and repo conventions.
    const candidates = [
      ...files
        .filter((file) =>
          /\.(tsx?|jsx?|html|css|md|json|go|rs|py|vue|svelte)$/.test(
            file.filename
          )
        )
        .flatMap((file) => [
          { repo: headRepo, path: file.filename, ref: data.head.sha },
          {
            repo: ref.repo,
            path: file.previous_filename ?? file.filename,
            ref: data.base.sha,
          },
        ]),
      ...["README.md", "package.json", "AGENTS.md"].map((path) => ({
        repo: ref.repo,
        path,
        ref: data.base.sha,
      })),
    ];
    const { context, contextWarnings } = await this.collectContext(
      candidates,
      files
    );
    for (const file of files) {
      if (!file.patch) {
        contextWarnings.push(`No textual patch for ${file.filename}`);
      }
    }
    const current = await this.pr(input);
    if (
      current.data.head.sha !== data.head.sha ||
      current.data.base.sha !== data.base.sha
    ) {
      throw new Error("PR changed during context collection; run again");
    }
    return {
      ref,
      sha: data.head.sha,
      baseSha: data.base.sha,
      headRepo,
      title: data.title,
      body: data.body ?? "",
      files,
      context,
      contextWarnings,
    };
  }

  private async collectContext(
    candidates: { repo: string; path: string; ref: string }[],
    files: PrContext["files"]
  ) {
    const context: PrContext["context"] = [];
    const contextWarnings: string[] = [];
    let remaining = this.config.QA_CONTEXT_CHARS;
    const visited = new Set<string>();
    for (const candidate of candidates) {
      const key = `${candidate.repo}:${candidate.ref}:${candidate.path}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      if (visited.size > 256) {
        contextWarnings.push(DEPENDENCY_CONTEXT_LIMIT_WARNING);
        break;
      }
      if (remaining <= 0) {
        contextWarnings.push(CONTEXT_BUDGET_EXHAUSTED_WARNING);
        break;
      }
      try {
        const content = z
          .object({ encoding: z.literal("base64"), content: z.string() })
          .parse(
            await this.request(
              `/repos/${candidate.repo}/contents/${candidate.path.split("/").map(encodeURIComponent).join("/")}?ref=${candidate.ref}`
            )
          );
        const decoded = Buffer.from(content.content, "base64").toString("utf8");
        const selected = decoded.slice(0, Math.min(remaining, 16_000));
        if (selected.length < decoded.length) {
          contextWarnings.push(
            truncatedContextWarning(candidate.path, candidate.ref)
          );
        }
        context.push({
          path: candidate.path,
          ref: candidate.ref,
          content: selected,
        });
        remaining -= selected.length;
        // One-hop imports and adjacent tests connect changed routes/components to their implementation.
        if (files.some((f) => f.filename === candidate.path)) {
          for (const imported of dependencyPaths(candidate.path, selected)) {
            candidates.push({ ...candidate, path: imported });
          }
        }
      } catch {
        contextWarnings.push(
          unavailableContextWarning(candidate.path, candidate.ref)
        );
      }
    }
    return { context, contextWarnings };
  }

  async deployments(
    context: PrContext
  ): Promise<{ url: string; sha: string; evidence: string } | undefined> {
    for (const repo of new Set([context.ref.repo, context.headRepo])) {
      for (let page = 1; page <= 5; page++) {
        const deployments = z
          .array(
            z.object({
              id: z.number(),
              sha: z.string(),
              environment: z.string(),
            })
          )
          .parse(
            await this.request(
              `/repos/${repo}/deployments?sha=${context.sha}&per_page=100&page=${page}`
            )
          );
        for (const deployment of deployments) {
          if (
            deployment.sha !== context.sha ||
            deployment.environment !== this.config.PREVIEW_ENVIRONMENT
          ) {
            continue;
          }
          const statuses = z
            .array(
              z.object({
                state: z.string(),
                environment_url: z.string().optional(),
              })
            )
            .parse(
              await this.request(
                `/repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`
              )
            );
          const latest = statuses[0];
          if (latest?.state === "success" && latest.environment_url) {
            return {
              url: latest.environment_url,
              sha: context.sha,
              evidence: `GitHub deployment ${repo}#${deployment.id} (${deployment.environment})`,
            };
          }
        }
        if (deployments.length < 100) {
          break;
        }
      }
    }
    return;
  }

  async status(
    context: PrContext,
    state: "pending" | "success" | "failure" | "error",
    description: string,
    targetUrl?: string
  ) {
    if (this.config.GITHUB_APP_ID) {
      const existing = z
        .object({
          check_runs: z.array(
            z.object({ id: z.number(), app: z.object({ id: z.number() }) })
          ),
        })
        .parse(
          await this.request(
            `/repos/${context.ref.repo}/commits/${context.sha}/check-runs?check_name=canary%2Fpr-qa&filter=latest`
          )
        )
        .check_runs.find((c) => String(c.app.id) === this.config.GITHUB_APP_ID);
      await this.request(
        `/repos/${context.ref.repo}/check-runs${existing ? `/${existing.id}` : ""}`,
        existing ? "PATCH" : "POST",
        {
          name: "canary/pr-qa",
          head_sha: context.sha,
          status: state === "pending" ? "in_progress" : "completed",
          ...(state === "pending"
            ? {}
            : {
                conclusion: checkConclusion(state),
                completed_at: new Date().toISOString(),
              }),
          output: { title: description.slice(0, 140), summary: description },
          ...(targetUrl ? { details_url: targetUrl } : {}),
        }
      );
    }
    await this.request(
      `/repos/${context.ref.repo}/statuses/${context.sha}`,
      "POST",
      {
        state,
        context: "canary/pr-qa",
        description: description.slice(0, 140),
        ...(targetUrl ? { target_url: targetUrl } : {}),
      }
    );
  }

  private async findBotComment(context: PrContext, marker: string) {
    const schema = z.array(
      z.object({
        id: z.number(),
        body: z.string(),
        user: z.object({ type: z.string() }).optional(),
      })
    );
    for (let page = 1; page <= 100; page++) {
      const comments = schema.parse(
        await this.request(
          `/repos/${context.ref.repo}/issues/${context.ref.number}/comments?per_page=100&page=${page}`
        )
      );
      const existing = comments.find(
        (c) => c.body.startsWith(marker) && c.user?.type === "Bot"
      );
      if (existing) {
        return existing;
      }
      if (comments.length < 100) {
        return;
      }
    }
    throw new Error(
      "Comment history exceeds 100 pages; refusing to create a duplicate report"
    );
  }
  async comment(context: PrContext, body: string): Promise<string> {
    const marker = "<!-- canary-pr-qa -->";
    const existing = await this.findBotComment(context, marker);
    const result = z
      .object({ html_url: z.string().url() })
      .parse(
        await this.request(
          existing
            ? `/repos/${context.ref.repo}/issues/comments/${existing.id}`
            : `/repos/${context.ref.repo}/issues/${context.ref.number}/comments`,
          existing ? "PATCH" : "POST",
          { body: `${marker}\n${body}` }
        )
      );
    return result.html_url;
  }
}

function checkConclusion(state: "success" | "failure" | "error" | "pending") {
  if (state === "success") {
    return "success";
  }
  if (state === "failure") {
    return "failure";
  }
  return "action_required";
}

function dependencyPaths(path: string, source: string) {
  const paths = new Set<string>();
  for (const match of source.matchAll(
    /(?:from\s*|require\s*\(\s*)["'](\.[^"']+)["']/g
  )) {
    const imported = posix.normalize(
      posix.join(posix.dirname(path), match[1] ?? "")
    );
    if (imported.startsWith("..")) {
      continue;
    }
    for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      paths.add(imported + suffix);
    }
  }
  const stem = path.replace(/\.(tsx?|jsx?)$/, "");
  for (const suffix of [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"]) {
    paths.add(stem + suffix);
  }
  return [...paths];
}
