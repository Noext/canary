import { z } from "zod";
import type { Config } from "./config.js";
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
  patch: z.string().optional(),
  previous_filename: z.string().optional(),
});
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
    const result = await fetchText(
      `${this.config.GITHUB_API_URL.replace(/\/$/, "")}${path}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(this.config.GITHUB_TOKEN
            ? { Authorization: `Bearer ${this.config.GITHUB_TOKEN}` }
            : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }
    );
    return JSON.parse(result.text);
  }

  async pr(input: string) {
    const ref = parsePrUrl(input);
    if (
      this.config.allowedRepos.length &&
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
    const context: PrContext["context"] = [];
    const contextWarnings: string[] = [];
    let remaining = this.config.QA_CONTEXT_CHARS;
    const headRepo = data.head.repo?.full_name ?? ref.repo;
    // Read only immutable refs. Include both versions of relevant files and repo conventions.
    const candidates = [
      ...files
        .filter((file) =>
          /\.(tsx?|jsx?|html|css|md|json|go|rs|py|vue|svelte)$/.test(
            file.filename
          )
        )
        .slice(0, 12)
        .flatMap((file) => [
          { repo: headRepo, path: file.filename, ref: data.head.sha },
          {
            repo: ref.repo,
            path: file.previous_filename ?? file.filename,
            ref: data.base.sha,
          },
        ]),
      ...["README.md", "package.json", "AGENTS.md"].map((path) => ({
        repo: headRepo,
        path,
        ref: data.head.sha,
      })),
    ];
    for (const candidate of candidates) {
      if (remaining <= 0) {
        contextWarnings.push("Repository context budget exhausted");
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
            `Truncated context: ${candidate.path} at ${candidate.ref}`
          );
        }
        context.push({
          path: candidate.path,
          ref: candidate.ref,
          content: selected,
        });
        remaining -= selected.length;
      } catch {
        contextWarnings.push(
          `Unavailable context: ${candidate.path} at ${candidate.ref}`
        );
      }
    }
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

  async comment(context: PrContext, body: string): Promise<string> {
    const result = z
      .object({ html_url: z.string().url() })
      .parse(
        await this.request(
          `/repos/${context.ref.repo}/issues/${context.ref.number}/comments`,
          "POST",
          { body }
        )
      );
    return result.html_url;
  }
}
