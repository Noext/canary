import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { ViewName } from "@/i18n";
import { type DeepLink, replaceHash } from "./routing";
import { useSession } from "./session";

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
  /** Deep-linked automatic attempt not consumed yet. */
  requestedAutomatic?: string;
  requestedRun?: string;
  /** Deep-linked run screen not consumed yet; distinct from the history pick. */
  requestedRunScreen?: string;
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
  initialView = "home",
}: {
  children: ReactNode;
  initialAutomatic?: string;
  initialRun?: string;
  initialRunScreen?: string;
  initialView?: ViewName;
}) {
  const { canWrite, isAdmin } = useSession();
  const [requestedView, setView] = useState<ViewName>(initialView);
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
      // the hash, so going back to a list never resurrects a stale detail.
      if (!screenViews.includes(target)) {
        replaceHash(undefined);
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
      requestedAutomatic,
      requestedRun,
      requestedRunScreen,
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
      requestedAutomatic,
      requestedRun,
      requestedRunScreen,
      requestedView,
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
