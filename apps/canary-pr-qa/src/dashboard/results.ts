import type { RunResult, ScenarioResult } from "../schema.js";
import { $ } from "./dom.js";
import { badge, outcomeNames, safeArtifact } from "./presentation.js";
export function renderResult(result: RunResult) {
  if (result.model) {
    $("provenance").textContent =
      `Commit ${(result.sha || "").slice(0, 12)} · ${result.model}`;
  }
  $("result").textContent = JSON.stringify(result, null, 2);
  $("resultSummary").hidden = false;
  $("resultSummary").className =
    "notice " +
    (["failed", "blocked", "stale"].includes(result.outcome) ? "error" : "");
  $("resultSummary").textContent =
    ({
      passed:
        "Les assertions ont réussi. Consultez les scénarios et leurs vidéos ci-dessous.",
      failed:
        "Au moins une assertion a échoué. Consultez le scénario concerné et sa vidéo.",
      blocked:
        "Le test est bloqué. Le diagnostic indique la dépendance ou la configuration à corriger.",
      stale: "La PR a changé. Relancez un test sur sa dernière version.",
      skipped:
        "Aucun scénario n’a été exécuté ; ce résultat ne valide pas les changements.",
    }[result.outcome] || "Résultat disponible.") +
    (result.error ? ` ${result.error}` : "");
  if (result.publication?.status === "failed") {
    $("resultSummary").textContent += " La publication GitHub a échoué.";
  }
  $("scenarioCards").replaceChildren();
  for (const item of result.scenarios || []) {
    $("scenarioCards").append(scenarioCard(item, result.id));
  }
  $("usage").textContent = result.usage
    ? result.usage.tokens +
      " tokens" +
      (result.usage.pricingConfigured
        ? ` · coût estimé $${result.usage.costUsd.toFixed(4)}`
        : " · coût non configuré")
    : "";
  $("links").replaceChildren();
  const report = document.createElement("a");
  report.href = `/artifacts/${result.id}/report.html`;
  report.textContent = "Ouvrir le rapport complet";
  report.target = "_blank";
  report.rel = "noopener";
  $("links").append(report);
  appendGitHubLink(result.publication?.commentUrl);
}

function scenarioCard(item: ScenarioResult, runId: string) {
  const card = document.createElement("article");
  card.className = "scenario";
  const title = document.createElement("h3");
  const label = document.createElement("span");
  label.textContent = item.scenario.title;
  title.append(
    label,
    badge(outcomeNames[item.outcome] || item.outcome, item.outcome)
  );
  card.append(title);
  const checks = document.createElement("ul");
  for (const assertion of item.assertions || []) {
    const li = document.createElement("li");
    const description =
      item.scenario.assertions?.find((a) => a.id === assertion.id)
        ?.description || assertion.id;
    li.textContent = (assertion.passed ? "✓ " : "✕ ") + description;
    checks.append(li);
  }
  card.append(checks);
  if (item.error) {
    const p = document.createElement("p");
    p.textContent = item.error;
    card.append(p);
  }
  const video = (item.artifacts || []).find((path) => path.endsWith(".webm"));
  const path = safeArtifact(video);
  if (path) {
    const player = document.createElement("video");
    player.controls = true;
    player.preload = "none";
    player.setAttribute(
      "aria-label",
      `Vidéo du scénario ${item.scenario.title}`
    );
    player.src =
      "/artifacts/" +
      runId +
      "/" +
      encodeURIComponent(item.scenario.id) +
      "/" +
      path;
    card.append(player);
  }
  return card;
}
function appendGitHubLink(commentUrl?: string) {
  if (commentUrl) {
    try {
      const url = new URL(commentUrl);
      if (url.origin === "https://github.com") {
        const link = document.createElement("a");
        link.href = url.href;
        link.textContent = "Résultat sur GitHub ↗";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        $("links").append(link);
      }
    } catch {
      /* A malformed publication URL is not rendered as a link. */
    }
  }
}
