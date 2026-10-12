import { $ } from "./dom.js";
import { state, type View } from "./state.js";
export function navigate(requestedView: View) {
  let view = requestedView;
  if (view === "settings" && state.currentUser?.role !== "admin") {
    view = "home";
  }
  if (view === "new" && !state.canWrite) {
    view = "runs";
  }
  state.activeView = view;
  for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== view;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-view]"
  )) {
    button.classList.toggle("active", button.dataset.view === view);
    if (button.dataset.view === view) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }
  const titles: Record<View, readonly [string, string, string]> = {
    home: [
      "Bienvenue dans Canary",
      "Connectez vos outils, puis lancez votre premier test.",
      "Vue d’ensemble",
    ],
    new: [
      "Nouveau test",
      "Vérifiez une pull request dans un vrai navigateur.",
      "Nouveau test",
    ],
    runs: [
      "Vos tests",
      "Suivez leur progression et inspectez les preuves.",
      "Historique",
    ],
    settings: [
      "Réglages de votre espace",
      "Vos connexions et les dépôts que Canary peut tester.",
      "Réglages",
    ],
  };
  const title = titles[view];
  $("viewTitle").textContent = title[0];
  $("viewIntro").textContent = title[1];
  $("breadcrumb").textContent = title[2];
  if (view !== "runs" && location.hash) {
    history.replaceState(null, "", location.pathname);
  }
  $("error").textContent = "";
  window.scrollTo({ top: 0, behavior: "instant" });
}
export function initializeNavigation() {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-view]"
  )) {
    const view = button.dataset.view;
    if (
      view === "home" ||
      view === "new" ||
      view === "runs" ||
      view === "settings"
    ) {
      button.onclick = () => navigate(view);
    }
  }
}
