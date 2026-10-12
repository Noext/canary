import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { QaError } from "./diagnostics.js";

const envSchema = z.object({
  QA_ALLOW_PRIVATE_PREVIEWS: z.enum(["true", "false"]).default("false"),
  QA_WEBHOOK_MAX_RUNS_PER_HOUR: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(60),
  QA_WEBHOOK_REPO_MAX_RUNS_PER_HOUR: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(20),
  QA_PREVIEW_WAIT_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(7200)
    .default(900),
  QA_BASELINE_URL_TEMPLATE: z.string().default(""),
  DATABASE_URL: z.string().default(""),
  QA_RUN_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(7200)
    .default(900),
  QA_RUN_MAX_TOKENS: z.coerce.number().int().min(1000).default(100_000),
  QA_RUN_MAX_COST_USD: z.coerce.number().positive().default(10),
  QA_INPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(0),
  QA_OUTPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(0),
  QA_USERS_FILE: z.string().default(""),
  QA_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),
  QA_STORAGE_MAX_GB: z.coerce.number().positive().default(20),
  QA_BROWSER_SERVICE_URL: z.string().default(""),
  QA_BROWSER_SERVICE_TOKEN: z.string().default(""),
  QA_BROWSER_HOST: z.string().default("127.0.0.1"),
  QA_BROWSER_PORT: z.coerce.number().int().default(8790),
  QA_FIXTURES_FILE: z.string().default(""),
  GITHUB_APP_ID: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY_FILE: z.string().default(""),
  GITHUB_INSTALLATION_ID: z.string().default(""),
  GITHUB_WEBHOOK_SECRET: z.string().default(""),
  QA_OIDC_ISSUER: z.string().default(""),
  QA_OIDC_AUDIENCE: z.string().default(""),
  QA_OIDC_JWKS_URL: z.string().default(""),
  QA_ALLOWED_PROVIDER_HOSTS: z.string().default(""),
  QA_RAW_EVIDENCE: z.enum(["true", "false"]).default("false"),
  GITHUB_TOKEN: z.string().default(""),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  GITHUB_ALLOWED_REPOS: z.string().default(""),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().min(1).default("configured-model"),
  OPENAI_JSON_MODE: z.enum(["true", "false"]).default("true"),
  OPENAI_TOKEN_PARAMETER: z
    .enum(["max_tokens", "max_completion_tokens"])
    .default("max_tokens"),
  OPENAI_TEMPERATURE: z
    .union([z.literal(""), z.coerce.number().min(0).max(2)])
    .default(""),
  QA_DATA_DIR: z.string().default("./qa-data"),
  QA_API_TOKEN: z.string().default(""),
  QA_HOST: z.string().default("127.0.0.1"),
  QA_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  QA_MAX_STEPS: z.coerce.number().int().min(1).max(100).default(25),
  QA_MAX_SCENARIOS: z.coerce.number().int().min(1).max(20).default(8),
  QA_PLAN_MAX_TOKENS: z.coerce
    .number()
    .int()
    .min(128)
    .max(32_768)
    .default(8000),
  QA_ACTION_MAX_TOKENS: z.coerce
    .number()
    .int()
    .min(128)
    .max(32_768)
    .default(4096),
  QA_DOCTOR_MAX_TOKENS: z.coerce
    .number()
    .int()
    .min(128)
    .max(32_768)
    .default(1024),
  QA_STEP_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  QA_MODEL_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(300)
    .default(120),
  QA_CONTEXT_CHARS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(500_000)
    .default(120_000),
  PREVIEW_ALLOWED_HOSTS: z.string().default(""),
  PREVIEW_URL_TEMPLATE: z.string().default(""),
  PREVIEW_SHA_PATH: z.string().default(""),
  PREVIEW_SHA_HEADER: z.string().default("x-commit-sha"),
  PREVIEW_ENVIRONMENT: z.string().default("preview"),
  ARTIFACT_BASE_URL: z.string().default(""),
  ARTIFACT_PUBLIC: z.enum(["true", "false"]).default("false"),
  CANARY_CLI_PATH: z
    .string()
    .default(
      fileURLToPath(new URL("../../canary/dist/cli.js", import.meta.url))
    ),
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    QA_DATA_DIR: resolve(parsed.QA_DATA_DIR),
    allowedRepos: parsed.GITHUB_ALLOWED_REPOS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    allowedHosts: parsed.PREVIEW_ALLOWED_HOSTS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
export type Config = ReturnType<typeof loadConfig>;

function validEndpoint(input: string, origin = false): boolean {
  try {
    const url = new URL(input);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!origin || url.pathname === "/")
    );
  } catch {
    return false;
  }
}
function serviceProblems(config: Config) {
  const problems: string[] = [];
  if (
    config.QA_API_TOKEN.length < 24 ||
    /replace-with|changeme/i.test(config.QA_API_TOKEN)
  ) {
    problems.push(
      "Set QA_API_TOKEN to at least 24 random characters; replace the example placeholder"
    );
  }
  if (!config.allowedRepos.length) {
    problems.push("Set GITHUB_ALLOWED_REPOS before serving jobs");
  }
  if (!(config.GITHUB_TOKEN || config.GITHUB_APP_ID)) {
    problems.push(
      "Set GITHUB_TOKEN for the default GitHub publication workflow"
    );
  }
  if (
    config.GITHUB_APP_ID &&
    !(config.GITHUB_INSTALLATION_ID && config.GITHUB_APP_PRIVATE_KEY_FILE)
  ) {
    problems.push(
      "Set GITHUB_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY_FILE together with GITHUB_APP_ID"
    );
  }
  if (
    config.GITHUB_WEBHOOK_SECRET &&
    config.GITHUB_WEBHOOK_SECRET.length < 32
  ) {
    problems.push(
      "GITHUB_WEBHOOK_SECRET must contain at least 32 random characters"
    );
  }
  if (
    config.QA_BROWSER_SERVICE_URL &&
    config.QA_BROWSER_SERVICE_TOKEN.length < 32
  ) {
    problems.push(
      "QA_BROWSER_SERVICE_TOKEN must contain at least 32 random characters"
    );
  }
  if (
    config.QA_OIDC_ISSUER &&
    !(config.QA_OIDC_AUDIENCE && config.QA_OIDC_JWKS_URL)
  ) {
    problems.push(
      "Set QA_OIDC_AUDIENCE and QA_OIDC_JWKS_URL with QA_OIDC_ISSUER"
    );
  }
  return problems;
}
export function validateConfiguration(config: Config, service = false) {
  const problems: string[] = [];
  for (const key of ["OPENAI_BASE_URL", "GITHUB_API_URL"] as const) {
    if (!validEndpoint(config[key])) {
      problems.push(
        `${key} must be an HTTP(S) endpoint without embedded credentials, query or fragment`
      );
    }
  }
  if (["configured-model", "your-model-name"].includes(config.OPENAI_MODEL)) {
    problems.push("Set OPENAI_MODEL to the actual endpoint's model identifier");
  }
  if (
    !config.allowedHosts.length ||
    config.allowedHosts.includes("preview.example.com")
  ) {
    problems.push(
      "Set PREVIEW_ALLOWED_HOSTS to the exact reachable preview hosts (including ports)"
    );
  }
  if (config.allowedRepos.some((repo) => !/^[\w.-]+\/[\w.-]+$/.test(repo))) {
    problems.push("GITHUB_ALLOWED_REPOS entries must use owner/repository");
  }
  if (
    config.ARTIFACT_BASE_URL &&
    !validEndpoint(config.ARTIFACT_BASE_URL, true)
  ) {
    problems.push(
      "ARTIFACT_BASE_URL must be an HTTP(S) origin without a path or credentials"
    );
  }
  if (service) {
    problems.push(...serviceProblems(config));
  }
  if (problems.length) {
    throw new QaError(
      "CONFIG_INVALID",
      problems.join("; "),
      "Edit .env using .env.example, then run doctor again. No secrets are printed by doctor."
    );
  }
}

export function validatePreviewUrl(input: string, config: Config): URL {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Invalid preview URL");
  }
  if (!config.allowedHosts.includes(url.host.toLowerCase())) {
    throw new QaError(
      "PREVIEW_HOST_NOT_ALLOWED",
      `Preview host ${url.host} is not in PREVIEW_ALLOWED_HOSTS`,
      "Add the exact hostname and port to PREVIEW_ALLOWED_HOSTS after verifying it is the intended test environment."
    );
  }
  return url;
}
