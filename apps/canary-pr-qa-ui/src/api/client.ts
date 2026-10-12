import { z } from "zod";
import { errorMessages } from "@/i18n";
import type { ApiErrorPayload } from "./contracts";
import {
  type ApiPath,
  errorPayloadSchema,
  type ResponseSchemas,
  responseSchemas,
} from "./schemas";

export const SESSION_EXPIRED_EVENT = "qa:session-expired";

/**
 * An error that already carries something actionable: a mapped code, the
 * server hint and the request id the operator can grep in the server logs.
 */
export class DashboardError extends Error {
  readonly code?: string;
  readonly hint?: string;
  readonly requestId?: string;

  constructor(
    message: string,
    details: { code?: string; hint?: string; requestId?: string } = {}
  ) {
    super(message);
    this.name = "DashboardError";
    this.code = details.code;
    this.hint = details.hint;
    this.requestId = details.requestId;
  }
}

export function errorText(value: unknown): string {
  const failure =
    value instanceof Error
      ? value
      : new Error("Une erreur inattendue est survenue.");
  const details = failure instanceof DashboardError ? failure : undefined;
  const message = errorMessages[details?.code ?? ""] ?? failure.message;
  return details?.requestId
    ? `${message} · Référence : ${details.requestId}`
    : message;
}

export interface ApiOptions {
  body?: unknown;
  headers?: Record<string, string>;
  method?: "DELETE" | "GET" | "POST" | "PUT";
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

function requestUrl(path: string, query: ApiOptions["query"]): string {
  if (!query) {
    return path;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function api<P extends ApiPath>(
  path: P,
  options?: ApiOptions
): Promise<z.infer<ResponseSchemas[P]>>;
export async function api<T>(
  path: string,
  options: ApiOptions & { schema: z.ZodType<T> }
): Promise<T>;
export async function api(
  path: string,
  options: ApiOptions & { schema?: z.ZodType<unknown> } = {}
): Promise<unknown> {
  const { body, headers = {}, method = "GET", query, schema, signal } = options;
  const known =
    path in responseSchemas ? responseSchemas[path as ApiPath] : undefined;
  const target = schema ?? known ?? z.unknown();

  let response: Response;
  try {
    response = await fetch(requestUrl(path, query), {
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      headers:
        body === undefined
          ? headers
          : { "Content-Type": "application/json", ...headers },
      method,
      signal,
    });
  } catch (failure) {
    if (failure instanceof DOMException && failure.name === "AbortError") {
      throw failure;
    }
    throw new DashboardError(
      "Le serveur est injoignable. Vérifiez qu'il est démarré et accessible."
    );
  }

  const requestId = response.headers.get("X-Request-ID") ?? undefined;
  const payload = await readBody(response);

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/")) {
      document.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    const parsed = errorPayloadSchema.safeParse(payload);
    if (parsed.success) {
      const details: ApiErrorPayload = parsed.data;
      throw new DashboardError(
        details.error ?? `La requête a échoué (HTTP ${response.status}).`,
        {
          code: details.code,
          hint: details.hint,
          requestId: details.requestId ?? requestId,
        }
      );
    }
    throw new DashboardError(
      `Le serveur n'a pas renvoyé une réponse valide (HTTP ${response.status}). Vérifiez sa disponibilité.`,
      { requestId }
    );
  }

  const result = target.safeParse(payload);
  if (!result.success) {
    throw new DashboardError(
      "La réponse du serveur ne correspond pas au contrat attendu. Rechargez la page ; si le problème persiste, signalez la référence ci-dessous.",
      { requestId }
    );
  }
  return result.data;
}

export const post = (body: unknown): ApiOptions => ({
  body,
  method: "POST",
});
