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
/**
 * Flux SSE livré puis cassé net : le contenu et l'usage annoncés sont
 * observables, la connexion meurt ensuite — le cas rejouable du transport.
 */
function brokenStream(options: {
  content?: string;
  usage?: Record<string, number>;
}): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              choices: [
                { delta: { content: options.content ?? "" }, index: 0 },
              ],
              ...(options.usage ? { usage: options.usage } : {}),
            })}\n\n`
          )
        );
      },
      pull(controller) {
        controller.error(new Error("socket hang up"));
      },
    }),
    { headers: { "Content-Type": "text/event-stream" }, status: 200 }
  );
}
/** Flux SSE complet : contenu, usage puis marqueur terminal. */
function completeStream(
  content: string,
  usage: Record<string, number>
): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }], usage })}\n\ndata: [DONE]\n\n`
          )
        );
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" }, status: 200 }
  );
}
/** Périmètre de run borné par `maxTokens`, pour les tests d'admission. */
function budgetScope(maxTokens: number): RunScope {
  return {
    calls: 0,
    costUsd: 0,
    id: "budget-hole",
    maxCostUsd: 1,
    maxTokens,
    reservedCostUsd: 0,
    reservedTokens: 0,
    signal: new AbortController().signal,
    tokens: 0,
  };
}
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
it("credits a lost attempt with the usage the stream reported, capped by that attempt's worst case when no total is declared", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const config = {
    ...f.config,
    QA_INPUT_COST_PER_MILLION: 1,
    QA_OUTPUT_COST_PER_MILLION: 2,
    QA_MODEL_RETRIES: 0,
  };
  // Le flux annonce un usage démesuré (500 000 + 900 000 tokens) puis casse,
  // sans total déclaré : la réserve crédible est mesurée, mais elle ne peut pas
  // dépasser le pire cas de la tentative perdue, sans quoi l'enveloppe qui
  // couvrait cet appel ne couvrirait plus sa propre réserve. Un total annoncé,
  // lui, échappe à ce plafond (tests « declares an endpoint's overshoot » et
  // « refuses the retry of a lost attempt »).
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
  // Jamais négative : une réserve qui plafonne son volume ne crédite pas le
  // budget du run en facturant une sortie négative.
  expect(scope.reservedCostUsd).toBeGreaterThan(0);
  expect(scope.reservedTokens).toBeLessThanOrEqual(scope.maxTokens);
});
it("credits a measured reserve from a positive usage, and admits the retry it leaves room for", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const config = {
    ...f.config,
    QA_INPUT_COST_PER_MILLION: 1,
    QA_OUTPUT_COST_PER_MILLION: 2,
    QA_MODEL_RETRIES: 1,
  };
  const request = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      brokenStream({
        content: "{",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      })
    )
    .mockResolvedValueOnce(
      completeStream('{"ok":true}', {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      })
    );
  const scope = budgetScope(2000);
  await expect(
    runScope.run(scope, () =>
      new Model(config).json(
        "You plan",
        {},
        z.object({ ok: z.boolean() }),
        1000
      )
    )
  ).resolves.toEqual({ ok: true });
  // L'usage rapporté est une mesure positive : la réserve vaut les 150 tokens
  // annoncés — pas le pire cas de l'appel (1 000 + borne de l'entrée, 1 245 ici)
  // — et la reprise tient sous l'enveloppe (150 + 1 245 <= 2 000).
  expect(scope.reservedTokens).toBe(150);
  expect(scope.reservedCostUsd).toBeCloseTo(0.0002, 6);
  expect(scope.reservedTokens).toBeLessThan(1000);
  expect(request).toHaveBeenCalledTimes(2);
});
it("credits no measured reserve from a zero-filled usage, and refuses the retry it no longer covers", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const config = {
    ...f.config,
    QA_INPUT_COST_PER_MILLION: 1,
    QA_OUTPUT_COST_PER_MILLION: 2,
    QA_MODEL_RETRIES: 1,
  };
  // Le cas mesuré : l'endpoint livre du contenu et annonce usage:{0,0,0} puis
  // casse. Les compteurs nuls ne sont pas une mesure, la tentative est donc
  // chiffrée à sa borne théorique (1 000 de sortie + 245 d'entrée = 1 245) et
  // non à zéro. Sous 1 500, la réservation (1 245) est admise mais la reprise ne
  // tient plus (1 245 + 1 245 > 1 500) : elle est refusée avant tout envoi.
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    brokenStream({
      content: "{",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  );
  const scope = budgetScope(1500);
  await expect(
    runScope.run(scope, () =>
      new Model(config).json(
        "You plan",
        {},
        z.object({ ok: z.boolean() }),
        1000
      )
    )
  ).rejects.toMatchObject({ code: "RUN_BUDGET_EXCEEDED" });
  expect(scope.reservedTokens).toBe(1245);
  expect(scope.reservedCostUsd).toBeGreaterThan(0);
  expect(request).toHaveBeenCalledTimes(1);
});
it("admits the retry when the envelope still covers the theoretical bound of a zero-filled attempt", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const config = { ...f.config, QA_MODEL_RETRIES: 1 };
  const request = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      brokenStream({
        content: "{",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    )
    .mockResolvedValueOnce(
      completeStream('{"ok":true}', {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      })
    );
  const scope = budgetScope(3000);
  // Même tentative perdue que ci-dessus, sous une enveloppe qui couvre la borne
  // théorique ET la reprise (1 245 + 1 245 <= 3 000) : la reprise part, et la
  // perte reste déclarée à sa borne, jamais à zéro.
  await expect(
    runScope.run(scope, () =>
      new Model(config).json(
        "You plan",
        {},
        z.object({ ok: z.boolean() }),
        1000
      )
    )
  ).resolves.toEqual({ ok: true });
  expect(scope.reservedTokens).toBe(1245);
  expect(request).toHaveBeenCalledTimes(2);
});
it("refuses before sending a prompt the envelope cannot cover at the prudent input bound", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const request = vi.spyOn(globalThis, "fetch");
  const scope = budgetScope(3000);
  await expect(
    runScope.run(scope, () =>
      new Model(f.config).json(
        "y".repeat(6000),
        {},
        z.object({ ok: z.boolean() }),
        500
      )
    )
  ).rejects.toMatchObject({ code: "RUN_BUDGET_EXCEEDED" });
  // 6 097 octets de prompt valent au moins 3 241 tokens à la borne prudente :
  // avec la sortie maximale, l'appel ne tient pas dans 3 000 et n'est jamais
  // envoyé. Une réponse qui annoncerait ensuite 900 000 prompt_tokens n'a donc
  // plus de dépense à surprendre, là où l'estimation au caractère (2 033 tokens)
  // laissait l'appel partir avant de le refuser après la dépense.
  expect(request).not.toHaveBeenCalled();
  expect(scope.tokens).toBe(0);
  expect(scope.reservedTokens).toBe(0);
});
it("floors the next admission on the input the endpoint reported, total included", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const config = { ...f.config, QA_MODEL_RETRIES: 1 };
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    brokenStream({
      content: "{",
      usage: {
        prompt_tokens: 900_000,
        completion_tokens: 3,
        total_tokens: 900_003,
      },
    })
  );
  const scope = budgetScope(10_000);
  await expect(
    runScope.run(scope, () =>
      new Model(config).json(
        "You plan",
        {},
        z.object({ ok: z.boolean() }),
        1000
      )
    )
  ).rejects.toMatchObject({ code: "RUN_BUDGET_EXCEEDED" });
  // Sans plancher, la reprise repartait : 1 000 de sortie plus la borne de
  // l'entrée (1 245) passent sous 10 000. Dès que l'endpoint chiffre l'entrée à
  // 900 000 tokens et le total à 900 003, la borne suivante vaut au moins ce
  // dernier poids et l'appel est refusé avant tout envoi. Le total rapporté
  // n'est pas absorbé par le pire cas de la tentative : il est déclaré à sa
  // hauteur, donc l'admission suivante ne part pas sur une sous-estimation
  // connue.
  expect(scope.observedInputTokens).toBe(900_003);
  expect(scope.reservedTokens).toBe(900_003);
  expect(request).toHaveBeenCalledTimes(1);
});
it("declares an endpoint's overshoot above the request's bound instead of hiding it", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    completeStream('{"ok":true}', {
      prompt_tokens: 900_000,
      completion_tokens: 3,
      total_tokens: 900_003,
    })
  );
  const scope = budgetScope(5000);
  await expect(
    runScope.run(scope, () =>
      new Model(f.config).json(
        "You plan",
        {},
        z.object({ ok: z.boolean() }),
        500
      )
    )
  ).rejects.toMatchObject({ code: "RUN_BUDGET_EXCEEDED" });
  // Angle mort assumé du cas mesuré : un endpoint qui annonce 900 000
  // prompt_tokens pour un prompt de 105 octets n'est découvert qu'après son
  // appel — l'admission ne pouvait pas l'anticiper. La dépense est déclarée
  // telle quelle (900 003 > 5 000), aucun appel suivant ne part, et le plancher
  // observé interdit d'en décider un sur la borne basse.
  expect(scope.tokens).toBe(900_003);
  expect(scope.tokens).toBeGreaterThan(scope.maxTokens);
  // Le plancher retient le plus grand des deux chiffres déclarés (entrée et
  // total) : 900 003, et non la seule entrée.
  expect(scope.observedInputTokens).toBe(900_003);
  expect(request).toHaveBeenCalledTimes(1);
});
it("counts a successful call at the total the endpoint declared, and refuses to continue", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const config = {
    ...f.config,
    QA_INPUT_COST_PER_MILLION: 1,
    QA_OUTPUT_COST_PER_MILLION: 2,
  };
  // Sonde C de la vérification du tour 3 : le succès n'expose qu'un total. Sans
  // lecture de `total_tokens`, l'appel était chiffré à nos bornes (745 tokens)
  // et le run continuait alors que l'endpoint annonçait 900 000.
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    completeStream('{"ok":true}', {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 900_000,
    })
  );
  const scope = budgetScope(5000);
  await expect(
    runScope.run(scope, () =>
      new Model(config).json("You plan", {}, z.object({ ok: z.boolean() }), 500)
    )
  ).rejects.toMatchObject({ code: "RUN_BUDGET_EXCEEDED" });
  // La dépense est déclarée telle quelle — 900 000 tokens, pas 745 — et
  // l'enveloppe refuse la suite : un appel suivant ne part pas sur la borne
  // basse, et aucune requête de plus n'est envoyée.
  expect(scope.tokens).toBe(900_000);
  expect(scope.tokens).toBeGreaterThan(scope.maxTokens);
  expect(scope.observedInputTokens).toBe(900_000);
  expect(request).toHaveBeenCalledTimes(1);
});
it("refuses the retry of a lost attempt that declared a total above the envelope", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const config = {
    ...f.config,
    QA_INPUT_COST_PER_MILLION: 1,
    QA_MODEL_RETRIES: 3,
    QA_OUTPUT_COST_PER_MILLION: 2,
  };
  // Sonde D de la vérification du tour 3 : chaque coupure rapporte ce total
  // seul. Plafonnée au pire cas de la tentative (1 245), la réserve laissait
  // partir les trois reprises — quatre requêtes — sous une enveloppe de
  // 50 000.
  const request = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      brokenStream({ content: "{", usage: { total_tokens: 900_000 } })
    );
  const scope = budgetScope(50_000);
  await expect(
    runScope.run(scope, () =>
      new Model(config).json(
        "You plan",
        {},
        z.object({ ok: z.boolean() }),
        1000
      )
    )
  ).rejects.toMatchObject({ code: "RUN_BUDGET_EXCEEDED" });
  // Le total annoncé est déclaré à sa hauteur, et le plancher qu'il pose refuse
  // la reprise avant tout envoi : une seule requête part, jamais quatre.
  expect(scope.reservedTokens).toBe(900_000);
  expect(scope.reservedCostUsd).toBeGreaterThan(0);
  expect(scope.observedInputTokens).toBe(900_000);
  expect(request).toHaveBeenCalledTimes(1);
});
it("counts the input bound when a successful response zero-fills its usage", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    completeStream('{"ok":true}', {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    })
  );
  const scope = budgetScope(3000);
  await expect(
    runScope.run(scope, () =>
      new Model(f.config).json(
        "You plan",
        {},
        z.object({ ok: z.boolean() }),
        500
      )
    )
  ).resolves.toEqual({ ok: true });
  // Un usage nul sur une réponse réussie n'est pas une mesure : l'appel est
  // chiffré à la borne de l'entrée (245) plus la sortie maximale autorisée
  // (500), soit 745 tokens — et non 0, comme si l'endpoint avait répondu
  // gratuitement. Le run passe en estimé, faute d'usage rapporté.
  expect(scope.tokens).toBe(745);
  expect(scope.estimated).toBe(true);
  expect(scope.calls).toBe(1);
  expect(request).toHaveBeenCalledTimes(1);
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
