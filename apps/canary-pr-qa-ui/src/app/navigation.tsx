import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { type SettingsSection, settingsNav, type ViewName } from "@/i18n";
import { createStore, type Store } from "@/lib/store";
import {
  addressFor,
  pushRoute,
  type Route,
  readRoute,
  replaceRoute,
  viewOf,
} from "./routing";
import { useSession } from "./session";

/** La page « Réglages » ouvre quand rien d'autre n'a été demandé. */
const DEFAULT_SECTION: SettingsSection = settingsNav[0].id;

/** Le rôle de l'opérateur connecté : ce que la garde de navigation regarde. */
interface Role {
  canWrite: boolean;
  isAdmin: boolean;
}

/** L'écran visible, et le test ou la tentative qu'un écran ouvert a reçus. */
interface NavigationState {
  requestedAutomatic?: string;
  requestedRun?: string;
  requestedRunScreen?: string;
  requestedView: ViewName;
  /**
   * Le nombre d'entrées que Retour ou Avant a restaurées. Un écran qui lit son
   * lien une seule fois se remonte sur cette valeur : l'adresse redevient ce qui
   * décide du détail affiché.
   */
  restoreCount: number;
  section: SettingsSection;
}

interface NavigationContextValue {
  consumeAutomatic(): string | undefined;
  consumeRun(): string | undefined;
  consumeRunScreen(): string | undefined;
  navigate(view: ViewName): void;
  openAutomatic(deliveryId: string): void;
  /** Sélectionne un test dans l'historique, en gardant l'ancien lien `#<uuid>`. */
  openRun(runId: string): void;
  /** Ouvre le rapport complet d'un test à son propre lien (`#run=<uuid>`). */
  openRunScreen(runId: string): void;
  /** Ouvre une page de réglages, à son propre lien (`#settings=<section>`). */
  openSection(section: SettingsSection): void;
  /** Tentative automatique liée par l'adresse, pas encore consommée. */
  requestedAutomatic?: string;
  requestedRun?: string;
  /** Écran de test lié par l'adresse, distinct du choix dans l'historique. */
  requestedRunScreen?: string;
  /**
   * Incrémenté à chaque entrée restaurée par Retour ou Avant. Les écrans qui
   * lisent leur lien une seule fois s'en servent de `key`, pour rouvrir le lien
   * de l'entrée restaurée au lieu de garder le détail de la précédente.
   */
  restoreCount: number;
  /** Page de réglages que l'écran visible affiche. */
  section: SettingsSection;
  view: ViewName;
}

const NavigationContext = createContext<NavigationContextValue | undefined>(
  undefined
);

/** Rôles qui ouvrent un panneau : réglages est administrateur, « nouveau » écrit. */
function isAllowed(
  view: ViewName,
  canWrite: boolean,
  isAdmin: boolean
): boolean {
  if (view === "settings") {
    return isAdmin;
  }
  if (view === "new") {
    return canWrite;
  }
  return true;
}

/** L'écran qu'un rôle peut lire ; un panneau refusé n'est jamais l'écran visible. */
function visibleView(view: ViewName, role: Role): ViewName {
  return isAllowed(view, role.canWrite, role.isAdmin) ? view : "home";
}

/**
 * Aligne l'entrée que la barre affiche sur l'écran visible, sans en ajouter :
 * l'adresse doit décrire ce que l'opérateur regarde, et jamais un écran que son
 * rôle ne peut pas lire. Les écrans détaillés gardent leur lien, seul porteur
 * d'un identifiant que la vue consomme à l'ouverture.
 */
function align(store: Store<NavigationState>, role: Role): void {
  const { requestedView, section } = store.getSnapshot();
  replaceRoute(
    addressFor(visibleView(requestedView, role), section, readRoute())
  );
}

/**
 * Rejoue l'entrée que Retour ou Avant vient de restaurer : l'adresse redevient
 * ce qui décide de l'écran, jugée avec le rôle du moment.
 */
function replay(store: Store<NavigationState>, role: Role): void {
  const route = readRoute();
  const shown: Route = isAllowed(viewOf(route), role.canWrite, role.isAdmin)
    ? route
    : { kind: "home" };
  store.set((current) => ({
    requestedAutomatic: shown.kind === "automatic" ? shown.id : undefined,
    requestedRun: shown.kind === "runs" ? shown.runId : undefined,
    requestedRunScreen: shown.kind === "run" ? shown.id : undefined,
    requestedView: viewOf(shown),
    restoreCount: current.restoreCount + 1,
    section: shown.kind === "settings" ? shown.section : current.section,
  }));
  // Une entrée que ce rôle ne peut pas lire ne reste pas dans la barre : elle est
  // corrigée sur place, sans ajouter une seconde entrée à l'historique.
  align(store, role);
  window.scrollTo({ behavior: "instant", top: 0 });
}

/**
 * Abonne React à l'historique du navigateur, pour la vie du provider.
 *
 * Le premier abonnement est le montage : l'entrée de chargement est alignée sur
 * l'écran visible sans pousser d'entrée, parce qu'un lien partagé doit rouvrir
 * le même écran et qu'un écran interdit au rôle courant ne doit pas y rester. Le
 * rôle fait partie de l'abonnement : une entrée ancienne est jugée avec le rôle
 * d'aujourd'hui, et non avec celui du montage.
 */
function watchHistory(
  store: Store<NavigationState>,
  role: Role,
  onStoreChange: () => void
): () => void {
  align(store, role);
  const onPopState = () => replay(store, role);
  window.addEventListener("popstate", onPopState);
  const unsubscribe = store.subscribe(onStoreChange);
  return () => {
    window.removeEventListener("popstate", onPopState);
    unsubscribe();
  };
}

/** Une lecture unique d'un lien profond : la valeur lue quitte l'état. */
function take(
  store: Store<NavigationState>,
  key: "requestedAutomatic" | "requestedRun" | "requestedRunScreen"
): string | undefined {
  const current = store.getSnapshot()[key];
  if (current !== undefined) {
    store.set((state) => ({ ...state, [key]: undefined }));
  }
  return current;
}

/**
 * Navigation d'un dashboard mono-document : aucune librairie de routage, mais un
 * seul endroit qui sait quelle vue est visible, quelle adresse elle porte, et
 * quel test ou quelle tentative a été ouvert par un lien.
 */
export function NavigationProvider({
  children,
  initialAutomatic,
  initialRun,
  initialRunScreen,
  initialSection = DEFAULT_SECTION,
  initialView = "home",
}: {
  children: ReactNode;
  initialAutomatic?: string;
  initialRun?: string;
  initialRunScreen?: string;
  initialSection?: SettingsSection;
  initialView?: ViewName;
}) {
  const { canWrite, isAdmin } = useSession();
  const [store] = useState(() =>
    createStore<NavigationState>({
      requestedAutomatic: initialAutomatic,
      requestedRun: initialRun,
      requestedRunScreen: initialRunScreen,
      requestedView: initialView,
      restoreCount: 0,
      section: initialSection,
    })
  );
  const subscribeToHistory = useCallback(
    (onStoreChange: () => void) =>
      watchHistory(store, { canWrite, isAdmin }, onStoreChange),
    [canWrite, isAdmin, store]
  );
  const state = useSyncExternalStore(
    subscribeToHistory,
    store.getSnapshot,
    store.getSnapshot
  );
  const view = visibleView(state.requestedView, { canWrite, isAdmin });

  const navigate = useCallback(
    (next: ViewName) => {
      const allowed = isAllowed(next, canWrite, isAdmin);
      const target = allowed ? next : "home";
      store.set((current) => ({ ...current, requestedView: target }));
      // Les écrans détaillés s'ouvrent par `openRun`, `openRunScreen` ou
      // `openAutomatic`, seuls à connaître l'identifiant qu'ils affichent.
      const address = addressFor(
        target,
        store.getSnapshot().section,
        readRoute()
      );
      // Une vue refusée n'écrit pas d'entrée : l'entrée courante est corrigée,
      // pour qu'un Retour ne retombe pas sur un écran que ce rôle ne peut pas lire.
      if (allowed) {
        pushRoute(address);
      } else {
        replaceRoute(address);
      }
      window.scrollTo({ behavior: "instant", top: 0 });
    },
    [canWrite, isAdmin, store]
  );

  /**
   * Le seul point d'entrée qui choisit une page de réglages. Le sous-menu de la
   * barre latérale l'utilise directement ; l'accueil s'en sert pour envoyer un
   * administrateur vers la connexion GitHub qu'il vient de lui annoncer.
   */
  const openSection = useCallback(
    (next: SettingsSection) => {
      const allowed = isAllowed("settings", canWrite, isAdmin);
      store.set((current) => ({
        ...current,
        requestedView: allowed ? "settings" : "home",
        section: next,
      }));
      if (allowed) {
        // La page est dans l'adresse : un lien partagé rouvre la même.
        pushRoute({ kind: "settings", section: next });
      } else {
        // Une page refusée ne doit pas rester dans la barre.
        replaceRoute({ kind: "home" });
      }
      window.scrollTo({ behavior: "instant", top: 0 });
    },
    [canWrite, isAdmin, store]
  );

  const openRun = useCallback(
    (runId: string) => {
      store.set((current) => ({
        ...current,
        requestedRun: runId,
        requestedView: "runs",
      }));
      pushRoute({ kind: "runs", runId });
      window.scrollTo({ behavior: "instant", top: 0 });
    },
    [store]
  );

  const openRunScreen = useCallback(
    (runId: string) => {
      store.set((current) => ({
        ...current,
        requestedRunScreen: runId,
        requestedView: "run",
      }));
      pushRoute({ id: runId, kind: "run" });
      window.scrollTo({ behavior: "instant", top: 0 });
    },
    [store]
  );

  const openAutomatic = useCallback(
    (deliveryId: string) => {
      store.set((current) => ({
        ...current,
        requestedAutomatic: deliveryId,
        requestedView: "automatic",
      }));
      pushRoute({ id: deliveryId, kind: "automatic" });
      window.scrollTo({ behavior: "instant", top: 0 });
    },
    [store]
  );

  /** Lectures uniques d'un lien profond ; l'appelant indexe son store dessus. */
  const consumeAutomatic = useCallback(
    () => take(store, "requestedAutomatic"),
    [store]
  );

  const consumeRun = useCallback(() => take(store, "requestedRun"), [store]);

  const consumeRunScreen = useCallback(
    () => take(store, "requestedRunScreen"),
    [store]
  );

  const value = useMemo<NavigationContextValue>(
    () => ({
      consumeAutomatic,
      consumeRun,
      consumeRunScreen,
      navigate,
      openAutomatic,
      openRun,
      openRunScreen,
      openSection,
      requestedAutomatic: state.requestedAutomatic,
      requestedRun: state.requestedRun,
      requestedRunScreen: state.requestedRunScreen,
      restoreCount: state.restoreCount,
      section: state.section,
      // Dérivé plutôt que corrigé par un effet : le rôle peut changer sous nos
      // pieds (un rafraîchissement de session), et un panneau que le rôle courant
      // ne peut pas lire n'est simplement jamais l'écran visible.
      view,
    }),
    [
      consumeAutomatic,
      consumeRun,
      consumeRunScreen,
      navigate,
      openAutomatic,
      openRun,
      openRunScreen,
      openSection,
      state,
      view,
    ]
  );

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation(): NavigationContextValue {
  const value = useContext(NavigationContext);
  if (!value) {
    throw new Error("useNavigation must be used inside NavigationProvider");
  }
  return value;
}
