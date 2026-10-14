import { isSettingsSection, type SettingsSection, type ViewName } from "@/i18n";

/**
 * L'écran détaillé qu'une adresse nomme : le rapport d'un test, ou celui d'une
 * tentative automatique. Les deux sont adressables, pour qu'une conversation de
 * support cite un lien au lieu de décrire un chemin à travers l'interface.
 */
export type ScreenRoute =
  | { id: string; kind: "automatic" }
  | { id: string; kind: "run" };

/**
 * Une adresse par écran, portée par le chemin et rien d'autre.
 *
 * Chaque écran vit à son propre chemin, donc un rechargement, un partage, un
 * onglet neuf ou un retour arrière retombent sur le même écran : l'historique
 * est `/history`, le détail d'un test `/history/<uuid>`, et Retour ramène de
 * l'un à l'autre parce que ce sont deux pages, pas deux fragments du même
 * document. Le `kind` d'une route est le nom de la vue qu'elle affiche : la
 * liste des écrans et celle des adresses ne peuvent pas diverger sans erreur de
 * compilation.
 */
export type Route =
  | { kind: "home" }
  | { kind: "new" }
  /** L'historique ; `runId` est le test que sélectionne le détail de la page. */
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
/** Les identifiants de tentative sont opaques ; ceci borne leur segment. */
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Un segment décodé, ou rien : un échappement malformé n'est pas un lien. */
function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return;
  }
}

/**
 * L'écran qu'un chemin nomme. Le serveur sert ce dashboard pour ces chemins et
 * pour rien d'autre : tout autre chemin — une adresse à moitié tapée, un ancien
 * marque-page — est l'accueil, et la barre d'adresse est corrigée en conséquence.
 * Un identifiant qu'aucun écran ne peut porter (un uuid tronqué, une section que
 * ce build ne connaît pas) n'est pas un lien non plus.
 */
function routeFromPath(pathname: string): Route {
  // Un segment final vide (`/history/`) désigne la page elle-même : la barre est
  // corrigée sur le chemin canonique au lieu de tomber sur l'accueil.
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if (path === "/new-test") {
    return { kind: "new" };
  }
  if (path === "/history") {
    return { kind: "runs" };
  }
  const report = /^\/history\/([^/]+)\/report$/.exec(path);
  if (report?.[1]) {
    const id = decoded(report[1]);
    return id && RUN_ID.test(id) ? { id, kind: "run" } : { kind: "home" };
  }
  const selected = /^\/history\/([^/]+)$/.exec(path);
  if (selected?.[1]) {
    const id = decoded(selected[1]);
    return id && RUN_ID.test(id)
      ? { kind: "runs", runId: id }
      : { kind: "home" };
  }
  const automatic = /^\/automatic\/([^/]+)$/.exec(path);
  if (automatic?.[1]) {
    const id = decoded(automatic[1]);
    return id && DELIVERY_ID.test(id)
      ? { id, kind: "automatic" }
      : { kind: "home" };
  }
  const settings = /^\/settings\/([^/]+)$/.exec(path);
  if (settings?.[1]) {
    const id = decoded(settings[1]);
    return id && isSettingsSection(id)
      ? { kind: "settings", section: id }
      : { kind: "home" };
  }
  return { kind: "home" };
}

/**
 * Les fragments que ce dashboard a écrits avant que les écrans aient des
 * chemins : `#<uuid>`, `#run=<uuid>`, `#automatic=<id>` et `#settings=<section>`.
 * Ils restent lus — un lien cité dans une conversation de support doit continuer
 * d'ouvrir le même écran — et le chargement les réécrit sur leur chemin : un
 * lien d'écran n'est lu qu'une fois, jamais rejoué depuis un fragment.
 */
function routeFromHash(hash: string): Route | undefined {
  const value = (prefix: string) => decoded(hash.slice(prefix.length));
  if (hash.startsWith("run=")) {
    const id = value("run=");
    return id && RUN_ID.test(id) ? { id, kind: "run" } : undefined;
  }
  if (hash.startsWith("automatic=")) {
    const id = value("automatic=");
    return id && DELIVERY_ID.test(id) ? { id, kind: "automatic" } : undefined;
  }
  if (hash.startsWith("settings=")) {
    const id = value("settings=");
    return id && isSettingsSection(id)
      ? { kind: "settings", section: id }
      : undefined;
  }
  return RUN_ID.test(hash) ? { kind: "runs", runId: hash } : undefined;
}

/**
 * Lit l'adresse telle qu'elle est, sans y toucher. Le chemin nomme l'écran ; un
 * fragment n'est lu que pour un lien écrit avant le passage aux chemins, et il
 * gagne alors sur le chemin, qui ne cite pas d'identifiant.
 */
function parseAddress(): {
  github?: string;
  hashNamesScreen: boolean;
  route: Route;
  setupCode?: string;
} {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(window.location.search);
  const legacy = routeFromHash(hash);
  return {
    github: params.get("github") ?? undefined,
    hashNamesScreen: Boolean(legacy),
    route: legacy ?? routeFromPath(window.location.pathname),
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
 * lien explicite gagne sur la destination du callback.
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
 * Le chemin qu'un écran occupe. L'historique porte la sélection du détail
 * (`/history/<uuid>`) plutôt qu'un fragment : c'est ce qui donne à Retour une
 * page à restaurer, et à un lien partagé une réponse du serveur.
 */
function addressPath(route: Route): string {
  switch (route.kind) {
    case "home":
      return "/";
    case "new":
      return "/new-test";
    case "runs":
      return route.runId ? `/history/${route.runId}` : "/history";
    case "settings":
      return `/settings/${route.section}`;
    case "run":
      return `/history/${route.id}/report`;
    case "automatic":
      return `/automatic/${route.id}`;
    default:
      return unreachable(route);
  }
}

/**
 * L'adresse d'un écran, absolue dans le document. Les listes la mettent dans
 * l'attribut `href` d'un lien dont le clic est intercepté : l'adresse reste donc
 * celle de la page, et le clic milieu, le Ctrl-clic ou « copier l'adresse du
 * lien » l'ouvrent comme n'importe quel lien.
 */
export function routeUrl(route: Route): string {
  return addressPath(route);
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
 * Lit l'URL une fois, au chargement. L'entrée est réécrite sur le chemin de
 * l'écran qu'elle nomme : un lien `#run=<uuid>`, `#automatic=<id>`,
 * `#settings=<section>` ou `#<uuid>` écrit avant le passage aux chemins ouvre le
 * même écran, et la barre d'adresse ne garde que la page. Seules les charges qui
 * ne doivent pas être rejouées — un code de setup temporaire, le retour du
 * callback GitHub, un fragment que ce dashboard n'a jamais écrit — quittent la
 * barre d'adresse.
 */
export function readInitialRoute(): InitialRoute {
  const address = parseAddress();
  if (window.location.hash || address.github) {
    window.history.replaceState(
      null,
      "",
      // Un ancien lien est un chemin à partir de maintenant ; une charge utile
      // garde la page où elle est arrivée, sans sa requête ni son fragment.
      address.hashNamesScreen
        ? routeUrl(address.route)
        : window.location.pathname
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
