import { api, errorText, post } from "./api.js";
import type { ApiResponses } from "./contracts.js";
import { $ } from "./dom.js";
import { loadSetupStatus } from "./overview.js";
import { list } from "./runs.js";
import { state } from "./state.js";
export const githubError = (value: unknown) => {
  $("githubError").textContent = errorText(value);
};
export function renderGitHub(data: ApiResponses["/github/app"]) {
  $("githubError").textContent = "";
  $("githubCreate").hidden = !!data.app;
  $("githubAppActions").hidden = !data.app;
  const enabled = data.repositories.filter(
    (r) =>
      r.enabled &&
      (!data.restriction.length ||
        data.restriction.includes(r.full_name.toLowerCase()))
  );
  if (data.app) {
    $("githubConnection").textContent = enabled.length
      ? "Connecté"
      : "À terminer";
    $("githubMessage").textContent = enabled.length
      ? "Dépôts enregistrés. Votre App est prête pour les tests et les webhooks."
      : "App créée. Installez-la sur GitHub, actualisez la connexion puis choisissez vos dépôts.";
  } else {
    $("githubConnection").textContent = "À connecter";
    $("githubMessage").textContent = data.legacyConfigured
      ? "Un accès technique est déjà configuré. Créez votre App pour gérer GitHub depuis cet assistant."
      : "Première étape : créez votre App. Vous reviendrez ici après confirmation sur GitHub.";
  }
  $("githubOriginHint").textContent =
    "Le serveur doit être joignable sur son domaine HTTPS public. Les callbacks et le webhook y sont configurés automatiquement.";
  if (!data.app) {
    return;
  }
  $("githubAppName").textContent = `${data.app.slug} · App #${data.app.id}`;
  $("githubRepoList").replaceChildren();
  for (const repo of data.repositories) {
    const row = document.createElement("div");
    row.className = "repo-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = repo.full_name;
    box.id = `repo-${repo.full_name.replaceAll("/", "-")}`;
    box.checked = repo.enabled;
    const restricted =
      data.restriction.length > 0 &&
      !data.restriction.includes(repo.full_name.toLowerCase());
    box.disabled = restricted;
    const label = document.createElement("label");
    label.htmlFor = box.id;
    label.textContent =
      repo.full_name + (restricted ? " · restreint par le serveur" : "");
    const privacy = document.createElement("span");
    privacy.className = "pill";
    privacy.textContent = repo.private ? "Privé" : "Public";
    row.append(box, label, privacy);
    $("githubRepoList").append(row);
  }
  if (!data.repositories.length) {
    $("githubRepoList").textContent =
      "Aucun dépôt accessible. Installez votre App puis cliquez sur Actualiser.";
  }
  if (data.lastDelivery) {
    $("githubMessage").textContent +=
      " Dernier webhook : " +
      new Date(data.lastDelivery.created_at).toLocaleString() +
      " · " +
      data.lastDelivery.status;
  }
}
export async function loadGitHub() {
  renderGitHub(await api("/github/app"));
}
export async function githubBusy(
  button: HTMLButtonElement,
  operation: () => Promise<void>
) {
  button.disabled = true;
  $("githubError").textContent = "";
  try {
    await operation();
  } catch (e) {
    githubError(e);
  } finally {
    button.disabled = false;
  }
}
export function initializeGithub() {
  $("githubName").value = `Canary-QA-${Math.random().toString(36).slice(2, 8)}`;
  $("githubCreate").onsubmit = (e) => {
    e.preventDefault();
    githubBusy($("githubCreateButton"), async () => {
      const result = await api(
        "/github/app/manifest",
        post({
          name: $("githubName").value,
          ...($("githubOrg").value.trim()
            ? { organization: $("githubOrg").value.trim() }
            : {}),
        })
      );
      const form = document.createElement("form");
      form.method = "POST";
      form.action = result.action;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = JSON.stringify(result.manifest);
      form.append(input);
      document.body.append(form);
      form.submit();
    });
  };
  $("githubInstall").onclick = () =>
    githubBusy($("githubInstall"), async () => {
      const result = await api("/github/app/install", post({}));
      location.assign(result.url);
    });
  $("githubRefresh").onclick = () =>
    githubBusy($("githubRefresh"), async () => {
      renderGitHub(await api("/github/app/refresh", post({})));
      state.currentUser = await api("/me");
      await loadSetupStatus();
    });
  $("githubRepos").onsubmit = (e) => {
    e.preventDefault();
    githubBusy($("githubSave"), async () => {
      const repositories = [
        ...$("githubRepoList").querySelectorAll<HTMLInputElement>(
          "input:checked:not(:disabled)"
        ),
      ].map((box) => box.value);
      renderGitHub(
        await api("/github/app/repositories", {
          ...post({ repositories }),
          method: "PUT",
        })
      );
      $("githubMessage").textContent =
        "Dépôts enregistrés. Vous pouvez maintenant préparer votre premier test.";
      state.currentUser = await api("/me");
      await loadSetupStatus();
      await list();
    });
  };
}
