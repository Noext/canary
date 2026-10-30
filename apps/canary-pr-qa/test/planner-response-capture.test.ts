import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { transportCode } from "../src/http.js";
import { Model } from "../src/model.js";
import type { ModelResponseRecord } from "../src/model-capture.js";
import { type RunScope, runScope } from "../src/run-scope.js";

/**
 * Une réponse payée n'est plus jamais perdue, ni le motif de son refus.
 *
 * Mesure d'origine (runs 5, 7 et 8) : 92 181 tokens d'entrée, ~40 000 tokens de
 * sortie complets, jugés invalides par `readContent`, puis un
 * `RUN_BUDGET_EXCEEDED` nu à la réservation de la correction. Ni le contenu, ni
 * le `finish_reason`, ni les violations n'étaient conservés. Le harnais est celui
 * de `model-correction-budget.test.ts` : vraie réponse HTTP (fetch remplacé, zéro
 * réseau), vrai schéma Zod, vraie réservation.
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

type Served = string | { status: number } | { usage: Record<string, number> };

function served(answer: Served): Response {
  if (typeof answer === "object" && "status" in answer) {
    return new Response(JSON.stringify({ error: { message: "refused" } }), {
      headers: { "content-type": "application/json" },
      status: answer.status,
    });
  }
  const content = typeof answer === "string" ? answer : '{"scenarios":[]}';
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content } }],
      usage:
        typeof answer === "string"
          ? {
              completion_tokens: 50,
              completion_tokens_details: { reasoning_tokens: 20 },
              prompt_tokens: 100,
              total_tokens: 150,
            }
          : answer.usage,
    }),
    { headers: { "content-type": "application/json" }, status: 200 }
  );
}

/** Rejoue les réponses dans l'ordre ; la dernière se répète. */
function stubProvider(answers: Served[]) {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      return served(answers[Math.min(calls - 1, answers.length - 1)]!);
    })
  );
  return () => calls;
}

function scope(maxCostUsd: number, records: ModelResponseRecord[]): RunScope {
  return {
    calls: 0,
    costUsd: 0,
    id: "response-capture",
    maxCostUsd,
    maxTokens: 400_000,
    onModelResponse: (record) => records.push(structuredClone(record)),
    reservedCostUsd: 0,
    reservedTokens: 0,
    retries: 0,
    signal: new AbortController().signal,
    tokens: 0,
  };
}

const messages = [{ content: "x", role: "user" }];
/** Une réservation tient, la seconde non : la forme mesurée sur PR #20. */
const ONE_CALL_ONLY = 0.0002;

/** Un plan lisible de ~60 Ko dont chaque scénario viole le schéma. */
function schemaInvalidPlan(): { content: string; violations: number } {
  const scenarios = Array.from({ length: 1450 }, () => ({
    id: 7,
    note: "padding-padding-padding",
  }));
  return { content: JSON.stringify({ scenarios }), violations: 1450 };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("une réponse refusée puis non financée garde sa cause", () => {
  it("lève PLAN_SCHEMA_INVALID, et le crochet reçoit tout le contenu et chaque violation", async () => {
    const { content, violations } = schemaInvalidPlan();
    expect(content.length).toBeGreaterThan(60_000);
    const fetched = stubProvider([content]);
    const records: ModelResponseRecord[] = [];
    const error = await runScope.run(scope(ONE_CALL_ONLY, records), () =>
      new Model(config())
        .json("s", messages, schema as never, 50)
        .catch((caught: unknown) => caught)
    );
    expect(fetched()).toBe(1);
    expect(error).toBeInstanceOf(QaError);
    expect((error as QaError).code).toBe("PLAN_SCHEMA_INVALID");
    expect((error as QaError).hint).toMatch(
      /^Validation: scenarios\.0\.id: .*expected string/i
    );
    expect((error as QaError).message).toContain("Response excerpt");
    expect((error as QaError).message).toMatch(
      /Next model call not sent: reservation \d+ tokens \/ \$[\d.]+ for -?\d+ tokens \/ \$-?[\d.]+ remaining/
    );
    const last = records.at(-1)!;
    expect(last.call).toBe(1);
    expect(last.content).toBe(content);
    expect(last.contentChars).toBe(content.length);
    expect(last.finishReason).toBe("stop");
    expect(last.maxTokens).toBe(50);
    expect(last.usage).toMatchObject({
      completion_tokens_details: { reasoning_tokens: 20 },
    });
    expect(last.verdict?.kind).toBe("schema");
    const issues = (last.verdict as { issues: string[] }).issues;
    expect(issues).toHaveLength(violations);
    expect(issues.at(-1)).toMatch(/^scenarios\.1449\.id: /);
  });

  it("lève MODEL_JSON_INVALID pour un contenu clôturé, avec l'erreur de JSON.parse", async () => {
    const fenced = `\`\`\`json\n${JSON.stringify({ scenarios: [{ id: "s" }] })}\n\`\`\``;
    const fetched = stubProvider([fenced]);
    const records: ModelResponseRecord[] = [];
    const error = await runScope.run(scope(ONE_CALL_ONLY, records), () =>
      new Model(config())
        .json("s", messages, schema as never, 50)
        .catch((caught: unknown) => caught)
    );
    expect(fetched()).toBe(1);
    expect((error as QaError).code).toBe("MODEL_JSON_INVALID");
    expect((error as QaError).message).toContain("Next model call not sent");
    expect((error as QaError).hint).toContain(
      "Response content is not valid JSON ("
    );
    const last = records.at(-1)!;
    expect(last.content).toBe(fenced);
    expect(last.verdict).toMatchObject({
      kind: "unreadable",
      parseError: expect.stringMatching(/JSON/),
    });
  });

  it("une reprise de contenu vide non financée remonte MODEL_OUTPUT_INCOMPLETE", async () => {
    const fetched = stubProvider([""]);
    const records: ModelResponseRecord[] = [];
    const error = await runScope.run(scope(ONE_CALL_ONLY, records), () =>
      new Model(config())
        .json("s", messages, schema as never, 50)
        .catch((caught: unknown) => caught)
    );
    expect(fetched()).toBe(1);
    expect((error as QaError).code).toBe("MODEL_OUTPUT_INCOMPLETE");
    expect((error as QaError).message).toContain("Next model call not sent");
    expect(records.at(-1)!.verdict?.kind).toBe("unusable");
  });

  it("un usage déclaré au-delà de l'enveloppe laisse la réponse enregistrée", async () => {
    stubProvider([
      {
        usage: { completion_tokens: 40, prompt_tokens: 100, total_tokens: 9e6 },
      },
    ]);
    const records: ModelResponseRecord[] = [];
    const error = await runScope.run(scope(1, records), () =>
      new Model(config())
        .json("s", messages, schema as never, 50)
        .catch((caught: unknown) => caught)
    );
    expect((error as QaError).code).toBe("RUN_BUDGET_EXCEEDED");
    expect(records).toHaveLength(1);
    expect(records[0]!.content).toBe('{"scenarios":[]}');
    expect(records[0]!.verdict).toBeUndefined();
  });

  it("un crochet qui échoue n'échoue jamais l'appel", async () => {
    stubProvider(['{"scenarios":[{"id":"ok"}]}']);
    const run = scope(1, []);
    run.onModelResponse = () => {
      throw new Error("disk full");
    };
    const value = await runScope.run(run, () =>
      new Model(config()).json("s", messages, schema as never, 50)
    );
    expect(value).toEqual({ scenarios: [{ id: "ok" }] });
  });
});

describe("une correction qui échoue rend le plan déjà refusé", () => {
  const refusedPlan = '{"scenarios":[{"id":"refused"}]}';
  const correctionFailures: [string, Served][] = [
    ["un HTTP 400", { status: 400 }],
    ["une réponse vide", ""],
    ["un JSON illisible", "not json at all"],
    ["un plan hors schéma", '{"scenarios":[{"id":1}]}'],
  ];
  for (const [label, failure] of correctionFailures) {
    it(`après ${label}`, async () => {
      stubProvider([refusedPlan, failure]);
      const records: ModelResponseRecord[] = [];
      let gate = 0;
      const value = await runScope.run(scope(1, records), () =>
        new Model(config())
          .json("s", messages, schema as never, 50, () => {
            gate += 1;
            return "Plan rejected: scenario refused by the gate";
          })
          .catch((caught: unknown) => caught)
      );
      // Le plan payé repart vers ses portes ; il n'est jamais déclaré valide :
      // la porte l'a refusé, et c'est à l'appelant de la rejouer.
      expect(value).not.toBeInstanceOf(Error);
      expect(value).toEqual({ scenarios: [{ id: "refused" }] });
      expect(gate).toBe(1);
      expect(records.find((record) => record.call === 1)).toBeDefined();
      expect(
        records.filter((record) => record.call === 1).at(-1)!.verdict
      ).toEqual({
        kind: "gate",
        refusal: "Plan rejected: scenario refused by the gate",
      });
    });
  }
});

describe("un délai levé en plein flux est classé, réservé et rejoué", () => {
  it("classe TimeoutError comme TIMEOUT, jamais une annulation", () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    expect(transportCode(timeout)).toBe("TIMEOUT");
    expect(
      transportCode(
        Object.assign(new Error("fetch failed"), { cause: timeout })
      )
    ).toBe("TIMEOUT");
    expect(transportCode(new DOMException("cancel", "AbortError"))).toBe(
      undefined
    );
  });

  it("réserve la tentative perdue et la rejoue", async () => {
    const encoder = new TextEncoder();
    const event = (value: unknown) =>
      encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        const first = calls === 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                event({
                  choices: [
                    {
                      delta: {
                        content: first ? '{"scenar' : '{"scenarios":[]}',
                      },
                    },
                  ],
                })
              );
              if (first) {
                // Le délai du client expire après des octets déjà livrés.
                controller.error(new DOMException("timed out", "TimeoutError"));
                return;
              }
              controller.enqueue(
                event({ choices: [{ delta: {}, finish_reason: "stop" }] })
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" }, status: 200 }
        );
      })
    );
    const run = scope(1, []);
    const value = await runScope.run(run, () =>
      new Model(config({ OPENAI_STREAM: "true", QA_MODEL_RETRIES: "1" })).json(
        "s",
        messages,
        schema as never,
        50
      )
    );
    expect(value).toEqual({ scenarios: [] });
    expect(calls).toBe(2);
    expect(run.retries).toBe(1);
    expect(run.reservedTokens).toBeGreaterThan(0);
    expect(run.estimated).toBe(true);
  }, 20_000);
});
