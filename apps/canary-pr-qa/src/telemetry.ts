import { SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  Counter,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
export const metrics = new Registry();
collectDefaultMetrics({ register: metrics, prefix: "canary_" });
export const modelCalls = new Counter({
  name: "canary_model_calls_total",
  help: "Model requests",
  labelNames: ["model", "outcome"],
  registers: [metrics],
});
export const modelTokens = new Counter({
  name: "canary_model_tokens_total",
  help: "Model usage tokens",
  labelNames: ["model", "direction"],
  registers: [metrics],
});
export const modelLatency = new Histogram({
  name: "canary_model_duration_seconds",
  help: "Model latency",
  labelNames: ["model"],
  registers: [metrics],
});
export function initializeTracing() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return;
  }
  const provider = new NodeTracerProvider({
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
  return () => provider.shutdown();
}
export async function traced<T>(
  name: string,
  attributes: Record<string, string | number>,
  operation: () => Promise<T>
): Promise<T> {
  return await trace
    .getTracer("canary-pr-qa")
    .startActiveSpan(name, { attributes }, async (span) => {
      try {
        return await operation();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}

export const durableRuns = new Gauge({
  name: "canary_durable_runs",
  help: "Durable run counts",
  labelNames: ["status", "outcome"],
  registers: [metrics],
});
export const durableTokens = new Gauge({
  name: "canary_durable_model_tokens",
  help: "Persisted model usage",
  labelNames: ["model"],
  registers: [metrics],
});
export const durableCost = new Gauge({
  name: "canary_durable_model_cost_usd",
  help: "Persisted estimated model cost",
  labelNames: ["model"],
  registers: [metrics],
});
