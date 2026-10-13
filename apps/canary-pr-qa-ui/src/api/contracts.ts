/**
 * Browser-safe view of the PR QA HTTP contract.
 *
 * These types describe what the dashboard consumes. They intentionally mirror
 * the server declarations (`src/access.ts`, `src/queue.ts`, `src/schema.ts`,
 * `src/github-setup.ts`) without importing them: this module is bundled for the
 * browser and must never pull a Node-only dependency.
 *
 * Runtime validation lives in `schemas.ts`; treat these types as the shape the
 * schemas guarantee, not as a promise made by the server.
 */

export type Role = "viewer" | "operator" | "admin";

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type Outcome = "passed" | "failed" | "blocked" | "skipped" | "stale";

export interface Principal {
  id: string;
  repos: string[];
  role: Role;
  username?: string;
}

export interface RunProgress {
  action?: string | null;
  phase?: string | null;
  scenarioId?: string | null;
}

/** The run options the server stored; the dashboard never reads them back. */
export interface Job {
  cancel_requested: boolean;
  created_at: string;
  id: string;
  input?: unknown;
  outcome?: string | null;
  owner: string;
  pr: number;
  repo: string;
  sha: string;
  status: RunStatus;
  updated_at: string;
  worker?: string | null;
}

export interface RunJob extends Job {
  error?: string | null;
  progress?: RunProgress | null;
}

/**
 * Preview constraints shown to an administrator, and returned by the host list
 * endpoint after an edit.
 */
export interface PreviewSettings {
  /** Hosts in force: the dashboard list, or the server default. */
  hosts?: string[] | null;
  /** `PREVIEW_ALLOWED_HOSTS` configured on the server, offered as a reset target. */
  hostsDefault?: string[] | null;
  shaHeader?: string | null;
  shaPath?: string | null;
}

export interface SetupStatus {
  ai: { defaultModel: string; endpoint: string };
  github: {
    /** Repositories where automatic runs are switched on (lowercase). */
    autoRepos: string[];
    mode: "missing" | "technical" | "app";
    repositories: string[];
  };
  preview: { automatic: boolean } & PreviewSettings;
}

/**
 * Lifecycle of a pull-request delivery. The first three are what the home block
 * lists; the terminal ones are what the detail screen meets when it opens an
 * attempt by its id after the attempt left the list.
 */
export type AutomaticState =
  | "waiting"
  | "expired"
  | "rate_limited"
  | "promoted"
  | "discarded"
  | "disabled";

export interface AutomaticAttempt {
  attempts: number;
  deadlineAt: string;
  id: string;
  /** Redacted last failure text, set when the attempt was refused. */
  lastError?: string | null;
  pr: number;
  reason: string;
  repo: string;
  runId: string | null;
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
 * One automatic attempt and the evidence of why it never became a run. The
 * preview constraints are deployment topology: an administrator only.
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

export interface GitHubRepository {
  account: string;
  auto_run: boolean;
  enabled: boolean;
  full_name: string;
  installation_id: string;
  private: boolean;
}

export interface GitHubDelivery {
  created_at: string;
  event: string;
  status: string;
}

export interface GitHubStatus {
  app: { id: string; origin: string; slug: string } | null;
  lastDelivery: GitHubDelivery | null;
  legacyConfigured: boolean;
  repositories: GitHubRepository[];
  restriction: string[];
}

export interface GitHubRemoval extends GitHubStatus {
  disconnected: {
    appDeleted: boolean;
    deleteApp: boolean;
    uninstalled: string[];
    warnings: string[];
  };
}

export interface GitHubManifest {
  action: string;
  manifest: Record<string, unknown>;
}

export interface ModelCatalog {
  data: { id: string }[];
  defaultModel: string;
}

export interface RunCreated {
  id: string;
  reportUrl: string;
  statusUrl: string;
}

export interface ScenarioAssertion {
  actual?: unknown;
  baseline?: unknown;
  id: string;
  passed: boolean;
  persisted?: unknown;
}

/** The server's explanation of a failing phase: its code, message and next step. */
export interface Diagnostic {
  code: string;
  hint: string;
  message: string;
}

/** The server's explanation of a failing phase: its code, message and next step. */
export interface Diagnostic {
  code: string;
  hint: string;
  message: string;
}

/**
 * The diagnostic stored for one scenario. `hint` is optional because the report
 * is read back from a file an older build may have written.
 */
export interface ScenarioDiagnostic {
  code: string;
  hint?: string | null;
  message: string;
}

export interface ScenarioSummary {
  artifacts: string[];
  assertions?: ScenarioAssertion[];
  /** Set when the scenario stopped on an error; the code names the cause. */
  diagnostic?: ScenarioDiagnostic | null;
  error?: string | null;
  outcome: Outcome;
  scenario: {
    assertions?: { description?: string | null; id: string }[];
    id: string;
    title: string;
  };
}

/**
 * Only the fields the dashboard renders are typed here; everything else in the
 * server result is carried through untouched by the schema.
 */
export interface RunResult {
  /** Set when the run stopped before finishing; the code names the cause. */
  diagnostic?: Diagnostic | null;
  endedAt?: string | null;
  error?: string | null;
  id: string;
  outcome: Outcome;
  preview?: { sha: string; url: string } | null;
  prUrl: string;
  publication?: { commentUrl: string; status: string } | null;
  scenarios: ScenarioSummary[];
  sha?: string | null;
  startedAt: string;
  usage?: {
    calls?: number | null;
    costUsd: number;
    estimated?: boolean | null;
    model?: string | null;
    pricingConfigured?: boolean | null;
    tokens: number;
  } | null;
}

export interface ApiErrorPayload {
  code?: string;
  error?: string;
  hint?: string;
  requestId?: string;
}
