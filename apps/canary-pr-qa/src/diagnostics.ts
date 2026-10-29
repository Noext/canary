import type { Config } from "./config.js";

export interface Diagnostic {
  code: string;
  hint: string;
  message: string;
}
export class QaError extends Error {
  readonly code: string;
  readonly hint: string;
  /**
   * Attente demandée par la réponse fautive (`Retry-After`), quand elle en porte
   * une. Elle ne change jamais le diagnostic : elle ne pilote que le délai avant
   * une reprise, et seulement pour un statut qui en admet une.
   */
  readonly retryAfterMs?: number;
  constructor(
    code: string,
    message: string,
    hint: string,
    retryAfterMs?: number
  ) {
    super(message);
    this.name = "QaError";
    this.code = code;
    this.hint = hint;
    this.retryAfterMs = retryAfterMs;
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

// --- Classe d'un échec ----------------------------------------------------
/**
 * La classe d'un échec — décidée par une règle, jamais par une prose.
 *
 * Un run qui ne passe pas doit dire **de quoi** il souffre : un plan que le gate
 * d'aujourd'hui refuserait (défaut de plan démontrable), un plan fautif que rien
 * de statique ne tranche, une régression produit, ou une panne d'infrastructure.
 * Sans cette fonction, chaque rapport classe à la main et se trompe : le lot BA
 * comptait `TRANSITION_NOT_OBSERVED` et une borne fausse comme « échecs produit »,
 * alors que le gate refuse aujourd'hui ces deux plans.
 */

export type FailureClass =
  | "plan-impossible"
  | "plan-defective"
  | "product-regression"
  | "infrastructure"
  | "unclassified";

/**
 * Les codes qui disent qu'un plan est fautif par construction : citation non
 * témoignée, cible inventée, vérification inapplicable, ordre de marqueur
 * impossible, précondition non déclarée, contrat incomplet. Aucun n'est un défaut
 * du produit testé : ils décrivent ce que le plan a demandé.
 */
const PLAN_CODES = new Set([
  "CONTRACT_INCOMPLETE",
  "CRITICAL_COVERAGE_MISSING",
  "MARKER_ORDER_UNREACHABLE",
  "PLAN_ATTRIBUTE_VALUE_READ_AS_TEXT",
  "PLAN_CHANGED_FILE_UNCOVERED",
  "PLAN_EVIDENCE_INCOMPLETE",
  "PLAN_SCENARIO_ID_RESERVED",
  "PLAN_SCHEMA_INVALID",
  "PLAN_STATE_TARGET_READ_AS_TEXT",
  "PLAN_TARGET_MISSING",
  "PRECONDITION_UNVERIFIED",
  "REQUIREMENT_UNGROUNDED",
  "STATE_ALREADY_SATISFIED",
  "TARGET_NOT_FOUND",
  "TRANSITION_NOT_OBSERVED",
  "TRANSITION_ON_INVARIANT",
]);

/** Les codes qui disent que le service n'a pas pu travailler. */
export const INFRASTRUCTURE_CODES = new Set([
  "MODEL_OUTPUT_INCOMPLETE",
  "MODEL_JSON_INVALID",
  "QA_ERROR",
  "RUN_BUDGET_EXCEEDED",
  "STALE_HEAD",
  "WORKER_STOPPING",
]);

export function classifyFailure(input: {
  /** Le diagnostic du run ou du scénario, s'il y en a un. */
  code?: string;
  /**
   * Vrai quand le gate d'aujourd'hui refuse le plan : le défaut est alors
   * démontrable, et l'échec est un défaut de plan, même si l'exécution l'a
   * rapporté comme une assertion fausse.
   */
  refusedByGate?: boolean;
}): FailureClass {
  const code = input.code ?? "";
  if (input.refusedByGate) {
    return "plan-impossible";
  }
  if (INFRASTRUCTURE_CODES.has(code)) {
    return "infrastructure";
  }
  if (PLAN_CODES.has(code)) {
    return "plan-defective";
  }
  if (code === "") {
    return "unclassified";
  }
  // Tout autre diagnostic vient de l'exécution : une assertion qui a observé
  // autre chose que l'attendu sur un plan que le gate accepte.
  return "product-regression";
}

/** Un résumé lisible, pour le rapport et les mesures. */
export function summarizeFailures(
  classes: FailureClass[]
): Record<FailureClass, number> {
  const summary: Record<FailureClass, number> = {
    infrastructure: 0,
    "plan-defective": 0,
    "plan-impossible": 0,
    "product-regression": 0,
    unclassified: 0,
  };
  for (const item of classes) {
    summary[item] += 1;
  }
  return summary;
}
