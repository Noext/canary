import { type Config, validatePreviewUrl } from "./config.js";
import type { GitHub, PrContext } from "./github.js";
import { fetchText } from "./http.js";
import type { Preview } from "./schema.js";

export async function verifyPreviewUrl(
  url: string,
  expectedSha: string,
  config: Config
): Promise<Preview> {
  const preview = validatePreviewUrl(url, config);
  const probe = config.PREVIEW_SHA_PATH
    ? new URL(config.PREVIEW_SHA_PATH, preview)
    : preview;
  if (probe.origin !== preview.origin) {
    throw new Error("PREVIEW_SHA_PATH must stay on the preview origin");
  }
  const { response, text } = await fetchText(probe, {}, 30_000, 2_000_000);
  let actual = response.headers.get(config.PREVIEW_SHA_HEADER);
  if (config.PREVIEW_SHA_PATH) {
    const data: unknown = JSON.parse(text);
    actual =
      typeof data === "object" &&
      data !== null &&
      "sha" in data &&
      typeof data.sha === "string"
        ? data.sha
        : null;
  }
  if (actual !== expectedSha) {
    throw new Error(
      `Preview SHA mismatch or missing provenance (expected ${expectedSha})`
    );
  }
  return {
    url: preview.href,
    sha: actual,
    evidence: config.PREVIEW_SHA_PATH
      ? `JSON sha at ${probe.pathname}`
      : `HTTP ${config.PREVIEW_SHA_HEADER} header`,
  };
}

export async function resolvePreview(
  context: PrContext,
  github: GitHub,
  config: Config,
  explicit?: string
): Promise<Preview> {
  const requested =
    explicit ||
    config.PREVIEW_URL_TEMPLATE.replaceAll("{sha}", context.sha).replaceAll(
      "{pr}",
      String(context.ref.number)
    );
  if (requested) {
    return await verifyPreviewUrl(requested, context.sha, config);
  }
  const deployment = await github.deployments(context);
  if (!deployment) {
    throw new Error(
      "No successful preview deployment for the exact PR SHA. Supply --preview with SHA provenance."
    );
  }
  validatePreviewUrl(deployment.url, config);
  // If configured, also verify the actual server, rather than just GitHub's deployment metadata.
  if (config.PREVIEW_SHA_PATH) {
    return await verifyPreviewUrl(deployment.url, context.sha, config);
  }
  return deployment;
}
