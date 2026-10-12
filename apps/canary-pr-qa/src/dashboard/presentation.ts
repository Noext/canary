export const stateNames: Record<string, string | undefined> = {
  queued: "En attente",
  running: "En cours",
  completed: "Terminé",
  cancelled: "Annulé",
  interrupted: "Interrompu",
  failed: "Erreur",
};
export const outcomeNames: Record<string, string | undefined> = {
  passed: "Réussi",
  failed: "Échec",
  blocked: "Bloqué",
  stale: "Version obsolète",
  skipped: "Non testé",
};
export const phaseNames: Record<string, string | undefined> = {
  context: "Lecture des changements de la pull request",
  preview: "Vérification de la version de votre application",
  discovery: "Découverte de l’application dans Chromium",
  planning: "Préparation des scénarios par l’IA",
  execution: "Exécution des scénarios dans Chromium",
  evidence: "Finalisation des vidéos et captures",
  verification: "Vérification des assertions et de la couverture",
  publication: "Publication du rapport sur GitHub",
  done: "Test terminé",
};
export function badge(label: string, value?: string) {
  const node = document.createElement("span");
  let tone = "";
  if (value === "passed") {
    tone = "success";
  } else if (["failed", "blocked", "interrupted"].includes(value || "")) {
    tone = "failed";
  } else if (["running", "queued"].includes(value || "")) {
    tone = "pending";
  }
  node.className = `pill ${tone}`;
  node.textContent = label;
  return node;
}
export function safeArtifact(path?: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("..") ||
    path.includes("\\")
  ) {
    return;
  }
  return path.split("/").map(encodeURIComponent).join("/");
}
