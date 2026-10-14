import { diagnose, QaError } from "./diagnostics.js";
import { requestSignal } from "./run-scope.js";
import { sseEventData, takeSseEvents } from "./sse.js";

/** Ouvre la requête et traduit tout échec en diagnostic nommé, comme le reste du harnais. */
async function open(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<{ body: ReadableStream<Uint8Array>; response: Response }> {
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
  return { body: response.body, response };
}

export async function fetchText(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = 30_000,
  maxBytes = 5_000_000
): Promise<{ response: Response; text: string }> {
  const { body, response } = await open(url, init, timeoutMs);
  const reader = body.getReader();
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

/**
 * Lit un flux SSE événement par événement, sans jamais garder le corps entier : une réponse
 * `chat/completions` streamée pèse plusieurs mégaoctets de deltas pour un seul plan.
 *
 * `onEvent` renvoie `false` pour interrompre la lecture (`[DONE]`, ou tout ce que
 * l'appelant sait terminal). La limite d'octets reste un garde-fou, pas une mesure.
 */
export async function fetchSse(
  url: string | URL,
  init: RequestInit,
  onEvent: (event: string) => boolean | undefined,
  timeoutMs = 30_000,
  maxBytes = 64 * 1024 * 1024
): Promise<void> {
  const { body } = await open(url, init, timeoutMs);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  const emit = (event: string): boolean => onEvent(event) !== false;
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
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = takeSseEvents(buffer);
      buffer = rest;
      for (const event of events) {
        if (!emit(event)) {
          return;
        }
      }
    }
    // Certains endpoints omettent la ligne vide finale : le dernier bloc reste exploitable.
    buffer += decoder.decode();
    const last = sseEventData(buffer);
    if (last !== undefined) {
      emit(last);
    }
  } finally {
    await reader.cancel();
  }
}
