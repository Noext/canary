import type { Config } from "./config.js";

export interface Diagnostic {
  code: string;
  hint: string;
  message: string;
}
export class QaError extends Error {
  readonly code: string;
  readonly hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.name = "QaError";
    this.code = code;
    this.hint = hint;
  }
}
export function redact(value: string, config?: Config): string {
  let safe = value;
  for (const secret of [
    config?.GITHUB_TOKEN ?? process.env.GITHUB_TOKEN,
    config?.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
    config?.QA_API_TOKEN ?? process.env.QA_API_TOKEN,
    process.env.CANARY_DAEMON_TOKEN,
    config?.QA_BROWSER_SERVICE_TOKEN,
    config?.GITHUB_WEBHOOK_SECRET,
    config?.githubPrivateKey,
    config?.DATABASE_URL,
    ...Object.entries(process.env)
      .filter(([key]) =>
        /TOKEN|SECRET|PASSWORD|STORAGE_STATE|API_KEY/.test(key)
      )
      .map(([, value]) => value),
  ]) {
    if (secret) {
      safe = safe.replaceAll(secret, "[REDACTED]");
      safe = safe.replaceAll(JSON.stringify(secret).slice(1, -1), "[REDACTED]");
      safe = safe.replaceAll(encodeURIComponent(secret), "[REDACTED]");
    }
  }
  return safe
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
const systemHints: Record<string, string> = {
  ENOTFOUND:
    "Check the endpoint hostname and Docker DNS; host.docker.internal needs the host-gateway mapping on Linux.",
  EAI_AGAIN:
    "DNS resolution failed. Check the container DNS and retry after the network is restored.",
  ECONNREFUSED:
    "Check the endpoint address/port and that the service listens on an interface reachable from Docker; localhost is this container.",
  EACCES:
    "Check ownership and permissions of the data/session volumes; the container runs as user node (UID 1000).",
  EPERM:
    "Check filesystem, socket and container permissions. Use Canary's authenticated loopback transport only when native sockets are unavailable.",
  ENOSPC:
    "The filesystem is full. Check df -h and the two project volumes; preserve evidence before applying your retention policy.",
  EADDRINUSE:
    "The configured API port is already occupied. Stop the conflicting instance or adjust QA_PORT, Compose ports and healthcheck together.",
  ENOENT:
    "Check that the CLI/runtime is built and installed: rebuild the image or run the documented Canary install command.",
};
export function diagnose(error: unknown, config?: Config): Diagnostic {
  if (error instanceof QaError) {
    return {
      code: error.code,
      message: redact(error.message, config),
      hint: error.hint,
    };
  }
  const err = error as
    | {
        code?: string;
        name?: string;
        message?: string;
        cause?: { code?: string };
      }
    | undefined;
  const message = err?.message ?? String(error);
  const code =
    err?.name === "TimeoutError" || err?.name === "AbortError"
      ? "TIMEOUT"
      : (err?.cause?.code ??
        (typeof err?.code === "string" ? err.code : "QA_ERROR"));
  const target = code === "QA_ERROR" && unresolvedTarget(message);
  const named = target ? "TARGET_NOT_FOUND" : code;
  return {
    code: named,
    message: redact(message, config),
    hint: hintFor(named, target),
  };
}

/** L'indice rendu à l'opérateur : la cause nommée, jamais un texte générique. */
function hintFor(code: string, target: boolean): string {
  if (target) {
    return "Nothing matched the target within its timeout: retarget the assertion, or prove the absence with kind hidden or a count of 0 on a stable selector.";
  }
  if (code === "TIMEOUT") {
    return "Check service latency and reachability. Increase the configured timeout only after identifying the slow dependency.";
  }
  return (
    systemHints[code] ??
    "Run canary-pr-qa doctor, inspect the run progress/events and use canary-pr-qa diagnose RUN_ID for a redacted summary."
  );
}

/**
 * Un délai passé à attendre une cible qui ne résout jamais. Playwright n'écrit
 * « locator resolved to » que lorsqu'un élément a bien été trouvé, sans être
 * actionnable : le premier cas est une cible à corriger, pas une panne.
 */
function unresolvedTarget(message: string): boolean {
  return (
    /Timeout \d+ms exceeded/.test(message) &&
    /waiting for (locator|getBy|internal:)/.test(message) &&
    !message.includes("locator resolved to") &&
    // Un `waitForEvent` qui n'arrive pas parle de l'événement, pas d'un
    // élément : la cible du clic a bien été trouvée.
    !message.includes("while waiting for event")
  );
}
