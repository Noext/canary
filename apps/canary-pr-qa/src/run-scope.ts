import { AsyncLocalStorage } from "node:async_hooks";
import { QaError } from "./diagnostics.js";
export interface RunScope {
  calls: number;
  costUsd: number;
  estimated?: boolean;
  id: string;
  maxCostUsd: number;
  maxTokens: number;
  /**
   * Plus grand chiffre que l'endpoint a rapporté pour l'entrée d'un appel sur ce
   * run (`Model.declaredInputFloor` via `observeInput`) : son `prompt_tokens`,
   * ou son `total_tokens` quand ce total est plus lourd. Il planche la borne de
   * l'entrée des admissions suivantes : une estimation qui s'est révélée basse —
   * même très basse face à un endpoint qui rapporte une entrée plus lourde que le
   * prompt envoyé — ne décide jamais deux admissions.
   */
  observedInputTokens?: number;
  /** Signalé avant chaque attente de reprise, pour que le run reste lisible. */
  onRetry?: (info: { attempt: number; max: number; code: string }) => void;
  previewSha?: string;
  /**
   * Bornes des tentatives perdues, cumulées à part de l'usage rapporté par
   * l'endpoint. Chaque borne est créditée de ce que le transport a réellement
   * livré (`Model.credibleReservation`), et non plus du pire cas théorique dès
   * qu'une coupure laisse quelque chose d'observable. Ce que nous chiffrons reste
   * plafonné par le pire cas de la tentative admise — l'enveloppe qui couvrait
   * cet appel couvre notre propre borne —, mais un `total_tokens` que l'endpoint
   * déclare au-delà de ce pire cas est repris tel quel, sans quoi la dépense
   * serait absorbée. Elle compte dans l'admission de l'appel suivant avec l'usage
   * consommé et la réservation de cet appel : une exposition qui dépasse
   * l'enveloppe fait refuser l'admission, donc plus aucune requête ne part.
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
 * envoyé. La seule exposition qui peut la dépasser est celle que l'endpoint a
 * lui-même rapportée — un `prompt_tokens` ou un `total_tokens` plus lourd que le
 * pire cas admis : elle est alors comptée à sa hauteur, donc toute admission
 * suivante est refusée.
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
