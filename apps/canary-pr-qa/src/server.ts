import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "@usecanary/logger";
import { z } from "zod";
import {
  type Config,
  validateConfiguration,
  validatePreviewUrl,
} from "./config.js";
import { type Diagnostic, diagnose, QaError, redact } from "./diagnostics.js";
import { parsePrUrl } from "./github.js";
import {
  ModelCatalog,
  ModelIdSchema,
  runModelConfig,
} from "./model-catalog.js";
import { writeJson } from "./report.js";
import { runQa } from "./runner.js";

const logger = createLogger({ name: "pr-qa-server" });
const requestSchema = z
  .object({
    prUrl: z.string().url(),
    previewUrl: z.string().url().optional(),
    publish: z.boolean().default(true),
    model: ModelIdSchema.optional(),
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
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) {
      req.resume();
      throw new QaError(
        "REQUEST_TOO_LARGE",
        "Request body exceeds 16384 bytes",
        "Submit only the PR URL, optional preview URL and publish flag; do not send source code or credentials in the body."
      );
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new QaError(
      "REQUEST_JSON_INVALID",
      "Request body is not valid JSON",
      "Send application/json with prUrl, optional previewUrl and publish. The rejected body is not echoed into diagnostics."
    );
  }
}
function errorStatus(code: string) {
  if (code === "REQUEST_TOO_LARGE") {
    return 413;
  }
  if (code === "ENOENT") {
    return 404;
  }
  if (["EACCES", "ENOSPC", "EIO"].includes(code)) {
    return 500;
  }
  return 400;
}
async function readStatus(config: Config, id: string) {
  const job = JSON.parse(
    await readFile(join(config.QA_DATA_DIR, id, "job.json"), "utf8")
  );
  try {
    const progress = JSON.parse(
      await readFile(join(config.QA_DATA_DIR, id, "progress.json"), "utf8")
    );
    return { ...job, progress };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return job;
  }
}

export function canonicalArtifactPath(raw: string) {
  if (/%(?:2f|5c|00)/i.test(raw)) {
    throw new Error("Ambiguous artifact path");
  }
  const path = decodeURIComponent(raw);
  if (
    !/^[\w./-]+$/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Invalid artifact path");
  }
  return path;
}
/**
 * Les dumps que la politique de données garde hors de portée : la trace
 * Playwright, le HAR, le journal natif, l'index `results.json` et les fichiers
 * qu'un rapport lie. La décision lit le **nom**, jamais les répertoires — un
 * scénario peut s'appeler `network-errors` ou `console-errors` et son
 * `report.html` reste un rapport. Partagée par la route HTTP des artefacts et
 * les outils MCP, pour qu'aucune surface n'ouvre ce que l'autre refuse.
 */
export function isRawEvidenceName(name: string) {
  return (
    /\.(?:har|zip|log)$/i.test(name) ||
    /^(?:results\.json$|console[.-]|network[.-])/i.test(name)
  );
}
export async function serveArtifact(
  res: ServerResponse,
  config: Config,
  id: string,
  artifactPath: string
) {
  const root = resolve(config.QA_DATA_DIR, id);
  const path = resolve(root, artifactPath);
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
  const [dataRoot, actualRoot, actualPath] = await Promise.all([
    realpath(config.QA_DATA_DIR),
    realpath(root),
    realpath(path),
  ]);
  if (
    relative(dataRoot, actualRoot).startsWith("..") ||
    relative(actualRoot, actualPath).startsWith("..")
  ) {
    throw new Error("Artifact symlinks outside the run are not allowed");
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
    ...(extname(path) === ".html"
      ? {
          "Content-Security-Policy":
            relative(root, path) === "report.html"
              ? "sandbox allow-same-origin; default-src 'self' data: blob:; script-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"
              : "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        }
      : {}),
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  // La réponse n'est terminée qu'une fois le fichier remis : un appelant qui
  // journalise une lecture juste après doit savoir que le contenu est parti,
  // pas seulement que l'en-tête a été écrit. Un transfert interrompu par le
  // disque ou par le client remonte donc en erreur, et ne se lit pas comme une
  // lecture réussie.
  await new Promise<void>((done, reject) => {
    const stream = createReadStream(path);
    stream.on("error", (error) => {
      res.destroy();
      reject(error);
    });
    res.on("finish", () => done());
    res.on("close", () => {
      if (!res.writableEnded) {
        reject(new Error("Artifact transfer interrupted"));
      }
    });
    stream.pipe(res);
  });
}

export async function startServer(config: Config) {
  validateConfiguration(config, true);
  await mkdir(config.QA_DATA_DIR, { recursive: true });
  const queue: { id: string; input: z.infer<typeof requestSchema> }[] = [];
  const models = new ModelCatalog(config);
  let busy = false;
  let reservations = 0;
  let stopping = false;
  let degraded: Diagnostic | undefined;
  let activeDrain: Promise<void> = Promise.resolve();
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
      for (
        let job = stopping ? undefined : queue.shift();
        job;
        job = stopping ? undefined : queue.shift()
      ) {
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
          const diagnostic = diagnose(error, config);
          logger.error({ diagnostic, runId: job.id }, "Job failed");
          await writeJson(path, {
            id: job.id,
            status: "failed",
            error: diagnostic.message,
            diagnostic,
            input: job.input,
          });
        }
      }
    } finally {
      busy = false;
    }
  };
  const server = createServer((req, res) => {
    const requestId = randomUUID();
    const started = Date.now();
    res.setHeader("X-Request-ID", requestId);
    res.once("finish", () =>
      logger.info(
        {
          requestId,
          method: req.method,
          path: redact(req.url?.split("?")[0] ?? "", config),
          status: res.statusCode,
          durationMs: Date.now() - started,
        },
        "API request"
      )
    );
    void handle(req, res).catch((error) => {
      const diagnostic = diagnose(error, config);
      logger.warn({ diagnostic, requestId }, "Request failed");
      if (res.headersSent) {
        res.destroy();
      } else {
        send(res, errorStatus(diagnostic.code), {
          error: diagnostic.message,
          code: diagnostic.code,
          hint: diagnostic.hint,
          requestId,
        });
      }
    });
  });
  async function enqueue(req: IncomingMessage, res: ServerResponse) {
    if (stopping || degraded) {
      send(res, 503, {
        error: "Service is shutting down or storage is degraded",
        diagnostic: degraded,
      });
      return;
    }
    if (queue.length + reservations >= 20) {
      send(res, 429, { error: "Job queue is full" });
      return;
    }
    reservations++;
    try {
      const input = requestSchema.parse(await readBody(req));
      input.model = runModelConfig(config, input.model).OPENAI_MODEL;
      await models.require(input.model);
      const ref = parsePrUrl(input.prUrl);
      if (!config.allowedRepos.includes(ref.repo.toLowerCase())) {
        throw new Error("Repository is not allowed");
      }
      if (input.previewUrl) {
        validatePreviewUrl(input.previewUrl, config);
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
      if (!busy) {
        activeDrain = drain().catch((error) => {
          degraded = diagnose(error, config);
          logger.error(
            { diagnostic: degraded },
            "Job persistence failed; service degraded"
          );
        });
      }
    } finally {
      reservations--;
    }
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      sendHealth(res);
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
    if (req.method === "GET" && url.pathname === "/models") {
      send(res, 200, {
        data: (await models.list()).map((id) => ({ id })),
        defaultModel: config.OPENAI_MODEL,
      });
      return;
    }
    const run = /^\/runs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === "GET" && run?.[1]) {
      send(res, 200, await readStatus(config, run[1]));
      return;
    }
    if (req.method === "GET" && artifact?.[1] && artifact[2]) {
      await serveArtifact(
        res,
        config,
        artifact[1],
        canonicalArtifactPath(artifact[2])
      );
      return;
    }
    send(res, 404, { error: "Not found" });
  }
  function sendHealth(res: ServerResponse) {
    send(res, degraded || stopping ? 503 : 200, {
      ok: !(degraded || stopping),
      busy,
      queued: queue.length,
      ...(degraded ? { diagnostic: degraded } : {}),
    });
  }
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on("close", () => {
    stopping = true;
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(config.QA_PORT, config.QA_HOST, () => {
      server.off("error", reject);
      done();
    });
  });
  server.on("error", (error) => {
    degraded = diagnose(error, config);
    logger.error({ diagnostic: degraded }, "API server error");
  });
  logger.info(
    { host: config.QA_HOST, port: config.QA_PORT },
    "PR QA server listening"
  );
  return Object.assign(server, {
    async shutdown() {
      stopping = true;
      logger.info(
        { busy, queued: queue.length },
        "Shutting down; pending jobs will be interrupted on restart"
      );
      const closed = new Promise<void>((done) => {
        server.close(() => done());
        server.closeIdleConnections();
      });
      await Promise.race([
        Promise.all([closed, activeDrain]),
        delay(25_000, undefined, { ref: false }),
      ]);
      server.closeAllConnections();
    },
  });
}
