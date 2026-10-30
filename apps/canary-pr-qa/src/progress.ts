import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { context, trace } from "@opentelemetry/api";
import { createLogger } from "@usecanary/logger";
import type { Diagnostic } from "./diagnostics.js";
import { recordModelResponses } from "./planner-record.js";
import { writeJson } from "./report.js";
import type { RunScope } from "./run-scope.js";

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
  /** Reprise d'un appel modèle après une coupure de transport. */
  retry?: { attempt: number; max: number; code: string };
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
  /**
   * Conserve chaque réponse payée du modèle sous `_planner/`, avec une ligne
   * d'événement sans contenu dans la phase en cours (`planner-record.ts`).
   */
  recordModelResponses(scope: RunScope | undefined) {
    recordModelResponses(scope, this.root, () => this.phase);
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
