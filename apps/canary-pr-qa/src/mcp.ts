import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createLogger } from "@usecanary/logger";
import { z } from "zod";
import { type Principal, requireAccess } from "./access.js";
import type { Config } from "./config.js";
import { automaticAttempt, type Job, type Queue } from "./queue.js";

const logger = createLogger({ name: "qa-mcp" });
const SERVER_NAME = "canary-pr-qa";
const SERVER_VERSION = "0.1.0";
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
/**
 * Protocol revisions this stateless subset can serve. A client that asks for
 * another one is answered the default instead, which is what the specification
 * requires when the two cannot agree.
 */
const PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
const ATTEMPT_STATES = [
  "waiting",
  "expired",
  "rate_limited",
  "promoted",
  "discarded",
  "disabled",
] as const;

interface ToolAnswer {
  content: { text: string; type: "text" }[];
  isError?: boolean;
}
interface ToolContext {
  config: Config;
  queue: Queue;
  user: Principal;
}
interface Tool {
  description: string;
  /** JSON Schema of `arguments`, published by `tools/list`. */
  inputSchema: Record<string, unknown>;
  name: string;
  run: (args: unknown, ctx: ToolContext) => Promise<ToolAnswer>;
}

/**
 * The repositories an AI agent may read. A named repository is checked against
 * the key it presented, so a tool argument is never a way around the access
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
 * Retention deletes the file with the run, so a missing file is an answer, not a
 * failure. Raw evidence (traces, HAR, console, network) stays out of reach: the
 * tools carry the same data policy as the artifact route.
 */
async function readResult(config: Config, id: string) {
  return await readFile(join(config.QA_DATA_DIR, id, "result.json"), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
}

function text(value: unknown, isError = false): ToolAnswer {
  return {
    ...(isError ? { isError: true } : {}),
    content: [
      {
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
        type: "text",
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

const listRunsArgs = z
  .object({
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    repo: z.string().optional(),
    search: z.string().optional(),
    status: z.enum(RUN_STATUSES).optional(),
  })
  .strict();
const getRunArgs = z.object({ id: z.string().uuid() }).strict();
const listAttemptsArgs = z
  .object({
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    repo: z.string().optional(),
    since: z.string().optional(),
    state: z.enum(ATTEMPT_STATES).optional(),
  })
  .strict();
const getAttemptArgs = z.object({ id: z.string().min(1) }).strict();

const LIMIT_SCHEMA = {
  description: "Nombre d'entrées à rendre, 200 au plus.",
  maximum: MAX_LIMIT,
  minimum: 1,
  type: "integer",
};

/**
 * The four read-only tools an AI agent gets with an API key. They answer with
 * the records the dashboard already reads, so the two surfaces cannot disagree.
 */
const tools: Tool[] = [
  {
    description:
      "Historique des tests QA, du plus récent au plus ancien. Chaque ligne donne le statut du job, son résultat, le modèle et le coût.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        limit: LIMIT_SCHEMA,
        repo: { description: "Dépôt, par exemple owner/name.", type: "string" },
        search: { description: "Dépôt ou début de SHA.", type: "string" },
        status: { enum: RUN_STATUSES, type: "string" },
      },
      type: "object",
    },
    name: "list_runs",
    run: async (raw, ctx) => {
      const args = listRunsArgs.parse(raw);
      try {
        const jobs = await ctx.queue.list(
          scope(ctx.user, args.repo),
          args.status ?? "",
          args.search ?? ""
        );
        const limit = args.limit ?? DEFAULT_LIMIT;
        return text({
          count: jobs.length,
          limit,
          runs: jobs.slice(0, limit).map(runRow),
        });
      } catch (error) {
        return refusal(error);
      }
    },
  },
  {
    description:
      "Un test QA complet : la ligne du job, puis le résultat enregistré (scénarios, assertions, vidéos, coût, publication). Les preuves brutes restent exclues.",
    inputSchema: {
      additionalProperties: false,
      properties: { id: { format: "uuid", type: "string" } },
      required: ["id"],
      type: "object",
    },
    name: "get_run",
    run: async (raw, ctx) => {
      const args = getRunArgs.parse(raw);
      try {
        const job = await ctx.queue.get(args.id);
        if (!job) {
          return text(
            `Ce test est introuvable ou a été purgé : ${args.id}.`,
            true
          );
        }
        requireAccess(ctx.user, job.repo);
        const result = await readResult(ctx.config, args.id);
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
    },
  },
  {
    description:
      "Historique des lancements automatiques déclenchés par GitHub : état, cause, pull request et SHA de chaque tentative.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        limit: LIMIT_SCHEMA,
        repo: { description: "Dépôt, par exemple owner/name.", type: "string" },
        since: {
          description:
            "Instant ISO ; les tentatives plus anciennes sont écartées.",
          type: "string",
        },
        state: { enum: ATTEMPT_STATES, type: "string" },
      },
      type: "object",
    },
    name: "list_automatic_attempts",
    run: async (raw, ctx) => {
      const args = listAttemptsArgs.parse(raw);
      try {
        const attempts = await ctx.queue.attempts(scope(ctx.user, args.repo), {
          deadlineSeconds: ctx.config.QA_AUTO_PREVIEW_WAIT_SECONDS,
          limit: args.limit ?? DEFAULT_LIMIT,
          ...(args.since ? { since: args.since } : {}),
          ...(args.state ? { state: args.state } : {}),
        });
        return text({ attempts, count: attempts.length });
      } catch (error) {
        return refusal(error);
      }
    },
  },
  {
    description:
      "Une tentative de lancement automatique et la chronologie d'audit de ses sondes de prévisualisation.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        id: { description: "Identifiant de livraison GitHub.", type: "string" },
      },
      required: ["id"],
      type: "object",
    },
    name: "get_automatic_attempt",
    run: async (raw, ctx) => {
      const args = getAttemptArgs.parse(raw);
      try {
        const row = await ctx.queue.delivery(
          args.id,
          ctx.config.QA_AUTO_PREVIEW_WAIT_SECONDS
        );
        const repo = row?.payload.repo;
        if (!(row && repo) || row.payload.ignored) {
          return text(
            `Cette tentative automatique est introuvable : ${args.id}.`,
            true
          );
        }
        requireAccess(ctx.user, repo);
        return text({
          attempt: automaticAttempt(row),
          timeline: await ctx.queue.deliveryTimeline(args.id),
        });
      } catch (error) {
        return refusal(error);
      }
    },
  },
];

function rpcError(id: unknown, code: number, message: string) {
  return { error: { code, message }, id: id ?? null, jsonrpc: "2.0" };
}
function rpcResult(id: unknown, result: unknown) {
  return { id: id ?? null, jsonrpc: "2.0", result };
}

/**
 * One JSON-RPC message. The subset is what a stateless read-only server needs:
 * the handshake, the tool inventory, the calls, and nothing the client must
 * subscribe to. A notification answers nothing at all, which is what the
 * caller sees as an empty `202`.
 */
async function handleMessage(
  message: unknown,
  ctx: ToolContext
): Promise<unknown | undefined> {
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    return rpcError(null, -32_600, "Invalid Request");
  }
  const { id, method, params } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (typeof method !== "string") {
    return rpcError(id, -32_600, "Invalid Request");
  }
  if (method.startsWith("notifications/")) {
    return;
  }
  if (method === "initialize") {
    const asked = (params as { protocolVersion?: unknown } | undefined)
      ?.protocolVersion;
    return rpcResult(id, {
      capabilities: { tools: {} },
      protocolVersion:
        typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : DEFAULT_PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "ping") {
    return rpcResult(id, {});
  }
  if (method === "tools/list") {
    return rpcResult(id, {
      tools: tools.map(({ description, inputSchema, name }) => ({
        description,
        inputSchema,
        name,
      })),
    });
  }
  if (method !== "tools/call") {
    return rpcError(id, -32_601, `Method not found: ${method}`);
  }
  const call = params as { arguments?: unknown; name?: unknown } | undefined;
  const tool = tools.find((entry) => entry.name === call?.name);
  if (!tool) {
    return rpcError(id, -32_602, `Unknown tool: ${String(call?.name)}`);
  }
  const args = call?.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return rpcError(id, -32_602, "arguments must be an object");
  }
  try {
    return rpcResult(id, await tool.run(args, ctx));
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map(
          (issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`
        )
        .join("; ");
      return rpcError(
        id,
        -32_602,
        `Invalid arguments for ${tool.name}: ${issues}`
      );
    }
    throw error;
  }
}

/**
 * `POST /mcp` for AI agents that hold an API key. The endpoint takes an API key
 * only. Every other credential the server accepts elsewhere — the service
 * token, a `users.json` token, an OIDC JWT, a session cookie — lacks
 * `Principal.apiKeyId` and is refused, so a cross-site request cannot read this
 * service even though the route sits behind the same origin.
 *
 * Stateless by design: no session, no server-to-client stream, one JSON answer
 * per request. A client that needs the full protocol can keep using the CLI.
 */
export function mcpRoutes(
  queue: Queue,
  config: Config,
  read: (req: IncomingMessage, max?: number) => Promise<Buffer>,
  json: (res: ServerResponse, status: number, value: unknown) => void
) {
  async function dispatch(res: ServerResponse, body: unknown, user: Principal) {
    const ctx: ToolContext = { config, queue, user };
    if (Array.isArray(body)) {
      const answers = (
        await Promise.all(body.map((message) => handleMessage(message, ctx)))
      ).filter((answer) => answer !== undefined);
      if (!answers.length) {
        res.writeHead(202, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      json(res, 200, answers);
      return;
    }
    const answer = await handleMessage(body, ctx);
    if (answer === undefined) {
      res.writeHead(202, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    json(res, 200, answer);
  }
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
    if (!user.apiKeyId) {
      json(res, 401, { error: "Authentication required" });
      return true;
    }
    let body: unknown;
    try {
      body = JSON.parse((await read(req)).toString() || "{}");
    } catch {
      json(res, 400, rpcError(null, -32_700, "Parse error"));
      return true;
    }
    try {
      await dispatch(res, body, user);
    } catch (error) {
      // An unexpected failure is a server fault, not a tool answer: the client
      // gets the protocol error, the operator gets the log line.
      logger.warn(
        { code: "MCP_INTERNAL", error: String(error) },
        "MCP call failed"
      );
      json(res, 500, rpcError(null, -32_603, "Internal error"));
    }
    return true;
  };
}
