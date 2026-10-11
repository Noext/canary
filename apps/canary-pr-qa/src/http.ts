import { diagnose, QaError } from "./diagnostics.js";
import { requestSignal } from "./run-scope.js";

export async function fetchText(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = 30_000,
  maxBytes = 5_000_000
): Promise<{ response: Response; text: string }> {
  const response = await fetch(url, {
    ...init,
    signal: requestSignal(timeoutMs),
    redirect: "error",
  }).catch((error: unknown) => {
    const diagnostic = diagnose(error);
    const target = new URL(url);
    throw new QaError(
      diagnostic.code,
      `${diagnostic.message} from ${target.host}${target.pathname}`,
      diagnostic.hint
    );
  });
  if (!response.ok) {
    const target = new URL(url);
    const requestId =
      response.headers.get("x-github-request-id") ??
      response.headers.get("x-request-id");
    await response.body?.cancel();
    const hints: Record<number, string> = {
      400: "Check the model ID, JSON mode and endpoint's supported parameters, or the GitHub request payload.",
      401: "Check that the configured provider/GitHub token is valid and has not expired.",
      403: "Check repository/token permissions, organization approval or SSO, rate limits and protected preview access.",
      404: "Check the endpoint path (/v1 if required), repository access and preview URL; private GitHub resources also return 404 without access.",
      429: "The dependency rate limit was reached. Check its quota and retry after the rate-limit window; POST operations are not blindly retried.",
    };
    throw new QaError(
      `HTTP_${response.status}`,
      `HTTP ${response.status} from ${target.host}${target.pathname}${requestId ? ` (request ${requestId})` : ""}`,
      hints[response.status] ??
        "Inspect the dependency's availability and logs; this request did not return a successful response."
    );
  }
  if (!response.body) {
    throw new Error("Empty HTTP response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        throw new Error(`HTTP response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return { response, text: Buffer.concat(chunks).toString("utf8") };
}
