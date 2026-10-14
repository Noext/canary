import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { Model } from "../src/model.js";
import {
  type ChatStreamState,
  emptyChatStream,
  reduceChatStream,
  sseEventData,
  takeSseEvents,
} from "../src/sse.js";
import { fixture } from "./fixture.js";

/** Configuration minimale pour un `fetch` remplacé : aucun appel réseau réel n'a lieu. */
const stubConfig = () =>
  loadConfig({
    OPENAI_BASE_URL: "https://model.fixture/v1",
    OPENAI_MODEL: "fixture-scripted-model",
    OPENAI_STREAM: "true",
  });

const chunk = (payload: Record<string, unknown>, done = false) =>
  `data: ${JSON.stringify(payload)}\n\n${done ? "data: [DONE]\n\n" : ""}`;

const content = (text: string) => ({ choices: [{ delta: { content: text } }] });

function streamResponse(parts: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(encoder.encode(part));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" }, status }
  );
}

function reduce(events: string[]): ChatStreamState {
  return events.reduce(reduceChatStream, emptyChatStream);
}

describe("takeSseEvents", () => {
  it("recolle un événement coupé au milieu d'une ligne entre deux lectures", () => {
    const first = takeSseEvents(`data: {"choices":[{"delta":{"cont`);
    expect(first.events).toEqual([]);
    expect(first.rest).toBe(`data: {"choices":[{"delta":{"cont`);
    const second = takeSseEvents(
      `${first.rest}ent":"Ada"}}]}\n\ndata: [DONE]\n\n`
    );
    expect(second.events).toEqual([
      `{"choices":[{"delta":{"content":"Ada"}}]}`,
      "[DONE]",
    ]);
    expect(second.rest).toBe("");
  });

  it("accepte les fins de ligne CRLF, les commentaires et les données multi-lignes", () => {
    const { events } = takeSseEvents(
      ': keep-alive\r\ndata: {"a":1}\r\n\r\ndata: ligne 1\ndata: ligne 2\n\n'
    );
    expect(events).toEqual([`{"a":1}`, "ligne 1\nligne 2"]);
  });

  it("n'émet rien pour un bloc de commentaires seuls", () => {
    expect(sseEventData(": keep-alive")).toBeUndefined();
    expect(takeSseEvents(": keep-alive\n\n").events).toEqual([]);
  });
});

describe("reduceChatStream", () => {
  it("assemble le contenu delta par delta et compte le raisonnement à part", () => {
    const state = reduce([
      `{"choices":[{"delta":{"role":"assistant"}}]}`,
      `{"choices":[{"delta":{"reasoning_content":"je réfléchis"}}]}`,
      `{"choices":[{"delta":{"content":"{\\"a\\":"}}]}`,
      `{"choices":[{"delta":{"content":"1}"}}]}`,
      `{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`,
    ]);
    expect(state.content).toBe('{"a":1}');
    expect(state.reasoningChars).toBe("je réfléchis".length);
    expect(state.finishReason).toBe("stop");
    expect(state.usage).toEqual({
      completion_tokens: 7,
      prompt_tokens: 11,
      total_tokens: 18,
    });
    expect(JSON.parse(state.content)).toEqual({ a: 1 });
  });

  it("ignore un événement illisible en le comptant, au lieu de le confondre avec un flux vide", () => {
    const state = reduce([
      "{pas du json",
      `{"choices":[{"delta":{"content":"ok"}}]}`,
    ]);
    expect(state.content).toBe("ok");
    expect(state.malformed).toBe(1);
    expect(state.events).toBe(2);
  });

  it("laisse [DONE] sans effet et retient une erreur annoncée par l'endpoint", () => {
    expect(reduce(["[DONE]"])).toEqual(emptyChatStream);
    const state = reduce([`{"error":{"message":"quota exceeded"}}`]);
    expect(state.error).toBe("quota exceeded");
    expect(state.content).toBe("");
  });

  it("garde l'erreur du flux malgré les événements suivants", () => {
    // Un dernier événement (usage, finish) suit souvent l'échec : sans conservation de l'erreur,
    // le contenu assemblé pourrait satisfaire le schéma et passer pour un succès.
    const state = reduce([
      `{"error":{"message":"quota exceeded"}}`,
      `{"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}`,
      `{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":18}}`,
    ]);
    expect(state.error).toBe("quota exceeded");
    expect(state.content).toBe('{"ok":true}');
    expect(JSON.parse(state.content)).toEqual({ ok: true });
  });
});

describe("modalités de transport du modèle", () => {
  it("streame par défaut, assemble les deltas et relit l'usage du flux", async () => {
    const f = await fixture();
    try {
      const value = await new Model(f.config).json(
        "You are a connection diagnostic",
        {},
        z.object({ ok: z.boolean() }).strict()
      );
      expect(value).toEqual({ ok: true });
      expect(f.modelRequests[0]).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
      expect(f.modelRequests[0]).not.toHaveProperty("reasoning_effort");
    } finally {
      await f.close();
    }
  });

  it("garde le corps complet quand OPENAI_STREAM=false", async () => {
    const f = await fixture();
    try {
      const config = { ...f.config, OPENAI_STREAM: "false" as const };
      const value = await new Model(config).json(
        "You are a connection diagnostic",
        {},
        z.object({ ok: z.boolean() }).strict()
      );
      expect(value).toEqual({ ok: true });
      expect(f.modelRequests[0]).not.toHaveProperty("stream");
      expect(f.modelRequests[0]).not.toHaveProperty("stream_options");
    } finally {
      await f.close();
    }
  });

  it("transmet OPENAI_REASONING_EFFORT quand il est configuré", async () => {
    const f = await fixture();
    try {
      const config = {
        ...f.config,
        OPENAI_REASONING_EFFORT: "low" as const,
      };
      await new Model(config).json(
        "You are a connection diagnostic",
        {},
        z.object({ ok: z.boolean() }).strict()
      );
      expect(f.modelRequests[0]).toMatchObject({ reasoning_effort: "low" });
    } finally {
      await f.close();
    }
  });

  it("n'applique pas les événements reçus après [DONE]", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      streamResponse([
        chunk(content('{"ok":true}')),
        "data: [DONE]\n\n",
        chunk(content('{"ok":false}')),
      ])
    );
    try {
      const value = await new Model(stubConfig()).json(
        "JSON",
        {},
        z.object({ ok: z.boolean() }).strict()
      );
      expect(value).toEqual({ ok: true });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("refuse un plan assemblé sur un flux troué plutôt que de perdre un scénario en silence", async () => {
    // Le contenu restant est un JSON valide et complet pour le schéma : sans le contrôle des
    // événements illisibles, le plan serait accepté alors qu'un delta a disparu.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      streamResponse([
        chunk(content('{"ok":')),
        "data: {pas du json}\n\n",
        chunk(content("true}")),
        "data: [DONE]\n\n",
      ])
    );
    try {
      await expect(
        new Model(stubConfig()).json(
          "JSON",
          {},
          z.object({ ok: z.boolean() }).strict()
        )
      ).rejects.toThrow("unreadable event");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("refuse un flux dont l'échec est suivi d'un contenu valide", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      streamResponse([
        chunk({ error: { message: "quota exceeded" } }),
        chunk(content('{"ok":true}')),
        chunk({}, true),
      ])
    );
    try {
      await expect(
        new Model(stubConfig()).json(
          "JSON",
          {},
          z.object({ ok: z.boolean() }).strict()
        )
      ).rejects.toThrow("quota exceeded");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("échoue explicitement sur une erreur annoncée au milieu du flux", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      streamResponse([
        chunk(content("début")),
        chunk({ error: { message: "quota exceeded" } }),
      ])
    );
    try {
      await expect(
        new Model(stubConfig()).json("JSON", {}, z.object({ a: z.number() }))
      ).rejects.toThrow("quota exceeded");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
