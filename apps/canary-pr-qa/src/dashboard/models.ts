import { api, errorText } from "./api.js";
import { $ } from "./dom.js";
import { syncReadiness } from "./overview.js";
import { state } from "./state.js";
export function invalidatePreflight() {
  state.preflight = undefined;
  $("preflightResult").hidden = true;
  $("runFeedback").textContent = "";
  syncReadiness();
}
export async function loadModels() {
  if (state.modelsLoading) {
    return;
  }
  state.modelsLoading = true;
  invalidatePreflight();
  const previous = $("model").value;
  $("model").disabled = true;
  $("refreshModels").disabled = true;
  $("retryModels").disabled = true;
  $("modelState").className = "field-help";
  $("modelState").textContent = "Chargement depuis votre fournisseur…";
  try {
    const catalog = await api("/models");
    const ids = catalog.data.map((item) => item.id);
    $("model").replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choisir un modèle";
    $("model").append(placeholder);
    for (const id of ids) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      $("model").append(option);
    }
    $("model").value = "";
    if (ids.includes(previous)) {
      $("model").value = previous;
    } else if (!state.modelsInitialized && ids.includes(catalog.defaultModel)) {
      $("model").value = catalog.defaultModel;
    }
    state.modelsInitialized = true;
    state.catalogReady = true;
    $("model").disabled = false;
    $("modelState").textContent = $("model").value
      ? `${ids.length} modèles disponibles · aucun remplacement automatique.`
      : "Modèle précédent ou par défaut indisponible : choisissez explicitement un modèle.";
    $("aiConnection").textContent = "Catalogue accessible";
    $("aiConnection").className = "pill success";
    $("aiCatalog").textContent =
      ids.length +
      " modèles récupérés auprès du fournisseur. Une génération IA réelle n’a pas encore été vérifiée.";
  } catch (e) {
    state.catalogReady = false;
    $("model").replaceChildren();
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Catalogue indisponible";
    $("model").append(option);
    $("modelState").className = "field-help error";
    $("modelState").textContent =
      errorText(e) +
      " — vérifiez le fournisseur ou Cloudflare puis actualisez.";
    $("aiConnection").textContent = "Connexion à vérifier";
    $("aiConnection").className = "pill failed";
    $("aiCatalog").textContent = $("modelState").textContent;
    throw e;
  } finally {
    state.modelsLoading = false;
    $("refreshModels").disabled = false;
    $("retryModels").disabled = false;
    syncReadiness();
  }
}
export const runInput = () => ({
  prUrl: $("pr").value.trim(),
  ...($("preview").value.trim()
    ? { previewUrl: $("preview").value.trim() }
    : {}),
  model: $("model").value,
});
export function initializeModels() {
  $("refreshModels").onclick = () =>
    loadModels().catch(() => {
      /* The field and provider cards already show this error. */
    });
  $("retryModels").onclick = () =>
    loadModels().catch(() => {
      /* The field and provider cards already show this error. */
    });
  $("model").onchange = invalidatePreflight;
  $("pr").oninput = invalidatePreflight;
  $("preview").oninput = invalidatePreflight;
}
