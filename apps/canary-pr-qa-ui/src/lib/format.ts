import type { Outcome, RunStatus } from "@/api/contracts";
import { outcomes, phases, runStates } from "@/i18n";

export type Tone = "failed" | "neutral" | "pending" | "success";

/** Statuses that stop the run: no further SSE update is expected. */
export function isTerminal(status: RunStatus): boolean {
  return status !== "queued" && status !== "running";
}

export function stateLabel(status: string | null | undefined): string {
  if (!status) {
    return "";
  }
  return runStates[status] ?? status;
}

export function outcomeLabel(outcome: string | null | undefined): string {
  if (!outcome) {
    return "";
  }
  return outcomes[outcome] ?? outcome;
}

export function toneFor(status: string | null | undefined): Tone {
  if (!status) {
    return "neutral";
  }
  if (status === "passed") {
    return "success";
  }
  if (["failed", "blocked", "interrupted"].includes(status)) {
    return "failed";
  }
  if (["running", "queued"].includes(status)) {
    return "pending";
  }
  return "neutral";
}

export function phaseLabel(phase: string | null | undefined): string {
  if (!phase) {
    return "";
  }
  return phases[phase] ?? phase;
}

const phaseGroups: string[][] = [
  ["context", "preview"],
  ["discovery", "planning"],
  ["execution", "evidence"],
  ["verification"],
  ["publication", "done"],
];

export function phaseIndex(phase: string | null | undefined): number {
  if (!phase) {
    return -1;
  }
  return phaseGroups.findIndex((group) => group.includes(phase));
}

/** Sequence of bootstrap steps owned by the home view. */
export function shortSha(sha: string | null | undefined): string {
  return (sha ?? "").slice(0, 12);
}

export function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "";
}

/**
 * Artifact paths come from the QA run, not from us: reject anything absolute or
 * traversing before building a URL, and encode each segment.
 */
export function safeArtifactPath(
  path: string | null | undefined
): string | undefined {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("..") ||
    path.includes("\\")
  ) {
    return;
  }
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Only ever link to GitHub when the URL really is a github.com URL. */
export function githubCommentUrl(
  value: string | null | undefined
): string | undefined {
  if (!value) {
    return;
  }
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" ? url.toString() : undefined;
  } catch {
    return;
  }
}

export function usageText(
  usage:
    | {
        costUsd: number;
        pricingConfigured?: boolean | null;
        tokens: number;
      }
    | null
    | undefined
): string {
  if (!usage) {
    return "";
  }
  return `${usage.tokens} tokens · ${
    usage.pricingConfigured === false
      ? "coût non configuré"
      : `coût estimé $${usage.costUsd.toFixed(4)}`
  }`;
}

export function isOutcome(value: string | undefined): value is Outcome {
  return value !== undefined && value in outcomes;
}
