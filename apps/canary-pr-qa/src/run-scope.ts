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
   * Bornes des tentatives perdues, cumulées à part de l'usage rapporté par
   * l'endpoint. Chaque borne est créditée de ce que le transport a réellement
   * livré (`Model.credibleReservation`), et non plus du pire cas théorique dès
   * qu'une coupure laisse quelque chose d'observable. Elle reste DANS
   * l'enveloppe : l'admission d'une tentative couvre l'usage consommé, ces
   * bornes et la réservation de l'appel qui part, sans quoi le budget
   * n'encadrerait plus la dépense totale du run.
   */
  reservedCostUsd: number;
  reservedTokens: number;
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
/**
 * L'admission juge l'usage consommé (`tokens`, `costUsd`), les bornes des
 * tentatives perdues (`reservedTokens`, `reservedCostUsd`) et l'engagement de
 * l'appel qui part (`reserveTokens`, `reserveCostUsd`) : l'enveloppe est une
 * borne dure, réserve comprise. Un appel qui ne tient pas dedans n'est jamais
 * envoyé, et l'exposition engagée du run (`tokens` + `reservedTokens`) reste
 * dans l'enveloppe.
 */
export function checkBudget(reserveTokens = 0, reserveCostUsd = 0) {
  const scope = runScope.getStore();
  scope?.signal.throwIfAborted();
  if (
    scope &&
    (scope.tokens + scope.reservedTokens + reserveTokens > scope.maxTokens ||
      scope.costUsd + scope.reservedCostUsd + reserveCostUsd >
        scope.maxCostUsd ||
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
