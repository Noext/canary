import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { type SettingsSection, settingsNav, type ViewName } from "@/i18n";
import { type DeepLink, replaceHash } from "./routing";
import { useSession } from "./session";

/** The page « Réglages » opens when nothing else was asked for. */
const DEFAULT_SECTION: SettingsSection = settingsNav[0].id;

interface NavigationContextValue {
  consumeAutomatic(): string | undefined;
  consumeRun(): string | undefined;
  consumeRunScreen(): string | undefined;
  navigate(view: ViewName): void;
  openAutomatic(deliveryId: string): void;
  /** Selects a run in the history, keeping the legacy `#<uuid>` link. */
  openRun(runId: string): void;
  /** Opens the full-screen run report at its own link (`#run=<uuid>`). */
  openRunScreen(runId: string): void;
  /** Opens one settings page, at its own link (`#settings=<section>`). */
  openSection(section: SettingsSection): void;
  /** Deep-linked automatic attempt not consumed yet. */
  requestedAutomatic?: string;
  requestedRun?: string;
  /** Deep-linked run screen not consumed yet; distinct from the history pick. */
  requestedRunScreen?: string;
  /** Settings page the visible screen shows. */
  section: SettingsSection;
  view: ViewName;
}

const NavigationContext = createContext<NavigationContextValue | undefined>(
  undefined
);

/** Views reached by a deep link: leaving one clears the hash it wrote. */
const screenViews: ViewName[] = ["automatic", "run"];

/** Roles that may open a panel: settings is admin-only, "new test" needs write. */
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

/**
 * Panel navigation for a single-document dashboard: no router library, but a
 * single place that knows which view is visible and which run or attempt was
 * deep-linked.
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
  const [requestedView, setView] = useState<ViewName>(initialView);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [requestedRun, setRequestedRun] = useState(initialRun);
  const [requestedRunScreen, setRequestedRunScreen] =
    useState(initialRunScreen);
  const [requestedAutomatic, setRequestedAutomatic] =
    useState(initialAutomatic);

  const navigate = useCallback(
    (next: ViewName) => {
      const target: ViewName = isAllowed(next, canWrite, isAdmin)
        ? next
        : "home";
      setView(target);
      // A screen link belongs to the screen that opened it: leaving it clears
      // the hash, so going back to a list never resurrects a stale detail. The
      // settings page is the exception — its section is part of its address.
      if (target === "settings") {
        replaceHash({ id: section, kind: "settings" });
      } else if (!screenViews.includes(target)) {
        replaceHash(undefined);
      }
      window.scrollTo({ behavior: "instant", top: 0 });
    },
    [canWrite, isAdmin, section]
  );

  /**
   * The one entry point that picks a settings page. The sidebar submenu uses it
   * directly; the home screen uses it to send an administrator to the GitHub
   * connection it just told them to make.
   */
  const openSection = useCallback(
    (next: SettingsSection) => {
      const allowed = isAllowed("settings", canWrite, isAdmin);
      setSection(next);
      setView(allowed ? "settings" : "home");
      if (allowed) {
        replaceHash({ id: next, kind: "settings" });
      }
      window.scrollTo({ behavior: "instant", top: 0 });
    },
    [canWrite, isAdmin]
  );

  const openScreen = useCallback((link: DeepLink, view: ViewName) => {
    replaceHash(link);
    setView(view);
    window.scrollTo({ behavior: "instant", top: 0 });
  }, []);

  const openRun = useCallback(
    (runId: string) => {
      setRequestedRun(runId);
      openScreen({ id: runId, kind: "legacy" }, "runs");
    },
    [openScreen]
  );

  const openRunScreen = useCallback(
    (runId: string) => {
      setRequestedRunScreen(runId);
      openScreen({ id: runId, kind: "run" }, "run");
    },
    [openScreen]
  );

  const openAutomatic = useCallback(
    (deliveryId: string) => {
      setRequestedAutomatic(deliveryId);
      openScreen({ id: deliveryId, kind: "automatic" }, "automatic");
    },
    [openScreen]
  );

  /** One-shot reads of a deep link; the caller keys its store on the value. */
  const consumeAutomatic = useCallback(() => {
    const current = requestedAutomatic;
    setRequestedAutomatic(undefined);
    return current;
  }, [requestedAutomatic]);

  const consumeRun = useCallback(() => {
    const current = requestedRun;
    setRequestedRun(undefined);
    return current;
  }, [requestedRun]);

  const consumeRunScreen = useCallback(() => {
    const current = requestedRunScreen;
    setRequestedRunScreen(undefined);
    return current;
  }, [requestedRunScreen]);

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
      requestedAutomatic,
      requestedRun,
      requestedRunScreen,
      section,
      // Derived rather than corrected by an effect: the role can change under
      // us (a session refresh), and a panel the current role may not read is
      // simply never the visible one.
      view: isAllowed(requestedView, canWrite, isAdmin)
        ? requestedView
        : "home",
    }),
    [
      consumeAutomatic,
      consumeRun,
      consumeRunScreen,
      isAdmin,
      canWrite,
      navigate,
      openAutomatic,
      openRun,
      openRunScreen,
      openSection,
      requestedAutomatic,
      requestedRun,
      requestedRunScreen,
      requestedView,
      section,
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
