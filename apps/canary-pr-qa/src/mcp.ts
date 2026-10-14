import { readdir, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createLogger } from "@usecanary/logger";
import { z } from "zod";
import {
  ACCESS_DENIED,
  mayLaunch,
  type Principal,
  requireAccess,
} from "./access.js";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import { automaticAttempt, type Job, type Queue } from "./queue.js";
import { accepted, type RunLauncher, runInputSchema } from "./run-launch.js";
import { isRawEvidenceName } from "./server.js";

const logger = createLogger({ name: "qa-mcp" });
const SERVER_NAME = "canary-pr-qa";
const SERVER_VERSION = "0.1.0";
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
/**
 * Messages one batched request may carry. Older revisions of the protocol
 * allow a batch, so an agent can send several calls at once; the cap and the
 * sequential execution keep this process from holding hundreds of run results
 * in memory at the same time.
 */
const MAX_BATCH = 8;
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
  /** The one run-creation path, shared with `POST /runs`. */
  launcher: RunLauncher;
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
 * A missing file is an answer: retention deletes it with the run, so the caller
 * decides what it means. Any other failure — unreadable file, malformed JSON —
 * is a fault of this server and must not be reported as a purged run, which
 * would send an agent looking for data that was never lost.
 */
async function readResult(config: Config, id: string) {
  const text = await readFile(
    join(config.QA_DATA_DIR, id, "result.json"),
    "utf8"
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  });
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

/**
 * Octets rendus par page inline. Une réponse MCP voyage dans la fenêtre de
 * contexte de l'agent : un `console.log` de plusieurs mégaoctets la saturerait
 * en un appel. La page se reprend avec `nextOffset`.
 */
const INLINE_PAGE = 16_384;
/**
 * Au-delà, l'artefact n'est plus rendu du tout : le tool rend son chemin, que
 * l'appelant demande avec sa propre clé. Un HAR de 8 Mo n'a rien à faire dans
 * une réponse d'outil.
 */
const MAX_INLINE = 262_144;
/**
 * Les fichiers qu'une session Canary laisse dans le dossier de son scénario,
 * dans l'ordre lisible d'un inventaire : l'index d'abord, puis le rapport, les
 * dumps et la trace.
 */
const SESSION_FILES = [
  { file: "results.json", kind: "results" },
  { file: "report.html", kind: "report" },
  { file: "console.log", kind: "console" },
  { file: "network.har", kind: "har" },
  { file: "trace.zip", kind: "trace" },
] as const;
/** Les captures vivent dans des sous-dossiers, une entrée par fichier. */
const SESSION_NESTED = [
  { dir: "video", ext: ".webm", kind: "video" },
  { dir: "screenshots", ext: ".png", kind: "screenshot" },
] as const;

type ArtifactKind =
  | (typeof SESSION_FILES)[number]["kind"]
  | (typeof SESSION_NESTED)[number]["kind"];

interface SessionArtifact {
  bytes: number;
  kind: ArtifactKind;
  path: string;
  url?: string;
}
interface RunSession {
  artifacts: SessionArtifact[];
  dir: string;
  id?: string;
  name?: string;
  outcome?: string;
}
/**
 * Un fichier ou un dossier absent est une réponse du disque ; toute autre panne
 * — permission refusée, entrée/sortie en erreur — en est une de ce serveur. La
 * taire ferait passer une perte d'accès pour un test qui n'a rien produit, et
 * enverrait l'agent chercher des preuves qui existent.
 */
function absent(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function maybeStat(path: string) {
  return stat(path).catch((error: NodeJS.ErrnoException) => {
    if (absent(error)) {
      return;
    }
    throw error;
  });
}
function maybeReaddir(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (absent(error)) {
        return [];
      }
      throw error;
    }
  );
}
/**
 * Les artefacts d'une session, tels que `canary end` les a copiés dans le
dossier du scénario. Le disque est la source de vérité : un run encore en cours
 * n'a pas de résultat, mais la copie des preuves est déjà là.
 */
async function sessionArtifacts(dir: string): Promise<SessionArtifact[]> {
  const artifacts: SessionArtifact[] = [];
  for (const { file, kind } of SESSION_FILES) {
    const info = await maybeStat(join(dir, file));
    if (info?.isFile()) {
      artifacts.push({ bytes: info.size, kind, path: file });
    }
  }
  for (const { dir: sub, ext, kind } of SESSION_NESTED) {
    const entries = await maybeReaddir(join(dir, sub));
    for (const entry of entries.filter((item) => item.name.endsWith(ext))) {
      const info = await maybeStat(join(dir, sub, entry.name));
      if (info?.isFile()) {
        artifacts.push({
          bytes: info.size,
          kind,
          path: `${sub}/${entry.name}`,
        });
      }
    }
  }
  return artifacts;
}
/**
 * Le scénario qui a produit chaque session, lu dans le `result.json` du run.
 * Un run encore en cours n'en a pas : les sessions restent énumérées depuis le
 * disque, sans titre ni issue, plutôt que d'être annoncées inexistantes.
 */
async function scenarioIndex(config: Config, runId: string) {
  const result = await readResult(config, runId);
  const index = new Map<
    string,
    { id?: string; name?: string; outcome?: string }
  >();
  const scenarios = (result as { scenarios?: unknown } | undefined)?.scenarios;
  if (!Array.isArray(scenarios)) {
    return index;
  }
  for (const entry of scenarios) {
    const scenario = (entry as { scenario?: { id?: unknown; title?: unknown } })
      .scenario;
    const dir = typeof scenario?.id === "string" ? scenario.id : undefined;
    if (!dir) {
      continue;
    }
    const sessionId = (entry as { sessionId?: unknown }).sessionId;
    const outcome = (entry as { outcome?: unknown }).outcome;
    index.set(dir, {
      ...(typeof sessionId === "string" ? { id: sessionId } : {}),
      ...(typeof scenario?.title === "string" ? { name: scenario.title } : {}),
      ...(typeof outcome === "string" ? { outcome } : {}),
    });
  }
  return index;
}
/**
 * La politique de preuves brutes, la même que la route HTTP des artefacts : le
 * MCP ne peut pas ouvrir ce que le navigateur refuse, et un test de la route
 * couvre donc aussi ces tools.
 */
function allowed(config: Config, path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return config.QA_RAW_EVIDENCE === "true" || !isRawEvidenceName(name);
}
/** Les kinds qu'un tool dédié rend : l'inventaire ne distribue pas leur lien. */
const READ_BY_TOOL = new Set<ArtifactKind>(["results", "console", "har"]);
/**
 * Une entrée d'inventaire, avec le chemin d'un fichier qu'aucun tool ne rend.
 *
 * Le MCP ne signe pas ce chemin : un lien signé est un porteur anonyme, et le
 * dashboard réserve son émission à qui a l'autorité d'écrire sur le run
 * (`POST /runs/:id/links`, audité `artifact.share`). Une clé API ne l'a jamais,
 * même en portée `operator`, qui n'ouvre que le lancement. Le chemin rendu se
 * lit donc avec la clé de l'appelant : chaque lecture reste authentifiée,
 * vérifiée sur le dépôt du run et auditée, au lieu de céder cinq minutes de
 * lecture à qui détient l'URL.
 */
function linked(
  config: Config,
  runId: string,
  session: string,
  artifact: SessionArtifact
): SessionArtifact {
  if (READ_BY_TOOL.has(artifact.kind) || !allowed(config, artifact.path)) {
    return artifact;
  }
  return {
    ...artifact,
    url: `/artifacts/${runId}/${session}/${artifact.path}`,
  };
}
/**
 * Les sessions d'un run : un dossier par scénario, plus la découverte. Un
 * dossier sans index ni trace n'est pas une session — un rapport seul, ou un
 * fichier de travail — et l'annoncer enverrait l'agent chercher des preuves qui
 * n'existent pas.
 */
async function runSessions(
  config: Config,
  runId: string
): Promise<RunSession[]> {
  const dirs = await maybeReaddir(join(config.QA_DATA_DIR, runId));
  const index = await scenarioIndex(config, runId);
  const sessions: RunSession[] = [];
  for (const entry of dirs) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const artifacts = await sessionArtifacts(
      join(config.QA_DATA_DIR, runId, entry.name)
    );
    if (
      !artifacts.some(
        (item) => item.kind === "results" || item.kind === "trace"
      )
    ) {
      continue;
    }
    sessions.push({
      artifacts: artifacts.map((artifact) =>
        linked(config, runId, entry.name, artifact)
      ),
      dir: entry.name,
      ...(entry.name === "_discovery" ? { name: "Discovery" } : {}),
      ...index.get(entry.name),
    });
  }
  return sessions.sort((left, right) => left.dir.localeCompare(right.dir));
}
/**
 * Un octet de continuation UTF-8 s'écrit 10xxxxxx : il ne peut pas ouvrir un
 * caractère, donc ni une page, ni un offset demandé par l'appelant.
 */
function isContinuation(byte: number | undefined) {
  return byte !== undefined && byte >= 0x80 && byte < 0xc0;
}
/** Début du caractère qui contient `offset`. */
function boundaryBefore(buffer: Buffer, offset: number) {
  let start = offset;
  while (start > 0 && isContinuation(buffer[start])) {
    start -= 1;
  }
  return start;
}
/**
 * Recule sur une frontière UTF-8 : une page ne doit pas finir sur la moitié
 * d'un caractère, que l'agent recollerait en mojibake.
 */
function safeCut(buffer: Buffer, start: number, end: number) {
  let cut = end;
  while (cut > start && cut < buffer.length && isContinuation(buffer[cut])) {
    cut -= 1;
  }
  if (cut > start || cut >= buffer.length) {
    return cut;
  }
  // La page n'a pas la place du premier caractère : elle le rend entier plutôt
  // que de rendre un texte vide au même offset, ce qui boucherait un appelant
  // qui suit `nextOffset`.
  return Math.min(buffer.length, start + utf8Width(buffer[start]));
}
/** Longueur du caractère dont l'octet de tête est `head`. */
function utf8Width(head: number | undefined) {
  if (head === undefined || head < 0x80) {
    return 1;
  }
  if (head < 0xe0) {
    return 2;
  }
  if (head < 0xf0) {
    return 3;
  }
  return 4;
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

/**
 * The one failure a tool answers itself: a repository the presented key does
 * not cover. Anything else — an unreadable result, a database that stopped
 * answering — is a fault of this server, and dressing it up as a tool answer
 * would tell an agent it asked something wrong.
 */
function denial(error: unknown) {
  if (error instanceof Error && error.message === ACCESS_DENIED) {
    return refusal(error);
  }
  throw error;
}
/**
 * A launch is an action, so every refusal on that path is something the caller
 * can act on: a repository out of scope, a pull-request URL that is not one, a
 * model outside the catalog, a preview host the policy refuses, a full volume.
 * The server's own faults still travel as faults: only the diagnostics this
 * service raised for a caller are answered as text.
 */
function launchDenial(error: unknown) {
  if (error instanceof QaError) {
    return text(`${error.message} ${error.hint}`, true);
  }
  return denial(error);
}
/** A key that may read but not act: the answer names the missing capability. */
const READ_ONLY_KEY = [
  "Cette clé API est en lecture seule : elle ne peut pas lancer de test.",
  "Demandez à l’administrateur une clé de portée « opérateur » (Réglages → Clés API),",
  "puis relancez cet appel avec son jeton.",
].join(" ");

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
    since: z.string().datetime({ offset: true }).optional(),
    state: z.enum(ATTEMPT_STATES).optional(),
  })
  .strict();
const getAttemptArgs = z.object({ id: z.string().min(1) }).strict();
/**
 * The run contract plus the caller's own retry token. The token is an argument
 * here where the dashboard sends it as an `Idempotency-Key` header: an agent that
 * retries a call it never saw answered must re-answer the run it already paid
 * for, not create a second one.
 */
const launchRunArgs = runInputSchema
  .extend({ idempotencyKey: z.string().min(1).max(150).optional() })
  .strict();

const listSessionsArgs = z.object({ runId: z.string().uuid() }).strict();
const sessionReadArgs = z
  .object({
    limit: z.number().int().min(1).max(INLINE_PAGE).optional(),
    offset: z.number().int().min(0).optional(),
    runId: z.string().uuid(),
    session: z.string().min(1).max(200),
  })
  .strict();

const LIMIT_SCHEMA = {
  description: "Nombre d'entrées à rendre, 200 au plus.",
  maximum: MAX_LIMIT,
  minimum: 1,
  type: "integer",
};

/**
 * Le refus d'un dump brut, en clair : l'agent doit savoir que la donnée existe
 * et qui peut l'ouvrir, plutôt que de conclure que la session n'a rien produit.
 */
const RAW_DISABLED = [
  "Les preuves brutes sont fermées par la politique de données du service :",
  "le journal natif, le HAR, la trace et l'index results.json ne sont pas lisibles",
  "tant que QA_RAW_EVIDENCE n'est pas à true. Le rapport de session et les vidéos",
  "restent accessibles, et chaque lecture de preuve brute est auditée.",
].join(" ");
const SESSION_READERS = [
  {
    description:
      "L'index de session d'un scénario (`results.json`) : résumé, étapes, assertions et la liste des artefacts de la session.",
    kind: "results",
    label: "index de session",
    name: "get_session_results",
  },
  {
    description:
      "Le journal natif d'une session (`console.log`) : messages de console et erreurs de page du scénario.",
    kind: "console",
    label: "journal natif",
    name: "get_session_console",
  },
  {
    description:
      "Le HAR réseau d'une session (`network.har`) : requêtes, réponses et échecs observés pendant le scénario.",
    kind: "har",
    label: "HAR réseau",
    name: "get_session_har",
  },
] as const;

/**
 * Une lecture de preuve de session : la session est nommée par son dossier de
 * scénario ou par l'identifiant Canary que l'inventaire publie, jamais par un
 * chemin — le dossier vient d'un `readdir`, pas de l'appelant.
 */
async function readSession(
  raw: unknown,
  ctx: ToolContext,
  spec: (typeof SESSION_READERS)[number]
): Promise<ToolAnswer> {
  const args = sessionReadArgs.parse(raw);
  try {
    const job = await ctx.queue.get(args.runId);
    if (!job) {
      return text(
        `Ce test est introuvable ou a été purgé : ${args.runId}.`,
        true
      );
    }
    requireAccess(ctx.user, job.repo);
    const sessions = await runSessions(ctx.config, args.runId);
    const session = sessions.find(
      (entry) => entry.dir === args.session || entry.id === args.session
    );
    if (!session) {
      return text(
        sessions.length
          ? `Ce test n'a pas de session « ${args.session} ». Sessions connues : ${sessions.map((entry) => entry.dir).join(", ")}.`
          : "Ce test n'a laissé aucune session : aucun scénario n'a produit d'index ni de trace.",
        true
      );
    }
    const artifact = session.artifacts.find(
      (entry) => entry.kind === spec.kind
    );
    if (!artifact) {
      return text(
        `La session « ${session.dir} » n'a pas d'${spec.label} : le scénario ne l'a pas produit.`,
        true
      );
    }
    if (!allowed(ctx.config, artifact.path)) {
      return text(RAW_DISABLED, true);
    }
    const path = `${session.dir}/${artifact.path}`;
    const reference = {
      dir: session.dir,
      ...(session.id ? { id: session.id } : {}),
      ...(session.name ? { name: session.name } : {}),
      ...(session.outcome ? { outcome: session.outcome } : {}),
    };
    const meta = { bytes: artifact.bytes, kind: artifact.kind, path };
    if (artifact.bytes > MAX_INLINE) {
      // Rien n'a été lu : le fichier voyage par le chemin rendu, que l'appelant
      // demande avec sa propre clé. Une lecture qui échoue ne laisse donc pas de
      // ligne, et le lien anonyme reste l'affaire du dashboard qui l'a autorisé.
      return text({
        artifact: meta,
        note: `Le fichier fait ${artifact.bytes} octets : au-delà de la taille rendue par le MCP. Le chemin rendu sert le fichier entier, à demander avec la même clé API en en-tête Authorization ; sa lecture est auditée.`,
        run: args.runId,
        session: reference,
        text: null,
        url: `/artifacts/${args.runId}/${path}`,
      });
    }
    const buffer = await readFile(
      join(ctx.config.QA_DATA_DIR, args.runId, path)
    );
    const offset = Math.min(args.offset ?? 0, buffer.length);
    if (isContinuation(buffer[offset])) {
      // La page commencerait sur la fin d'un caractère, ce que `nextOffset` ne
      // rend jamais : le dire vaut mieux que de servir un caractère cassé et de
      // perdre l'octet.
      return text(
        `L'offset ${offset} tombe au milieu d'un caractère UTF-8 : reprendre à ${boundaryBefore(buffer, offset)}, ou à la valeur de nextOffset que rend une page.`,
        true
      );
    }
    const cut = safeCut(
      buffer,
      offset,
      Math.min(buffer.length, offset + (args.limit ?? INLINE_PAGE))
    );
    // La ligne n'est écrite qu'une fois la lecture faite : elle porte la taille
    // rendue, donc elle ne peut pas dire qu'un contenu a été lu quand la lecture
    // a échoué et que l'appel repart en faute du serveur.
    await ctx.queue.audit(ctx.user.id, "artifact.read", args.runId, {
      bytes: cut - offset,
      delivery: "inline",
      offset,
      path,
      via: "mcp",
    });
    return text({
      artifact: meta,
      nextOffset: cut < buffer.length ? cut : null,
      offset,
      run: args.runId,
      session: reference,
      text: buffer.subarray(offset, cut).toString("utf8"),
      url: null,
    });
  } catch (error) {
    return denial(error);
  }
}

const SESSION_READER_TOOLS: Tool[] = SESSION_READERS.map((reader) => ({
  description: `${reader.description} La session se nomme par le dossier du scénario ou par l'identifiant rendu par list_run_sessions. Le contenu reste soumis à la politique de preuves brutes et chaque lecture est auditée ; au-delà de ${MAX_INLINE} octets, le chemin de l'artefact est rendu sans contenu, à demander avec la même clé API.`,
  inputSchema: {
    additionalProperties: false,
    properties: {
      limit: {
        description: `Taille de la page en octets, ${INLINE_PAGE} au plus.`,
        maximum: INLINE_PAGE,
        minimum: 1,
        type: "integer",
      },
      offset: {
        description:
          "Octet de départ, sur une frontière de caractère ; reprendre la suite avec nextOffset. Un offset au milieu d'un caractère est refusé.",
        minimum: 0,
        type: "integer",
      },
      runId: {
        description: "Identifiant du test (UUID).",
        format: "uuid",
        type: "string",
      },
      session: {
        description:
          "Session du test : dossier du scénario ou identifiant de session rendu par list_run_sessions.",
        type: "string",
      },
    },
    required: ["runId", "session"],
    type: "object",
  },
  name: reader.name,
  run: (raw, ctx) => readSession(raw, ctx, reader),
}));

/**
 * The read-only tools an AI agent gets with an API key, plus the one action a
 * key of the `operator` scope may take: starting a run. They answer with the
 * records the dashboard already reads, and `launch_run` goes through the same
 * launcher as `POST /runs`, so the two surfaces cannot disagree.
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
        return denial(error);
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
        if (result === undefined) {
          // Retention deletes the run row with its evidence, so a run this
          // server just returned still has its result to come: only a run that
          // has already ended can have lost it.
          const ended = job.status !== "queued" && job.status !== "running";
          return text({
            result: null,
            resultAvailable: false,
            run: job,
            note: ended
              ? "Le résultat enregistré n'existe plus : la rétention a purgé les preuves de ce test."
              : "Ce test n'est pas terminé : le résultat sera écrit à la fin de l'exécution.",
          });
        }
        return text({ result, resultAvailable: true, run: job });
      } catch (error) {
        return denial(error);
      }
    },
  },
  {
    description:
      "Les sessions Canary enregistrées d'un test : une par scénario, plus la découverte. Chaque session donne son dossier, son identifiant, son issue et l'inventaire de ses artefacts (index results.json, rapport, trace, HAR, journal, vidéos, captures), avec le chemin de ceux qu'aucun autre outil ne rend, à demander avec la même clé API.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        runId: {
          description: "Identifiant du test (UUID).",
          format: "uuid",
          type: "string",
        },
      },
      required: ["runId"],
      type: "object",
    },
    name: "list_run_sessions",
    run: async (raw, ctx) => {
      const args = listSessionsArgs.parse(raw);
      try {
        const job = await ctx.queue.get(args.runId);
        if (!job) {
          return text(
            `Ce test est introuvable ou a été purgé : ${args.runId}.`,
            true
          );
        }
        requireAccess(ctx.user, job.repo);
        const sessions = await runSessions(ctx.config, args.runId);
        const rawEvidence = ctx.config.QA_RAW_EVIDENCE === "true";
        return text({
          count: sessions.length,
          note: rawEvidence
            ? "Les preuves brutes sont ouvertes : chaque lecture est auditée."
            : "Les preuves brutes sont fermées par QA_RAW_EVIDENCE : la trace n'a pas de chemin, et les outils d'index, de journal et de HAR les refusent. Le rapport, les vidéos et les captures restent accessibles.",
          rawEvidence,
          run: args.runId,
          sessions,
        });
      } catch (error) {
        return denial(error);
      }
    },
  },
  ...SESSION_READER_TOOLS,
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
            "Instant ISO 8601 ; les tentatives plus anciennes sont écartées.",
          format: "date-time",
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
        return denial(error);
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
        return denial(error);
      }
    },
  },
  {
    description:
      "Lance un test QA sur une pull request et rend l’identifiant du test créé. Le SHA testé est celui que GitHub donne à la PR au moment de l’appel. Réservé aux clés API de portée « opérateur ».",
    inputSchema: {
      additionalProperties: false,
      properties: {
        idempotencyKey: {
          description:
            "Jeton de reprise propre à l’appelant : le même jeton sur le même SHA rend le test déjà créé au lieu d’en payer un second.",
          type: "string",
        },
        model: {
          description:
            "Identifiant du modèle, tel que publié par le catalogue de l’instance ; par défaut le modèle configuré.",
          type: "string",
        },
        prUrl: {
          description:
            "URL GitHub de la pull request, par exemple https://github.com/owner/repo/pull/123.",
          format: "uri",
          type: "string",
        },
        previewUrl: {
          description:
            "URL de la preview du SHA de la PR. Sans elle, le service cherche un déploiement réussi de cette PR.",
          format: "uri",
          type: "string",
        },
        publish: {
          default: true,
          description:
            "Publier le rapport sur la pull request ; false pour un test privé.",
          type: "boolean",
        },
      },
      required: ["prUrl"],
      type: "object",
    },
    name: "launch_run",
    run: async (raw, ctx) => {
      const { idempotencyKey, ...args } = launchRunArgs.parse(raw);
      if (!mayLaunch(ctx.user)) {
        return text(READ_ONLY_KEY, true);
      }
      try {
        const job = await ctx.launcher.launch(ctx.user, args, idempotencyKey);
        return text({
          ...accepted(job),
          model: job.input.model ?? null,
          note: "Le test est en file, pas terminé : suivez-le avec get_run, qui rend le résultat une fois l’exécution finie.",
          pr: job.pr,
          repo: job.repo,
          sha: job.sha,
          status: job.status,
        });
      } catch (error) {
        return launchDenial(error);
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
  launcher: RunLauncher,
  read: (req: IncomingMessage, max?: number) => Promise<Buffer>,
  json: (res: ServerResponse, status: number, value: unknown) => void
) {
  async function dispatch(res: ServerResponse, body: unknown, user: Principal) {
    const ctx: ToolContext = { config, launcher, queue, user };
    if (Array.isArray(body)) {
      if (body.length > MAX_BATCH) {
        json(
          res,
          400,
          rpcError(
            null,
            -32_600,
            `Invalid Request: ${MAX_BATCH} calls at most per request`
          )
        );
        return;
      }
      // One call at a time: a batch must not make this process read and hold
      // every result it names before it answers.
      const answers: unknown[] = [];
      for (const message of body) {
        const answer = await handleMessage(message, ctx);
        if (answer !== undefined) {
          answers.push(answer);
        }
      }
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
