import { mkdtemp } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Queue } from "../src/queue.js";
import type { Plan } from "../src/schema.js";

export const SHA = "1".repeat(40);
export const BASE_SHA = "2".repeat(40);
export const PR_URL = "https://github.com/fixture/app/pull/1";
/** Citation témoin du second fichier changé, servie dans son patch. */
export const SECOND_FILE_QUOTE = "second changed file witness value";
export const plan: Plan = {
  summary: "Verify the changed welcome form behavior",
  scenarios: [
    {
      id: "welcome",
      title: "Submitting the name saves a welcome message",
      kind: "happy_path",
      rationale: "PR changes form submission",
      sourceFiles: ["src/form.ts"],
      preconditions: [],
      requirements: [
        {
          sourceFile: "src/form.ts",
          quote: "show('Welcome '+name)",
          behavior: "Save the name via the form",
        },
      ],
      steps: [
        {
          id: "enter",
          description: "Enter Ada",
          action: {
            type: "fill",
            locator: { by: "label", value: "Name" },
            value: "Ada",
          },
        },
        {
          id: "save",
          description: "Submit",
          action: {
            type: "click",
            locator: { by: "role", value: "button", name: "Save" },
          },
        },
        {
          id: "verify",
          description: "Verify welcome message",
          action: { type: "assert", assertionId: "saved" },
        },
      ],
      assertions: [
        {
          id: "saved",
          description: "Saved output welcomes Ada",
          kind: "text",
          expected: "Welcome Ada",
          target: { by: "css", value: "#saved" },
          afterStep: "save",
          verification: "transition",
        },
      ],
    },
  ],
  skipped: [],
};
export async function body(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function json(
  res: ServerResponse,
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}
/**
 * Réponse `text/event-stream` : deltas partiels (dont un delta de raisonnement), usage final
 * puis `[DONE]`. Le contenu est coupé sur une frontière sûre pour forcer un vrai recollage.
 */
export function sse(
  res: ServerResponse,
  text: string,
  finishReason = "stop",
  completionTokens = 7
) {
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/event-stream",
  });
  const halfway = Math.ceil(text.length / 2);
  const boundary = text.lastIndexOf(" ", halfway);
  const cut = boundary > 0 ? boundary : halfway;
  const chunk = (
    delta: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) => {
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta, index: 0, ...extra }] })}\n\n`
    );
  };
  res.write(": stream open\n\n");
  chunk({ role: "assistant" });
  chunk({ reasoning_content: "fixture reasoning" });
  chunk({ content: text.slice(0, cut) });
  chunk({ content: text.slice(cut) });
  res.write(
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: finishReason, index: 0 }],
      usage: {
        completion_tokens: completionTokens,
        prompt_tokens: 11,
        total_tokens: 11 + completionTokens,
      },
    })}\n\n`
  );
  res.end("data: [DONE]\n\n");
}
/**
 * Runs the production SQL of `Queue` on PostgreSQL WASM: migration, delivery
 * state machine and queue helpers execute the real statements without a server.
 * Multi-process row locking is covered separately on native PostgreSQL in CI.
 */
export async function pgliteQueue(cleanup: (() => Promise<void>)[]) {
  const db = await PGlite.create();
  cleanup.push(() => db.close());
  const query = async (text: string, values?: unknown[]) => {
    if (!values && text.includes("CREATE TABLE")) {
      await db.exec(text);
      return { rows: [], rowCount: 0 };
    }
    const result = await db.query(text, values);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
    end: async () => undefined,
    on: () => undefined,
  };
  vi.spyOn(pg, "Pool").mockImplementation(
    class {
      query = pool.query;
      connect = pool.connect;
      end = pool.end;
      on = pool.on;
    } as unknown as typeof pg.Pool
  );
  const queue = new Queue("postgres://fixture");
  await queue.migrate();
  return queue;
}
export async function fixture(
  options: {
    broken?: boolean;
    noSha?: boolean;
    updatedSha?: boolean;
    noScenarios?: boolean;
    listenHost?: string;
    missingDiffAndContext?: boolean;
    decoy?: boolean;
    plans?: Plan[];
    /** Patch de `src/form.ts`, pour un témoin exact mais sans contenu visible. */
    formPatch?: string;
    /**
     * Contenu servi par `/contents/` au lieu de la phrase par défaut. Une valeur
     * plus longue que le plafond de `collectContext` rend le contexte du fichier
     * cité partiel, exactement comme un fichier de production plus gros que
     * 16 000 caractères.
     */
    headContent?: string;
    /** Second fichier changé, pour déclarer une source sans exigence témoignée. */
    secondChangedFile?: string;
    /**
     * Fichiers changés servis à la place de `src/form.ts` (et du second
     * fichier) : un diff de documentation seule, ou un diff mêlé.
     */
    changedFiles?: { filename: string; patch: string }[];
    /** `approvedSkips` de la politique `.canary/qa.json` servie sur la base. */
    approvedSkips?: { path: string; reason: string }[];
    requireWriteEvidence?: boolean;
    unchangedState?: boolean;
    persistent?: boolean;
    persistenceBroken?: boolean;
    maliciousUrl?: string;
    requireCookie?: boolean;
    unnamedStatus?: boolean;
    models?: string[];
    modelsStatus?: number;
    /** Nombre de propositions de plan coupées net, avant toute réponse. */
    modelResets?: number;
    /** Nombre de flux de plan fermés sans marqueur terminal. */
    modelTruncations?: number;
    /** Nombre de plans coupés par la borne de sortie (`finish_reason: "length"`). */
    modelIncomplete?: number;
    /** Contenu partiel servi à la place du plan d'une réponse coupée. */
    incompleteContent?: string;
    /** Nombre de plans complets mais illisibles : un contenu qui n'est pas du JSON. */
    modelUnreadable?: number;
    /** Contenu servi à la place du plan d'une réponse illisible. */
    unreadableContent?: string;
    /**
     * Nombre de réponses de plan dont l'usage annonce une sortie au-delà de la
     * borne transmise (`max_tokens` + 1000) : un endpoint qui ignore le champ de
     * limite.
     */
    modelOverBound?: number;
    /** Statut HTTP servi par `chat/completions` au lieu d'une réponse de plan. */
    completionsStatus?: number;
    /**
     * Statuts HTTP servis à la place de la réponse de plan, un par envoi, dans
     * l'ordre : une séquence dit qu'un gateway a refusé N tentatives avant de
     * servir la bonne, ce qu'un statut unique ne peut pas exprimer.
     */
    completionsStatuses?: number[];
    /** En-tête `Retry-After` posé sur ces refus, quand l'endpoint en envoie un. */
    retryAfter?: string;
    /** Variables d'environnement ajoutées à la configuration du fixture. */
    env?: Record<string, string>;
    /**
     * Préversion de base servie par un second serveur, donc sur une autre
     * origine comme un vrai déploiement : le même formulaire, dont la sortie
     * commence par `greeting`, et `sha` (défaut `BASE_SHA`) annoncé en
     * `x-commit-sha`. Son hôte est ajouté à `PREVIEW_ALLOWED_HOSTS`.
     */
    baseApp?: { greeting: string; sha?: string; button?: string };
    /**
     * Base de fusion servie par `compare` (défaut `BASE_SHA`) : une autre valeur
     * dit que main a avancé depuis la bifurcation de la PR.
     */
    mergeBaseSha?: string;
  } = {}
) {
  const baseServer = options.baseApp
    ? await serveBaseApp(options.baseApp)
    : undefined;
  const outgoing: { path: string; payload: Record<string, unknown> }[] = [];
  const comments: { id: number; body: string; user: { type: string } }[] = [];
  const modelRequests: Record<string, unknown>[] = [];
  const catalogRequests: string[] = [];
  /** Appels de semis et de nettoyage reçus par le catalogue de fixtures local. */
  const fixtureCalls: { path: string; key: string | undefined }[] = [];

  let prReads = 0;
  let planRequests = 0;
  let modelResets = options.modelResets ?? 0;
  const completionsStatuses = [...(options.completionsStatuses ?? [])];
  /** Envois reçus par `chat/completions`, réponse ou refus confondus. */
  let completionRequests = 0;
  let modelTruncations = options.modelTruncations ?? 0;
  let modelIncomplete = options.modelIncomplete ?? 0;
  let modelUnreadable = options.modelUnreadable ?? 0;
  let modelOverBound = options.modelOverBound ?? 0;
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) =>
      json(res, { error: String(error) }, 500)
    );
  });
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Test fixture deliberately dispatches all local protocol endpoints in one place.
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = req.url ?? "/";
    if (path === "/v1/models") {
      catalogRequests.push(path);
      json(
        res,
        {
          data: (
            options.models ?? [
              "fixture-scripted-model",
              "fixture-alternate-model",
            ]
          ).map((id) => ({ id })),
        },
        options.modelsStatus ?? 200
      );
      return;
    }
    if (
      path === "/repos/fixture/app" ||
      path === "/repos/fixture/app/contents"
    ) {
      json(res, {
        full_name: "fixture/app",
        permissions: { pull: true, push: true },
      });
      return;
    }
    if (path === "/repos/fixture/app/deployments?per_page=1") {
      json(res, []);
      return;
    }
    if (path.startsWith("/http-")) {
      res.setHeader("x-github-request-id", "fixture-request-42");
      json(
        res,
        { error: "Do not echo fixture-token in diagnostics" },
        Number(path.slice(6))
      );
      return;
    }
    if (path === "/slow") {
      return;
    }
    if (path === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        ...(options.noSha ? {} : { "x-commit-sha": SHA }),
      });
      if (
        options.requireCookie &&
        !req.headers.cookie?.includes("qa_role=test-member-secret")
      ) {
        res.end("<!doctype html><h1>Sign in required</h1>");
        return;
      }
      let savedExpression = options.broken
        ? "'Wrong output'"
        : "'Welcome '+document.querySelector('#name').value";
      if (options.unchangedState) {
        savedExpression = "document.querySelector('#saved').textContent";
      }
      res.end(
        `<!doctype html><html lang="en"><title>QA form fixture</title><h1>Welcome form</h1><a href="/download" download>Download report</a><a href="/popup" target="_blank">Open popup</a><form><label for="name">Name</label><input id="name" name="name"><button type="submit">Save</button></form><p role="status" id="saved">${options.unchangedState ? "Welcome Ada" : ""}</p>${options.decoy ? "<aside id=decoy>Welcome Ada</aside>" : ""}<script>${options.maliciousUrl ? `fetch(${JSON.stringify(options.maliciousUrl)}).catch(()=>{});` : ""}${options.persistent ? `document.querySelector('#saved').textContent=localStorage.getItem('saved')||'';` : ""}document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();document.querySelector('#saved').textContent=${savedExpression}${options.persistent && !options.persistenceBroken ? `;localStorage.setItem('saved',document.querySelector('#saved').textContent)` : ""}})</script></html>`
      );
      return;
    }
    if (path === "/baseline") {
      // Préversion de base : même hôte, autre SHA annoncé, pour exercer le tour
      // de comparaison `QA_BASELINE_URL_TEMPLATE` sans changer d'infrastructure.
      res.writeHead(200, {
        "Content-Type": "text/html",
        "x-commit-sha": BASE_SHA,
      });
      res.end(
        '<!doctype html><html lang="en"><title>QA baseline fixture</title><h1>Baseline</h1></html>'
      );
      return;
    }
    if (path === "/download") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Disposition": 'attachment; filename="report.txt"',
        "x-commit-sha": SHA,
      });
      res.end("QA download evidence");
      return;
    }
    if (path === "/popup") {
      res.writeHead(200, { "Content-Type": "text/html", "x-commit-sha": SHA });
      res.end("<!doctype html><h1>Popup evidence</h1>");
      return;
    }
    if (path === "/typographie" || path === "/typographie-double") {
      // Noms accessibles qui ne diffèrent du plan que par la graphie de
      // l'apostrophe : le cas réel où le plan recopie U+0027 et la page expose
      // U+2019. La seconde page en expose deux, pour prouver qu'aucune n'est
      // choisie quand elles se concurrencent.
      const labels =
        path === "/typographie"
          ? [
              '<label for="justification">Justification de l\u2019écart</label><textarea id="justification"></textarea>',
            ]
          : [
              '<label for="droite">Justification de l\u2019écart</label><textarea id="droite"></textarea>',
              '<label for="gauche">Justification de l\u2018écart</label><textarea id="gauche"></textarea>',
            ];
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "x-commit-sha": SHA,
      });
      res.end(
        `<!doctype html><html lang="fr"><body>${labels.join("")}</body></html>`
      );
      return;
    }
    if (path.startsWith("/typographie-texte")) {
      // Textes et placeholders qui ne diffèrent du plan que par la graphie de
      // l'apostrophe : le plan recopie U+0027, la page expose U+2019. Le titre
      // de la page garde le texte des ancêtres différent de chaque graphie,
      // pour que `getByText` exact ne résolve que le paragraphe visé. Les deux
      // libellés longs portent trois puis quatre signes repliables (27 et 81
      // graphies), au-delà du plafond historique de 16 : la mesure y retombait
      // sur la graphie brute. Les suffixes `-double` et `-triple` font
      // concurrencer les graphies ou en répètent une seule.
      const suffix = ["-double", "-triple"].find((item) => path.endsWith(item));
      const route = path.slice(0, path.length - (suffix?.length ?? 0));
      let label = "Justification de l'écart";
      if (route.endsWith("-long-four")) {
        label = "l'écart d'espèces n'est pas justifié par l'opérateur";
      } else if (route.endsWith("-long")) {
        label = "l'écart d'espèces n'est pas justifié";
      }
      const spelled = label.replace(/'/g, "\u2019");
      const shifted = label.replace(/'/g, "\u2018");
      let spellings = [spelled];
      if (suffix === "-double") {
        spellings = [spelled, shifted];
      } else if (suffix === "-triple") {
        spellings = [spelled, spelled, spelled];
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "x-commit-sha": SHA,
      });
      res.end(
        `<!doctype html><html lang="fr"><body><h1>Écart</h1><main>${spellings
          .map(
            (spelling, index) =>
              `<p id="ligne-${index}">${spelling}</p><input id="champ-${index}" placeholder="${spelling}">`
          )
          .join("")}</main></body></html>`
      );
      return;
    }
    if (
      req.method === "POST" &&
      (path === "/fixture-seed" || path === "/fixture-cleanup")
    ) {
      fixtureCalls.push({
        path,
        key: req.headers["idempotency-key"] as string | undefined,
      });
      json(res, { ok: true });
      return;
    }
    if (path === "/version.json") {
      json(res, { sha: options.noSha ? BASE_SHA : SHA });
      return;
    }
    if (path.startsWith("/repos/fixture/app/pulls/1/files")) {
      if (options.changedFiles) {
        json(
          res,
          options.changedFiles.map((file) => ({ ...file, status: "modified" }))
        );
        return;
      }
      json(res, [
        {
          filename: "src/form.ts",
          status: "modified",
          ...(options.missingDiffAndContext
            ? {}
            : {
                patch:
                  options.formPatch ??
                  "- show('Hello')\n+ show('Welcome '+name)",
              }),
        },
        ...(options.secondChangedFile
          ? [
              {
                filename: options.secondChangedFile,
                status: "modified",
                ...(options.missingDiffAndContext
                  ? {}
                  : {
                      patch: `+ const witness = "${SECOND_FILE_QUOTE}";`,
                    }),
              },
            ]
          : []),
      ]);
      return;
    }
    if (path.startsWith(`/repos/fixture/app/compare/${BASE_SHA}...${SHA}`)) {
      json(res, {
        merge_base_commit: { sha: options.mergeBaseSha ?? BASE_SHA },
      });
      return;
    }
    if (path === "/repos/fixture/app/pulls/1") {
      prReads++;
      json(res, {
        title: "Welcome users by name",
        body: "Save the name via the form",
        state: "open",
        changed_files:
          options.changedFiles?.length ?? (options.secondChangedFile ? 2 : 1),
        head: {
          sha: options.updatedSha && prReads >= 3 ? BASE_SHA : SHA,
          repo: { full_name: "fixture/app" },
        },
        base: { sha: BASE_SHA, repo: { full_name: "fixture/app" } },
      });
      return;
    }
    if (path.includes("/contents/.canary/qa.json")) {
      if (
        options.requireWriteEvidence === undefined &&
        options.approvedSkips === undefined
      ) {
        json(res, { message: "Not Found" }, 404);
        return;
      }
      json(res, {
        encoding: "base64",
        content: Buffer.from(
          JSON.stringify({
            version: 1,
            requireWriteEvidence: options.requireWriteEvidence,
            approvedSkips: options.approvedSkips,
          })
        ).toString("base64"),
      });
      return;
    }
    if (path.includes("/contents/")) {
      if (options.missingDiffAndContext) {
        json(res, { message: "Not Found" }, 404);
        return;
      }
      json(res, {
        encoding: "base64",
        content: Buffer.from(
          options.headContent ??
            "Use the Name textbox and Save button; status displays Welcome <name>"
        ).toString("base64"),
      });
      return;
    }
    if (path.startsWith("/repos/fixture/app/deployments?")) {
      json(res, [{ id: 42, sha: SHA, environment: "preview" }]);
      return;
    }
    if (path === "/repos/fixture/app/deployments/42/statuses?per_page=1") {
      json(res, [{ state: "inactive", environment_url: baseUrl }]);
      return;
    }
    if (path === "/v1/chat/completions") {
      completionRequests++;
      if (modelResets > 0) {
        modelResets -= 1;
        // Une socket détruite avant toute réponse : c'est le ECONNRESET réel,
        // celui qui laisse "terminated" côté client.
        req.socket.destroy();
        return;
      }
      const payload = await body(req);
      const refused = completionsStatuses.shift() ?? options.completionsStatus;
      if (refused) {
        // Le corps est lu avant la réponse, comme un vrai endpoint : la requête
        // n'est pas un plan, elle n'est donc pas enregistrée dans modelRequests.
        json(
          res,
          { error: { message: "fixture refusal" } },
          refused,
          options.retryAfter ? { "Retry-After": options.retryAfter } : undefined
        );
        return;
      }
      modelRequests.push(payload);
      const messages = payload.messages as { role: string; content: string }[];
      let value: unknown;
      let raw: string | undefined;
      let finishReason = "stop";
      /** Usage annoncé au-delà de la borne transmise, pour un endpoint qui l'ignore. */
      let reportedOutput: number | undefined;
      if (messages[0]?.content.startsWith("You are a connection diagnostic")) {
        value = { ok: true };
      } else if (messages[0]?.content.startsWith("You plan")) {
        if (modelOverBound > 0) {
          modelOverBound -= 1;
          // Le champ de limite est ignoré : la réponse est complète, mais son
          // usage annonce une sortie plus lourde que la borne demandée.
          reportedOutput = Number(payload.max_tokens) + 1000;
        }
        if (modelUnreadable > 0) {
          modelUnreadable -= 1;
          // Réponse complète mais hors schéma : le contenu n'est pas du JSON.
          raw = options.unreadableContent ?? "I cannot produce a plan here.";
        } else if (modelIncomplete > 0) {
          modelIncomplete -= 1;
          // Génération arrêtée par la borne de sortie : un JSON resté ouvert,
          // la signature d'un MODEL_OUTPUT_INCOMPLETE.
          raw =
            options.incompleteContent ??
            '{"summary":"Cut before the end of the plan","scenarios":[{"id":"welcome"';
          finishReason = "length";
        } else {
          const scripted =
            options.plans?.[planRequests] ?? options.plans?.at(-1);
          planRequests++;
          value = options.noScenarios
            ? {
                summary: "No browser changes",
                scenarios: [],
                skipped: [{ sourceFile: "src/form.ts", reason: "fixture" }],
              }
            : structuredClone(scripted ?? plan);
          if (options.unnamedStatus && !options.noScenarios) {
            (value as Plan).scenarios[0]!.assertions[0]!.target = {
              by: "role",
              value: "status",
              name: "",
            };
          }
        }
      } else {
        // L'exécuteur rejoue le contrat figé et ne consulte plus le modèle : un
        // appel d'exécution ici est une régression, jamais une réponse à scripter.
        json(
          res,
          { error: { message: "Unexpected model prompt during execution" } },
          500
        );
        return;
      }
      const text = raw ?? JSON.stringify(value);
      if (payload.stream === true) {
        if (modelTruncations > 0) {
          modelTruncations -= 1;
          // Flux fermé proprement, sans marqueur terminal : c'est la coupure que
          // le client refuse au lieu d'accepter un plan tronqué.
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "{" }, index: 0 }] })}\n\n`
          );
          res.end();
          return;
        }
        sse(res, text, finishReason, reportedOutput ?? 7);
        return;
      }
      json(res, {
        choices: [
          {
            message: { content: text },
            finish_reason: finishReason,
          },
        ],
        ...(reportedOutput === undefined
          ? {}
          : {
              usage: {
                completion_tokens: reportedOutput,
                prompt_tokens: 11,
                total_tokens: 11 + reportedOutput,
              },
            }),
      });
      return;
    }
    if (req.method === "GET" && path.includes("/comments?")) {
      json(res, comments);
      return;
    }
    if (
      req.method === "PATCH" &&
      path.startsWith("/repos/fixture/app/issues/comments/")
    ) {
      const payload = await body(req);
      const comment = comments.find(
        (item) => item.id === Number(path.split("/").at(-1))
      );
      if (!comment) {
        json(res, { error: "Comment not found" }, 404);
        return;
      }
      comment.body = String(payload.body);
      outgoing.push({ path, payload });
      json(res, { html_url: `${PR_URL}#issuecomment-${comment.id}` });
      return;
    }
    if (
      req.method === "POST" &&
      (path.includes("/statuses/") || path.endsWith("/comments"))
    ) {
      outgoing.push({ path, payload: await body(req) });
      if (path.endsWith("/comments")) {
        comments.push({
          id: comments.length + 1,
          body: String(outgoing.at(-1)!.payload.body),
          user: { type: "Bot" },
        });
      }
      json(
        res,
        path.endsWith("/comments")
          ? { html_url: `${PR_URL}#issuecomment-1` }
          : { state: "ok" }
      );
      return;
    }
    json(res, { error: `Unknown fixture path ${path}` }, 404);
  }
  await new Promise<void>((done) =>
    server.listen(0, options.listenHost ?? "127.0.0.1", done)
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No fixture address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const dataDir = await mkdtemp(join(tmpdir(), "canary-pr-qa-test-"));
  const config = loadConfig({
    QA_ALLOW_PRIVATE_PREVIEWS: "true",
    GITHUB_API_URL: baseUrl,
    GITHUB_TOKEN: "fixture-token",
    GITHUB_ALLOWED_REPOS: "fixture/app",
    OPENAI_BASE_URL: `${baseUrl}/v1`,
    OPENAI_MODEL: "fixture-scripted-model",
    QA_DATA_DIR: dataDir,
    PREVIEW_ALLOWED_HOSTS: [address.port, baseServer?.port]
      .filter((port) => port !== undefined)
      .map((port) => `127.0.0.1:${port}`)
      .join(","),
    QA_API_TOKEN: "fixture-api-token-123456789012345",
    // Les plans du fixture sont scriptés envoi par envoi : la sonde de vues,
    // active par défaut, consommerait un plan destiné à une correction ou à une
    // réécriture. Un test qui la vise l'active (`QA_VIEW_PROBE: true`).
    QA_VIEW_PROBE: "false",
    ...options.env,
  });
  return {
    config,
    baseUrl,
    outgoing,
    modelRequests,
    fixtureCalls,
    /** Nombre d'envois reçus par `chat/completions`, réponse ou refus confondus. */
    completionRequests: () => completionRequests,
    catalogRequests,
    dataDir,
    /** Origine de la préversion de base, quand `baseApp` est fourni. */
    baseAppUrl: baseServer?.url,
    setBaseSha: baseServer?.setSha,
    close: async () => {
      await baseServer?.close();
      await new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
    },
  };
}

/** Le formulaire de la préversion de base, sur son propre port. */
async function serveBaseApp(app: {
  greeting: string;
  sha?: string;
  /** Libellé du bouton d'envoi (défaut « Save », celui du plan). */
  button?: string;
}) {
  let sha = app.sha ?? BASE_SHA;
  const server = createServer((req, res) => {
    if ((req.url ?? "/") !== "/") {
      json(res, { error: "Unknown base path" }, 404);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "x-commit-sha": sha,
    });
    res.end(
      `<!doctype html><html lang="en"><title>QA base fixture</title><h1>Welcome form</h1><form><label for="name">Name</label><input id="name" name="name"><button type="submit">${app.button ?? "Save"}</button></form><p role="status" id="saved"></p><script>document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();document.querySelector('#saved').textContent=${JSON.stringify(app.greeting)}+document.querySelector('#name').value})</script></html>`
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No base fixture address");
  }
  return {
    port: address.port,
    /** Redéploie la base sur un autre SHA, en cours de run. */
    setSha: (next: string) => {
      sha = next;
    },
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/**
 * Copie de citation refusée par `REQUIREMENT_UNGROUNDED`, mesurée sur un run
 * réel du fork : le rapport complet est conservé dans `qa-data/<runId>`, et
 * `quote` comme `realLine` sont les octets d'origine — la ligne vient du fichier
 * au SHA publié par le run, donc le cas se rejoue sans réseau. Le corpus est la
 * mesure du lot O (PR pharmania/arpilabe-pilotage#17, SHA 814b6713) et des lots
 * G à K, dont les refus remontent au 14 octobre 2026.
 *
 * Chaque entrée est vérifiée contre l'artefact du run — le scénario, le rang,
 * le fichier déclaré et la citation du plan, octet pour octet — et la ligne
 * réelle est confirmée par les refus eux-mêmes quand le gate la nomme, ou par
 * les citations acceptées d'autres runs quand elle y apparaît mot pour mot.
 */
export interface MeasuredCopyRefusal {
  /**
   * Répartition mesurée de la cause : `a-floor` une copie EXACTE refusée par
   * l'ancien plancher de contenu, qui comptait les blancs — le proxy est retiré
   * du contrat, donc ces copies sont acceptées depuis ; `b-altered` et
   * `b-invented` une copie altérée ou inventée par le planificateur ;
   * `c-misattributed` un texte exact attribué à un fichier qui ne le porte pas ;
   * `d-stitched` deux fragments recousus.
   */
  cause:
    | "a-floor"
    | "b-altered"
    | "b-invented"
    | "c-misattributed"
    | "d-stitched";
  /** Fichier que le plan déclarait pour cette citation. */
  declaredFile: string;
  /** Ce que la copie change par rapport à `realLine`, mesuré caractère à caractère. */
  fault: string;
  /** Fichier qui porte réellement `realLine`. */
  lineFile: string;
  /** Numéro de `realLine` dans `lineFile` ; 0 quand aucune ligne ne la porte. */
  lineNumber: number;
  measuredAt: string;
  /**
   * Verdict du contrat actuel sur cette copie mesurée : `accepted` quand elle
   * est exacte et porte une lettre ou un chiffre visibles — les quatre copies
   * `a-floor` —, `refused` quand elle est altérée, inventée, recousue ou
   * attribuée à un fichier qui ne la porte pas.
   */
  outcome: "accepted" | "refused";
  /** La citation telle que le plan la portait, octet pour octet. */
  quote: string;
  /** Rang de l'exigence dans le scénario, celui que le refus nomme. */
  rank: number;
  /** La ligne réelle, octet pour octet. Vide quand le texte cité n'existe nulle part. */
  realLine: string;
  /**
   * Ce que le refus MESURÉ disait de la ligne — trace du run d'origine, puisque
   * une copie `accepted` n'est plus refusée : `names-line` la ligne réelle et son
   * numéro, `names-other-file` le fichier qui porte la citation exacte,
   * `generic` aucun des deux.
   */
  remedy: "names-line" | "names-other-file" | "generic";
  /** Run d'origine du refus — le rapport et son diagnostic y sont conservés. */
  runId: string;
  scenarioId: string;
}
export const MEASURED_COPY_REFUSALS: MeasuredCopyRefusal[] = [
  {
    runId: "9ee36233-f353-41ff-a2ea-ca175b150a5b",
    measuredAt: "2026-10-14T09:46:00.114Z",
    scenarioId: "cash-cents-no-float-drift",
    rank: 2,
    declaredFile: "packages/domain/src/__tests__/cash.spec.ts",
    lineFile: "packages/domain/src/__tests__/cash.spec.ts",
    lineNumber: 0,
    realLine: "",
    quote: "expect(total(result)).toBe(170);",
    cause: "b-invented",
    outcome: "refused",
    remedy: "generic",
    fault:
      "aucune ligne du fichier ne porte ce texte : la valeur attendue est inventée",
  },
  {
    runId: "9ee36233-f353-41ff-a2ea-ca175b150a5b",
    measuredAt: "2026-10-14T09:46:00.114Z",
    scenarioId: "cash-cents-no-float-drift",
    rank: 4,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 389,
    realLine:
      '        <div className="relative overflow-hidden rounded-2xl bg-[#08086f] p-5 text-white"><div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-[#912cff]/45"/><p className="relative text-sm text-white/60">Total compté</p><p className="relative mt-2 text-2xl font-bold">{counted.ok?formatAmountFr(centsToEuros(counted.totalCents)):"—"}</p><div className="relative my-4 border-t border-white/10"/><p className="relative text-sm text-white/60">Écart, compté − attendu</p><p className="relative mt-2 text-2xl font-bold">{variance===null?"—":formatAmountFr(centsToEuros(variance))}</p></div>',
    quote: "formatAmountFr(centsToEuros(counted.totalCents))",
    cause: "a-floor",
    outcome: "accepted",
    remedy: "generic",
    fault:
      "la copie est exacte mais d'un seul jeton : sous le plancher de contenu, donc sans témoin",
  },
  {
    runId: "9ee36233-f353-41ff-a2ea-ca175b150a5b",
    measuredAt: "2026-10-14T09:46:00.114Z",
    scenarioId: "cash-cents-no-float-drift",
    rank: 5,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 368,
    realLine: `          <span className="rounded-full bg-[#f1f2f8] px-2.5 py-1 text-xs font-bold text-[#74758d]">{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}\`:"—"}</span>`,
    quote: `{counted.totalUnits} unité\${counted.totalUnits>1?"s":"":""} comptée`,
    cause: "b-altered",
    outcome: "refused",
    remedy: "names-line",
    fault: `la copie insère \`:\\"\\"\` et s'arrête au milieu de la ligne`,
  },
  {
    runId: "36926219-c46c-4431-9f45-8419a919b758",
    measuredAt: "2026-10-14T12:14:15.334Z",
    scenarioId: "cash-balance-close-lock",
    rank: 3,
    declaredFile: "packages/domain/src/cash.ts",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 368,
    realLine: `          <span className="rounded-full bg-[#f1f2f8] px-2.5 py-1 text-xs font-bold text-[#74758d]">{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}\`:"—"}</span>`,
    quote: `\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}\``,
    cause: "c-misattributed",
    outcome: "refused",
    remedy: "names-other-file",
    fault:
      "citation exacte de la ligne, attribuée à un fichier qui ne la porte pas",
  },
  {
    runId: "94e86f2b-9fc5-4916-884a-70576bdf131f",
    measuredAt: "2026-10-15T15:54:31.372Z",
    scenarioId: "s3-quantite-decimale-refusee",
    rank: 4,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 372,
    realLine: `          <Input value={session.quantities[String(d.cents)]??""} onChange={e=>setQuantity(d.cents,e.target.value)} disabled={closed} inputMode="numeric" aria-label={\`Quantité · \${d.label}\`} aria-invalid={invalid||undefined} className="h-10 rounded-lg bg-[#fbfcff] text-right font-semibold"/>`,
    quote: "aria-invalid={invalid||undefined}",
    cause: "a-floor",
    outcome: "accepted",
    remedy: "generic",
    fault:
      "la copie est exacte mais d'un seul jeton : sous le plancher de contenu, donc sans témoin",
  },
  {
    runId: "94e86f2b-9fc5-4916-884a-70576bdf131f",
    measuredAt: "2026-10-15T15:54:31.372Z",
    scenarioId: "s3-quantite-decimale-refusee",
    rank: 5,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 386,
    realLine:
      '        <div className="mt-6 flex flex-wrap items-center justify-between gap-3"><span role="status" className="text-sm font-semibold text-[#16865b]">{message}</span><Button onClick={close} disabled={closed||!counted.ok} className="h-11 rounded-xl bg-[#08086f] px-5 hover:bg-[#24249a]">Clôturer la session</Button></div>',
    quote: "disabled={closed||!counted.ok}",
    cause: "a-floor",
    outcome: "accepted",
    remedy: "generic",
    fault:
      "la copie est exacte mais d'un seul jeton : sous le plancher de contenu, donc sans témoin",
  },
  {
    runId: "71cb3369-cd3b-4fc0-a18d-7c5e1579f0f0",
    measuredAt: "2026-10-15T16:06:16.122Z",
    scenarioId: "caisse-comptage-juste-cloture",
    rank: 3,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 356,
    realLine:
      '  return <div className="mx-auto max-w-6xl space-y-5" data-cash-state={closed?"cloture":"ouvert"}>',
    quote: 'data-cash-state={closed?"cloture":"ouvert"}',
    cause: "a-floor",
    outcome: "accepted",
    remedy: "generic",
    fault:
      "la copie est exacte mais d'un seul jeton : sous le plancher de contenu, donc sans témoin",
  },
  {
    runId: "71cb3369-cd3b-4fc0-a18d-7c5e1579f0f0",
    measuredAt: "2026-10-15T16:06:16.122Z",
    scenarioId: "caisse-comptage-juste-cloture",
    rank: 8,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 368,
    realLine: `          <span className="rounded-full bg-[#f1f2f8] px-2.5 py-1 text-xs font-bold text-[#74758d]">{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}\`:"—"}</span>`,
    quote: `\${counted.totalUnits} unité\${counted.totalUnits>1?"s":"":""} comptée\${counted.totalUnits>1?"s":""}`,
    cause: "b-altered",
    outcome: "refused",
    remedy: "names-line",
    fault: `la copie insère \`:\\"\\"\` après le premier \`?\\"s\\":\\"\\"\``,
  },
  {
    runId: "c7d46e91-7a30-4f79-aae9-e6fd88a63228",
    measuredAt: "2026-10-15T22:20:42.728Z",
    scenarioId: "caisse-quantite-decimale-refusee",
    rank: 1,
    declaredFile: "packages/domain/src/__tests__/cash.spec.ts",
    lineFile: "packages/domain/src/__tests__/cash.spec.ts",
    lineNumber: 56,
    realLine: '    expect(countCash({ "200": "abc" }).ok).toBe(false);',
    quote: 'expect(countCash({ "500": "3,5" }).ok).toBe(false);',
    cause: "b-invented",
    outcome: "refused",
    remedy: "names-line",
    fault: `la ligne attendue n'existe pas : la plus proche porte \`\\"200\\"\`: \`\\"abc\\"\` ; le refus propose une autre assertion`,
  },
  {
    runId: "973cf40f-d087-480a-a5bc-1bf9b77aa336",
    measuredAt: "2026-10-15T22:37:43.239Z",
    scenarioId: "cash-decimal-quantity-refused",
    rank: 2,
    declaredFile: "packages/domain/src/__tests__/cash.spec.ts",
    lineFile: "packages/domain/src/__tests__/cash.spec.ts",
    lineNumber: 56,
    realLine: '    expect(countCash({ "200": "abc" }).ok).toBe(false);',
    quote: 'expect(countCash({ "500": "3,5" }).ok).toBe(false);',
    cause: "b-invented",
    outcome: "refused",
    remedy: "names-line",
    fault: `la ligne attendue n'existe pas : la plus proche porte \`\\"200\\"\`: \`\\"abc\\"\` ; le refus propose une autre assertion`,
  },
  {
    runId: "925abf20-34f6-4be8-88f2-56f9b544ed50",
    measuredAt: "2026-10-16T01:26:05.921Z",
    scenarioId: "caisse-montant-attendu-illisible",
    rank: 1,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 378,
    realLine:
      '            <Input value={session.expected} onChange={e=>onChange({expected:e.target.value})} disabled={closed} inputMode="decimal" aria-label="Montant d’espèces attendu" aria-invalid={expected.ok?undefined:true} className="mt-2 h-11 rounded-xl bg-[#fbfcff] font-semibold"/>',
    quote: 'inputMode="decimal" aria-invalid={expected.ok?undefined:true}',
    cause: "d-stitched",
    outcome: "refused",
    remedy: "names-line",
    fault: `la copie recoud deux fragments de la même ligne en sautant \`aria-label=\\"Montant d’espèces attendu\\"\``,
  },
  {
    runId: "2c0ce681-a024-4443-8f86-dff0830cded9",
    measuredAt: "2026-10-16T01:59:09.407Z",
    scenarioId: "cash-count-balanced-closure",
    rank: 4,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 354,
    realLine: `  const close=()=>{if(!counted.ok){setMessage("Quantité illisible : corrigez la ligne signalée avant de clôturer.");return}if(expectedCents===null){setMessage("Montant d’espèces attendu manquant ou illisible.");return}if(closure?.blocking){setMessage(\`Écart de \${formatAmountFr(centsToEuros(closure.varianceCents))} : une justification écrite est obligatoire avant clôture.\`);return}onChange({closedAt:new Date().toISOString()});setMessage("Session clôturée : le comptage est verrouillé.")};`,
    quote:
      'onChange({closedAt:new Date().toISOString()});setMessage("Session clôturée : le comptage est verrouillé.");',
    cause: "b-altered",
    outcome: "refused",
    remedy: "names-line",
    fault: `la copie écrit \`\\");\` là où la ligne écrit \`\\")};\``,
  },
  {
    runId: "2f0511fd-3085-434d-a67b-457cf9e8845c",
    measuredAt: "2026-10-16T08:14:39.228Z",
    scenarioId: "caisse-comptage-juste-et-cloture",
    rank: 5,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 368,
    realLine: `          <span className="rounded-full bg-[#f1f2f8] px-2.5 py-1 text-xs font-bold text-[#74758d]">{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}\`:"—"}</span>`,
    quote: `\${counted.totalUnits} unité\${counted.totalUnits>1?"s":"":""} comptée\${counted.totalUnits>1?"s":""}`,
    cause: "b-altered",
    outcome: "refused",
    remedy: "names-line",
    fault: `la copie insère \`:\\"\\"\` ; elle laisse aussi de côté le début et la fin de la ligne`,
  },
  {
    runId: "f328177b-efd8-4b75-b3cb-14810d32692a",
    measuredAt: "2026-10-16T11:39:12.184Z",
    scenarioId: "pieces-unites-sans-derive",
    rank: 3,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 368,
    realLine: `          <span className="rounded-full bg-[#f1f2f8] px-2.5 py-1 text-xs font-bold text-[#74758d]">{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}\`:"—"}</span>`,
    quote: `unité\${counted.totalUnits>1?"s":"":""} comptée\${counted.totalUnits>1?"s":""}`,
    cause: "b-altered",
    outcome: "refused",
    remedy: "names-line",
    fault: `la copie insère \`:\\"\\"\` ; elle commence à \`unité\`, donc son début est manquant`,
  },
  {
    runId: "0f8d8cd5-483a-4dc4-a133-edbe8445f509",
    measuredAt: "2026-10-16T20:52:45.427Z",
    scenarioId: "cash-exact-count-close-reopen",
    rank: 7,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 368,
    realLine: `          <span className="rounded-full bg-[#f1f2f8] px-2.5 py-1 text-xs font-bold text-[#74758d]">{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}\`:"—"}</span>`,
    quote: `{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":"":""} comptée\${counted.totalUnits>1?"s":""}\`:"—"}`,
    cause: "b-altered",
    outcome: "refused",
    remedy: "names-line",
    fault: `la copie insère \`:\\"\\"\` après le premier \`?\\"s\\":\\"\\"\``,
  },
  {
    runId: "7eef87d4-5030-464f-919b-e9667312aa8e",
    measuredAt: "2026-10-16T21:04:00.597Z",
    scenarioId: "caisse-comptage-par-pharmacie",
    rank: 1,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 76,
    realLine:
      "  const updateCash=(patch:Partial<CashSession>)=>setCashByPharmacy(sessions=>({...sessions,[pharmacyCode]:{...(sessions[pharmacyCode]??emptyCashSession),...patch}}));",
    quote:
      "const updateCash=(patch:Partial<CashSession>)=>setCashByPharmacy(sessions=>({...sessions,[pharmacyCode]:{...(sessions[pharmacyCode]??emptyCashSession),...patch}});",
    cause: "b-altered",
    outcome: "refused",
    remedy: "generic",
    fault: "la copie perd une `)` de la ligne ; le refus ne nomme aucune ligne",
  },
  {
    runId: "2f899cb1-cd1c-42e5-a49d-b47a7e65e1d0",
    measuredAt: "2026-10-17T22:11:54.110Z",
    scenarioId: "caisse-comptage-juste",
    rank: 3,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 368,
    realLine: `          <span className="rounded-full bg-[#f1f2f8] px-2.5 py-1 text-xs font-bold text-[#74758d]">{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}\`:"—"}</span>`,
    quote: `\${counted.totalUnits} unité\${counted.totalUnits>1?"s":"":""} comptée\${counted.totalUnits>1?"s":""}`,
    cause: "b-altered",
    outcome: "refused",
    remedy: "names-line",
    fault: `la copie insère \`:\\"\\"\` après le premier \`?\\"s\\":\\"\\"\``,
  },
  {
    runId: "049d7efb-a764-4d1c-b817-c06653f39c8d",
    measuredAt: "2026-10-17T22:19:50.072Z",
    scenarioId: "caisse-comptage-juste-et-cloture",
    rank: 3,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 368,
    realLine: `          <span className="rounded-full bg-[#f1f2f8] px-2.5 py-1 text-xs font-bold text-[#74758d]">{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}\`:"—"}</span>`,
    quote: `{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":"":""} comptée\${counted.totalUnits>1?"s":"":""}\`:"—"}`,
    cause: "b-altered",
    outcome: "refused",
    remedy: "names-line",
    fault: `la copie insère \`:\\"\\"\` dans les DEUX ternaires de la ligne`,
  },
  {
    runId: "a6cd72ae-bdc8-42d6-8caa-d4ea93188c2a",
    measuredAt: "2026-10-19T14:11:16.574Z",
    scenarioId: "caisse-comptage-par-pharmacie",
    rank: 2,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 368,
    realLine: `          <span className="rounded-full bg-[#f1f2f8] px-2.5 py-1 text-xs font-bold text-[#74758d]">{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}\`:"—"}</span>`,
    quote: `\${counted.totalUnits} unité\${counted.totalUnits>1?"s":"":""} comptée\${counted.totalUnits>1?"s":"":""}`,
    cause: "b-altered",
    outcome: "refused",
    remedy: "names-line",
    fault: `la copie insère \`:\\"\\"\` après chaque \`?\\"s\\":\\"\\"\` et laisse de côté le début et la fin de la ligne`,
  },
  {
    runId: "9add286d-044f-448f-a472-3dd2a796cd11",
    measuredAt: "2026-10-19T21:01:42.923Z",
    scenarioId: "caisse-comptage-juste-cloture",
    rank: 2,
    declaredFile: "apps/web/app/page.tsx",
    lineFile: "apps/web/app/page.tsx",
    lineNumber: 368,
    realLine: `          <span className="rounded-full bg-[#f1f2f8] px-2.5 py-1 text-xs font-bold text-[#74758d]">{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}\`:"—"}</span>`,
    quote: `\${counted.totalUnits} unité\${counted.totalUnits>1?"s":"":""}`,
    cause: "b-altered",
    outcome: "refused",
    remedy: "names-line",
    fault: `la copie insère \`:\\"\\"\` à l'offset 56 et s'arrête au milieu de la ligne : trois caractères de plus qu'un témoin exact`,
  },
];
/**
 * Patch minimal qui place `text` à la ligne `line` du nouveau fichier : c'est le
 * matériel hors ligne de la ligne réelle mesurée, pour rejouer une copie refusée
 * et vérifier que le gate accepte la ligne qu'elle a ratée.
 */
export function lineAt(file: string, line: number, text: string) {
  return { filename: file, patch: `@@ -${line},1 +${line},1 @@\n+${text}` };
}
