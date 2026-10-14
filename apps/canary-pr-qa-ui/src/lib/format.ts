import type { Outcome, RunStatus } from "@/api/contracts";
import {
  automatic,
  automaticReasons,
  automaticStates,
  outcomes,
  phases,
  runStates,
} from "@/i18n";

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

/**
 * An automatic attempt that waits is not a failure; only an expired deadline is.
 * `rate_limited`, `discarded` and `disabled` stay neutral so the screens never
 * overstate the problem, and a promoted attempt is the one unambiguous success.
 */
export function toneForAutomatic(state: string | null | undefined): Tone {
  if (state === "expired") {
    return "failed";
  }
  if (state === "waiting") {
    return "pending";
  }
  return state === "promoted" ? "success" : "neutral";
}

/**
 * The two failures a retry can restart. `waiting` is already probing, `promoted`
 * has its run, `discarded` would be discarded again on the same facts, and
 * `disabled` is a server-side switch: none of them has anything to re-arm.
 */
export function retryableAutomatic(state: string | null | undefined): boolean {
  return state === "expired" || state === "rate_limited";
}

/**
 * The two failures a delete can clear: the same set a retry can re-arm, because
 * both stopped without a run. The row itself is what the server checks, so this
 * only decides whether the button is offered.
 */
export function deletableAutomatic(state: string | null | undefined): boolean {
  return retryableAutomatic(state);
}

export function automaticStateLabel(state: string | null | undefined): string {
  if (!state) {
    return "";
  }
  return automaticStates[state] ?? state;
}

/** An unknown reason code is still shown, never swallowed. */
export function automaticReasonLabel(
  reason: string | null | undefined
): string {
  if (!reason) {
    return "";
  }
  return automaticReasons[reason] ?? automatic.reasonUnknown(reason);
}

const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;

/**
 * Repository names come from GitHub webhook payloads, so the pull-request link
 * is only built when the name really looks like `owner/name`.
 */
export function githubPullUrl(
  repo: string | null | undefined,
  pr: number | null | undefined
): string | undefined {
  if (!(repo && repositoryPattern.test(repo))) {
    return;
  }
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) {
    return;
  }
  return `https://github.com/${repo}/pull/${pr}`;
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

/**
 * Dates of a French-only interface. The runtime locale of a container is not a
 * given (it renders `10/13/2026, 6:25:05 AM` under `en-US`), so the locale is
 * pinned here rather than inherited from the host.
 */
export function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString("fr-FR") : "";
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

export function isOutcome(value: string | undefined): value is Outcome {
  return value !== undefined && value in outcomes;
}
