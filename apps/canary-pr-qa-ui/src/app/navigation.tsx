import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { ViewName } from "@/i18n";
import { replaceHash } from "./routing";
import { useSession } from "./session";

interface NavigationContextValue {
  consumeRun(): string | undefined;
  navigate(view: ViewName): void;
  openRun(runId: string): void;
  requestedRun?: string;
  view: ViewName;
}

const NavigationContext = createContext<NavigationContextValue | undefined>(
  undefined
);

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
 * single place that knows which view is visible and which run was deep-linked.
 */
export function NavigationProvider({
  children,
  initialRun,
  initialView = "home",
}: {
  children: ReactNode;
  initialRun?: string;
  initialView?: ViewName;
}) {
  const { canWrite, isAdmin } = useSession();
  const [requestedView, setView] = useState<ViewName>(initialView);
  const [requestedRun, setRequestedRun] = useState(initialRun);

  const navigate = useCallback(
    (next: ViewName) => {
      const target: ViewName = isAllowed(next, canWrite, isAdmin)
        ? next
        : "home";
      setView(target);
      if (target !== "runs") {
        replaceHash(undefined);
      }
      window.scrollTo({ behavior: "instant", top: 0 });
    },
    [canWrite, isAdmin]
  );

  const openRun = useCallback((runId: string) => {
    replaceHash(runId);
    setRequestedRun(runId);
    setView("runs");
  }, []);

  const consumeRun = useCallback(() => {
    const current = requestedRun;
    setRequestedRun(undefined);
    return current;
  }, [requestedRun]);

  const value = useMemo<NavigationContextValue>(
    () => ({
      consumeRun,
      navigate,
      openRun,
      requestedRun,
      // Derived rather than corrected by an effect: the role can change under
      // us (a session refresh), and a panel the current role may not read is
      // simply never the visible one.
      view: isAllowed(requestedView, canWrite, isAdmin)
        ? requestedView
        : "home",
    }),
    [
      consumeRun,
      isAdmin,
      canWrite,
      navigate,
      openRun,
      requestedRun,
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
