import { z } from "zod";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import { fetchText } from "./http.js";

export const ModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (id) =>
      [...id].every(
        (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127
      ),
    "Model ID contains control characters"
  );
const catalogSchema = z.object({
  data: z.array(z.object({ id: ModelIdSchema })).max(5000),
});
export function assertProvider(config: Config) {
  const allowed = config.QA_ALLOWED_PROVIDER_HOSTS.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (
    allowed.length &&
    !allowed.includes(new URL(config.OPENAI_BASE_URL).host.toLowerCase())
  ) {
    throw new QaError(
      "MODEL_PROVIDER_DENIED",
      "Model provider not allowed by data policy",
      "Check QA_ALLOWED_PROVIDER_HOSTS; the endpoint URL is controlled by the server, never by the browser."
    );
  }
}
function allowedModelIds(config: Config) {
  return config.QA_ALLOWED_MODELS.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
export function runModelConfig(config: Config, requested?: string): Config {
  const id = ModelIdSchema.parse(requested ?? config.OPENAI_MODEL);
  const allowed = allowedModelIds(config);
  if (allowed.length && !allowed.includes(id)) {
    throw new QaError(
      "MODEL_NOT_ALLOWED",
      "Model is not allowed for QA runs",
      "Choose a model permitted by QA_ALLOWED_MODELS or ask the operator to update that policy."
    );
  }
  return {
    ...config,
    OPENAI_MODEL: id,
    // Global pricing belongs to the configured default, not every catalog model.
    ...(id === config.OPENAI_MODEL
      ? {}
      : { QA_INPUT_COST_PER_MILLION: 0, QA_OUTPUT_COST_PER_MILLION: 0 }),
  };
}
export class ModelCatalog {
  private cache?: { at: number; ids: string[] };
  private pending?: Promise<string[]>;
  private readonly config: Config;
  constructor(config: Config) {
    this.config = config;
  }
  async list(): Promise<string[]> {
    if (this.cache && Date.now() - this.cache.at < 30_000) {
      return [...this.cache.ids];
    }
    if (this.pending) {
      return [...(await this.pending)];
    }
    this.pending = this.load();
    try {
      return [...(await this.pending)];
    } finally {
      this.pending = undefined;
    }
  }
  private async load() {
    assertProvider(this.config);
    const { text } = await fetchText(
      `${this.config.OPENAI_BASE_URL.replace(/\/$/, "")}/models`,
      {
        headers: this.config.OPENAI_API_KEY
          ? { Authorization: `Bearer ${this.config.OPENAI_API_KEY}` }
          : {},
      },
      Math.min(this.config.QA_MODEL_TIMEOUT_SECONDS * 1000, 30_000)
    );
    let data: z.infer<typeof catalogSchema>;
    try {
      data = catalogSchema.parse(JSON.parse(text));
    } catch {
      throw new QaError(
        "MODEL_CATALOG_INVALID",
        "Provider /models response is not an OpenAI-compatible catalog",
        'Expected a JSON object with data:[{id:"model-id"}]. Check the endpoint path and Cloudflare access; response bodies and credentials are not echoed.'
      );
    }
    const allowed = allowedModelIds(this.config);
    const ids = [...new Set(data.data.map((entry) => entry.id))]
      .filter((id) => !allowed.length || allowed.includes(id))
      .sort();
    if (!ids.length) {
      throw new QaError(
        "MODEL_CATALOG_EMPTY",
        "No available QA model in the provider catalog",
        "Check /v1/models and QA_ALLOWED_MODELS. The dashboard does not invent a fallback model."
      );
    }
    this.cache = { at: Date.now(), ids };
    return ids;
  }
  async require(id: string) {
    if (!(await this.list()).includes(id)) {
      throw new QaError(
        "MODEL_NOT_AVAILABLE",
        "Selected model is absent from the current provider catalog",
        "Refresh the model list and choose an available model."
      );
    }
  }
}
