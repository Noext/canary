import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { Model } from "../src/model.js";
import { runScope } from "../src/run-scope.js";

/**
 * Une seule borne d'entrée pour le compteur de tokens ET pour le coût réservé.
 *
 * Le coût était réservé sur les OCTETS du message pris pour des tokens, quand le
 * compteur réservait ces octets divisés par deux : la même tentative engageait
 * deux fois plus de dollars que de tokens. Mesuré sur le payload du
 * planificateur — 273 856 octets — la réservation valait 0,0918 $ au lieu de
 * 0,0507 $, et un plafond de 0,07 $ refusait un appel que la borne de tokens
 * acceptait.
 */

const BYTES_REPRO = 273_856;
const OUTPUT = 8000;

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

/** Répond une complétion JSON et compte les requêtes réellement parties. */
function stubProvider() {
  const calls: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        max_tokens?: number;
        messages: { content: string; role: string }[];
      };
      calls.push(body.max_tokens ?? 0);
      const prompt = Math.ceil(
        Buffer.byteLength(JSON.stringify(body.messages), "utf8") / 2
      );
      return new Response(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", message: { content: '{"ok":true}' } },
          ],
          usage: {
            completion_tokens: 7,
            prompt_tokens: prompt,
            total_tokens: prompt + 7,
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      );
    })
  );
  return calls;
}

/** Le message du planificateur, à l'octet près. */
function messagesOf(bytes: number) {
  const overhead = Buffer.byteLength(
    JSON.stringify([
      { content: "system prompt", role: "system" },
      { content: '{"payload":""}', role: "user" },
    ]),
    "utf8"
  );
  return [
    { content: "system prompt", role: "system" },
    { content: `{"payload":"${"x".repeat(bytes - overhead)}"}`, role: "user" },
  ];
}

function reservations(settings: ReturnType<typeof config>, messages: unknown) {
  const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  const inputTokens = Math.ceil(bytes / 2) + 64 * 2;
  const cost = (tokens: number) =>
    (tokens * settings.QA_INPUT_COST_PER_MILLION +
      OUTPUT * settings.QA_OUTPUT_COST_PER_MILLION) /
    1_000_000;
  return {
    bytes,
    inputTokens,
    legacyCost: cost(bytes),
    newCost: cost(inputTokens),
  };
}

function inScope<T>(
  limits: { maxCostUsd: number; maxTokens?: number },
  body: () => Promise<T>
) {
  const scope = {
    calls: 0,
    costUsd: 0,
    id: "reservation-test",
    maxCostUsd: limits.maxCostUsd,
    maxTokens: limits.maxTokens ?? 400_000,
    reservedCostUsd: 0,
    reservedTokens: 0,
    retries: 0,
    signal: new AbortController().signal,
    tokens: 0,
  };
  return runScope.run(scope, body).then((value) => ({ scope, value }));
}

const schema = { parse: (value: unknown) => value } as never;

function call(settings: ReturnType<typeof config>, messages: unknown) {
  return new Model(settings)
    .json("s", messages, schema, OUTPUT)
    .catch((error: unknown) => error);
}

describe("le coût réservé suit la borne de tokens, pas les octets", () => {
  it("reproduit 273 856 octets : la nouvelle réservation tient sous 0,07 $", async () => {
    const settings = config();
    const calls = stubProvider();
    const messages = messagesOf(BYTES_REPRO);
    const { legacyCost, newCost } = reservations(settings, messages);
    // L'ancienne borne dépassait le plafond de l'expérience, la nouvelle non.
    expect(legacyCost).toBeGreaterThan(0.07);
    expect(newCost).toBeLessThan(0.07);
    const { scope } = await inScope(
      { maxCostUsd: 0.07 },
      () => call(settings, messages) as Promise<unknown>
    );
    expect(calls).toHaveLength(1);
    expect(scope.costUsd).toBeLessThan(0.07);
  }, 20_000);

  it("refuse sous l'ancienne borne ce qu'elle acceptait, et accepte sous la nouvelle", async () => {
    const settings = config();
    const calls = stubProvider();
    const messages = messagesOf(BYTES_REPRO);
    const { legacyCost, newCost } = reservations(settings, messages);
    // Un plafond posé entre les deux : l'ancienne réservation l'aurait refusé.
    const cap = (legacyCost + newCost) / 2;
    expect(cap).toBeGreaterThan(newCost);
    expect(cap).toBeLessThan(legacyCost);
    const { scope } = await inScope(
      { maxCostUsd: cap },
      () => call(settings, messages) as Promise<unknown>
    );
    expect(calls).toHaveLength(1);
    expect(scope.costUsd).toBeLessThan(cap);
  }, 20_000);

  it("le coût réservé est exactement tokens × tarif entrée + sortie × tarif sortie", async () => {
    const settings = config();
    stubProvider();
    const messages = messagesOf(50_000);
    const { inputTokens, newCost } = reservations(settings, messages);
    // Une enveloppe juste sous la réservation refuse : la réservation vaut bien
    // ce que la formule annonce, pas moins.
    const refused = await inScope(
      { maxCostUsd: newCost - 0.0001 },
      () => call(settings, messages) as Promise<unknown>
    );
    expect((refused.value as QaError).code).toBe("RUN_BUDGET_EXCEEDED");
    const accepted = await inScope(
      { maxCostUsd: newCost + 0.0001 },
      () => call(settings, messages) as Promise<unknown>
    );
    expect(accepted.value).not.toBeInstanceOf(QaError);
    expect(inputTokens).toBeGreaterThan(0);
  }, 20_000);
});

describe("le refus reste fail-closed et n'envoie rien", () => {
  it("aucune requête quand la dépense réservée dépasse l'enveloppe", async () => {
    const settings = config();
    const calls = stubProvider();
    const { newCost } = reservations(settings, messagesOf(50_000));
    const { value } = await inScope(
      { maxCostUsd: newCost / 2 },
      () => call(settings, messagesOf(50_000)) as Promise<unknown>
    );
    expect((value as QaError).code).toBe("RUN_BUDGET_EXCEEDED");
    expect(calls).toHaveLength(0);
  }, 20_000);

  it("aucune requête quand les tokens réservés dépassent l'enveloppe", async () => {
    const settings = config();
    const calls = stubProvider();
    const { value } = await inScope(
      { maxCostUsd: 10, maxTokens: 1000 },
      () => call(settings, messagesOf(50_000)) as Promise<unknown>
    );
    expect((value as QaError).code).toBe("RUN_BUDGET_EXCEEDED");
    expect(calls).toHaveLength(0);
  }, 20_000);

  it("deux appels dans une enveloppe d'un seul : le second est refusé", async () => {
    const settings = config();
    const calls = stubProvider();
    const messages = messagesOf(50_000);
    const { newCost } = reservations(settings, messages);
    const { scope, value } = await inScope(
      { maxCostUsd: newCost + 0.002 },
      async () => {
        await call(settings, messages);
        return call(settings, messages);
      }
    );
    expect(value).toBeInstanceOf(QaError);
    expect((value as QaError).code).toBe("RUN_BUDGET_EXCEEDED");
    expect(calls).toHaveLength(1);
    expect(scope.costUsd).toBeLessThanOrEqual(newCost + 0.002);
  }, 20_000);
});

describe("le contenu multilingue est chiffré comme le reste", () => {
  it("accentué et CJK : la réservation reste une borne haute, coût compris", async () => {
    const settings = config();
    const calls = stubProvider();
    const text = `${"éàüç ".repeat(3000)}${"数量·硬貨 ".repeat(3000)}`;
    const messages = [
      { content: "system", role: "system" },
      { content: text, role: "user" },
    ];
    const { bytes, inputTokens, newCost } = reservations(settings, messages);
    // Deux octets par token reste au-dessus du vrai compte pour l'accentué
    // (2 octets/caractère) comme pour le CJK (3 octets/caractère, ~1 token).
    expect(inputTokens).toBeGreaterThan(text.length);
    const { value } = await inScope(
      { maxCostUsd: newCost + 0.0001 },
      () => call(settings, messages) as Promise<unknown>
    );
    expect(value).not.toBeInstanceOf(QaError);
    expect(calls).toHaveLength(1);
    expect(bytes).toBeGreaterThan(text.length);
  }, 20_000);
});
