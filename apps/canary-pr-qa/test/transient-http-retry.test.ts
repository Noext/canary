import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { parseRetryAfter, RETRY_AFTER_MAX_MS } from "../src/http.js";
import { MAX_MODEL_CALLS_PER_RUN, Model } from "../src/model.js";
import { type RunScope, runScope } from "../src/run-scope.js";

/**
 * Le gateway devant l'endpoint modèle renvoie `503` par intermittence quand son
 * amont refuse la requête (`server_error: Upstream request failed: Endpoint is
 * unavailable`), et `429` quand il applique sa fenêtre de débit. Ces deux
 * statuts arrivent avant tout contenu, comme une connexion coupée : la reprise
 * est donc sans effet de bord, et c'est elle que ces tests bornent. Le dépôt
 * factice remplace `fetch` : aucun appel réseau n'a lieu, et chaque envoi est
 * compté — un envoi de trop fait échouer le test au lieu de passer inaperçu.
 */
const config = (retries: number, stream = false) =>
  loadConfig({
    OPENAI_BASE_URL: "https://model.fixture/v1",
    OPENAI_MODEL: "fixture-scripted-model",
    OPENAI_STREAM: stream ? "true" : "false",
    QA_MODEL_RETRIES: String(retries),
  });

const plan = z.object({ ok: z.boolean() }).strict();

function served(value: unknown = { ok: true }): Response {
  return new Response(
    JSON.stringify({
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(value) } },
      ],
      usage: { completion_tokens: 7, prompt_tokens: 11, total_tokens: 18 },
    }),
    { headers: { "Content-Type": "application/json" }, status: 200 }
  );
}

function refusalStatus(status: number, retryAfter?: string): Response {
  return new Response(
    JSON.stringify({ error: { message: "Endpoint is unavailable." } }),
    {
      headers: {
        "Content-Type": "application/json",
        ...(retryAfter === undefined ? {} : { "Retry-After": retryAfter }),
      },
      status,
    }
  );
}

function streamed(events: Record<string, unknown>[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" }, status: 200 }
  );
}

/**
 * Réponses servies dans l'ordre, une par envoi. Un envoi au-delà du script est
 * une erreur de transport : le test voit l'échec au lieu d'un succès tardif.
 */
function scriptedFetch(responses: Response[]): number[] {
  const queue = [...responses];
  const sent: number[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    sent.push(Date.now());
    const next = queue.shift();
    if (!next) {
      throw new Error("unexpected model call");
    }
    return next;
  });
  return sent;
}

/** Le périmètre d'un run : c'est lui qui porte `retries` et `calls`. */
async function inRun<T>(
  run: (scope: RunScope) => Promise<T>
): Promise<{ scope: RunScope; value: T }> {
  const scope: RunScope = {
    calls: 0,
    costUsd: 0,
    id: "transient-http",
    maxCostUsd: 1_000_000,
    maxTokens: 100_000_000,
    reservedCostUsd: 0,
    reservedTokens: 0,
    signal: new AbortController().signal,
    tokens: 0,
  };
  return { scope, value: await runScope.run(scope, () => run(scope)) };
}

/** L'erreur d'un appel qui doit être refusé, jamais un succès silencieux. */
async function refusal(call: () => Promise<unknown>): Promise<QaError> {
  const error = await call().then(
    () => undefined,
    (reason: unknown) => reason
  );
  if (!(error instanceof QaError)) {
    throw new Error(`expected a QaError, got ${String(error)}`);
  }
  return error;
}

describe("reprise d'un statut HTTP transitoire du modèle", () => {
  it("rejoue un 503 puis sert la réponse, et compte la reprise", async () => {
    const sent = scriptedFetch([refusalStatus(503), served()]);
    try {
      const { scope, value } = await inRun(() =>
        new Model(config(1)).json("JSON", {}, plan)
      );
      expect(value).toEqual({ ok: true });
      expect(sent).toHaveLength(2);
      expect(scope.retries).toBe(1);
      // Un seul appel a répondu : la tentative refusée ne compte pas comme appel.
      expect(scope.calls).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejoue deux 503 avant de servir la réponse", async () => {
    const sent = scriptedFetch([
      refusalStatus(503),
      refusalStatus(503),
      served(),
    ]);
    try {
      const { scope, value } = await inRun(() =>
        new Model(config(3)).json("JSON", {}, plan)
      );
      expect(value).toEqual({ ok: true });
      expect(sent).toHaveLength(3);
      expect(scope.retries).toBe(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("épuise les reprises et rend le code d'origine avec leur nombre", async () => {
    const sent = scriptedFetch([
      refusalStatus(503),
      refusalStatus(503),
      refusalStatus(503),
    ]);
    try {
      const { scope, value } = await inRun(() =>
        refusal(() => new Model(config(2)).json("JSON", {}, plan))
      );
      expect(value.code).toBe("HTTP_503");
      expect(value.message).toContain("(after 2 retries)");
      expect(sent).toHaveLength(3);
      expect(scope.retries).toBe(2);
      expect(scope.calls).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejoue un 429", async () => {
    const sent = scriptedFetch([refusalStatus(429), served()]);
    try {
      const { scope, value } = await inRun(() =>
        new Model(config(1)).json("JSON", {}, plan)
      );
      expect(value).toEqual({ ok: true });
      expect(sent).toHaveLength(2);
      expect(scope.retries).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([
    400, 401, 403, 404,
  ])("ne rejoue jamais un refus de requête HTTP %i", async (status) => {
    const sent = scriptedFetch([refusalStatus(status)]);
    try {
      const { scope, value } = await inRun(() =>
        refusal(() => new Model(config(3)).json("JSON", {}, plan))
      );
      expect(value.code).toBe(`HTTP_${status}`);
      expect(value.message).not.toContain("retries");
      expect(sent).toHaveLength(1);
      // Aucune reprise décidée : le compteur n'est pas même ouvert.
      expect(scope.retries).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("ne rejoue jamais une erreur rapportée au milieu du flux", async () => {
    const sent = scriptedFetch([
      streamed([
        { choices: [{ delta: { content: "{" }, index: 0 }] },
        { error: { message: "quota exceeded" } },
      ]),
    ]);
    try {
      const { scope, value } = await inRun(() =>
        refusal(() => new Model(config(3, true)).json("JSON", {}, plan))
      );
      expect(value.code).toBe("MODEL_STREAM_ERROR");
      expect(sent).toHaveLength(1);
      expect(scope.retries).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("ne rejoue jamais un flux troué", async () => {
    const encoder = new TextEncoder();
    const sent = scriptedFetch([
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of [
              `{"choices":[{"delta":{"content":"{\\"ok\\":"}}]}`,
              "{pas du json",
              `{"choices":[{"delta":{"content":"true}"}}]}`,
              "[DONE]",
            ]) {
              controller.enqueue(encoder.encode(`data: ${event}\n\n`));
            }
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" }, status: 200 }
      ),
    ]);
    try {
      const { scope, value } = await inRun(() =>
        refusal(() => new Model(config(3, true)).json("JSON", {}, plan))
      );
      expect(value.code).toBe("MODEL_STREAM_INVALID");
      expect(sent).toHaveLength(1);
      expect(scope.retries).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("ne rejoue rien quand QA_MODEL_RETRIES vaut 0", async () => {
    const sent = scriptedFetch([refusalStatus(503)]);
    try {
      const { scope, value } = await inRun(() =>
        refusal(() => new Model(config(0)).json("JSON", {}, plan))
      );
      expect(value.code).toBe("HTTP_503");
      expect(value.message).not.toContain("retries");
      expect(sent).toHaveLength(1);
      expect(scope.retries).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("borne les reprises au plafond d'appels du run", async () => {
    // Huit appels sont déjà comptés par le run. Ce refus, la reprise envisagée et
    // son envoi doivent tenir dans MAX_MODEL_CALLS_PER_RUN : une seule reprise est
    // permise, la seconde ne part jamais, quel que soit QA_MODEL_RETRIES.
    const seeded = 8;
    const sent = scriptedFetch([refusalStatus(503), refusalStatus(503)]);
    try {
      const { scope, value } = await inRun(async (state) => {
        state.calls = seeded;
        return await refusal(() => new Model(config(5)).json("JSON", {}, plan));
      });
      expect(value.code).toBe("HTTP_503");
      // Même formulation que la reprise de transport, dont celle-ci emprunte
      // le mécanisme jusqu'au message final.
      expect(value.message).toContain("(after 1 retries)");
      expect(sent).toHaveLength(2);
      expect(scope.retries).toBe(1);
      // C'est le plafond, et non QA_MODEL_RETRIES=5, qui a arrêté la seconde
      // reprise : elle aurait engagé un onzième appel sur un run qui en admet dix.
      expect(seeded + (scope.retries ?? 0) + 2).toBeGreaterThan(
        MAX_MODEL_CALLS_PER_RUN
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("respecte le Retry-After que l'endpoint joint à son 503", async () => {
    const sent = scriptedFetch([refusalStatus(503, "2"), served()]);
    try {
      await inRun(() => new Model(config(1)).json("JSON", {}, plan));
      // Deux secondes demandées, plus le jitter ; le repli n'en aurait attendu
      // qu'une.
      expect(sent[1]! - sent[0]!).toBeGreaterThanOrEqual(2000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("ne suit pas un Retry-After qui figerait le run", async () => {
    const sent = scriptedFetch([refusalStatus(503, "3600"), served()]);
    try {
      const started = Date.now();
      const { value } = await inRun(() =>
        new Model(config(1)).json("JSON", {}, plan)
      );
      expect(value).toEqual({ ok: true });
      expect(sent).toHaveLength(2);
      // Une heure demandée : la reprise a lieu au délai de repli, pas dans une heure.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("parseRetryAfter", () => {
  it("lit les secondes entières de la première forme", () => {
    expect(parseRetryAfter("1")).toBe(1000);
    expect(parseRetryAfter(" 2 ")).toBe(2000);
  });

  it("lit la date HTTP de la seconde forme", () => {
    const ms = parseRetryAfter(new Date(Date.now() + 2000).toUTCString());
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(2000);
  });

  it("n'accepte ni une valeur illisible, ni une date passée", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("1.5")).toBeUndefined();
    expect(
      parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())
    ).toBeUndefined();
  });

  it("écarte une attente plus longue que le plafond du run", () => {
    expect(parseRetryAfter(String(RETRY_AFTER_MAX_MS / 1000))).toBe(
      RETRY_AFTER_MAX_MS
    );
    expect(parseRetryAfter("3600")).toBeUndefined();
  });
});
