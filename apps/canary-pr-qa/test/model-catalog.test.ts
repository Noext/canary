import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { Model } from "../src/model.js";
import { ModelCatalog, runModelConfig } from "../src/model-catalog.js";
import { startServer } from "../src/server.js";
import { fixture } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
it("uses only the explicitly configured DeepSeek default", () => {
  expect(loadConfig({}).OPENAI_MODEL).toBe("opencode-go/deepseek-v4.1-flash");
});
it("fetches the provider catalog once for simultaneous requests, filters IDs and rejects absent choices", async () => {
  const f = await fixture({
    models: [
      "fixture-alternate-model",
      "fixture-scripted-model",
      "fixture-alternate-model",
    ],
  });
  cleanup.push(f.close);
  const catalog = new ModelCatalog({
    ...f.config,
    QA_ALLOWED_MODELS: "fixture-scripted-model",
  });
  expect(
    await Promise.all([catalog.list(), catalog.list(), catalog.list()])
  ).toEqual([
    ["fixture-scripted-model"],
    ["fixture-scripted-model"],
    ["fixture-scripted-model"],
  ]);
  expect(f.catalogRequests).toHaveLength(1);
  await expect(
    catalog.require("fixture-alternate-model")
  ).rejects.toMatchObject({ code: "MODEL_NOT_AVAILABLE" });
  expect(() =>
    runModelConfig(
      { ...f.config, QA_ALLOWED_MODELS: "fixture-scripted-model" },
      "fixture-alternate-model"
    )
  ).toThrow();
});
it("does not invent a default when the catalog lacks it and does not cache failures", async () => {
  const f = await fixture({ models: ["explicit-choice-only"] });
  cleanup.push(f.close);
  const catalog = new ModelCatalog(f.config);
  expect(await catalog.list()).toEqual(["explicit-choice-only"]);
  await expect(catalog.require(f.config.OPENAI_MODEL)).rejects.toMatchObject({
    code: "MODEL_NOT_AVAILABLE",
  });
  const unavailable = await fixture({ modelsStatus: 403 });
  cleanup.push(unavailable.close);
  const denied = new ModelCatalog(unavailable.config);
  await expect(denied.list()).rejects.toThrow();
  await expect(denied.list()).rejects.toThrow();
  expect(unavailable.catalogRequests).toHaveLength(2);
});
it("protects server-side model discovery and never sends the provider credential to the browser", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const secret = "server-side-provider-secret-test";
  const server = await startServer({
    ...f.config,
    OPENAI_API_KEY: secret,
    QA_PORT: 0,
  });
  cleanup.push(() => server.shutdown());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  expect((await fetch(`${base}/models`)).status).toBe(401);
  const response = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${f.config.QA_API_TOKEN}` },
  });
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(JSON.parse(text)).toEqual({
    data: [{ id: "fixture-alternate-model" }, { id: "fixture-scripted-model" }],
    defaultModel: "fixture-scripted-model",
  });
  expect(text).not.toContain(secret);
});
it("pins the requested model without applying the default model price to a different model", () => {
  const config = loadConfig({
    QA_INPUT_COST_PER_MILLION: "2",
    QA_OUTPUT_COST_PER_MILLION: "4",
  });
  expect(runModelConfig(config).QA_INPUT_COST_PER_MILLION).toBe(2);
  const selected = runModelConfig(config, "explicit-other-model");
  expect(selected.OPENAI_MODEL).toBe("explicit-other-model");
  expect(selected.QA_INPUT_COST_PER_MILLION).toBe(0);
  expect(selected.QA_OUTPUT_COST_PER_MILLION).toBe(0);
  expect(config.OPENAI_MODEL).toBe("opencode-go/deepseek-v4.1-flash");
});

it("returns useful schema errors to the bounded repair request without silently changing models", async () => {
  const bodies: Record<string, unknown>[] = [];
  const request = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  bodies.length === 1 ? { ok: "wrong-type" } : { ok: true }
                ),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
        { status: 200 }
      );
    });
  const config = loadConfig({});
  expect(
    await new Model(config).json(
      "Diagnostic JSON",
      {},
      z.object({ ok: z.boolean() }).strict()
    )
  ).toEqual({ ok: true });
  expect(request).toHaveBeenCalledTimes(2);
  expect(
    bodies.every((body) => body.model === "opencode-go/deepseek-v4.1-flash")
  ).toBe(true);
  const messages = bodies[1]?.messages as { content: string }[];
  expect(messages.at(-1)?.content).toContain("ok: Expected boolean");
});
