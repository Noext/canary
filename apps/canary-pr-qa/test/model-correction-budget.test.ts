import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { Model } from "../src/model.js";
import { runScope } from "../src/run-scope.js";

/**
 * Une correction impossible à RÉSERVER ne détruit pas ce qui est déjà payé.
 *
 * Mesure d'origine (PR #20, 0,0784 $) : la génération a produit un JSON parsé,
 * une porte déterministe a refusé le plan, Canary a voulu corriger, `claim()` a
 * refusé la réservation, et `RUN_BUDGET_EXCEEDED` a remplacé le motif du refus.
 * Le plan candidat n'était conservé nulle part.
 *
 * Le harnais reproduit le parcours réel : vraie réponse HTTP (fetch remplacé),
 * vrai schéma Zod lu par `readContent`, `repair` qui rend une correction en
 * CHAÎNE — la forme pour laquelle `depositCorrection` rend `undefined`, donc
 * celle que le garde doit reconnaître via `refused`.
 */

const schema = z.object({ scenarios: z.array(z.object({ id: z.string() })) });

const config = (env: NodeJS.ProcessEnv = {}) =>
  loadConfig({
    OPENAI_API_KEY: "fixture-key-1234567890",
    OPENAI_BASE_URL: "https://ai.fixture.test/v1",
    OPENAI_MODEL: "fixture-model",
    OPENAI_STREAM: "false",
    QA_API_TOKEN: "fixture-api-token-123456789012345",
    QA_INPUT_COST_PER_MILLION: "0.30",
    QA_OUTPUT_COST_PER_MILLION: "1.20",
    ...env,
  });

function stubProvider(contents: string[]) {
  const calls: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { max_tokens?: number };
      calls.push(body.max_tokens ?? 0);
      const content = contents[Math.min(calls.length - 1, contents.length - 1)];
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content } }],
          usage: {
            completion_tokens: 50,
            prompt_tokens: 100,
            total_tokens: 150,
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      );
    })
  );
  return calls;
}

function inScope<T>(maxCostUsd: number, body: () => Promise<T>) {
  return runScope.run(
    {
      calls: 0,
      costUsd: 0,
      id: "correction-budget",
      maxCostUsd,
      maxTokens: 400_000,
      reservedCostUsd: 0,
      reservedTokens: 0,
      retries: 0,
      signal: new AbortController().signal,
      tokens: 0,
    },
    body
  );
}

const messages = [{ content: "x", role: "user" }];
/** Une réservation tient, la seconde non : la forme mesurée sur PR #20. */
const ONE_CALL_ONLY = 0.0002;

describe("un plan refusé survit à une correction non finançable", () => {
  it("rend le plan refusé, pas l'erreur de budget, et n'envoie qu'un appel", async () => {
    const settings = config();
    const calls = stubProvider(['{"scenarios":[{"id":"s"}]}']);
    let refusal = "";
    const value = await inScope(ONE_CALL_ONLY, () =>
      new Model(settings)
        .json("s", messages, schema as never, 50, (candidate) => {
          refusal = `Scenario s: ${JSON.stringify(candidate)} refused by the deterministic gate`;
          return refusal;
        })
        .catch((error: unknown) => error)
    );
    expect(value).not.toBeInstanceOf(QaError);
    expect(value).toEqual({ scenarios: [{ id: "s" }] });
    expect(refusal).toMatch(/refused by the deterministic gate/);
    expect(calls).toHaveLength(1);
  }, 20_000);

  it("le plan rendu reste refusé : la porte de l'appelant le rejette encore", async () => {
    const settings = config();
    stubProvider(['{"scenarios":[{"id":"s"}]}']);
    let gateCalls = 0;
    const value = await inScope(ONE_CALL_ONLY, () =>
      new Model(settings)
        .json("s", messages, schema as never, 50, () => {
          gateCalls += 1;
          return "refusé";
        })
        .catch((error: unknown) => error)
    );
    // Le plan est rendu pour être re-jugé, pas validé : la porte a bien refusé.
    expect(gateCalls).toBe(1);
    expect(value).toEqual({ scenarios: [{ id: "s" }] });
    // Et rien dans `json()` ne le déclare conforme à une règle métier.
    expect(value).not.toBeInstanceOf(QaError);
  }, 20_000);

  it("un plan valide est rendu sans correction ni second appel", async () => {
    const settings = config();
    const calls = stubProvider(['{"scenarios":[{"id":"ok"}]}']);
    const value = await inScope(1, () =>
      new Model(settings).json("s", messages, schema as never, 50)
    );
    expect(value).toEqual({ scenarios: [{ id: "ok" }] });
    expect(calls).toHaveLength(1);
  }, 20_000);

  it("une correction finançable est bien tentée et retenue", async () => {
    const settings = config();
    const calls = stubProvider([
      '{"scenarios":[{"id":"refused"}]}',
      '{"scenarios":[{"id":"corrected"}]}',
    ]);
    const value = await inScope(1, () =>
      new Model(settings).json(
        "s",
        messages,
        schema as never,
        50,
        (candidate) =>
          (candidate as { scenarios: { id: string }[] }).scenarios[0]?.id ===
          "corrected"
            ? undefined
            : "refusé"
      )
    );
    expect(calls).toHaveLength(2);
    expect(value).toEqual({ scenarios: [{ id: "corrected" }] });
  }, 20_000);

  it("sans candidat refusé, une réservation impossible lève toujours", async () => {
    const settings = config();
    stubProvider(['{"scenarios":[]}']);
    const value = await inScope(0.000_000_1, () =>
      new Model(settings)
        .json("s", messages, schema as never, 50)
        .catch((error: unknown) => error)
    );
    expect(value).toBeInstanceOf(QaError);
    expect((value as QaError).code).toBe("RUN_BUDGET_EXCEEDED");
  }, 20_000);
});
