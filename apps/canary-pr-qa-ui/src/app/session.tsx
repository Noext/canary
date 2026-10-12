import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { api, post, SESSION_EXPIRED_EVENT } from "@/api/client";
import type { Principal } from "@/api/contracts";
import { okSchema } from "@/api/schemas";
import { auth } from "@/i18n";
import { createStore, type Store, useStore } from "@/lib/store";

export type SessionPhase = "anonymous" | "authenticated" | "loading";

interface SessionState {
  initialized: boolean;
  phase: SessionPhase;
  user?: Principal;
}

interface SessionContextValue {
  canWrite: boolean;
  createAdmin(username: string, password: string): Promise<void>;
  initialized: boolean;
  isAdmin: boolean;
  login(username: string, password: string): Promise<void>;
  loginWithToken(token: string): Promise<void>;
  logout(): Promise<void>;
  phase: SessionPhase;
  refreshUser(): Promise<void>;
  setupCode?: string;
  user?: Principal;
}

const SessionContext = createContext<SessionContextValue | undefined>(
  undefined
);

async function loadStatus(store: Store<SessionState>) {
  try {
    const status = await api("/auth/status");
    store.set((current) => ({ ...current, initialized: status.initialized }));
  } catch {
    // A failed status probe must not block the login screen.
    store.set((current) => ({ ...current, initialized: true }));
  }
}

async function loadUser(store: Store<SessionState>) {
  try {
    const principal = await api("/me");
    store.set(() => ({
      initialized: true,
      phase: "authenticated",
      user: principal,
    }));
  } catch {
    store.set((current) => ({ ...current, phase: "anonymous" }));
  }
}

function createSessionStore(setupCode: string | undefined) {
  return createStore<SessionState>(
    { initialized: false, phase: "loading" },
    (store) => {
      // The subscription that React performs on mount is what starts the probe.
      void loadStatus(store);
      if (setupCode) {
        // A setup link always wins: never silently resume an existing session.
        store.set((current) => ({ ...current, phase: "anonymous" }));
      } else {
        void loadUser(store);
      }
      document.addEventListener(SESSION_EXPIRED_EVENT, () => {
        store.set((current) => ({
          ...current,
          phase: "anonymous",
          user: undefined,
        }));
        void loadStatus(store);
      });
    }
  );
}

export function SessionProvider({
  children,
  setupCode,
}: {
  children: ReactNode;
  setupCode?: string;
}) {
  const [store] = useState(() => createSessionStore(setupCode));
  const state = useStore(store);

  const authenticate = useCallback(
    async (path: "/auth/login" | "/auth/setup", body: unknown) => {
      const principal = await api(path, post(body));
      store.set(() => ({
        initialized: true,
        phase: "authenticated",
        user: principal,
      }));
      void loadStatus(store);
    },
    [store]
  );

  const login = useCallback(
    (username: string, password: string) =>
      authenticate("/auth/login", { password, username }),
    [authenticate]
  );

  const createAdmin = useCallback(
    (username: string, password: string) =>
      authenticate("/auth/setup", { password, setupCode, username }),
    [authenticate, setupCode]
  );

  const loginWithToken = useCallback(
    async (token: string) => {
      const principal = await api("/session", {
        headers: { Authorization: `Bearer ${token}` },
        method: "POST",
      });
      store.set(() => ({
        initialized: true,
        phase: "authenticated",
        user: principal,
      }));
      void loadStatus(store);
    },
    [store]
  );

  const refreshUser = useCallback(() => loadUser(store), [store]);

  const logout = useCallback(async () => {
    // DELETE /session answers {ok:true}, not a principal: without the explicit
    // schema every logout looked like a contract error and was swallowed, so a
    // real server-side failure left the cookie valid while the UI reloaded.
    await api("/session", { method: "DELETE", schema: okSchema });
    window.location.reload();
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      canWrite: state.user ? state.user.role !== "viewer" : false,
      createAdmin,
      initialized: state.initialized,
      isAdmin: state.user?.role === "admin",
      login,
      loginWithToken,
      logout,
      phase: state.phase,
      refreshUser,
      ...(setupCode ? { setupCode } : {}),
      ...(state.user ? { user: state.user } : {}),
    }),
    [createAdmin, login, loginWithToken, logout, refreshUser, setupCode, state]
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used inside SessionProvider");
  }
  return value;
}

export const authCopy = auth;
