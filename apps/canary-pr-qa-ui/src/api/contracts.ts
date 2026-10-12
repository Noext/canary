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

export interface SetupStatus {
  ai: { defaultModel: string; endpoint: string };
  github: {
    mode: "missing" | "technical" | "app";
    repositories: string[];
  };
  preview: {
    automatic: boolean;
    hosts?: string[] | null;
    shaHeader?: string | null;
    shaPath?: string | null;
  };
}

export interface Preflight {
  model: string;
  pr: { number: number; repo: string; sha: string; title: string };
  preview: { sha: string; url: string };
  ready: boolean;
}

export interface GitHubRepository {
  account: string;
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

export interface ScenarioSummary {
  artifacts: string[];
  assertions?: ScenarioAssertion[];
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
