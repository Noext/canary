import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { createLogger } from "@usecanary/logger";
import { z } from "zod";
import type { Config } from "./config.js";
import { parsePrUrl } from "./github.js";
import { writeJson } from "./report.js";
import { runQa } from "./runner.js";

const logger = createLogger({ name: "pr-qa-server" });
const requestSchema = z
  .object({
    prUrl: z.string().url(),
    previewUrl: z.string().url().optional(),
    publish: z.boolean().default(true),
  })
  .strict();
const ID = /^[0-9a-f-]{36}$/;
function authorized(req: IncomingMessage, config: Config) {
  const actual = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${config.QA_API_TOKEN}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) {
      throw new Error("Request body too large");
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveArtifact(
  res: ServerResponse,
  config: Config,
  id: string,
  artifactPath: string
) {
  const root = resolve(config.QA_DATA_DIR, id);
  const path = resolve(root, decodeURIComponent(artifactPath));
  if (
    relative(root, path).startsWith("..") ||
    ![
      ".html",
      ".json",
      ".md",
      ".webm",
      ".zip",
      ".har",
      ".jsonl",
      ".log",
      ".png",
    ].includes(extname(path)) ||
    path.endsWith("job.json")
  ) {
    throw new Error("Artifact path is not allowed");
  }
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error("Not a file");
  }
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".webm": "video/webm",
    ".zip": "application/zip",
  };
  res.writeHead(200, {
    "Content-Type": mime[extname(path)] ?? "text/plain; charset=utf-8",
    "Content-Length": info.size,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  createReadStream(path)
    .on("error", () => res.destroy())
    .pipe(res);
}

export async function startServer(config: Config) {
  if (config.QA_API_TOKEN.length < 24) {
    throw new Error("Set a QA_API_TOKEN of at least 24 characters");
  }
  if (!config.allowedRepos.length) {
    throw new Error("Set GITHUB_ALLOWED_REPOS before serving jobs");
  }
  await mkdir(config.QA_DATA_DIR, { recursive: true });
  const queue: { id: string; input: z.infer<typeof requestSchema> }[] = [];
  let busy = false;
  // Explicitly mark interrupted jobs. Never replay side-effecting scenarios after a crash.
  for (const id of await readdir(config.QA_DATA_DIR)) {
    if (!ID.test(id)) {
      continue;
    }
    try {
      const job = JSON.parse(
        await readFile(join(config.QA_DATA_DIR, id, "job.json"), "utf8")
      );
      if (["queued", "running"].includes(job.status)) {
        await writeJson(join(config.QA_DATA_DIR, id, "job.json"), {
          ...job,
          status: "interrupted",
          error: "Service restarted; explicitly submit a new run",
        });
      }
    } catch {
      /* ignore non-job directories */
    }
  }
  const drain = async () => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const path = join(config.QA_DATA_DIR, job.id, "job.json");
        try {
          await writeJson(path, {
            id: job.id,
            status: "running",
            input: job.input,
          });
          const result = await runQa({ ...job.input, id: job.id }, config);
          await writeJson(path, {
            id: job.id,
            status: "completed",
            outcome: result.outcome,
            input: job.input,
          });
        } catch (error) {
          logger.error({ err: error, runId: job.id }, "Job failed");
          await writeJson(path, {
            id: job.id,
            status: "failed",
            error: "Internal failure; inspect service logs",
            input: job.input,
          });
        }
      }
    } finally {
      busy = false;
    }
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      logger.warn({ err: error }, "Request failed");
      if (res.headersSent) {
        res.destroy();
      } else {
        send(res, 400, {
          error: error instanceof Error ? error.message : "Bad request",
        });
      }
    });
  });
  async function enqueue(req: IncomingMessage, res: ServerResponse) {
    if (queue.length >= 20) {
      send(res, 429, { error: "Job queue is full" });
      return;
    }
    const input = requestSchema.parse(await readBody(req));
    const ref = parsePrUrl(input.prUrl);
    if (!config.allowedRepos.includes(ref.repo.toLowerCase())) {
      throw new Error("Repository is not allowed");
    }
    const id = randomUUID();
    await mkdir(join(config.QA_DATA_DIR, id));
    await writeJson(join(config.QA_DATA_DIR, id, "job.json"), {
      id,
      status: "queued",
      input,
    });
    queue.push({ id, input });
    send(res, 202, {
      id,
      statusUrl: `/runs/${id}`,
      reportUrl: `/artifacts/${id}/report.html`,
    });
    void drain();
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true, busy, queued: queue.length });
      return;
    }
    const artifact = /^\/artifacts\/([0-9a-f-]{36})\/(.+)$/.exec(url.pathname);
    if (
      !(
        authorized(req, config) ||
        (artifact && config.ARTIFACT_PUBLIC === "true")
      )
    ) {
      send(res, 401, { error: "Bearer authentication required" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/runs") {
      await enqueue(req, res);
      return;
    }
    const run = /^\/runs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === "GET" && run?.[1]) {
      const job = JSON.parse(
        await readFile(join(config.QA_DATA_DIR, run[1], "job.json"), "utf8")
      );
      send(res, 200, job);
      return;
    }
    if (req.method === "GET" && artifact?.[1] && artifact[2]) {
      await serveArtifact(res, config, artifact[1], artifact[2]);
      return;
    }
    send(res, 404, { error: "Not found" });
  }
  await new Promise<void>((done) =>
    server.listen(config.QA_PORT, config.QA_HOST, done)
  );
  logger.info(
    { host: config.QA_HOST, port: config.QA_PORT },
    "PR QA server listening"
  );
  return server;
}
