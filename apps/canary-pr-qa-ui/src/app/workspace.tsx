import { createContext, type ReactNode, useContext, useMemo } from "react";
import { api, errorText } from "@/api/client";
import type {
  GitHubStatus,
  ModelCatalog,
  Preflight,
  SetupStatus,
} from "@/api/contracts";
import { createStore, type Store, useStore } from "@/lib/store";
import { useSession } from "./session";

interface WorkspaceState {
  github?: GitHubStatus;
  /** Set when the GitHub status request failed: the state is unknown, not empty. */
  githubError?: string;
  model: string;
  models?: ModelCatalog;
  modelsBusy: boolean;
  modelsError?: string;
  preflight?: Preflight;
  preflightBusy: boolean;
  status?: SetupStatus;
  /** Set when the setup status request failed, so the UI can retry it. */
  statusError?: string;
}

interface WorkspaceContextValue {
  github?: GitHubStatus;
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
function createWorkspaceStore(roles: { canWrite: boolean; isAdmin: boolean }) {
  const flags: CatalogFlags = { autoPicked: false, loaded: false };
  const store = createStore<WorkspaceState>(
    { model: "", modelsBusy: false, preflightBusy: false },
    (self) => {
      // The mount subscription starts the initial loading; retries are actions.
      void loadStatus(self);
      if (roles.canWrite) {
        void fetchModels(self, flags, false);
      }
      if (roles.isAdmin) {
        void loadGithub(self).catch(() => undefined);
      }
    }
  );
  return { flags, store };
}

async function loadStatus(store: Store<WorkspaceState>) {
  try {
    const status = await api("/dashboard/status");
    store.set((current) => ({ ...current, status, statusError: undefined }));
  } catch (failure) {
    // Swallowing this would leave `githubReady` false and the New Test screen
    // silently refusing to launch, with no error and no way to retry.
    store.set((current) => ({ ...current, statusError: errorText(failure) }));
  }
}

async function loadGithub(store: Store<WorkspaceState>) {
  try {
    const github = await api("/github/app");
    store.set((current) => ({ ...current, github, githubError: undefined }));
  } catch (failure) {
    // Without this, an admin whose request failed is shown "À connecter" and
    // the creation form, as if no App existed. The rejection is also
    // propagated: a mutation whose reload failed must not report success on
    // the strength of the cached status.
    store.set((current) => ({ ...current, githubError: errorText(failure) }));
    throw failure;
  }
}

interface CatalogFlags {
  autoPicked: boolean;
  loaded: boolean;
}

async function fetchModels(
  store: Store<WorkspaceState>,
  flags: CatalogFlags,
  force: boolean
) {
  // Guards live outside React state: keying them on `modelsBusy` would refetch
  // the catalogue in a loop, and `loaded` makes the initial load idempotent.
  if (store.getSnapshot().modelsBusy || (flags.loaded && !force)) {
    return;
  }
  store.set((current) => ({ ...current, modelsBusy: true }));
  try {
    const catalog = await api("/models");
    store.set((current) => {
      const known = catalog.data.some((entry) => entry.id === current.model);
      const exposesDefault = catalog.data.some(
        (entry) => entry.id === catalog.defaultModel
      );
      let model = current.model;
      if (!known) {
        // A model the provider no longer offers must not stay selected: it
        // would keep `modelReady` true while the select has no such option.
        model = "";
        flags.autoPicked = false;
      }
      // The configured default is only auto-selected when the provider really
      // exposes it: never guess a model on the user's behalf.
      if (!(model || flags.autoPicked) && exposesDefault) {
        flags.autoPicked = true;
        model = catalog.defaultModel;
      }
      return {
        ...current,
        model,
        models: catalog,
        modelsBusy: false,
        modelsError: undefined,
      };
    });
    flags.loaded = true;
  } catch (failure) {
    flags.loaded = false;
    store.set((current) => ({
      ...current,
      modelsBusy: false,
      modelsError: errorText(failure),
    }));
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { canWrite, isAdmin } = useSession();
  // The store is keyed by the roles it captures: the provider can mount before
  // the session resolves (and a role can change), so a store built for the
  // wrong roles must never win. A new store simply starts its loads again on
  // the next subscription — the alternative is an effect reacting to a role.
  const workspace = useMemo(
    () => createWorkspaceStore({ canWrite, isAdmin }),
    [canWrite, isAdmin]
  );
  const { flags, store } = workspace;
  const state = useStore(store);

  const actions = useMemo(
    () => ({
      loadGithub: () => loadGithub(store),
      loadModels: () => fetchModels(store, flags, true),
      loadStatus: () => loadStatus(store),
      setModel: (value: string) =>
        store.set((current) => ({ ...current, model: value })),
      setPreflight: (value: Preflight | undefined) =>
        store.set((current) => ({ ...current, preflight: value })),
      setPreflightBusy: (value: boolean) =>
        store.set((current) => ({ ...current, preflightBusy: value })),
    }),
    [flags, store]
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      githubReady:
        state.status !== undefined &&
        state.status.github.mode !== "missing" &&
        state.status.github.repositories.length > 0,
      modelReady: Boolean(state.model),
      ...actions,
      ...(state.github ? { github: state.github } : {}),
      ...(state.githubError ? { githubError: state.githubError } : {}),
      ...(state.models ? { models: state.models } : {}),
      ...(state.modelsError ? { modelsError: state.modelsError } : {}),
      ...(state.preflight ? { preflight: state.preflight } : {}),
      ...(state.status ? { status: state.status } : {}),
      ...(state.statusError ? { statusError: state.statusError } : {}),
      model: state.model,
      modelsBusy: state.modelsBusy,
      preflightBusy: state.preflightBusy,
    }),
    [actions, state]
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
