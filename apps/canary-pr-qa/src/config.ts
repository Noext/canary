import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const envSchema = z.object({
  GITHUB_TOKEN: z.string().default(""),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  GITHUB_ALLOWED_REPOS: z.string().default(""),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().min(1).default("configured-model"),
  OPENAI_JSON_MODE: z.enum(["true", "false"]).default("true"),
  QA_DATA_DIR: z.string().default("./qa-data"),
  QA_API_TOKEN: z.string().default(""),
  QA_HOST: z.string().default("127.0.0.1"),
  QA_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  QA_MAX_STEPS: z.coerce.number().int().min(1).max(100).default(25),
  QA_MAX_SCENARIOS: z.coerce.number().int().min(1).max(20).default(8),
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
    throw new Error(`Preview host ${url.host} is not in PREVIEW_ALLOWED_HOSTS`);
  }
  return url;
}
