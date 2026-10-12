import type { RunResult } from "../schema.js";
import { api, error, errorText, post } from "./api.js";
import type { RunJob } from "./contracts.js";
import { $ } from "./dom.js";
import { invalidatePreflight, runInput } from "./models.js";
import { navigate } from "./navigation.js";
import { syncReadiness } from "./overview.js";
import { badge, outcomeNames, phaseNames, stateNames } from "./presentation.js";
import { renderResult } from "./results.js";
import { state } from "./state.js";
export function runLink(run: RunJob) {
  const link = document.createElement("a");
  link.href = `#${run.id}`;
  link.textContent = `${run.repo} #${run.pr}`;
  link.onclick = (e) => {
    e.preventDefault();
    detail(run.id).catch(error);
  };
  return link;
}
export async function list() {
  const filtered = !!$("status").value || !!$("search").value;
  const rows = await api<RunJob[]>(
    "/runs?status=" +
      encodeURIComponent($("status").value) +
      "&search=" +
      encodeURIComponent($("search").value)
  );
  const all = filtered ? await api("/runs") : rows;
  $("runs").replaceChildren();
  for (const run of rows) {
    const tr = document.createElement("tr");
    const first = document.createElement("td");
    first.append(runLink(run));
    tr.append(first);
    for (const value of [
      run.sha.slice(0, 12),
      run.input.model || "Historique",
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      tr.append(cell);
    }
    const state = document.createElement("td");
    state.append(badge(stateNames[run.status] || run.status, run.status));
    const result = document.createElement("td");
    result.append(badge(outcomeNames[run.outcome || ""] || "—", run.outcome));
    const at = document.createElement("td");
    at.textContent = new Date(run.created_at).toLocaleString();
    tr.append(state, result, at);
    $("runs").append(tr);
  }
  $("historyEmpty").hidden = !!rows.length;
  $("historyTable").hidden = !rows.length;
  $("historyEmptyTitle").textContent = filtered
    ? "Aucun test ne correspond à ces filtres"
    : "Aucun test pour le moment";
  $("historyEmptyIntro").textContent = filtered
    ? "Modifiez votre recherche ou revenez à tous les états."
    : "Lancez votre premier test depuis « Nouveau test ».";
  $("countTotal").textContent = String(all.length);
  $("countActive").textContent = String(
    all.filter((run) => ["queued", "running"].includes(run.status)).length
  );
  $("countPassed").textContent = String(
    all.filter((run) => run.outcome === "passed").length
  );
  $("overviewEmpty").hidden = all.length > 0;
  $("recentRuns").replaceChildren();
  for (const run of all.slice(0, 3)) {
    const row = document.createElement("div");
    row.className = "repo-row";
    row.append(
      runLink(run),
      badge(
        outcomeNames[run.outcome || ""] || stateNames[run.status] || run.status,
        run.outcome || run.status
      )
    );
    $("recentRuns").append(row);
  }
  if (all.length && state.canWrite) {
    $("welcomeTitle").textContent =
      "Vos pull requests, vérifiées dans le navigateur.";
    $("welcomeIntro").textContent =
      "Lancez un nouveau test ou reprenez le suivi de vos derniers résultats.";
  }
}
export function renderProgress(data: RunJob) {
  const progress = data.progress || {};
  $("events").textContent = JSON.stringify(progress, null, 2);
  $("runState").textContent =
    outcomeNames[data.outcome || ""] || stateNames[data.status] || data.status;
  $("liveMessage").textContent =
    phaseNames[progress.phase || ""] ||
    stateNames[data.status] ||
    "En attente du worker…";
  if (progress.scenarioId) {
    $("liveMessage").textContent += ` · ${progress.scenarioId}`;
  }
  if (progress.action) {
    $("liveMessage").textContent += ` · ${progress.action}`;
  }
  const phaseIndex: Record<string, number | undefined> = {
    context: 0,
    preview: 0,
    discovery: 1,
    planning: 1,
    execution: 2,
    evidence: 2,
    verification: 3,
    publication: 4,
    done: 4,
  };
  const phase = phaseIndex[progress.phase || ""] ?? -1;
  const phases = document.querySelectorAll<HTMLElement>("#phaseList li");
  for (const [index, node] of phases.entries()) {
    node.className = phaseClass(index, phase, progress.phase, data.outcome);
  }
  $("cancel").hidden = !(
    state.canWrite && ["queued", "running"].includes(data.status)
  );
  $("provenance").textContent =
    "Commit " +
    data.sha.slice(0, 12) +
    " · " +
    (data.input.model || "Modèle historique");
  if (data.error) {
    $("liveMessage").textContent = `Le test a été interrompu : ${data.error}`;
  }
}
export async function detail(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return;
  }
  const initial = await api<RunJob>(`/runs/${id}`);
  state.current = id;
  navigate("runs");
  history.replaceState(null, "", `#${id}`);
  $("detail").hidden = false;
  $("runTitle").textContent = "Chargement du test…";
  $("runIdentifier").textContent = `Run ID : ${id}`;
  $("scenarioCards").replaceChildren();
  $("links").replaceChildren();
  $("resultSummary").hidden = true;
  $("events").textContent = "";
  $("result").textContent = "";
  $("usage").textContent = "";
  state.stream?.close();
  $("runTitle").textContent = `${initial.repo} · PR #${initial.pr}`;
  renderProgress(initial);
  const source = new EventSource(`/runs/${id}/events`);
  state.stream = source;
  source.onopen = () => {
    if (state.current === id) {
      $("liveConnection").textContent = "Suivi en direct connecté";
    }
  };
  source.onerror = () => {
    if (state.current === id && source.readyState !== 2) {
      $("liveConnection").textContent = "Reconnexion du suivi…";
    }
  };
  source.onmessage = async (e) => {
    if (state.current !== id) {
      return;
    }
    let data: RunJob;
    try {
      data = JSON.parse(e.data);
    } catch (failure) {
      source.close();
      $("liveConnection").textContent = "Suivi interrompu : réponse invalide";
      error(failure);
      return;
    }
    $("runTitle").textContent = `${data.repo} · PR #${data.pr}`;
    renderProgress(data);
    list().catch(error);
    if (!["queued", "running"].includes(data.status)) {
      source.close();
      $("liveConnection").textContent = "Suivi terminé";
      try {
        const result = await api<RunResult>(`/artifacts/${id}/result.json`);
        if (state.current === id) {
          renderResult(result);
        }
      } catch (e) {
        if (state.current === id) {
          $("resultSummary").hidden = false;
          $("resultSummary").className = "notice warning";
          $("resultSummary").textContent =
            "Aucun rapport de scénarios disponible pour ce test. " +
            errorText(e);
        }
      }
    }
  };
}
export function initializeRuns() {
  $("checkRun").onclick = async () => {
    if (!$("runForm").reportValidity()) {
      return;
    }
    const input = runInput();
    state.preflightBusy = true;
    invalidatePreflight();
    $("error").textContent = "";
    $("runFeedback").textContent =
      "Lecture de la PR et vérification de son application…";
    try {
      const checked = await api("/runs/preflight", post(input));
      if (JSON.stringify(runInput()) !== JSON.stringify(input)) {
        $("runFeedback").textContent =
          "Les paramètres ont changé. Vérifiez à nouveau.";
        return;
      }
      state.preflight = checked;
      $("preflightResult").hidden = false;
      $("preflightSummary").textContent =
        checked.pr.title +
        " · " +
        checked.pr.repo +
        " #" +
        checked.pr.number +
        " · version " +
        checked.pr.sha.slice(0, 12) +
        " · " +
        new URL(checked.preview.url).host;
      $("runFeedback").textContent =
        "Vous pouvez lancer le test. Aucun scénario ni commentaire GitHub n’a encore été créé.";
    } catch (e) {
      $("runFeedback").textContent = errorText(e);
      error(e);
    } finally {
      state.preflightBusy = false;
      syncReadiness();
    }
  };
  $("filters").onsubmit = (e) => {
    e.preventDefault();
    list().catch(error);
  };
  $("runForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!state.preflight) {
      $("runFeedback").textContent =
        "Vérifiez d’abord les accès et la version de l’application.";
      return;
    }
    const button = $("startRun");
    button.disabled = true;
    $("runFeedback").textContent = "Création du test…";
    try {
      const run = await api<RunJob>(
        "/runs",
        post({ ...runInput(), publish: true })
      );
      state.preflight = undefined;
      await detail(run.id);
      await list();
    } catch (e) {
      error(e);
    } finally {
      syncReadiness();
    }
  };
  $("cancel").onclick = async () => {
    const button = $("cancel");
    button.disabled = true;
    try {
      await api(`/runs/${state.current}/cancel`, post({}));
      $("liveMessage").textContent =
        "Annulation demandée. Le worker finalise les preuves.";
    } catch (e) {
      error(e);
    } finally {
      button.disabled = false;
    }
  };
}

function phaseClass(
  index: number,
  phase: number,
  name?: string,
  outcome?: string
) {
  if (name === "done") {
    return outcome === "passed" ? "done" : "";
  }
  if (index === phase) {
    return "active";
  }
  return index < phase ? "done" : "";
}
