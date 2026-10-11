import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Progress } from "../src/progress.js";
import { initializeTracing, traced } from "../src/telemetry.js";

it("exports real OTLP HTTP spans and correlates saved progress with the active trace", async () => {
  const received: { path: string; body: string }[] = [];
  const collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      received.push({ path: req.url!, body: Buffer.concat(chunks).toString() });
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
  });
  await new Promise<void>((done) => collector.listen(0, "127.0.0.1", done));
  vi.stubEnv(
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    `http://127.0.0.1:${(collector.address() as { port: number }).port}`
  );
  vi.stubEnv("OTEL_SERVICE_NAME", "canary-trace-fixture");
  const stop = initializeTracing()!;
  try {
    const root = await mkdtemp(join(tmpdir(), "canary-otel-"));
    await traced("qa.run", { runId: "otel-probe" }, async () => {
      await new Progress(root, "otel-probe").record({
        phase: "execution",
        action: "assert",
      });
      await traced("model.json", { model: "fixture" }, async () => undefined);
    });
    await stop();
    const progress = JSON.parse(
      await readFile(join(root, "progress.json"), "utf8")
    );
    expect(progress.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(received[0]?.path).toBe("/v1/traces");
    const data = JSON.parse(received[0]!.body);
    const spans = data.resourceSpans.flatMap(
      (r: {
        scopeSpans: {
          spans: { name: string; traceId: string; events: unknown[] }[];
        }[];
      }) => r.scopeSpans.flatMap((s) => s.spans)
    );
    expect(spans.map((s: { name: string }) => s.name).sort()).toEqual([
      "model.json",
      "qa.run",
    ]);
    expect(
      spans.every(
        (s: { traceId: string }) => s.traceId.toLowerCase() === progress.traceId
      )
    ).toBe(true);
    expect(data.resourceSpans[0].resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "canary-trace-fixture" },
    });
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((done) => collector.close(() => done()));
  }
}, 15_000);
