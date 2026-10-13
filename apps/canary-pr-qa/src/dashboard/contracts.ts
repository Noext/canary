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

/**
 * Lifecycle of a pull-request delivery. The list reports the three states that
 * still have something to check; the detail screen can be opened on the terminal
 * ones too: promoted into a run, discarded without one (repository left the
 * allowlist, pull request closed, SHA moved), or refused before any probe.
 */
export type AutomaticState =
  | "waiting"
  | "expired"
  | "rate_limited"
  | "promoted"
  | "discarded"
  | "disabled";

export interface AutomaticAttempt {
  /** Probe count already spent waiting for a verifiable preview. */
  attempts: number;
  /** ISO instant after which the attempt stops waiting and expires. */
  deadlineAt: string;
  /** Webhook delivery id; stable across probes. */
  id: string;
  /** Redacted last failure text, set when the attempt was refused. */
  lastError?: string | null;
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

/** One recorded step of an automatic attempt, oldest first. */
export interface AutomaticTimelineEntry {
  /** Audit action (`automatic.preview_wait`, `automatic.preview_expired`, ...). */
  action: string;
  /** ISO instant the step was recorded. */
  at: string;
  /** Backoff the step scheduled before the next probe, when it recorded one. */
  seconds?: number | null;
}

/**
 * Everything known about one automatic attempt that never became a run: the
 * attempt itself, the version proof its preview had to satisfy and the audit
 * trail of its probes. The title configuration is deployment topology, so it is
 * reported to administrators only.
 *
 * `POST /dashboard/automatic/:id/retry` answers with this same object, so the
 * screen that re-armed an attempt replaces what it shows with the response.
 */
export interface AutomaticDetail {
  attempt: AutomaticAttempt;
  preview?: {
    shaHeader: string;
    shaPath?: string | null;
    template?: string | null;
  } | null;
  timeline: AutomaticTimelineEntry[];
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

/**
 * One service key, without its secret: the clear token exists only in the answer
 * that created it. `repos` is what the key may read, never what it may write;
 * `role` is what it may do beyond reading — an `operator` key starts runs.
 */
export interface ApiKeyRow {
  createdAt: string;
  id: string;
  lastUsedAt: string | null;
  name: string;
  /** First characters of the token, all the list ever shows (`qa_live_7f3c`). */
  prefix: string;
  repos: string[];
  revokedAt: string | null;
  role: "operator" | "viewer";
}

/** A fresh key: the only answer that carries the token in clear. */
export interface ApiKeyCreated extends ApiKeyRow {
  token: string;
}

/**
 * One local account of the dashboard: the setup administrator, or an account an
 * administrator created in Réglages → Comptes utilisateurs. `id` is the raw uuid
 * the accounts endpoints address, without the `local:` prefix a principal wears.
 */
export interface LocalAccount {
  createdAt: string;
  id: string;
  repos: string[];
  role: "admin" | "operator" | "viewer";
  username: string;
}

/** `GET /accounts` answers every account the caller may administer. */
export interface AccountsPayload {
  accounts: LocalAccount[];
}

/** The created or updated account `POST /accounts` and `PATCH /accounts/:id` answer with. */
export interface AccountPayload {
  account: LocalAccount;
}
