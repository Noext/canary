import type { ApiResponses } from "./contracts.js";
import { $ } from "./dom.js";
export const post = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
export const errorMessages: Record<string, string | undefined> = {
  PREVIEW_SHA_MISMATCH:
    "L’application de test ne présente pas le commit de cette PR. Déployez cette version puis vérifiez à nouveau.",
  PREVIEW_NOT_FOUND:
    "Aucune application de test trouvée pour cette PR. Renseignez son URL dans le formulaire.",
  PREVIEW_HOST_NOT_ALLOWED:
    "Cette adresse de test n’est pas autorisée sur le serveur. Consultez les hôtes dans Réglages.",
  GITHUB_REPOSITORY_DENIED:
    "Ce dépôt n’est pas connecté à votre espace. Sélectionnez-le dans Réglages → GitHub.",
  MODEL_NOT_AVAILABLE:
    "Ce modèle n’est plus disponible chez votre fournisseur. Actualisez la liste et choisissez explicitement un modèle.",
  MODEL_CATALOG_INVALID:
    "Le fournisseur n’a pas renvoyé un catalogue de modèles valide. Vérifiez son endpoint et l’accès Cloudflare.",
  HTTP_403:
    "L’accès a été refusé. Vérifiez les permissions GitHub ou l’autorisation Cloudflare de l’IP du VPS.",
  HTTP_401:
    "La connexion à ce service a été refusée. Vérifiez ses credentials sur le serveur.",
};

export class DashboardError extends Error {
  code?: string;
  hint?: string;
  requestId?: string;
  constructor(
    message: string,
    details: { code?: string; hint?: string; requestId?: string } = {}
  ) {
    super(message);
    this.name = "DashboardError";
    Object.assign(this, details);
  }
}
export function errorText(value: unknown): string {
  const failure =
    value instanceof Error
      ? value
      : new Error("Une erreur inattendue est survenue.");
  const details = failure instanceof DashboardError ? failure : undefined;
  return (
    (errorMessages[details?.code || ""] || failure.message) +
    (details?.requestId ? ` · Référence : ${details.requestId}` : "")
  );
}
export function error(value: unknown) {
  $("error").textContent = errorText(value);
}
export function api<P extends keyof ApiResponses>(
  path: P,
  options?: RequestInit
): Promise<ApiResponses[P]>;
export function api<T>(path: string, options?: RequestInit): Promise<T>;
export async function api(
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const response = await fetch(path, options);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new DashboardError(
      `Le serveur n’a pas renvoyé une réponse valide (HTTP ${response.status}). Vérifiez sa disponibilité.`,
      { requestId: response.headers.get("X-Request-ID") || undefined }
    );
  }
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/")) {
      document.dispatchEvent(new Event("qa:session-expired"));
    }
    const body =
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : {};
    const field = (key: string) =>
      typeof body[key] === "string" ? body[key] : undefined;
    throw new DashboardError(field("error") || "La requête a échoué.", {
      code: field("code"),
      hint: field("hint"),
      requestId:
        field("requestId") || response.headers.get("X-Request-ID") || undefined,
    });
  }
  return data;
}
