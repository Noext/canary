import { z } from "zod";
import { apiKeyListSchema } from "./api-keys";
import { automaticStatusSchema } from "./automatic";

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

/**
 * One local account of the dashboard: the setup administrator, or an account an
 * administrator created in Réglages → Comptes utilisateurs.
 */
const localAccountSchema = z.object({
  createdAt: z.string(),
  id: z.string(),
  repos: z.array(z.string()),
  role,
  username: z.string(),
});

const accountsSchema = z.object({
  accounts: z.array(localAccountSchema),
});

export const accountPayloadSchema = z.object({ account: localAccountSchema });

const runStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const outcomeSchema = z.enum([
  "passed",
  "failed",
  "blocked",
  "skipped",
  "stale",
]);

const runProgressSchema = z.object({
  action: z.string().nullish(),
  phase: z.string().nullish(),
  retry: z
    .object({
      attempt: z.number(),
      code: z.string(),
      max: z.number(),
    })
    .nullish(),
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
  // Seul le compteur de reprises est lu dans la liste : les autres champs
  // d'usage sont absents tant que le run n'a pas fini.
  usage: z.object({ retries: z.number().nullish() }).passthrough().nullish(),
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
const diagnosticSchema = z
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
const scenarioDiagnosticSchema = z
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
      .object({
        commentUrl: z.string().nullish(),
        commitStatus: z.string().nullish(),
        status: z.string(),
      })
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
        reservedCostUsd: z.number().nullish(),
        reservedTokens: z.number().nullish(),
        retries: z.number().nullish(),
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
  "/accounts": accountsSchema,
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
