import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { context, trace } from "@opentelemetry/api";
import { createLogger } from "@usecanary/logger";
import type { Diagnostic } from "./diagnostics.js";
import { writeJson } from "./report.js";

export type Phase =
  | "context"
  | "preview"
  | "discovery"
  | "planning"
  | "execution"
  | "evidence"
  | "verification"
  | "publication"
  | "done";
export interface ProgressEvent {
  action?: string;
  diagnostic?: Diagnostic;
  durationMs?: number;
  outcome?: string;
  phase: Phase;
  scenarioId?: string;
  step?: number;
}
const logger = createLogger({ name: "pr-qa-progress" });
export class Progress {
  private readonly root: string;
  private readonly runId: string;
  private sequence = 0;
  phase: Phase = "context";
  constructor(root: string, runId: string) {
    this.root = root;
    this.runId = runId;
  }
  async record(event: ProgressEvent) {
    this.phase = event.phase;
    const span = trace.getSpan(context.active());
    span?.addEvent(event.phase, {
      runId: this.runId,
      action: event.action ?? "",
      scenario: event.scenarioId ?? "",
    });
    const entry = {
      traceId: span?.spanContext().traceId,
      spanId: span?.spanContext().spanId,
      runId: this.runId,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      ...event,
    };
    await mkdir(this.root, { recursive: true });
    await appendFile(
      join(this.root, "events.jsonl"),
      `${JSON.stringify(entry)}\n`,
      { mode: 0o600 }
    );
    await writeJson(join(this.root, "progress.json"), entry);
    logger.info(entry, "QA progress");
  }
}
