import { randomUUID } from "node:crypto";
import { mkdir, readFile, statfs } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { createLogger } from "@usecanary/logger";
import { z } from "zod";
import {
  type Principal,
  principal,
  requireAccess,
  sessionCookie,
  signedArtifact,
  validArtifactSignature,
} from "./access.js";
import { ApiKeys } from "./api-keys.js";
import { authRoutes } from "./auth-routes.js";
import {
  type Config,
  validateConfiguration,
  validatePreviewUrl,
} from "./config.js";
import { dashboard, dashboardAssets } from "./dashboard.js";
import { dashboardRoutes } from "./dashboard-routes.js";
import { diagnose, QaError } from "./diagnostics.js";
import { GitHub, parsePrUrl } from "./github.js";
import { verifyWebhook } from "./github-app.js";
import { GitHubSetup } from "./github-setup.js";
import { githubSetupRoutes } from "./github-setup-routes.js";
import { importLegacy } from "./legacy.js";
import { LocalAuth, localCookie } from "./local-auth.js";
import { mcpRoutes } from "./mcp.js";
import {
  ModelCatalog,
  ModelIdSchema,
  runModelConfig,
} from "./model-catalog.js";
import { PreviewHosts } from "./preview-hosts.js";
import { type Job, Queue } from "./queue.js";
import { purgeRun } from "./retention.js";
import { canonicalArtifactPath, serveArtifact } from "./server.js";
import {
  durableCost,
  durableRuns,
  durableTokens,
  metrics,
} from "./telemetry.js";

const logger = createLogger({ name: "qa-api" });
const inputSchema = z
  .object({
    prUrl: z.string().url(),
    previewUrl: z.string().url().optional(),
    publish: z.boolean().default(true),
    model: ModelIdSchema.optional(),
  })
  .strict();
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function rawBody(req: IncomingMessage, max = 16_384) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) {
      throw new Error("Request too large");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function startProductionServer(config: Config) {
  validateConfiguration(config, true);
  await mkdir(config.QA_DATA_DIR, { recursive: true });
  const queue = new Queue(config.DATABASE_URL);
  await queue.migrate();
  await importLegacy(queue, config);
  // The dashboard-managed host list replaces the environment default for this
  // process and is republished so the browser and egress containers enforce it.
  const previewHosts = new PreviewHosts(queue.pool, config);
  await previewHosts.load();
  await previewHosts.publish("server");
  const accounts = new LocalAuth(queue.pool);
  const keys = new ApiKeys(queue.pool, config);
  const setup = new GitHubSetup(queue.pool, config);
  const setupRoute = githubSetupRoutes(setup, queue, rawBody, json);
  async function identify(req: IncomingMessage) {
    return principal(req, await setup.effective(), accounts, keys);
  }
  const models = new ModelCatalog(config);
  const dashboardRoute = dashboardRoutes(
    setup,
    config,
    models,
    queue,
    previewHosts,
    rawBody,
    json,
    keys
  );
  const mcpRoute = mcpRoutes(queue, config, rawBody, json);
  const streams = new Set<ServerResponse>();
  const attempts = new Map<string, { count: number; until: number }>();
  let stopping = false;
  async function authorizeJob(
    user: Principal,
    id: string,
    write = false
  ): Promise<Job> {
    const job = await queue.get(id);
    if (!job) {
      throw runNotFound();
    }
    requireAccess(user, job.repo, write);
    return job;
  }
  async function status(job: Job) {
    const progress = await readFile(
      join(config.QA_DATA_DIR, job.id, "progress.json"),
      "utf8"
    )
      .then(JSON.parse)
      .catch(() => undefined);
    return { ...job, progress };
  }
  async function enqueue(
    req: IncomingMessage,
    res: ServerResponse,
    user: Principal
  ) {
    const effective = await setup.effective();
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
    const input = inputSchema.parse(
      JSON.parse((await rawBody(req)).toString())
    );
    const ref = parsePrUrl(input.prUrl);
    requireAccess(user, ref.repo, true);
    const selected = runModelConfig(config, input.model).OPENAI_MODEL;
    await models.require(selected);
    if (!effective.allowedRepos.includes(ref.repo.toLowerCase())) {
      throw new Error("Repository not allowed");
    }
    if (input.previewUrl) {
      validatePreviewUrl(input.previewUrl, config);
    }
    const disk = await statfs(config.QA_DATA_DIR);
    if (disk.bavail * disk.bsize < 500_000_000) {
      throw new Error("Storage low: fewer than 500 MB available");
    }
    const pr = await github.pr(input.prUrl);
    const supplied = req.headers["idempotency-key"];
    if (supplied && (typeof supplied !== "string" || supplied.length > 150)) {
      throw new Error("Invalid idempotency key");
    }
    const key = supplied
      ? `${user.id}:${ref.repo}:${ref.number}:${pr.data.head.sha}:${supplied}`
      : randomUUID();
    const job = await queue.enqueue(
      ref.repo,
      ref.number,
      pr.data.head.sha,
      user.id,
      { ...input, model: selected },
      key
    );
    json(res, 202, {
      id: job.id,
      statusUrl: `/runs/${job.id}`,
      reportUrl: `/artifacts/${job.id}/report.html`,
    });
  }
  async function webhook(req: IncomingMessage, res: ServerResponse) {
    const effective = await setup.effective();
    const raw = await rawBody(req, 1_000_000);
    if (
      !verifyWebhook(
        raw,
        String(req.headers["x-hub-signature-256"] ?? ""),
        effective.GITHUB_WEBHOOK_SECRET
      )
    ) {
      json(res, 401, { error: "Invalid webhook signature" });
      return;
    }
    const delivery = String(req.headers["x-github-delivery"] ?? "");
    const event = String(req.headers["x-github-event"] ?? "");
    if (!/^[\w-]{1,100}$/.test(delivery)) {
      throw new Error("Invalid delivery ID");
    }
    const payload = JSON.parse(raw.toString());
    const repo = payload.repository?.full_name;
    if (
      typeof repo !== "string" ||
      !effective.allowedRepos.includes(repo.toLowerCase())
    ) {
      json(res, 200, { ignored: true });
      return;
    }
    if (!validInstallation(effective, repo, payload)) {
      json(res, 200, { ignored: true });
      return;
    }
    // Durable inbox: only validated metadata, no full webhook body retained.
    const pr = payload.pull_request;
    const record =
      automaticPr(event, payload) && pr
        ? { repo, number: pr.number, sha: pr.head?.sha, prUrl: pr.html_url }
        : { repo, ignored: true };
    if (!("ignored" in record || validPullRequest(record, repo))) {
      json(res, 400, { error: "Invalid pull request metadata" });
      return;
    }
    const saved = await queue.acceptDelivery(
      delivery,
      event,
      record,
      effective.QA_AUTO_PREVIEW_WAIT_SECONDS
    );
    json(res, 202, { accepted: true, duplicate: !saved });
  }
  async function artifact(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    id: string,
    rawPath: string,
    user?: Principal
  ) {
    const path = canonicalArtifactPath(rawPath);
    const job = await queue.get(id);
    if (!job) {
      throw runNotFound();
    }
    const signed = validArtifactSignature(id, path, url, config);
    if (!signed) {
      if (!user) {
        json(res, 401, { error: "Authentication required" });
        return;
      }
      requireAccess(user, job.repo);
    }
    if (
      config.QA_RAW_EVIDENCE !== "true" &&
      /\.(har|zip|log)$|\/results\.json$|\/report\.html$|console|network/i.test(
        path
      )
    ) {
      json(res, 403, { error: "Raw evidence disabled by data policy" });
      return;
    }
    await serveArtifact(res, config, id, path);
    if (user) {
      await queue.audit(user.id, "artifact.read", id, { path });
    }
  }
  async function streamRun(
    req: IncomingMessage,
    res: ServerResponse,
    id: string
  ) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    streams.add(res);
    let closed = false;
    let last = "";
    const publish = async () => {
      if (closed) {
        return;
      }
      const current = await identify(req);
      if (!current) {
        res.end();
        return;
      }
      const latest = await authorizeJob(current, id);
      if (!latest) {
        return;
      }
      const value = JSON.stringify(await status(latest));
      if (value === last) {
        res.write(": heartbeat\n\n");
      } else {
        last = value;
        res.write(`data: ${value}\n\n`);
      }
    };
    await publish();
    const timer = setInterval(() => {
      void publish().catch(() => res.end());
    }, 1000);
    res.on("close", () => {
      closed = true;
      clearInterval(timer);
      streams.delete(res);
    });
  }
  async function shareArtifact(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    user: Principal
  ) {
    const value = z
      .object({ path: z.string().regex(/^[\w./-]+$/) })
      .strict()
      .parse(JSON.parse((await rawBody(req)).toString()));
    value.path = canonicalArtifactPath(value.path);
    await queue.audit(user.id, "artifact.share", id, { path: value.path });
    json(res, 200, {
      url: signedArtifact(id, value.path, config),
      expiresInSeconds: 300,
    });
  }
  async function runRoute(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    user: Principal,
    id: string,
    action: string
  ) {
    const write = req.method !== "GET";
    const job = await authorizeJob(user, id, write);
    if (req.method === "GET" && action === "") {
      json(res, 200, await status(job));
      return;
    }
    if (req.method === "POST" && action === "cancel") {
      await queue.cancel(id, user.id);
      json(res, 200, { cancelRequested: true });
      return;
    }
    if (req.method === "DELETE" && action === "") {
      if (user.role !== "admin") {
        throw new Error("Administrator required for deletion");
      }
      await purgeRun(queue, config, job, user.id);
      json(res, 200, { deleted: true });
      return;
    }
    if (req.method === "GET" && action === "events") {
      await streamRun(req, res, id);
      return;
    }
    if (req.method === "POST" && action === "links") {
      await shareArtifact(req, res, id, user);
      return;
    }
    json(res, 404, { error: "Not found" });
  }
  async function publicRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ) {
    if (req.method === "GET" && url.pathname === "/health") {
      const counts = await queue.pool.query(
        "SELECT status,count(*)::int AS count FROM qa_jobs WHERE status IN ('queued','running') GROUP BY status"
      );
      json(res, 200, { ok: true, mode: "postgres", jobs: counts.rows });
      return true;
    }
    if (req.method === "GET" && dashboardAssets.has(url.pathname)) {
      const asset = dashboardAssets.get(url.pathname);
      if (!asset) {
        return false;
      }
      res.setHeader("Content-Type", asset.type);
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(asset.body);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'"
      );
      res.end(dashboard);
      return true;
    }
    if (req.method === "POST" && url.pathname === "/github/webhook") {
      await webhook(req, res);
      return true;
    }
    return false;
  }
  async function legacyLogin(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal | undefined
  ) {
    if (req.method === "POST" && url.pathname === "/session") {
      const key = req.socket.remoteAddress ?? "unknown";
      const attempt = attempts.get(key);
      if (attempt && attempt.until > Date.now() && attempt.count >= 10) {
        json(res, 429, { error: "Too many login attempts" });
        return true;
      }
      if (!user) {
        attempts.set(key, {
          count: attempt && attempt.until > Date.now() ? attempt.count + 1 : 1,
          until: Date.now() + 60_000,
        });
        json(res, 401, { error: "Invalid credentials" });
        return true;
      }
      attempts.delete(key);
      res.setHeader("Set-Cookie", sessionCookie(user, config));
      await queue.audit(user.id, "login");
      json(res, 200, user);
      return true;
    }
    return false;
  }
  async function login(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal | undefined
  ) {
    return (
      (await authRoutes(
        accounts,
        queue,
        await setup.effective(),
        rawBody,
        json
      )(req, res, url)) || (await legacyLogin(req, res, url, user))
    );
  }
  async function serveMetrics(res: ServerResponse) {
    const counts = await queue.pool.query(
      "SELECT status,COALESCE(outcome,'pending') AS outcome,count(*)::int AS count FROM qa_jobs GROUP BY status,outcome"
    );
    durableRuns.reset();
    for (const row of counts.rows) {
      durableRuns.set({ status: row.status, outcome: row.outcome }, row.count);
    }
    const usage = await queue.pool.query(
      "SELECT COALESCE(usage->>'model','unknown') AS model,COALESCE(sum((usage->>'tokens')::numeric),0)::float AS tokens,COALESCE(sum((usage->>'costUsd')::numeric),0)::float AS cost FROM qa_jobs GROUP BY usage->>'model'"
    );
    durableTokens.reset();
    durableCost.reset();
    for (const row of usage.rows) {
      durableTokens.set({ model: row.model }, row.tokens);
      durableCost.set({ model: row.model }, row.cost);
    }
    res.setHeader("Content-Type", metrics.contentType);
    res.end(await metrics.metrics());
  }
  async function modelRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal
  ) {
    if (req.method === "GET" && url.pathname === "/models") {
      if (user.role === "viewer") {
        throw new Error("Project access denied: operator required");
      }
      json(res, 200, {
        data: (await models.list()).map((id) => ({ id })),
        defaultModel: config.OPENAI_MODEL,
      });
      return true;
    }
    return false;
  }
  async function accountRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal
  ) {
    if (req.method === "GET" && url.pathname === "/me") {
      json(res, 200, user);
      return true;
    }
    if (req.method === "DELETE" && url.pathname === "/session") {
      await accounts.logout(req);
      res.setHeader("Set-Cookie", [
        localCookie("", config, req),
        "qa_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      ]);
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/metrics") {
      if (user.role !== "admin") {
        throw new Error("Administrator required");
      }
      await serveMetrics(res);
      return true;
    }
    return false;
  }
  async function userRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal
  ) {
    if (
      (await dashboardRoute(req, res, url, user)) ||
      (await setupRoute(req, res, url, user)) ||
      (await modelRoute(req, res, url, user)) ||
      (await accountRoute(req, res, url, user)) ||
      (await mcpRoute(req, res, url, user))
    ) {
      return true;
    }
    if (req.method === "GET" && url.pathname === "/runs") {
      json(
        res,
        200,
        await queue.list(
          user.repos,
          url.searchParams.get("status") ?? "",
          url.searchParams.get("search") ?? ""
        )
      );
      return true;
    }
    if (req.method === "POST" && url.pathname === "/runs") {
      await enqueue(req, res, user);
      return true;
    }
    return false;
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (stopping) {
      json(res, 503, { error: "Shutting down" });
      return;
    }
    if (await publicRoute(req, res, url)) {
      return;
    }
    // SameSite cookies plus strict Origin check prevent dashboard CSRF.
    if (
      req.method !== "GET" &&
      req.headers.origin &&
      new URL(req.headers.origin).host !== req.headers.host
    ) {
      json(res, 403, { error: "Origin rejected" });
      return;
    }
    const user = await identify(req);
    if (await login(req, res, url, user)) {
      return;
    }
    const match = /^\/artifacts\/([0-9a-f-]{36})\/(.+)$/.exec(url.pathname);
    if (req.method === "GET" && match?.[1] && match[2]) {
      await artifact(req, res, url, match[1], match[2], user);
      return;
    }
    if (!user) {
      json(res, 401, { error: "Authentication required" });
      return;
    }
    if (await userRoute(req, res, url, user)) {
      return;
    }
    const run = /^\/runs\/([0-9a-f-]{36})(?:\/(cancel|events|links))?$/.exec(
      url.pathname
    );
    if (run?.[1]) {
      await runRoute(req, res, url, user, run[1], run[2] ?? "");
      return;
    }
    json(res, 404, { error: "Not found" });
  }
  const server = createServer((req, res) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-ID", requestId);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    void handle(req, res).catch((error) => {
      const diagnostic = diagnose(error, config);
      logger.warn({ requestId, diagnostic }, "API request failed");
      if (res.headersSent) {
        res.end();
      } else {
        json(res, apiErrorStatus(diagnostic), {
          error: diagnostic.message,
          code: diagnostic.code,
          hint: diagnostic.hint,
          requestId,
        });
      }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.QA_PORT, config.QA_HOST, resolve);
  });
  return Object.assign(server, {
    async shutdown() {
      stopping = true;
      for (const stream of streams) {
        stream.end();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      await queue.close();
    },
  });
}

function apiErrorStatus(diagnostic: { code: string; message: string }) {
  if (["RUN_NOT_FOUND", "API_KEY_UNKNOWN"].includes(diagnostic.code)) {
    return 404;
  }
  if (diagnostic.code === "API_KEY_REVOKED") {
    return 409;
  }
  if (["AUTH_RATE_LIMIT", "AUTH_BUSY"].includes(diagnostic.code)) {
    return 429;
  }
  return /access denied|Administrator/i.test(diagnostic.message) ? 403 : 400;
}

/**
 * A run the caller asked for that this instance does not have. Its own code lets
 * the dashboard tell a purged run from a bad moment: only this verdict, and a
 * refusal by the access check, justify replacing a detail with a missing state.
 */
function runNotFound() {
  return new QaError(
    "RUN_NOT_FOUND",
    "Ce test n’existe pas ou a été purgé.",
    "Vérifiez l’identifiant du test dans l’historique, ou lancez un nouveau test."
  );
}

function validInstallation(
  config: Config,
  repo: string,
  payload: { installation?: { id?: number } }
) {
  return (
    !config.githubInstallations ||
    String(payload.installation?.id) ===
      config.githubInstallations[repo.toLowerCase()]
  );
}

function automaticPr(
  event: string,
  payload: { action: string; pull_request?: { draft?: boolean } }
) {
  return (
    event === "pull_request" &&
    ["opened", "reopened", "synchronize", "ready_for_review"].includes(
      payload.action
    ) &&
    payload.pull_request &&
    !payload.pull_request.draft
  );
}

function validPullRequest(
  record: { prUrl: string; number: number; sha?: string },
  repo: string
) {
  const ref = parsePrUrl(record.prUrl);
  return (
    ref.repo.toLowerCase() === repo.toLowerCase() &&
    ref.number === record.number &&
    /^[a-f0-9]{40}$/.test(record.sha ?? "")
  );
}
