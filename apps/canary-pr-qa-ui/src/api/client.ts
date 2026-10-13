import { z } from "zod";
import { apiErrors, errorMessages } from "@/i18n";
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
  /**
   * HTTP status of the failed response, when there was one. A few screens need
   * to tell a verdict on the resource (404, 403) from a bad moment (5xx, no
   * response, a contract mismatch): only the first is worth replacing a detail
   * with a missing state.
   */
  readonly status?: number;

  constructor(
    message: string,
    details: {
      code?: string;
      hint?: string;
      requestId?: string;
      status?: number;
    } = {}
  ) {
    super(message);
    this.name = "DashboardError";
    this.code = details.code;
    this.hint = details.hint;
    this.requestId = details.requestId;
    this.status = details.status;
  }
}

export function errorText(value: unknown): string {
  const failure =
    value instanceof Error ? value : new Error(apiErrors.unexpected);
  const details = failure instanceof DashboardError ? failure : undefined;
  const message = errorMessages[details?.code ?? ""] ?? failure.message;
  return details?.requestId
    ? `${message} · Référence : ${details.requestId}`
    : message;
}

export interface ApiOptions {
  body?: unknown;
  headers?: Record<string, string>;
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /**
   * Declares that the caller does not read the answer, for a write whose effect
   * is observed by reloading the resource it touched. A response nobody reads is
   * the only case where validating it would prove nothing; without this flag, a
   * path outside the typed map still has to carry a schema.
   */
  unvalidated?: true;
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
/**
 * A write whose answer the caller does not read, for an id-carrying path the
 * typed map cannot know. The `unvalidated` flag is required, so no caller loses
 * a schema by omission: the change the write makes is observed by reloading the
 * resource it touched, and that read is the one carrying a schema.
 */
export async function api(
  path: string,
  options: ApiOptions & { unvalidated: true }
): Promise<unknown>;
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
    throw new DashboardError(apiErrors.unreachable);
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
        details.error ?? apiErrors.failed(response.status),
        {
          code: details.code,
          hint: details.hint,
          requestId: details.requestId ?? requestId,
          status: response.status,
        }
      );
    }
    throw new DashboardError(apiErrors.invalidResponse(response.status), {
      requestId,
      status: response.status,
    });
  }

  const result = target.safeParse(payload);
  if (!result.success) {
    throw new DashboardError(apiErrors.contract, { requestId });
  }
  return result.data;
}

export const post = (body: unknown): ApiOptions => ({
  body,
  method: "POST",
});
