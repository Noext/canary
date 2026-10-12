export interface InitialRoute {
  github?: string;
  runId?: string;
  setupCode?: string;
}

const RUN_ID = /^[0-9a-f-]{36}$/;

/**
 * The dashboard is a single document: deep links are read once, then stripped
 * from the URL so a refresh never replays them.
 */
export function readInitialRoute(): InitialRoute {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(window.location.search);
  const route: InitialRoute = {};
  if (RUN_ID.test(hash)) {
    route.runId = hash;
  } else if (hash.startsWith("setup=")) {
    route.setupCode = hash.slice("setup=".length);
  }
  const github = params.get("github");
  if (github) {
    route.github = github;
  }
  if (hash || github) {
    window.history.replaceState(null, "", window.location.pathname);
  }
  return route;
}

/** Runs `#<uuid>` links are opened by selecting the runs view. */
export function replaceHash(runId: string | undefined) {
  const path = window.location.pathname;
  window.history.replaceState(null, "", runId ? `${path}#${runId}` : path);
}
