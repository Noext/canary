import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, post, SESSION_EXPIRED_EVENT } from "@/api/client";
import type { Principal } from "@/api/contracts";
import { okSchema } from "@/api/schemas";
import { auth } from "@/i18n";

export type SessionPhase = "anonymous" | "authenticated" | "loading";

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

export function SessionProvider({
  children,
  setupCode,
}: {
  children: ReactNode;
  setupCode?: string;
}) {
  const [user, setUser] = useState<Principal>();
  const [phase, setPhase] = useState<SessionPhase>("loading");
  const [initialized, setInitialized] = useState(false);
  const signingIn = useRef(false);

  const loadStatus = useCallback(async () => {
    try {
      const status = await api("/auth/status");
      setInitialized(status.initialized);
    } catch {
      setInitialized(true);
    }
  }, []);

  const refreshUser = useCallback(async () => {
    const principal = await api("/me");
    setUser(principal);
    setPhase("authenticated");
  }, []);

  useEffect(() => {
    let active = true;
    void loadStatus();
    if (setupCode) {
      // A setup link always wins: never silently resume an existing session.
      setPhase("anonymous");
    } else {
      void refreshUser().catch(() => {
        if (active) {
          setPhase("anonymous");
        }
      });
    }
    return () => {
      active = false;
    };
  }, [loadStatus, refreshUser, setupCode]);

  useEffect(() => {
    const expire = () => {
      setUser(undefined);
      setPhase("anonymous");
      void loadStatus();
    };
    document.addEventListener(SESSION_EXPIRED_EVENT, expire);
    return () => document.removeEventListener(SESSION_EXPIRED_EVENT, expire);
  }, [loadStatus]);

  const authenticate = useCallback(
    async (path: "/auth/login" | "/auth/setup", body: unknown) => {
      signingIn.current = true;
      try {
        const principal = await api(path, post(body));
        setUser(principal);
        setPhase("authenticated");
        void loadStatus();
      } finally {
        signingIn.current = false;
      }
    },
    [loadStatus]
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
      setUser(principal);
      setPhase("authenticated");
      void loadStatus();
    },
    [loadStatus]
  );

  const logout = useCallback(async () => {
    // DELETE /session answers {ok:true}, not a principal: without the explicit
    // schema every logout looked like a contract error and was swallowed, so a
    // real server-side failure left the cookie valid while the UI reloaded.
    await api("/session", { method: "DELETE", schema: okSchema });
    window.location.reload();
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      canWrite: user ? user.role !== "viewer" : false,
      createAdmin,
      initialized,
      isAdmin: user?.role === "admin",
      login,
      loginWithToken,
      logout,
      phase,
      refreshUser,
      ...(setupCode ? { setupCode } : {}),
      ...(user ? { user } : {}),
    }),
    [
      createAdmin,
      initialized,
      login,
      loginWithToken,
      logout,
      phase,
      refreshUser,
      setupCode,
      user,
    ]
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
