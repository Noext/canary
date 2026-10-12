/**
 * Dashboard HTTP contract, server side.
 *
 * The browser copy of this contract lives in `@usecanary/pr-qa-ui`
 * (`src/api/contracts.ts` + `src/api/schemas.ts`). Keep both in sync: the UI
 * validates every response at runtime, so a change here that is not mirrored
 * there fails loudly instead of rendering `undefined`.
 */

/**
 * Preview constraints shown to an administrator, and returned by the host list
 * endpoint after an edit.
 */
export interface PreviewSettings {
  /** Hosts in force: the dashboard list, or the server default. */
  hosts: string[];
  /** `PREVIEW_ALLOWED_HOSTS` as configured on the server, offered as a reset target. */
  hostsDefault: string[];
  shaHeader?: string;
  shaPath?: string;
}

export interface SetupStatus {
  ai: { defaultModel: string; endpoint: string };
  github: {
    /** Repositories where automatic runs are switched on (lowercase). */
    autoRepos: string[];
    mode: "missing" | "technical" | "app";
    repositories: string[];
  };
  preview: { automatic: boolean } & Partial<PreviewSettings>;
}

/** Lifecycle of a pull-request delivery that has no run yet. */
export type AutomaticState = "waiting" | "expired" | "rate_limited";

export interface AutomaticAttempt {
  /** Probe count already spent waiting for a verifiable preview. */
  attempts: number;
  /** ISO instant after which the attempt stops waiting and expires. */
  deadlineAt: string;
  /** Webhook delivery id; stable across probes. */
  id: string;
  pr: number;
  /** Machine reason of the current state (`PREVIEW_NOT_FOUND`, ...). */
  reason: string;
  repo: string;
  /** Run id once the attempt was promoted to a queued job. */
  runId: string | null;
  /** Full PR head SHA the attempt is pinned to. */
  sha: string;
  state: AutomaticState;
  updatedAt: string;
}

export interface AutomaticStatus {
  attempts: AutomaticAttempt[];
  enabledRepos: string[];
  summary: { expired: number; rateLimited: number; waiting: number };
}

export interface Preflight {
  model: string;
  pr: { number: number; repo: string; sha: string; title: string };
  preview: { sha: string; url: string };
  ready: boolean;
}
