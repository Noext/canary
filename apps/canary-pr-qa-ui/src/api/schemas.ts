import { z } from "zod";

/**
 * Every response the dashboard consumes is parsed before it reaches a
 * component: a server change becomes a readable error instead of an
 * `undefined` rendered in the UI.
 */

const role = z.enum(["viewer", "operator", "admin"]);

export const principalSchema = z.object({
  id: z.string(),
  repos: z.array(z.string()),
  role,
  username: z.string().optional(),
});

export const authStatusSchema = z.object({ initialized: z.boolean() });

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const outcomeSchema = z.enum([
  "passed",
  "failed",
  "blocked",
  "skipped",
  "stale",
]);

const runProgressSchema = z.object({
  action: z.string().nullish(),
  phase: z.string().nullish(),
  scenarioId: z.string().nullish(),
});

export const runJobSchema = z.object({
  cancel_requested: z.boolean(),
  created_at: z.string(),
  error: z.string().nullish(),
  id: z.string(),
  input: z.unknown().optional(),
  outcome: z.string().nullish(),
  owner: z.string(),
  pr: z.number(),
  progress: runProgressSchema.nullish(),
  repo: z.string(),
  sha: z.string(),
  status: runStatusSchema,
  updated_at: z.string(),
  worker: z.string().nullish(),
});

export const runJobListSchema = z.array(
  runJobSchema.omit({ error: true, progress: true })
);

export const previewSettingsSchema = z.object({
  hosts: z.array(z.string()),
  hostsDefault: z.array(z.string()),
  shaHeader: z.string().nullish(),
  shaPath: z.string().nullish(),
});

export const setupStatusSchema = z.object({
  ai: z.object({ defaultModel: z.string(), endpoint: z.string() }),
  github: z.object({
    autoRepos: z.array(z.string()),
    mode: z.enum(["missing", "technical", "app"]),
    repositories: z.array(z.string()),
  }),
  preview: z.object({
    automatic: z.boolean(),
    hosts: z.array(z.string()).nullish(),
    hostsDefault: z.array(z.string()).nullish(),
    shaHeader: z.string().nullish(),
    shaPath: z.string().nullish(),
  }),
});

export const apiKeyRowSchema = z.object({
  createdAt: z.string(),
  id: z.string(),
  lastUsedAt: z.string().nullable(),
  name: z.string(),
  prefix: z.string(),
  repos: z.array(z.string()),
  revokedAt: z.string().nullable(),
});

export const apiKeyListSchema = z.array(apiKeyRowSchema);

/** A creation answers the token in clear text; no other answer ever carries it. */
export const apiKeyCreatedSchema = apiKeyRowSchema.extend({
  token: z.string(),
});

export const apiKeySecretSchema = z.object({ token: z.string() });

export const apiKeyRevokedSchema = z.object({
  id: z.string(),
  revokedAt: z.string(),
});

export const preflightSchema = z.object({
  model: z.string(),
  pr: z.object({
    number: z.number(),
    repo: z.string(),
    sha: z.string(),
    title: z.string(),
  }),
  preview: z.object({ sha: z.string(), url: z.string() }),
  ready: z.boolean(),
});

export const githubRepositorySchema = z.object({
  account: z.string(),
  auto_run: z.boolean(),
  enabled: z.boolean(),
  full_name: z.string(),
  installation_id: z.string(),
  private: z.boolean(),
});

export const automaticStateSchema = z.enum([
  "waiting",
  "expired",
  "rate_limited",
  "promoted",
  "discarded",
  "disabled",
]);

export const automaticAttemptSchema = z.object({
  attempts: z.number(),
  deadlineAt: z.string(),
  id: z.string(),
  lastError: z.string().nullish(),
  reason: z.string(),
  pr: z.number(),
  repo: z.string(),
  runId: z.string().nullable(),
  sha: z.string(),
  state: automaticStateSchema,
  updatedAt: z.string(),
});

/** One recorded step of an attempt, oldest first. */
export const automaticTimelineEntrySchema = z.object({
  action: z.string(),
  at: z.string(),
  seconds: z.number().nullish(),
});

export const automaticDetailSchema = z.object({
  attempt: automaticAttemptSchema,
  preview: z
    .object({
      shaHeader: z.string(),
      shaPath: z.string().nullish(),
      template: z.string().nullish(),
    })
    .nullish(),
  timeline: z.array(automaticTimelineEntrySchema),
});

export const automaticStatusSchema = z.object({
  attempts: z.array(automaticAttemptSchema),
  enabledRepos: z.array(z.string()),
  summary: z.object({
    expired: z.number(),
    rateLimited: z.number(),
    waiting: z.number(),
  }),
});

export const githubStatusSchema = z.object({
  app: z
    .object({ id: z.string(), origin: z.string(), slug: z.string() })
    .nullable(),
  lastDelivery: z
    .object({
      created_at: z.string(),
      event: z.string(),
      status: z.string(),
    })
    .nullable(),
  legacyConfigured: z.boolean(),
  repositories: z.array(githubRepositorySchema),
  restriction: z.array(z.string()),
});

export const githubRemovalSchema = githubStatusSchema.extend({
  disconnected: z.object({
    appDeleted: z.boolean(),
    deleteApp: z.boolean(),
    uninstalled: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
});

export const githubManifestSchema = z.object({
  action: z.string(),
  manifest: z.record(z.unknown()),
});

export const githubInstallSchema = z.object({ url: z.string() });

export const modelCatalogSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
  defaultModel: z.string(),
});

export const runCreatedSchema = z.object({
  id: z.string(),
  reportUrl: z.string(),
  statusUrl: z.string(),
});

export const cancelSchema = z.object({ cancelRequested: z.literal(true) });

export const okSchema = z.object({ ok: z.literal(true) });

const resultAssertionSchema = z.object({
  actual: z.unknown().optional(),
  baseline: z.unknown().optional(),
  id: z.string(),
  passed: z.boolean(),
  persisted: z.unknown().optional(),
});

/** The planned assertion, matched by id to label the executed one. */
const planAssertionSchema = z.object({
  description: z.string().nullish(),
  id: z.string(),
});

/**
/** The server diagnostic of a failing phase: its code, message and next step. */
export const diagnosticSchema = z
  .object({
    code: z.string(),
    hint: z.string(),
    message: z.string(),
  })
  .passthrough();

/**
 * The diagnostic a report stores for one scenario. `hint` is read back from a
 * file written by an older build, so a scenario that carries only its code and
 * message stays valid: the run-level diagnostic above is the strict one.
 */
export const scenarioDiagnosticSchema = z
  .object({
    code: z.string(),
    hint: z.string().nullish(),
    message: z.string(),
  })
  .passthrough();

/**
 * Passthrough on purpose: the dashboard renders a subset of the report, but the
 * technical diagnostic prints the whole result. Stripping the undeclared fields
 * (steps, contract, sessionId, nested diagnostics) removed exactly the data an
 * operator needs to investigate a failed run.
 */
const scenarioSummarySchema = z
  .object({
    artifacts: z.array(z.string()),
    assertions: z.array(resultAssertionSchema).optional(),
    diagnostic: scenarioDiagnosticSchema.nullish(),
    error: z.string().nullish(),
    outcome: outcomeSchema,
    scenario: z
      .object({
        assertions: z.array(planAssertionSchema).optional(),
        id: z.string(),
        title: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export const runResultSchema = z
  .object({
    diagnostic: diagnosticSchema.nullish(),
    endedAt: z.string().nullish(),
    error: z.string().nullish(),
    id: z.string(),
    outcome: outcomeSchema,
    preview: z.object({ sha: z.string(), url: z.string() }).nullish(),
    prUrl: z.string(),
    publication: z
      .object({ commentUrl: z.string(), status: z.string() })
      .nullish(),
    scenarios: z.array(scenarioSummarySchema),
    sha: z.string().nullish(),
    startedAt: z.string(),
    usage: z
      .object({
        calls: z.number().nullish(),
        costUsd: z.number(),
        estimated: z.boolean().nullish(),
        model: z.string().nullish(),
        pricingConfigured: z.boolean().nullish(),
        tokens: z.number(),
      })
      .nullish(),
  })
  .passthrough();

export const errorPayloadSchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  hint: z.string().optional(),
  requestId: z.string().optional(),
});

/** Path-keyed schemas: adding an endpoint here makes `api()` typed for it. */
export const responseSchemas = {
  "/auth/login": principalSchema,
  "/auth/setup": principalSchema,
  "/auth/status": authStatusSchema,
  "/dashboard/api-keys": apiKeyListSchema,
  "/dashboard/automatic": automaticStatusSchema,
  "/dashboard/preview-hosts": previewSettingsSchema,
  "/dashboard/status": setupStatusSchema,
  "/github/app": githubStatusSchema,
  "/github/app/install": githubInstallSchema,
  "/github/app/manifest": githubManifestSchema,
  "/github/app/refresh": githubStatusSchema,
  "/github/app/repositories": githubStatusSchema,
  "/me": principalSchema,
  "/models": modelCatalogSchema,
  "/runs": runJobListSchema,
  "/runs/preflight": preflightSchema,
  "/session": principalSchema,
} as const;

export type ResponseSchemas = typeof responseSchemas;
export type ApiPath = keyof ResponseSchemas;
