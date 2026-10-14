import { AsyncLocalStorage } from "node:async_hooks";
import { QaError } from "./diagnostics.js";
export interface RunScope {
  calls: number;
  costUsd: number;
  estimated?: boolean;
  id: string;
  maxCostUsd: number;
  maxTokens: number;
  /** Signalé avant chaque attente de reprise, pour que le run reste lisible. */
  onRetry?: (info: { attempt: number; max: number; code: string }) => void;
  previewSha?: string;
  /**
   * Reprises de transport déjà effectuées sur les appels modèle du run. Compté
   * à part de `calls`, qui ne compte que les réponses reçues : un appel coupé
   * avant tout contenu n'incrémente pas `calls`.
   */
  retries?: number;
  signal: AbortSignal;
  tokens: number;
  verifyOwnership?: () => Promise<void>;
}
export const runScope = new AsyncLocalStorage<RunScope>();
export function checkBudget(reserveTokens = 0, reserveCostUsd = 0) {
  const scope = runScope.getStore();
  scope?.signal.throwIfAborted();
  if (
    scope &&
    (scope.tokens + reserveTokens > scope.maxTokens ||
      scope.costUsd + reserveCostUsd > scope.maxCostUsd ||
      scope.costUsd >= scope.maxCostUsd)
  ) {
    throw new QaError(
      "RUN_BUDGET_EXCEEDED",
      "Run token or cost budget exhausted",
      "Inspect usage in result.json; adjust limits only after reviewing model pricing and scenarios."
    );
  }
}
export function requestSignal(timeout: number): AbortSignal {
  const signal = runScope.getStore()?.signal;
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
}
