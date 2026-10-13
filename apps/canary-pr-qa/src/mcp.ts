import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { type Principal, requireAccess } from "./access.js";
import type { Config } from "./config.js";
import { automaticAttempt, type Job, type Queue } from "./queue.js";

const SERVER_NAME = "canary-pr-qa";
const SERVER_VERSION = "0.1.0";
const MAX_LIMIT = 200;

/**
 * The repositories an AI agent may read. A named repository is checked against
 * the key it presented, so the tool argument is never a way around the access
 * rule the dashboard already enforces.
 */
function scope(user: Principal, repo?: string): string[] {
  if (!repo) {
    return user.repos;
  }
  requireAccess(user, repo);
  return [repo];
}

/** What one run shows in a list: enough to choose one, not the whole record. */
function runRow(job: Job) {
  return {
    costUsd: job.usage?.costUsd ?? null,
    createdAt: job.created_at,
    id: job.id,
    model: job.usage?.model ?? job.input.model ?? null,
    outcome: job.outcome ?? null,
    owner: job.owner,
    pr: job.pr,
    repo: job.repo,
    sha: job.sha,
    status: job.status,
    updatedAt: job.updated_at,
  };
}

/**
 * The persisted result of a run, read from the same file the dashboard serves.
 * Retention deletes the file with the run, so a missing file is an answer, not
 * a failure. Raw evidence (traces, HAR, console, network) stays out of reach:
 * the tools carry the same data policy as the artifact route.
 */
async function readResult(config: Config, id: string) {
  return await readFile(join(config.QA_DATA_DIR, id, "result.json"), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
}

function text(value: unknown, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

/** A refused tool call answers a readable message, not a protocol error. */
function refusal(error: unknown) {
  return text(
    error instanceof Error ? error.message : "Appel refusé par le serveur.",
    true
  );
}

/**
 * The four read-only tools an AI agent gets with an API key. They answer with
 * the records the dashboard already reads, so the two surfaces cannot disagree.
 */
export function createMcpServer(queue: Queue, config: Config, user: Principal) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "list_runs",
    {
      description:
        "Historique des tests QA d'une ou plusieurs pull requests, du plus récent au plus ancien. Chaque ligne donne le statut du job et son résultat.",
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        repo: z.string().optional(),
        search: z.string().optional(),
        status: z
          .enum([
            "queued",
            "running",
            "completed",
            "failed",
            "cancelled",
            "interrupted",
          ])
          .optional(),
      },
    },
    async ({ limit, repo, search, status }) => {
      try {
        const jobs = await queue.list(
          scope(user, repo),
          status ?? "",
          search ?? ""
        );
        return text({
          count: jobs.length,
          limit: limit ?? 50,
          runs: jobs.slice(0, limit ?? 50).map(runRow),
        });
      } catch (error) {
        return refusal(error);
      }
    }
  );

  server.registerTool(
    "get_run",
    {
      description:
        "Un test QA complet : la ligne du job, puis le résultat enregistré (scénarios, assertions, vidéos, coût, publication). Les preuves brutes restent exclues.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      try {
        const job = await queue.get(id);
        if (!job) {
          return text(`Ce test est introuvable ou a été purgé : ${id}.`, true);
        }
        requireAccess(user, job.repo);
        const result = await readResult(config, id);
        return text({
          result: result ?? null,
          resultAvailable: result !== undefined,
          run: job,
          ...(result === undefined
            ? {
                note: "Le résultat enregistré n'existe plus : la rétention a purgé les preuves de ce test.",
              }
            : {}),
        });
      } catch (error) {
        return refusal(error);
      }
    }
  );

  server.registerTool(
    "list_automatic_attempts",
    {
      description:
        "Historique des lancements automatiques déclenchés par GitHub : état, cause, pull request et SHA de chaque tentative.",
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        repo: z.string().optional(),
        since: z.string().optional(),
        state: z
          .enum([
            "waiting",
            "expired",
            "rate_limited",
            "promoted",
            "discarded",
            "disabled",
          ])
          .optional(),
      },
    },
    async ({ limit, repo, since, state }) => {
      try {
        const { attempts } = await queue.automatic(
          scope(user, repo),
          config.QA_AUTO_PREVIEW_WAIT_SECONDS
        );
        const kept = attempts.filter(
          (attempt) =>
            (!state || attempt.state === state) &&
            (!since || attempt.updatedAt >= since)
        );
        return text({
          attempts: kept.slice(0, limit ?? 50),
          count: kept.length,
        });
      } catch (error) {
        return refusal(error);
      }
    }
  );

  server.registerTool(
    "get_automatic_attempt",
    {
      description:
        "Une tentative de lancement automatique et la chronologie d'audit de ses sondes de prévisualisation.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const row = await queue.delivery(
          id,
          config.QA_AUTO_PREVIEW_WAIT_SECONDS
        );
        const repo = row?.payload.repo;
        if (!(row && repo) || row.payload.ignored) {
          return text(
            `Cette tentative automatique est introuvable : ${id}.`,
            true
          );
        }
        requireAccess(user, repo);
        return text({
          attempt: automaticAttempt(row),
          timeline: await queue.deliveryTimeline(id),
        });
      } catch (error) {
        return refusal(error);
      }
    }
  );

  return server;
}

/**
 * `POST /mcp` for AI agents that hold an API key. The endpoint takes a bearer
 * key only: a dashboard session cookie never opens it, so a cross-site request
 * cannot read this service even though the route sits behind the same origin.
 *
 * Stateless: every request builds its own server and JSON transport, which
 * keeps a long-lived session out of a process that restarts under a lease.
 */
export function mcpRoutes(
  queue: Queue,
  config: Config,
  read: (req: IncomingMessage, max?: number) => Promise<Buffer>,
  json: (res: ServerResponse, status: number, value: unknown) => void
) {
  return async function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal
  ): Promise<boolean> {
    if (url.pathname !== "/mcp") {
      return false;
    }
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!/^Bearer \S/i.test(req.headers.authorization ?? "")) {
      json(res, 401, { error: "Authentication required" });
      return true;
    }
    let body: unknown;
    try {
      body = JSON.parse((await read(req)).toString() || "{}");
    } catch {
      json(res, 400, {
        error: { code: -32_700, message: "Parse error" },
        id: null,
        jsonrpc: "2.0",
      });
      return true;
    }
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
    });
    const server = createMcpServer(queue, config, user);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return true;
  };
}
