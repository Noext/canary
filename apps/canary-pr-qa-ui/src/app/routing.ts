import { isSettingsSection, type SettingsSection, type ViewName } from "@/i18n";

/**
 * L'écran détaillé qu'une adresse nomme : le détail d'une tentative automatique,
 * ou celui d'un test. Les deux sont adressables, pour qu'une conversation de
 * support cite un lien au lieu de décrire un chemin à travers l'interface.
 */
export type ScreenRoute =
  | { id: string; kind: "automatic" }
  | { id: string; kind: "run" };

/**
 * Une adresse par écran. L'historique et la page de nouveau test vivent dans le
 * chemin (`/history`, `/new-test`), donc un rechargement ou un partage n'a pas
 * besoin du fragment ; les écrans qui citent un identifiant gardent un hash, que
 * le serveur n'a jamais eu à servir. Le `kind` d'une route est le nom de la vue
 * qu'elle affiche : la liste des écrans et celle des adresses ne peuvent pas
 * diverger sans erreur de compilation.
 */
export type Route =
  | { kind: "home" }
  | { kind: "new" }
  /** L'historique ; `runId` est le test que nomme l'ancien lien `#<uuid>`. */
  | { kind: "runs"; runId?: string }
  | { kind: "settings"; section: SettingsSection }
  | ScreenRoute;

/**
 * Ce pour quoi un chargement a été servi : l'écran que son adresse nomme, et les
 * charges utiles qui l'accompagnaient.
 */
export interface InitialRoute {
  github?: string;
  /** L'écran que l'adresse demande ; `home` quand elle n'en nomme aucun. */
  route: Route;
  setupCode?: string;
}

const RUN_ID = /^[0-9a-f-]{36}$/;
/** Les identifiants de tentative sont opaques ; ceci borne le hash. */
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** `run=<uuid>` et `automatic=<id>` ; rien d'autre n'est un lien d'écran. */
function screenFromHash(hash: string): ScreenRoute | undefined {
  const value = (prefix: string) => {
    try {
      return decodeURIComponent(hash.slice(prefix.length));
    } catch {
      // Un échappement malformé n'est pas un lien que ce dashboard écrit.
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

/** `settings=<id>` ; une page que ce build ne connaît pas n'est pas un lien. */
function sectionFromHash(hash: string): SettingsSection | undefined {
  if (!hash.startsWith("settings=")) {
    return;
  }
  try {
    const id = decodeURIComponent(hash.slice("settings=".length));
    return isSettingsSection(id) ? id : undefined;
  } catch {
    // Un échappement malformé n'est pas un lien que ce dashboard écrit.
    return;
  }
}

/**
 * L'écran qu'un chemin nomme. Le serveur sert ce dashboard pour `/`, `/history`
 * et `/new-test`, et pour rien d'autre : tout autre chemin (une adresse à moitié
 * tapée, un ancien marque-page) est l'accueil, et la barre d'adresse est corrigée
 * en conséquence.
 */
function routeFromPath(pathname: string): Route {
  if (pathname === "/history") {
    return { kind: "runs" };
  }
  if (pathname === "/new-test") {
    return { kind: "new" };
  }
  return { kind: "home" };
}

/**
 * Lit l'adresse telle qu'elle est, sans y toucher. L'écran est le hash quand il
 * en nomme un — la seule partie qui puisse citer un identifiant — et le chemin
 * sinon : le serveur ne sert ce document que pour les chemins qu'il connaît.
 */
function parseAddress(): {
  github?: string;
  hashNamesScreen: boolean;
  route: Route;
  setupCode?: string;
} {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(window.location.search);
  const screen = screenFromHash(hash);
  const section = sectionFromHash(hash);
  const legacyRun = !(screen || section) && RUN_ID.test(hash);
  let route: Route = routeFromPath(window.location.pathname);
  if (screen) {
    route = screen;
  } else if (section) {
    route = { kind: "settings", section };
  } else if (legacyRun) {
    route = { kind: "runs", runId: hash };
  }
  return {
    github: params.get("github") ?? undefined,
    hashNamesScreen: Boolean(screen || section || legacyRun),
    route,
    setupCode: hash.startsWith("setup=")
      ? hash.slice("setup=".length)
      : undefined,
  };
}

/**
 * La vue qu'une adresse affiche : le `kind` d'une route est le nom de son écran,
 * donc une route ajoutée sans vue correspondante ne compile pas.
 */
export function viewOf(route: Route): ViewName {
  return route.kind;
}

/**
 * L'écran qu'un chargement ouvre. Le retour du callback GitHub ouvre la page de
 * connexion GitHub, mais seulement quand l'adresse ne nomme aucun écran : un
 * lien explicite (`#run=`, `#automatic=`, `#settings=`, `#<uuid>`) gagne sur la
 * destination du callback.
 */
export function initialViewFor(route: Route, github?: string): ViewName {
  return route.kind === "home" && github ? "settings" : viewOf(route);
}

/**
 * Preuve de compilation qu'une union est entièrement traitée : un écran ajouté
 * sans adresse ne compile pas, au lieu de retomber silencieusement sur l'accueil.
 */
function unreachable(value: never): never {
  throw new Error(`Écran sans adresse : ${JSON.stringify(value)}`);
}

/**
 * Le chemin et le hash qu'un écran occupe. Les listes n'utilisent que le chemin,
 * pour qu'un rechargement ou un partage n'ait pas besoin du fragment ; les écrans
 * détaillés gardent `/` en chemin et citent leur identifiant dans le hash, comme
 * ils l'ont toujours fait.
 */
function addressParts(route: Route): { hash: string; path: string } {
  switch (route.kind) {
    case "home":
      return { hash: "", path: "/" };
    case "new":
      return { hash: "", path: "/new-test" };
    case "runs":
      return route.runId
        ? { hash: `#${route.runId}`, path: "/" }
        : { hash: "", path: "/history" };
    case "settings":
      return { hash: `#settings=${route.section}`, path: "/" };
    case "run":
      return { hash: `#run=${route.id}`, path: "/" };
    case "automatic":
      return { hash: `#automatic=${route.id}`, path: "/" };
    default:
      return unreachable(route);
  }
}

/** L'adresse d'un écran, absolue dans le document. */
export function routeUrl(route: Route): string {
  const { hash, path } = addressParts(route);
  return `${path}${hash}`;
}

/**
 * L'adresse d'une vue visible. `current` porte l'identifiant des écrans
 * détaillés : la vue le consomme à l'ouverture, donc l'état ne le garde plus,
 * mais l'adresse par laquelle il est arrivé ne doit pas être perdue.
 */
export function addressFor(
  view: ViewName,
  section: SettingsSection,
  current: Route
): Route {
  switch (view) {
    case "home":
      return { kind: "home" };
    case "new":
      return { kind: "new" };
    case "runs":
      return current.kind === "runs" && current.runId
        ? current
        : { kind: "runs" };
    case "settings":
      return { kind: "settings", section };
    // Un écran détaillé garde le lien par lequel il a été ouvert.
    case "run":
    case "automatic":
      return current;
    default:
      return unreachable(view);
  }
}

/** L'adresse telle que la barre la porte, requête et hash compris. */
function currentUrl(): string {
  const { hash, pathname, search } = window.location;
  return `${pathname}${search}${hash}`;
}

/** Écrit l'adresse d'un écran, ou laisse la barre tranquille si elle y est déjà. */
function write(route: Route, mode: "push" | "replace"): void {
  const url = routeUrl(route);
  // L'adresse demandée est déjà celle de la barre : la pousser laisserait une
  // entrée dont Retour ne sort pas, et la réécrire à l'identique n'écrit rien.
  if (url === currentUrl()) {
    return;
  }
  if (mode === "push") {
    window.history.pushState(null, "", url);
  } else {
    window.history.replaceState(null, "", url);
  }
}

/** Ajoute une entrée : Retour ramène l'écran qui était affiché avant. */
export function pushRoute(route: Route): void {
  write(route, "push");
}

/** Corrige l'entrée que la barre affiche, sans en ajouter une seconde. */
export function replaceRoute(route: Route): void {
  write(route, "replace");
}

/**
 * Relit l'adresse courante sans la modifier : `popstate` rejoue l'entrée que le
 * navigateur vient de restaurer, et la réécrire effacerait ce Retour.
 */
export function readRoute(): Route {
  return parseAddress().route;
}

/**
 * Lit l'URL une fois, au chargement. Un lien que ce dashboard a écrit reste dans
 * l'URL, donc recharger un `#automatic=<id>`, `#run=<uuid>` ou
 * `#settings=<section>` partagé rouvre le même écran au lieu de le perdre à la
 * première actualisation. Les chemins `/history` et `/new-test` restent pour la
 * même raison. Seules les charges qui ne doivent pas être rejouées — un code de
 * setup temporaire, le retour du callback GitHub, un hash que ce dashboard n'a
 * jamais écrit — quittent la barre d'adresse.
 */
export function readInitialRoute(): InitialRoute {
  const address = parseAddress();
  if (window.location.hash || address.github) {
    const path = window.location.pathname;
    window.history.replaceState(
      null,
      "",
      address.hashNamesScreen ? `${path}${window.location.hash}` : path
    );
  }
  const initial: InitialRoute = { route: address.route };
  if (address.github) {
    initial.github = address.github;
  }
  if (address.setupCode) {
    initial.setupCode = address.setupCode;
  }
  return initial;
}
