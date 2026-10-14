import { isSettingsSection, type SettingsSection } from "@/i18n";

/**
 * The dedicated screen a URL points at: the detail of one automatic attempt, or
 * the detail of one run. Both are addressable so a support conversation can
 * quote one link instead of describing a path through the interface.
 */
export type ScreenRoute =
  | { id: string; kind: "automatic" }
  | { id: string; kind: "run" };

/**
 * Hash bodies this dashboard writes. `legacy` is the bare `#<uuid>` link the
 * history has always used to select a run in place: it keeps working, and it is
 * deliberately not the same link as the dedicated `run=` screen.
 */
export type DeepLink =
  | ScreenRoute
  | { id: string; kind: "legacy" }
  | { id: SettingsSection; kind: "settings" };

export interface InitialRoute {
  github?: string;
  /** Legacy `#<uuid>` link, still honoured: the runs view selects this run. */
  runId?: string;
  /** Dedicated screen the URL asked for, when it named one. */
  screen?: ScreenRoute;
  /** Settings page the URL asked for, when it named one. */
  section?: SettingsSection;
  setupCode?: string;
}

const RUN_ID = /^[0-9a-f-]{36}$/;
/** Delivery ids are opaque; this only bounds what may travel in a path segment. */
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** `run=<uuid>` and `automatic=<id>`; anything else is not a screen link. */
function screenFromHash(hash: string): ScreenRoute | undefined {
  const value = (prefix: string) => {
    try {
      return decodeURIComponent(hash.slice(prefix.length));
    } catch {
      // A malformed escape is not a link this dashboard ever wrote.
      return;
    }
  };
  if (hash.startsWith("run=")) {
    const id = value("run=");
    return id && RUN_ID.test(id) ? { id, kind: "run" } : undefined;
  }
  if (hash.startsWith("automatic=")) {
    const id = value("automatic=");
    return id && DELIVERY_ID.test(id) ? { id, kind: "automatic" } : undefined;
  }
  return;
}

/** `settings=<id>`; a section this build does not know is not a link. */
function sectionFromHash(hash: string): SettingsSection | undefined {
  if (!hash.startsWith("settings=")) {
    return;
  }
  try {
    const id = decodeURIComponent(hash.slice("settings=".length));
    return isSettingsSection(id) ? id : undefined;
  } catch {
    // A malformed escape is not a link this dashboard ever wrote.
    return;
  }
}

/**
 * Reads the URL once, at load. A link this dashboard wrote stays in the URL, so
 * reloading a shared `#automatic=<id>`, `#run=<uuid>` or `#settings=<section>`
 * reopens the same screen instead of dropping it on the first of two refreshes.
 * Only the payloads that must not be replayed — a temporary setup code, the
 * GitHub callback — are erased from the address bar.
 */
export function readInitialRoute(): InitialRoute {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(window.location.search);
  const route: InitialRoute = {};
  const screen = screenFromHash(hash);
  const section = sectionFromHash(hash);
  // A bare `#<uuid>` is the legacy run link, written by `openRun`; it is kept
  // like the screen links so a refresh keeps the run the history selected.
  let keepHash = false;
  if (screen) {
    route.screen = screen;
    keepHash = true;
  } else if (section) {
    route.section = section;
    keepHash = true;
  } else if (RUN_ID.test(hash)) {
    route.runId = hash;
    keepHash = true;
  } else if (hash.startsWith("setup=")) {
    route.setupCode = hash.slice("setup=".length);
  }
  const github = params.get("github");
  if (github) {
    route.github = github;
  }
  if (hash || github) {
    const path = window.location.pathname;
    window.history.replaceState(
      null,
      "",
      keepHash ? `${path}${window.location.hash}` : path
    );
  }
  return route;
}

/** Writes the deep link of the visible screen, or clears it. */
export function replaceHash(link: DeepLink | undefined) {
  const path = window.location.pathname;
  if (!link) {
    window.history.replaceState(null, "", path);
    return;
  }
  const body =
    link.kind === "legacy"
      ? link.id
      : `${link.kind}=${encodeURIComponent(link.id)}`;
  window.history.replaceState(null, "", `${path}#${body}`);
}
