import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { GitHub } from "../src/github.js";
import { Model } from "../src/model.js";
import { DURABLE_USAGE_SQL } from "../src/production-server.js";
import { checkBudget, type RunScope, runScope } from "../src/run-scope.js";
import { fixture, PR_URL, pgliteQueue, SHA } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
it("refuses a billable model request before exceeding its configured cost ceiling", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const request = vi.spyOn(globalThis, "fetch");
  const config = {
    ...f.config,
    QA_INPUT_COST_PER_MILLION: 1,
    QA_OUTPUT_COST_PER_MILLION: 2,
  };
  await expect(
    runScope.run(
      {
        id: "cost-preflight",
        signal: new AbortController().signal,
        tokens: 0,
        costUsd: 0,
        reservedTokens: 0,
        reservedCostUsd: 0,
        calls: 0,
        maxTokens: 100_000,
        maxCostUsd: 0.000_01,
      },
      () =>
        new Model(config).json("JSON", {}, z.object({ ok: z.boolean() }), 1024)
    )
  ).rejects.toMatchObject({ code: "RUN_BUDGET_EXCEEDED" });
  expect(request).not.toHaveBeenCalled();
});
it("credits a lost attempt with the usage the stream reported, capped by that attempt's worst case", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const config = {
    ...f.config,
    QA_INPUT_COST_PER_MILLION: 1,
    QA_OUTPUT_COST_PER_MILLION: 2,
    QA_MODEL_RETRIES: 0,
  };
  // Le flux annonce un usage démesuré (500 000 + 900 000 tokens) puis casse :
  // la réserve crédible est mesurée, mais elle ne peut pas dépasser le pire cas
  // de la tentative perdue, sans quoi l'enveloppe qui couvrait cet appel ne
  // couvrirait plus sa propre réserve.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: "{" }, index: 0 }],
                usage: { prompt_tokens: 500_000, completion_tokens: 900_000 },
              })}\n\n`
            )
          );
        },
        // L'usage est livré, puis la connexion casse : c'est la coupure qui
        // laisse un usage partiel observable.
        pull(controller) {
          controller.error(new Error("socket hang up"));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" }, status: 200 }
    )
  );
  const scope: RunScope = {
    calls: 0,
    costUsd: 0,
    id: "credible-reserve",
    maxCostUsd: 0.01,
    maxTokens: 100_000,
    reservedCostUsd: 0,
    reservedTokens: 0,
    signal: new AbortController().signal,
    tokens: 0,
  };
  await expect(
    runScope.run(scope, () =>
      new Model(config).json(
        "You plan",
        { context: "x".repeat(300) },
        z.object({ ok: z.boolean() }),
        1000
      )
    )
  ).rejects.toThrowError("socket hang up");
  // Sortie maximale réservée (1000) plus l'entrée estimée au caractère : la
  // réserve reste au niveau du pire cas, très loin des 1 400 000 annoncés.
  expect(scope.reservedTokens).toBeGreaterThanOrEqual(1000);
  expect(scope.reservedTokens).toBeLessThan(5000);
  expect(scope.reservedCostUsd).toBeLessThanOrEqual(0.003);
  expect(scope.reservedTokens).toBeLessThanOrEqual(scope.maxTokens);
});
it("counts a lost attempt's reserve in the admission, so the envelope stays a hard bound", async () => {
  const scope: RunScope = {
    calls: 0,
    costUsd: 0,
    id: "hard-bound",
    maxCostUsd: 1,
    maxTokens: 1000,
    reservedCostUsd: 0,
    reservedTokens: 200,
    signal: new AbortController().signal,
    tokens: 900,
  };
  await runScope.run(scope, async () => {
    const attempt = async () => checkBudget();
    // 900 consommés + 200 de réserve = 1100 > 1000 : la réserve d'une tentative
    // perdue reste dans l'enveloppe, donc la prochaine tentative est refusée
    // avant tout envoi. Sans elle, 900 + 0 tiendrait et le budget ne bornerait
    // plus la dépense totale.
    await expect(attempt()).rejects.toMatchObject({
      code: "RUN_BUDGET_EXCEEDED",
    });
    scope.reservedTokens = 100;
    // 900 + 100 = 1000 : l'enveloppe est atteinte sans être dépassée.
    await expect(attempt()).resolves.toBeUndefined();
    await expect(async () => checkBudget(1, 0)).rejects.toMatchObject({
      code: "RUN_BUDGET_EXCEEDED",
    });
    // Même règle sur le coût : la réserve perdue compte dans le plafond.
    scope.maxCostUsd = 0.001;
    scope.costUsd = 0.0008;
    scope.reservedCostUsd = 0.0004;
    await expect(attempt()).rejects.toMatchObject({
      code: "RUN_BUDGET_EXCEEDED",
    });
  });
});
it("counts a lost attempt's reserve in the durable usage aggregates", async () => {
  const q = await pgliteQueue(cleanup);
  const blocked = await q.enqueue(
    "fixture/app",
    1,
    SHA,
    "alice",
    { prUrl: PR_URL },
    "lost-attempt"
  );
  const legacy = await q.enqueue(
    "fixture/app",
    1,
    SHA,
    "alice",
    { prUrl: PR_URL },
    "legacy-usage"
  );
  // Un run dont le seul appel s'est perdu : rien de consommé, une réserve
  // entière. Les jauges durables ne doivent pas publier zéro pour autant.
  await q.pool.query("UPDATE qa_jobs SET usage=$1::jsonb WHERE id=$2", [
    JSON.stringify({
      model: "fixture-model",
      tokens: 0,
      costUsd: 0,
      reservedTokens: 403_443,
      reservedCostUsd: 0.002,
    }),
    blocked.id,
  ]);
  // Un job écrit avant l'existence des réserves : sa contribution reste intacte.
  await q.pool.query("UPDATE qa_jobs SET usage=$1::jsonb WHERE id=$2", [
    JSON.stringify({ model: "fixture-model", tokens: 36, costUsd: 0.01 }),
    legacy.id,
  ]);
  const { rows } = await q.pool.query(DURABLE_USAGE_SQL);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ model: "fixture-model", tokens: 403_479 });
  expect(rows[0].cost as number).toBeCloseTo(0.012, 6);
});
it("finds the existing bot report beyond 100 human comments and updates it", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const github = new GitHub(f.config);
  const context = await github.context(PR_URL);
  const request = vi
    .spyOn(github, "request")
    .mockImplementation(async (path, method = "GET") => {
      if (method === "PATCH") {
        return { html_url: `${PR_URL}#issuecomment-444` };
      }
      if (path.endsWith("page=1")) {
        return Array.from({ length: 100 }, (_, i) => ({
          id: i,
          body: "Human discussion",
          user: { type: "User" },
        }));
      }
      if (path.endsWith("page=2")) {
        return [
          {
            id: 444,
            body: "<!-- canary-pr-qa -->\nold report",
            user: { type: "Bot" },
          },
        ];
      }
      throw new Error("Unexpected request / duplicate comment");
    });
  await expect(github.comment(context, "replacement")).resolves.toContain(
    "444"
  );
  expect(request).toHaveBeenCalledWith(
    "/repos/fixture/app/issues/comments/444",
    "PATCH",
    { body: "<!-- canary-pr-qa -->\nreplacement" }
  );
  expect(request.mock.calls.some(([, method]) => method === "POST")).toBe(
    false
  );
});
