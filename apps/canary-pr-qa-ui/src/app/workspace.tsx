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
import { api, errorText } from "@/api/client";
import type {
  GitHubStatus,
  ModelCatalog,
  Preflight,
  SetupStatus,
} from "@/api/contracts";
import { useSession } from "./session";

interface WorkspaceContextValue {
  github?: GitHubStatus;
  /** Set when the GitHub status request failed: the state is unknown, not empty. */
  githubError?: string;
  githubReady: boolean;
  loadGithub(): Promise<void>;
  /** Reloads the catalogue on demand (retry buttons); the initial load is automatic. */
  loadModels(): Promise<void>;
  loadStatus(): Promise<void>;
  model: string;
  modelReady: boolean;
  models?: ModelCatalog;
  modelsBusy: boolean;
  modelsError?: string;
  preflight?: Preflight;
  preflightBusy: boolean;
  setModel(value: string): void;
  setPreflight(value: Preflight | undefined): void;
  setPreflightBusy(value: boolean): void;
  status?: SetupStatus;
  /** Set when the setup status request failed, so the UI can retry it. */
  statusError?: string;
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(
  undefined
);

/**
 * Connections every screen depends on: setup status, the AI catalogue and the
 * selected model. Kept in one place so the home and "new test" screens never
 * disagree about readiness.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { canWrite, isAdmin } = useSession();
  const [status, setStatus] = useState<SetupStatus>();
  const [models, setModels] = useState<ModelCatalog>();
  const [github, setGithub] = useState<GitHubStatus>();
  const [modelsBusy, setModelsBusy] = useState(false);
  const [statusError, setStatusError] = useState<string>();
  const [githubError, setGithubError] = useState<string>();
  const inFlight = useRef(false);
  const loaded = useRef(false);
  const [modelsError, setModelsError] = useState<string>();
  const [model, setModel] = useState("");
  const [preflight, setPreflight] = useState<Preflight>();
  const [preflightBusy, setPreflightBusy] = useState(false);
  const modelRef = useRef("");
  const autoPicked = useRef(false);

  /** Mirrors the selected model so the loader can read it without stale state. */
  const chooseModel = useCallback((value: string) => {
    modelRef.current = value;
    setModel(value);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api("/dashboard/status"));
      setStatusError(undefined);
    } catch (failure) {
      // Swallowing this would leave `githubReady` false and the New Test screen
      // silently refusing to launch, with no error and no way to retry.
      setStatusError(errorText(failure));
    }
  }, []);

  const fetchModels = useCallback(
    async (force: boolean) => {
      // Guards live in refs: keying them on `modelsBusy` would rebuild this
      // callback on every toggle, retrigger the effect below and refetch the
      // catalogue in a loop. `loaded` also makes the initial load idempotent
      // under StrictMode's double-invoked effects.
      if (inFlight.current || (loaded.current && !force)) {
        return;
      }
      inFlight.current = true;
      setModelsBusy(true);
      try {
        const catalog = await api("/models");
        setModels(catalog);
        setModelsError(undefined);
        loaded.current = true;
        const known = catalog.data.some(
          (entry) => entry.id === modelRef.current
        );
        if (!known) {
          // A model the provider no longer offers must not stay selected: it
          // would keep `modelReady` true while the select has no such option.
          chooseModel("");
          autoPicked.current = false;
        }
        const exposesDefault = catalog.data.some(
          (entry) => entry.id === catalog.defaultModel
        );
        // The configured default is only auto-selected when the provider really
        // exposes it: never guess a model on the user's behalf.
        if (!(modelRef.current || autoPicked.current) && exposesDefault) {
          autoPicked.current = true;
          chooseModel(catalog.defaultModel);
        }
      } catch (failure) {
        setModelsError(
          failure instanceof Error ? failure.message : String(failure)
        );
        loaded.current = false;
      } finally {
        inFlight.current = false;
        setModelsBusy(false);
      }
    },
    [chooseModel]
  );

  const loadModels = useCallback(() => fetchModels(true), [fetchModels]);

  const loadGithub = useCallback(async () => {
    try {
      setGithub(await api("/github/app"));
      setGithubError(undefined);
    } catch (failure) {
      // Without this, an admin whose request failed is shown "À connecter" and
      // the creation form, as if no App existed. The rejection is also
      // propagated: a mutation whose reload failed must not report success on
      // the strength of the cached status.
      setGithubError(errorText(failure));
      throw failure;
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (canWrite) {
      void fetchModels(false);
    }
  }, [canWrite, fetchModels]);

  useEffect(() => {
    if (isAdmin) {
      // The failure is carried by `githubError`, not by an unhandled rejection.
      void loadGithub().catch(() => undefined);
    }
  }, [isAdmin, loadGithub]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      githubReady:
        status !== undefined &&
        status.github.mode !== "missing" &&
        status.github.repositories.length > 0,
      modelReady: Boolean(model),
      modelsBusy,
      modelsError,
      preflightBusy,
      setPreflight,
      setPreflightBusy,
      setModel: chooseModel,
      model,
      loadGithub,
      loadModels,
      loadStatus,
      ...(github ? { github } : {}),
      ...(githubError ? { githubError } : {}),
      ...(models ? { models } : {}),
      ...(preflight ? { preflight } : {}),
      ...(status ? { status } : {}),
      ...(statusError ? { statusError } : {}),
    }),
    [
      chooseModel,
      github,
      githubError,
      loadGithub,
      loadModels,
      loadStatus,
      model,
      models,
      modelsBusy,
      modelsError,
      preflight,
      preflightBusy,
      status,
      statusError,
    ]
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider");
  }
  return value;
}
