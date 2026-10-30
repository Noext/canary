import { diagnose, QaError } from "./diagnostics.js";
import { requestSignal } from "./run-scope.js";
import { sseEventData, takeSseEvents } from "./sse.js";

/**
 * Plafond d'un `Retry-After` honoré. Au-delà, l'endpoint demande une pause plus
 * longue que ce qu'un run peut tenir : la valeur n'est pas retenue et le délai
 * de repli du client modèle s'applique. Un endpoint qui demande une heure
 * d'arrêt ne doit pas figer un run dont le délai modèle est de 15 minutes.
 */
export const RETRY_AFTER_MAX_MS = 30_000;

/**
 * `Retry-After` d'une réponse fautive, en millisecondes : secondes entières ou
 * date HTTP, les deux formes que la norme définit. Une valeur illisible, passée
 * ou au-delà de `RETRY_AFTER_MAX_MS` n'est pas retenue.
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return;
  }
  const trimmed = value.trim();
  const ms = /^\d+$/.test(trimmed)
    ? Number(trimmed) * 1000
    : Date.parse(trimmed) - Date.now();
  return Number.isFinite(ms) && ms >= 0 && ms <= RETRY_AFTER_MAX_MS
    ? ms
    : undefined;
}

/**
 * Codes de transport rejouables : la connexion meurt avant tout contenu utile,
 * donc la reprise est sans effet de bord et sans double facturation. Les deux
 * derniers sont nos normalisations de transport — `TIMEOUT` (délai du client
 * modèle, issu d'un `AbortSignal.timeout`) et `MODEL_STREAM_TRUNCATED` (flux
 * fermé proprement avant `[DONE]`). Restent définitifs un refus de plan (preuve,
 * schéma, couverture) et une erreur rapportée par l'endpoint
 * (`MODEL_STREAM_ERROR`) : ils ne s'améliorent pas en rejouant la même requête.
 * Les deux codes d'une réponse reçue mais inexploitable ont leur propre reprise,
 * unique (`CONTENT_RETRY_CODES`).
 */
const TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "TIMEOUT",
  "MODEL_STREAM_TRUNCATED",
]);

/**
 * Statuts HTTP rejouables : l'endpoint était momentanément indisponible (503,
 * celui qu'un gateway renvoie quand son amont refuse la requête) ou appliquait
 * sa fenêtre de débit (429). La requête est partie sans produire de contenu utile
 * — la même situation qu'une connexion coupée —, donc la reprise est sans effet
 * de bord. Tout autre statut reste définitif : un 4xx de requête (400, 401, 403,
 * 404) ne s'améliore pas au second essai.
 */
export const RETRYABLE_HTTP_CODES = new Set(["HTTP_429", "HTTP_503"]);

/**
 * Vrai pour le délai du client modèle levé EN COURS de flux : l'`AbortSignal`
 * du délai rejette la lecture du corps avec une `DOMException` nommée
 * `TimeoutError` (code numérique 23), que rien ne normalise après les en-têtes.
 * Mesure du run 6 : jamais rejouée, et les tokens facturés jamais réservés. Une
 * annulation du run (`AbortError`, ou la raison `RUN_DEADLINE`) n'est pas un
 * délai d'appel et reste définitive.
 */
function midStreamTimeout(candidate: unknown): boolean {
  return (candidate as { name?: unknown } | undefined)?.name === "TimeoutError";
}

/** Classe une erreur : code rejouable, ou `undefined` (échec définitif). */
export function transportCode(error: unknown): string | undefined {
  for (const candidate of [
    error,
    (error as { cause?: { code?: string } } | undefined)?.cause,
  ]) {
    const code = (candidate as { code?: unknown } | undefined)?.code;
    if (
      typeof code === "string" &&
      (TRANSPORT_CODES.has(code) || RETRYABLE_HTTP_CODES.has(code))
    ) {
      return code;
    }
    if (midStreamTimeout(candidate)) {
      return "TIMEOUT";
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  // Node signale une socket détruite en plein échange par « terminated » ou
  // « socket hang up », parfois sans code : c'est la même classe rejouable.
  return /terminated|socket hang up/i.test(message)
    ? "UND_ERR_SOCKET"
    : undefined;
}

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
      429: "The dependency rate limit was reached. Check its quota and the rate-limit window, and honour the Retry-After header it sends: the model endpoint is retried with backoff, other POST operations are not.",
    };
    throw new QaError(
      `HTTP_${response.status}`,
      `HTTP ${response.status} from ${target.host}${target.pathname}${requestId ? ` (request ${requestId})` : ""}`,
      hints[response.status] ??
        "Inspect the dependency's availability and logs; this request did not return a successful response.",
      parseRetryAfter(response.headers.get("retry-after"))
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
