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
export function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
/**
 * Réponse `text/event-stream` : deltas partiels (dont un delta de raisonnement), usage final
 * puis `[DONE]`. Le contenu est coupé sur une frontière sûre pour forcer un vrai recollage.
 */
export function sse(res: ServerResponse, text: string) {
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
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      usage: { completion_tokens: 7, prompt_tokens: 11, total_tokens: 18 },
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
    /** Variables d'environnement ajoutées à la configuration du fixture. */
    env?: Record<string, string>;
  } = {}
) {
  const outgoing: { path: string; payload: Record<string, unknown> }[] = [];
  const comments: { id: number; body: string; user: { type: string } }[] = [];
  const modelRequests: Record<string, unknown>[] = [];
  const catalogRequests: string[] = [];

  let prReads = 0;
  let planRequests = 0;
  let modelResets = options.modelResets ?? 0;
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
    if (path === "/version.json") {
      json(res, { sha: options.noSha ? BASE_SHA : SHA });
      return;
    }
    if (path.startsWith("/repos/fixture/app/pulls/1/files")) {
      json(res, [
        {
          filename: "src/form.ts",
          status: "modified",
          ...(options.missingDiffAndContext
            ? {}
            : { patch: "- show('Hello')\n+ show('Welcome '+name)" }),
        },
      ]);
      return;
    }
    if (path === "/repos/fixture/app/pulls/1") {
      prReads++;
      json(res, {
        title: "Welcome users by name",
        body: "Save the name via the form",
        state: "open",
        changed_files: 1,
        head: {
          sha: options.updatedSha && prReads >= 3 ? BASE_SHA : SHA,
          repo: { full_name: "fixture/app" },
        },
        base: { sha: BASE_SHA, repo: { full_name: "fixture/app" } },
      });
      return;
    }
    if (path.includes("/contents/.canary/qa.json")) {
      if (options.requireWriteEvidence === undefined) {
        json(res, { message: "Not Found" }, 404);
        return;
      }
      json(res, {
        encoding: "base64",
        content: Buffer.from(
          JSON.stringify({
            version: 1,
            requireWriteEvidence: options.requireWriteEvidence,
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
      if (modelResets > 0) {
        modelResets -= 1;
        // Une socket détruite avant toute réponse : c'est le ECONNRESET réel,
        // celui qui laisse "terminated" côté client.
        req.socket.destroy();
        return;
      }
      const payload = await body(req);
      modelRequests.push(payload);
      const messages = payload.messages as { role: string; content: string }[];
      let value: unknown;
      if (messages[0]?.content.startsWith("You are a connection diagnostic")) {
        value = { ok: true };
      } else if (messages[0]?.content.startsWith("You plan")) {
        const scripted = options.plans?.[planRequests] ?? options.plans?.at(-1);
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
      const text = JSON.stringify(value);
      if (payload.stream === true) {
        sse(res, text);
        return;
      }
      json(res, {
        choices: [
          {
            message: { content: text },
            finish_reason: "stop",
          },
        ],
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
    PREVIEW_ALLOWED_HOSTS: `127.0.0.1:${address.port}`,
    QA_API_TOKEN: "fixture-api-token-123456789012345",
    ...options.env,
  });
  return {
    config,
    baseUrl,
    outgoing,
    modelRequests,
    catalogRequests,
    dataDir,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
