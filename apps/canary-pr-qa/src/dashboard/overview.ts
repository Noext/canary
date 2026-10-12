import { api } from "./api.js";
import { $ } from "./dom.js";
import { navigate } from "./navigation.js";
import { state } from "./state.js";
export async function loadSetupStatus() {
  const info = await api("/dashboard/status");
  state.setupInfo = info;
  $("aiEndpoint").textContent = `Endpoint : ${info.ai.endpoint}`;
  $("aiDefault").textContent = `Modèle par défaut : ${info.ai.defaultModel}`;
  $("previewMode").textContent = info.preview.automatic
    ? "Une adresse de test est configurée automatiquement pour vos PR."
    : "Vous pouvez fournir une URL de test ou utiliser les previews publiées sur GitHub.";
  $("previewHosts").textContent = info.preview.hosts
    ? `Hôtes autorisés : ${info.preview.hosts.join(", ")}`
    : "Les hôtes sont définis par l’opérateur du serveur.";
  $("previewProof").textContent = info.preview.shaPath
    ? `La preuve de version est lue dans le JSON ${info.preview.shaPath}.`
    : "L’application doit exposer le commit dans l’en-tête " +
      (info.preview.shaHeader || "configuré") +
      ".";
  syncReadiness();
}
export function syncReadiness() {
  if (!(state.currentUser && state.canWrite)) {
    return;
  }
  const githubReady =
    !!state.setupInfo &&
    state.setupInfo.github.mode !== "missing" &&
    state.setupInfo.github.repositories.length > 0;
  const modelReady = state.catalogReady && !!$("model").value;
  $("stepGitHub").classList.toggle("done", githubReady);
  $("stepModel").classList.toggle("done", modelReady);
  $("stepGitHubState").textContent = githubStepLabel(githubReady);
  $("stepModelState").textContent = modelStepLabel(modelReady);
  $("setupCount").textContent =
    `${Number(githubReady) + Number(modelReady)}/2 connexions prêtes`;
  $("welcomeAction").textContent = welcomeLabel(githubReady, modelReady);
  $("welcomeNote").textContent =
    githubReady && modelReady
      ? "PR + application de test → scénarios, vidéos et résultat."
      : "Votre progression est enregistrée. Commencez par l’étape indiquée.";
  $("welcomeAction").onclick = () =>
    navigate(
      !githubReady && state.currentUser?.role === "admin" ? "settings" : "new"
    );
  if (state.currentUser.role !== "admin" && !githubReady) {
    $("welcomeIntro").textContent =
      "Demandez à l’administrateur de connecter votre dépôt dans les réglages GitHub.";
  }
  $("runBlocker").hidden = githubReady;
  if (!githubReady) {
    $("runBlocker").textContent =
      state.currentUser.role === "admin"
        ? "Connectez GitHub et sélectionnez un dépôt dans Réglages avant de vérifier une PR."
        : "Votre administrateur doit connecter le dépôt avant votre premier test.";
  }
  $("checkRun").disabled = !(githubReady && modelReady) || state.preflightBusy;
  $("startRun").disabled =
    !(githubReady && modelReady && state.preflight) || state.preflightBusy;
}
export function initializeOverview() {
  $("stepGitHub").onclick = () =>
    navigate(state.currentUser?.role === "admin" ? "settings" : "new");
  $("stepModel").onclick = () => navigate("new");
  $("stepFirstRun").onclick = () => navigate("new");
  $("showHistory").onclick = () => navigate("runs");
}

function githubStepLabel(ready: boolean): string {
  const info = state.setupInfo;
  if (!info) {
    return "Vérification…";
  }
  if (ready && info.github.mode === "app") {
    return `Connecté · ${info.github.repositories.length} dépôt(s)`;
  }
  if (ready) {
    return "Accès technique actif";
  }
  return info.github.mode === "app"
    ? "Choisir vos dépôts →"
    : "Connecter GitHub →";
}
function modelStepLabel(ready: boolean): string {
  if (ready) {
    return "Modèle disponible";
  }
  if (state.modelsLoading) {
    return "Chargement du catalogue…";
  }
  return state.catalogReady ? "Choisir un modèle →" : "Vérifier la connexion →";
}
function welcomeLabel(githubReady: boolean, modelReady: boolean): string {
  if (!githubReady) {
    return "Connecter GitHub";
  }
  return modelReady ? "Tester une pull request" : "Choisir mon modèle IA";
}
