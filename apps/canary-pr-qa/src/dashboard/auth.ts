import type { Principal } from "../access.js";
import { api, error, post } from "./api.js";
import { $ } from "./dom.js";
import { githubError, loadGitHub } from "./github.js";
import { loadModels } from "./models.js";
import { navigate } from "./navigation.js";
import { loadSetupStatus } from "./overview.js";
import { detail, list } from "./runs.js";
import { state } from "./state.js";
export function signedIn(user: Principal) {
  state.currentUser = user;
  state.canWrite = ["operator", "admin"].includes(user.role);
  $("login").hidden = true;
  $("authHeader").hidden = true;
  $("work").hidden = false;
  $("connection").textContent =
    (user.username || user.id) +
    " • " +
    ({ admin: "Administrateur", operator: "Opérateur", viewer: "Lecture" }[
      user.role
    ] || user.role);
  $("nav-settings").hidden = user.role !== "admin";
  $("nav-new").hidden = !state.canWrite;
  $("onboarding").hidden = !state.canWrite;
  $("cancel").hidden = !state.canWrite;
  navigate("home");
  loadSetupStatus().catch(error);
  if (state.canWrite) {
    loadModels().catch(() => {
      /* The model controls show catalog failures. */
    });
  }
  if (user.role === "admin") {
    loadGitHub().catch(githubError);
  }
  if (!state.canWrite) {
    $("welcomeTitle").textContent = "Suivez les tests de votre équipe.";
    $("welcomeIntro").textContent =
      "Consultez les résultats, les assertions et les vidéos des dépôts auxquels vous avez accès.";
    $("welcomeAction").textContent = "Voir les tests";
    $("welcomeAction").onclick = () => navigate("runs");
    $("welcomeNote").textContent =
      "Votre compte dispose d’un accès en lecture.";
  }
  const returning = new URLSearchParams(location.search).get("github");
  if (returning && user.role === "admin") {
    navigate("settings");
    history.replaceState(null, "", location.pathname);
  }
  if (state.requestedRun) {
    const id = state.requestedRun;
    state.requestedRun = undefined;
    detail(id).catch(error);
  }
}
export async function authState() {
  const status = await api("/auth/status");
  state.setupMode = !status.initialized;
  $("authTitle").textContent = state.setupMode
    ? "Créez votre compte administrateur"
    : "Connectez-vous";
  $("authIntro").textContent = state.setupMode
    ? "Choisissez votre identifiant et un mot de passe. Nous vous guiderons ensuite pour connecter GitHub et lancer votre premier test."
    : "Retrouvez vos tests, leurs vidéos et les résultats de vos pull requests.";
  $("confirmation").hidden = !state.setupMode;
  $("confirmPassword").required = state.setupMode;
  $("setupInstructions").hidden = !state.setupMode || !!state.setupCode;
  $("accountSubmit").disabled = state.setupMode && !state.setupCode;
  $("accountSubmit").textContent = state.setupMode
    ? "Créer mon compte administrateur"
    : "Se connecter";
  $("password").autocomplete = state.setupMode
    ? "new-password"
    : "current-password";
  $("setupCommand").textContent =
    "docker compose exec -T pr-qa canary-pr-qa setup-admin --origin " +
    location.origin;
}
export function initializeAuth() {
  document.addEventListener("qa:session-expired", () => {
    state.stream?.close();
    $("work").hidden = true;
    $("login").hidden = false;
    $("authHeader").hidden = false;
    state.currentUser = undefined;
    state.canWrite = false;
    authState().catch(error);
  });
  $("logout").onclick = async () => {
    await api("/session", { method: "DELETE" });
    location.reload();
  };
  if (state.setupCode) {
    history.replaceState(null, "", location.pathname);
  }
  $("showPassword").onclick = () => {
    const visible = $("password").type === "password";
    $("password").type = visible ? "text" : "password";
    $("showPassword").textContent = visible ? "Masquer" : "Afficher";
    $("showPassword").setAttribute(
      "aria-label",
      visible ? "Masquer le mot de passe" : "Afficher le mot de passe"
    );
  };
  $("accountForm").onsubmit = async (e) => {
    e.preventDefault();
    $("error").textContent = "";
    if (state.setupMode && $("password").value !== $("confirmPassword").value) {
      error(new Error("Les mots de passe ne correspondent pas."));
      return;
    }
    const button = $("accountSubmit");
    button.disabled = true;
    $("authStatus").textContent = state.setupMode
      ? "Création de votre compte…"
      : "Connexion…";
    try {
      const user = await api(
        state.setupMode ? "/auth/setup" : "/auth/login",
        post({
          username: $("username").value,
          password: $("password").value,
          ...(state.setupMode ? { setupCode: state.setupCode } : {}),
        })
      );
      $("password").value = "";
      $("confirmPassword").value = "";
      state.setupCode = "";
      state.setupMode = false;
      authState().catch(error);
      signedIn(user);
      await list();
    } catch (e) {
      error(e);
    } finally {
      $("authStatus").textContent = "";
      button.disabled = state.setupMode && !state.setupCode;
    }
  };
  authState().catch(error);
  $("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const user = await api("/session", {
        method: "POST",
        headers: { Authorization: `Bearer ${$("token").value}` },
      });
      $("token").value = "";
      signedIn(user);
      await list();
    } catch (e) {
      error(e);
    }
  };
  if (!state.setupCode) {
    api("/me")
      .then((user) => {
        signedIn(user);
        return list();
      })
      .catch(() => {
        /* A missing session is expected on the sign-in screen. */
      });
  }
}
