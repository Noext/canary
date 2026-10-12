import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "@/api/client";
import type {
  GitHubStatus,
  ModelCatalog,
  Preflight,
  SetupStatus,
} from "@/api/contracts";
import { useSession } from "./session";

interface WorkspaceContextValue {
  github?: GitHubStatus;
  githubReady: boolean;
  loadGithub(): Promise<void>;
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
  const [modelsError, setModelsError] = useState<string>();
  const [model, setModel] = useState("");
  const [preflight, setPreflight] = useState<Preflight>();
  const [preflightBusy, setPreflightBusy] = useState(false);
  const pickedDefault = useState(() => ({ done: false }))[0];

  const loadStatus = useCallback(async () => {
    setStatus(await api("/dashboard/status"));
  }, []);

  const loadModels = useCallback(async () => {
    if (modelsBusy) {
      return;
    }
    setModelsBusy(true);
    try {
      const catalog = await api("/models");
      setModels(catalog);
      setModelsError(undefined);
      setModel((current) => {
        if (current && catalog.data.some((entry) => entry.id === current)) {
          return current;
        }
        // The configured default is only auto-selected when the provider really
        // exposes it: never guess a model on the user's behalf.
        const present = catalog.data.some(
          (entry) => entry.id === catalog.defaultModel
        );
        if (!pickedDefault.done && present) {
          pickedDefault.done = true;
          return catalog.defaultModel;
        }
        return current;
      });
    } catch (failure) {
      setModelsError(
        failure instanceof Error ? failure.message : String(failure)
      );
    } finally {
      setModelsBusy(false);
    }
  }, [modelsBusy, pickedDefault]);

  const loadGithub = useCallback(async () => {
    setGithub(await api("/github/app"));
  }, []);

  useEffect(() => {
    void loadStatus().catch(() => undefined);
  }, [loadStatus]);

  useEffect(() => {
    if (canWrite) {
      void loadModels().catch(() => undefined);
    }
  }, [canWrite, loadModels]);

  useEffect(() => {
    if (isAdmin) {
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
      setModel,
      model,
      loadGithub,
      loadModels,
      loadStatus,
      ...(github ? { github } : {}),
      ...(models ? { models } : {}),
      ...(preflight ? { preflight } : {}),
      ...(status ? { status } : {}),
    }),
    [
      github,
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
