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
  /** Reprise d'un appel modèle après une coupure de transport. */
  retry?: { attempt: number; code: string; max: number } | null;
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
  /** Reprises de transport du run, quand le worker les a enregistrées. */
  usage?: { retries?: number | null } | null;
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
 * Portée d'une clé API : `viewer` lit les tests et leurs rapports, `operator`
 * peut en plus lancer un test. Aucune clé n'est `admin` : les réglages restent
 * réservés aux comptes du dashboard.
 */
export type ApiKeyRole = "viewer" | "operator";

/**
 * One API key as the dashboard lists it. The token itself is never part of a
 * row: the list only carries the prefix an operator can recognise.
 */
export interface ApiKeyRow {
  createdAt: string;
  id: string;
  lastUsedAt: string | null;
  name: string;
  prefix: string;
  /** Repositories the key can read; the server decides what it may see. */
  repos: string[];
  revokedAt: string | null;
  /**
   * Lecture seule (`viewer`) ou droit de lancer un test (`operator`) : la
   * portée est figée à la création, une clé ne l'élargit jamais toute seule.
   */
  role: ApiKeyRole;
}

/**
 * The answer of a creation: the clear token travels back once, so the operator
 * can copy it before the server keeps only its encrypted copy.
 */
export interface ApiKeyCreated extends ApiKeyRow {
  token: string;
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

/**
 * One local account of the dashboard. The id is the raw uuid the accounts
 * endpoints address; the setup-created administrator is one of these.
 */
export interface LocalAccount {
  createdAt: string;
  id: string;
  repos: string[];
  role: Role;
  username: string;
}

export interface AccountsPayload {
  accounts: LocalAccount[];
}

/** A created or updated account, as `POST` and `PATCH` answer it. */
export interface AccountPayload {
  account: LocalAccount;
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
 *
 * `POST /dashboard/automatic/:id/retry` answers with this same object, the
 * attempt it re-armed, so a screen can replace what it shows with the response.
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
  /**
   * `status` porte l'issue de la publication du rapport ("published"/"failed"),
   * jamais l'état du commit status GitHub ; les résultats antérieurs portent
   * l'ancien vocabulaire ("success"/"error") et restent lus tels quels.
   */
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
    /** Cumul des bornes « au pire cas » des tentatives perdues. */
    reservedCostUsd?: number | null;
    reservedTokens?: number | null;
    retries?: number | null;
    tokens: number;
  } | null;
}

export interface ApiErrorPayload {
  code?: string;
  error?: string;
  hint?: string;
  requestId?: string;
}
