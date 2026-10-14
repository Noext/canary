import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardError } from "@/api/client";
import type {
  GitHubStatus,
  ModelCatalog,
  Principal,
  SetupStatus,
} from "@/api/contracts";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { SessionProvider } from "@/app/session";
import { WorkspaceProvider } from "@/app/workspace";
import { common, type SettingsSection, settings } from "@/i18n";
import { AccountsSettings } from "./accounts";
import { AiSettings } from "./ai-settings";
import { ApiKeysSettings } from "./api-keys-settings";
import { GithubSettings } from "./github-settings";
import { PreviewSettings } from "./preview-settings";
import { SettingsView } from "./settings-view";

interface ApiCall {
  body?: unknown;
  method: string;
  path: string;
}

const { apiMock } = vi.hoisted(() => ({
  apiMock:
    vi.fn<
      (
        path: string,
        options?: { body?: unknown; method?: string }
      ) => Promise<unknown>
    >(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: apiMock };
});

const MANIFEST = {
  action: "https://github.com/settings/apps/new",
  manifest: { name: "Canary-Test", redirect_url: "https://qa.example.com" },
};

const admin: Principal = {
  id: "user-1",
  repos: ["fixture/app", "fixture/private"],
  role: "admin",
  username: "ui-admin",
};

function emptyGithub(): GitHubStatus {
  return {
    app: null,
    lastDelivery: null,
    legacyConfigured: false,
    repositories: [],
    restriction: [],
  };
}

function connectedGithub(): GitHubStatus {
  return {
    app: {
      id: "95001",
      origin: "https://qa.example.com",
      slug: "canary-fixture-app",
    },
    lastDelivery: null,
    legacyConfigured: false,
    repositories: [
      {
        account: "fixture",
        auto_run: true,
        enabled: true,
        full_name: "fixture/app",
        installation_id: "1",
        private: false,
      },
    ],
    restriction: [],
  };
}

function deleteAppOf(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("deleteApp" in body)) {
    return false;
  }
  return body.deleteApp === true;
}

function repositoriesOf(body: unknown): string[] {
  if (typeof body !== "object" || body === null || !("repositories" in body)) {
    return [];
  }
  const value = body.repositories;
  return Array.isArray(value) ? value.map(String) : [];
}

/** `undefined` keeps the stored opt-ins, exactly like the server does. */
function autoReposOf(body: unknown): string[] | undefined {
  if (typeof body !== "object" || body === null || !("autoRepos" in body)) {
    return;
  }
  const value = body.autoRepos;
  return Array.isArray(value) ? value.map(String) : undefined;
}

function hostsOf(body: unknown, fallback: string[]): string[] {
  if (typeof body !== "object" || body === null || !("hosts" in body)) {
    return fallback;
  }
  const value = body.hosts;
  return Array.isArray(value)
    ? value.map((host) => String(host).toLowerCase())
    : fallback;
}

function byId(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[id="${id}"]`);
  if (!element) {
    throw new Error(`Missing control #${id}`);
  }
  return element;
}

let calls: ApiCall[] = [];
let github: GitHubStatus;
let setup: SetupStatus;
let models: ModelCatalog;
let modelsFailure: DashboardError | undefined;
let githubFailure: DashboardError | undefined;
let hostsFailure: DashboardError | undefined;
let manifestFailure: DashboardError | undefined;
let refreshFailure: DashboardError | undefined;
let removalWarnings: string[] = [];

beforeEach(() => {
  calls = [];
  github = emptyGithub();
  models = { data: [], defaultModel: "" };
  modelsFailure = undefined;
  githubFailure = undefined;
  hostsFailure = undefined;
  manifestFailure = undefined;
  refreshFailure = undefined;
  removalWarnings = [];
  setup = {
    ai: {
      defaultModel: "opencode-go/deepseek-v4.1-flash",
      endpoint: "ai.noext.fr",
    },
    github: {
      autoRepos: ["fixture/app"],
      mode: "app",
      repositories: ["fixture/app"],
    },
    preview: {
      automatic: false,
      hosts: ["preview.example.com"],
      hostsDefault: ["preview.example.com"],
      shaHeader: "x-commit-sha",
    },
  };

  apiMock.mockReset();
  apiMock.mockImplementation(async (path, options) => {
    const call: ApiCall = { method: options?.method ?? "GET", path };
    if (options?.body !== undefined) {
      call.body = options.body;
    }
    calls.push(call);

    switch (path) {
      case "/accounts":
        return {
          accounts: [
            {
              createdAt: "2026-01-01T00:00:00.000Z",
              id: "11111111-1111-1111-1111-111111111111",
              repos: ["fixture/app"],
              role: "admin",
              username: "ui-admin",
            },
          ],
        };
      case "/auth/status":
        return { initialized: true };
      case "/me":
        return admin;
      case "/dashboard/api-keys":
        return [];
      case "/dashboard/status":
        return setup;
      case "/models":
        if (modelsFailure) {
          throw modelsFailure;
        }
        return models;
      case "/github/app": {
        if (githubFailure) {
          throw githubFailure;
        }
        if (options?.method === "DELETE") {
          const deleteApp = deleteAppOf(options.body);
          github = emptyGithub();
          return {
            ...github,
            disconnected: {
              appDeleted: deleteApp,
              deleteApp,
              uninstalled: [],
              warnings: removalWarnings,
            },
          };
        }
        return github;
      }
      case "/github/app/install":
        return {
          url: "https://github.com/apps/canary-fixture-app/installations/new",
        };
      case "/github/app/manifest":
        if (manifestFailure) {
          throw manifestFailure;
        }
        return MANIFEST;
      case "/github/app/refresh":
        if (refreshFailure) {
          const failure = refreshFailure;
          refreshFailure = undefined;
          throw failure;
        }
        return github;
      case "/github/app/repositories": {
        const selected = repositoriesOf(options?.body);
        const autoRepos = autoReposOf(options?.body);
        github = {
          ...github,
          repositories: github.repositories.map((repository) => ({
            ...repository,
            auto_run:
              autoRepos === undefined
                ? repository.auto_run
                : autoRepos.includes(repository.full_name),
            enabled: selected.includes(repository.full_name),
          })),
        };
        return github;
      }
      case "/dashboard/preview-hosts": {
        if (hostsFailure) {
          throw hostsFailure;
        }
        const preview = setup.preview;
        const hostsDefault = preview.hostsDefault ?? [];
        setup = {
          ...setup,
          preview: {
            ...preview,
            hosts:
              options?.method === "DELETE"
                ? hostsDefault
                : hostsOf(options?.body, preview.hosts ?? []),
          },
        };
        return {
          hosts: setup.preview.hosts ?? [],
          hostsDefault,
          shaHeader: setup.preview.shaHeader ?? null,
          shaPath: setup.preview.shaPath ?? null,
        };
      }
      default:
        throw new Error(`Unexpected API path ${path}`);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function providers(children: ReactNode): ReactNode {
  return (
    <ErrorProvider>
      <ErrorAlert />
      <SessionProvider>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </SessionProvider>
    </ErrorProvider>
  );
}

/**
 * One settings page, as the shell renders it. The Chromium e2e walks the same
 * submenu; this is the counterpart that asserts a page never carries another
 * page's controls.
 */
function renderSection(section: SettingsSection): ReturnType<typeof render> {
  return render(providers(<SettingsView section={section} />));
}

/**
 * Every settings panel in one container. The assertions below address every
 * control by its id, exactly like the browser tests do, whichever page now
 * carries it.
 */
function renderSettings(): ReturnType<typeof render> {
  return render(
    providers(
      <section data-panel="settings" id="settingsPanel">
        <GithubSettings />
        <AiSettings />
        <PreviewSettings />
        <ApiKeysSettings />
        <AccountsSettings />
      </section>
    )
  );
}

const FIRST_RUN_MESSAGE =
  "Première étape : créez votre App. Vous reviendrez ici après confirmation sur GitHub.";

/** Every control the legacy dashboard exposes on this screen, and the e2e hooks. */
const CONTROL_IDS = [
  "accountsCreate",
  "accountsCreateSubmit",
  "accountsList",
  "accountsNewPassword",
  "accountsNewRole",
  "accountsSettings",
  "accountsUsername",
  "githubSettings",
  "githubConnection",
  "githubMessage",
  "githubNotice",
  "githubError",
  "githubCreate",
  "githubName",
  "githubOrg",
  "githubCreateButton",
  "githubAppActions",
  "githubAppName",
  "githubInstall",
  "githubRefresh",
  "githubRepos",
  "githubRepoSearch",
  "githubRepoCount",
  "githubRepoList",
  "githubSave",
  "githubDanger",
  "githubUninstall",
  "githubDeleteApp",
  "githubConfirm",
  "githubConfirmText",
  "githubConfirmRun",
  "githubConfirmCancel",
  "githubOriginHint",
  "apiKeysSettings",
  "apiKeyScope",
  "apiKeyName",
  "apiKeyCreate",
  "apiKeyTokenBlock",
  "apiKeyToken",
  "apiKeyTokenCopy",
  "apiKeyTokenReceipt",
  "apiKeyTokenWarning",
  "apiKeyListTitle",
  "apiKeyEmpty",
  "apiKeyList",
  "apiKeyNotice",
  "apiKeyError",
  "aiConnection",
  "aiEndpoint",
  "aiDefault",
  "aiCatalog",
  "retryModels",
  "previewMode",
  "previewHosts",
  "previewProof",
  "previewHostEditor",
  "previewHostsDefault",
  "previewHostList",
  "previewHostInput",
  "previewHostAdd",
  "previewHostSave",
  "previewHostReset",
] as const;

describe("SettingsView", () => {
  const pages: [SettingsSection, string][] = [
    ["github", "githubSettings"],
    ["ai", "aiSettings"],
    ["preview", "previewSettings"],
    ["apiKeys", "apiKeysSettings"],
    ["accounts", "accountsSettings"],
  ];

  it("renders one settings page at a time", () => {
    for (const [section, root] of pages) {
      const { container, unmount } = renderSection(section);
      expect(byId(container, root)).toBeInTheDocument();
      for (const [other, rootId] of pages) {
        if (other !== section) {
          expect(container.querySelector(`[id="${rootId}"]`)).toBeNull();
        }
      }
      expect(container.querySelector("#settingsPanel")).toHaveAttribute(
        "data-section",
        section
      );
      unmount();
    }
  });

  it("offers a retry instead of the creation form when the GitHub status fails", async () => {
    githubFailure = new DashboardError("Contrat GitHub indisponible.");
    const container = renderSettings().container;
    // The connection is unknown, not absent: no "À connecter" invitation here.
    await waitFor(() =>
      expect(byId(container, "githubPending")).toHaveTextContent(
        "Contrat GitHub indisponible."
      )
    );
    expect(byId(container, "githubCreate")).not.toBeVisible();
    expect(byId(container, "githubAppActions")).not.toBeVisible();
    expect(byId(container, "githubConnection")).toHaveTextContent(
      common.checking
    );

    githubFailure = undefined;
    await userEvent.click(
      within(byId(container, "githubPending")).getByRole("button", {
        name: common.retry,
      })
    );
    await waitFor(() =>
      expect(document.getElementById("githubPending")).toBeNull()
    );
    // The real state replaces the "Vérification…" placeholder once the retry
    // succeeds (this fixture has no App yet).
    expect(byId(container, "githubConnection")).toHaveTextContent(
      settings.github.notConnected
    );
  });

  it("renders every control the GitHub, AI, preview and accounts cards promise", async () => {
    const { container } = renderSettings();

    await screen.findByText(FIRST_RUN_MESSAGE);
    for (const id of CONTROL_IDS) {
      expect(byId(container, id)).toBeInTheDocument();
    }
  });
  it("shows the creation form and the trail while no app is configured", async () => {
    const { container } = renderSettings();

    expect(await screen.findByText(FIRST_RUN_MESSAGE)).toBeInTheDocument();
    expect(byId(container, "githubSettings")).toBeInTheDocument();
    expect(byId(container, "githubConnection")).toHaveTextContent(
      "À connecter"
    );
    expect(byId(container, "githubSettings")).toHaveTextContent(
      "1. Créer l'App"
    );
    expect(byId(container, "githubSettings")).toHaveTextContent(
      "3. Choisir les dépôts"
    );
    expect(byId(container, "githubCreate")).not.toHaveAttribute("hidden");
    expect(byId(container, "githubAppActions")).toHaveAttribute("hidden");
    expect(byId(container, "githubConfirm")).toHaveAttribute("hidden");
    expect(byId(container, "githubOriginHint")).toHaveTextContent(
      "domaine HTTPS public"
    );

    const name = screen.getByLabelText<HTMLInputElement>(
      "Nom de votre App GitHub"
    );
    expect(name).toHaveAttribute("id", "githubName");
    expect(name.value).toMatch(/^Canary-QA-[0-9a-z]+$/);
    expect(
      screen.getByLabelText<HTMLInputElement>(
        "Organisation GitHub (facultatif)"
      )
    ).toHaveAttribute("id", "githubOrg");
    expect(
      screen.getByRole("button", { name: "Créer mon App sur GitHub →" })
    ).toBeEnabled();
  });

  it("lists repositories, keeps the server-restricted one disabled and saves the selection", async () => {
    github = {
      app: {
        id: "95001",
        origin: "https://qa.example.com",
        slug: "canary-fixture-app",
      },
      lastDelivery: null,
      legacyConfigured: false,
      repositories: [
        {
          account: "fixture",
          auto_run: true,
          enabled: false,
          full_name: "fixture/app",
          installation_id: "1",
          private: false,
        },
        {
          account: "fixture",
          auto_run: true,
          enabled: true,
          full_name: "fixture/private",
          installation_id: "1",
          private: true,
        },
      ],
      restriction: ["fixture/app"],
    };
    const user = userEvent.setup();
    const { container } = renderSettings();

    expect(await screen.findByText("À terminer")).toBeInTheDocument();
    expect(byId(container, "githubCreate")).toHaveAttribute("hidden");
    expect(byId(container, "githubAppActions")).not.toHaveAttribute("hidden");
    expect(byId(container, "githubAppName")).toHaveTextContent(
      "canary-fixture-app · App #95001"
    );

    const list = byId(container, "githubRepoList");
    expect(list).toHaveTextContent("fixture/app");
    expect(list).toHaveTextContent(
      "fixture/private · restreint par le serveur"
    );
    expect(list).toHaveTextContent("Privé");
    expect(list).toHaveTextContent("Public");
    expect(byId(container, "repo-fixture-app")).not.toBeDisabled();
    expect(byId(container, "repo-fixture-private")).toBeDisabled();
    expect(byId(container, "repo-fixture-private")).toBeChecked();
    expect(byId(container, "repo-auto-fixture-app")).toBeEnabled();
    expect(byId(container, "repo-auto-fixture-app")).toBeChecked();
    expect(byId(container, "repo-auto-fixture-private")).toBeDisabled();
    expect(list).toHaveTextContent(
      "Lancer automatiquement une QA à chaque pull request"
    );
    // The Chromium e2e picks the selection checkbox by `value`: the automatic
    // run toggle must not answer the same selector.
    expect(list.querySelectorAll('input[value="fixture/app"]')).toHaveLength(1);

    await user.click(byId(container, "repo-fixture-app"));
    await user.click(byId(container, "githubSave"));

    await waitFor(() =>
      expect(byId(container, "githubMessage")).toHaveTextContent(
        "Dépôts enregistrés. Vous pouvez maintenant préparer votre premier test."
      )
    );
    expect(calls).toContainEqual({
      body: { autoRepos: ["fixture/app"], repositories: ["fixture/app"] },
      method: "PUT",
      path: "/github/app/repositories",
    });
    await waitFor(() =>
      expect(byId(container, "githubConnection")).toHaveTextContent(
        "Connecté · 1 dépôt(s)"
      )
    );
    expect(byId(container, "repo-fixture-app")).toBeChecked();
  });

  it("narrows the repository list from the search field", async () => {
    github = {
      app: {
        id: "95001",
        origin: "https://qa.example.com",
        slug: "canary-fixture-app",
      },
      lastDelivery: null,
      legacyConfigured: false,
      repositories: ["api", "scanner", "supabase"].map((name) => ({
        account: "pharmacia",
        auto_run: false,
        enabled: false,
        full_name: `pharmacia/${name}`,
        installation_id: "1",
        private: true,
      })),
      restriction: [],
    };
    const user = userEvent.setup();
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "githubRepoList")).toHaveTextContent(
        "pharmacia/api"
      )
    );
    expect(byId(container, "githubRepoCount")).toHaveTextContent(
      "3 dépôt(s) affiché(s) sur 3"
    );

    await user.type(screen.getByLabelText(settings.github.searchLabel), "scan");

    expect(byId(container, "githubRepoList")).toHaveTextContent(
      "pharmacia/scanner"
    );
    expect(byId(container, "githubRepoList")).not.toHaveTextContent(
      "pharmacia/api"
    );
    expect(byId(container, "githubRepoCount")).toHaveTextContent(
      "1 dépôt(s) affiché(s) sur 3"
    );

    await user.clear(screen.getByLabelText(settings.github.searchLabel));
    await user.type(
      screen.getByLabelText(settings.github.searchLabel),
      "absent"
    );

    expect(byId(container, "githubRepoList")).toHaveTextContent(
      "Aucun dépôt ne correspond à « absent »"
    );
  });

  it("saves a selection that the search hides", async () => {
    github = {
      app: {
        id: "95001",
        origin: "https://qa.example.com",
        slug: "canary-fixture-app",
      },
      lastDelivery: null,
      legacyConfigured: false,
      repositories: ["api", "scanner"].map((name) => ({
        account: "pharmacia",
        auto_run: false,
        enabled: true,
        full_name: `pharmacia/${name}`,
        installation_id: "1",
        private: true,
      })),
      restriction: [],
    };
    const user = userEvent.setup();
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "githubRepoList")).toHaveTextContent(
        "pharmacia/scanner"
      )
    );
    await user.type(screen.getByLabelText(settings.github.searchLabel), "scan");
    await user.click(byId(container, "githubSave"));

    await waitFor(() =>
      expect(byId(container, "githubMessage")).toHaveTextContent(
        "Dépôts enregistrés"
      )
    );
    // The filter is a view concern: the request still carries every
    // repository the status reports, including the one it hides.
    expect(calls).toContainEqual({
      body: {
        autoRepos: [],
        repositories: ["pharmacia/api", "pharmacia/scanner"],
      },
      method: "PUT",
      path: "/github/app/repositories",
    });
  });

  it("sends the automatic-run opt-ins with the repository selection", async () => {
    github = {
      app: {
        id: "95001",
        origin: "https://qa.example.com",
        slug: "canary-fixture-app",
      },
      lastDelivery: null,
      legacyConfigured: false,
      repositories: [
        {
          account: "fixture",
          auto_run: true,
          enabled: true,
          full_name: "fixture/app",
          installation_id: "1",
          private: false,
        },
        {
          account: "fixture",
          auto_run: false,
          enabled: false,
          full_name: "fixture/other",
          installation_id: "1",
          private: false,
        },
      ],
      restriction: [],
    };
    const user = userEvent.setup();
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "githubConnection")).toHaveTextContent(
        "Connecté · 1 dépôt(s)"
      )
    );
    const toggles = screen.getAllByLabelText(settings.github.autoRunLabel);
    expect(toggles.map((toggle) => toggle.getAttribute("id"))).toEqual([
      "repo-auto-fixture-app",
      "repo-auto-fixture-other",
    ]);
    expect(byId(container, "repo-auto-fixture-app")).toBeChecked();
    expect(byId(container, "repo-auto-fixture-other")).not.toBeChecked();

    await user.click(byId(container, "repo-auto-fixture-app"));
    await user.click(byId(container, "repo-auto-fixture-other"));
    await user.click(byId(container, "githubSave"));

    await waitFor(() =>
      expect(byId(container, "githubMessage")).toHaveTextContent(
        "Dépôts enregistrés"
      )
    );
    // `fixture/other` is not in `repositories`: opting it in would send
    // autoRepos outside the saved selection, which the server refuses (400).
    expect(calls).toContainEqual({
      body: { autoRepos: [], repositories: ["fixture/app"] },
      method: "PUT",
      path: "/github/app/repositories",
    });
    await waitFor(() =>
      expect(byId(container, "repo-auto-fixture-other")).not.toBeChecked()
    );
    expect(byId(container, "repo-auto-fixture-app")).not.toBeChecked();
  });

  it("does not opt in an unselected repository whose auto_run defaults to true", async () => {
    github = {
      app: {
        id: "95001",
        origin: "https://qa.example.com",
        slug: "canary-fixture-app",
      },
      lastDelivery: null,
      legacyConfigured: false,
      repositories: [
        {
          account: "fixture",
          auto_run: true,
          enabled: false,
          full_name: "fixture/app",
          installation_id: "1",
          private: false,
        },
        {
          account: "fixture",
          auto_run: true,
          enabled: false,
          full_name: "fixture/other",
          installation_id: "1",
          private: false,
        },
      ],
      restriction: [],
    };
    const user = userEvent.setup();
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "githubRepoList")).toHaveTextContent(
        "fixture/other"
      )
    );
    // Both repositories arrive with the server-side default `auto_run=true`
    // while neither is selected yet.
    expect(byId(container, "repo-auto-fixture-other")).toBeChecked();

    await user.click(byId(container, "repo-fixture-app"));
    await user.click(byId(container, "githubSave"));

    await waitFor(() =>
      expect(byId(container, "githubMessage")).toHaveTextContent(
        "Dépôts enregistrés"
      )
    );
    const saved = calls.find(
      (call) => call.path === "/github/app/repositories"
    );
    expect(saved?.body).toEqual({
      autoRepos: ["fixture/app"],
      repositories: ["fixture/app"],
    });
  });

  it("asks for confirmation before uninstalling, then erases only the local connection", async () => {
    github = connectedGithub();
    const user = userEvent.setup();
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "githubConnection")).toHaveTextContent(
        "Connecté · 1 dépôt(s)"
      )
    );

    await user.click(byId(container, "githubUninstall"));
    expect(byId(container, "githubConfirm")).not.toHaveAttribute("hidden");
    expect(byId(container, "githubConfirmText")).toHaveTextContent(
      "Désinstaller l'App GitHub de tous vos dépôts"
    );

    await user.click(byId(container, "githubConfirmCancel"));
    expect(byId(container, "githubConfirm")).toHaveAttribute("hidden");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(byId(container, "githubConnection")).toHaveTextContent(
      "Connecté · 1 dépôt(s)"
    );

    await user.click(byId(container, "githubUninstall"));
    await user.click(byId(container, "githubConfirmRun"));

    await waitFor(() =>
      expect(byId(container, "githubConnection")).toHaveTextContent(
        "À connecter"
      )
    );
    expect(calls).toContainEqual({
      body: { deleteApp: false },
      method: "DELETE",
      path: "/github/app",
    });
    expect(byId(container, "githubNotice")).toHaveTextContent(
      "App désinstallée sur GitHub."
    );
    expect(byId(container, "githubConfirm")).toHaveAttribute("hidden");
  });

  it("deletes the App on GitHub after the irreversible confirmation", async () => {
    github = connectedGithub();
    const user = userEvent.setup();
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "githubConnection")).toHaveTextContent(
        "Connecté · 1 dépôt(s)"
      )
    );

    await user.click(byId(container, "githubDeleteApp"));
    expect(byId(container, "githubConfirmText")).toHaveTextContent(
      "Supprimer définitivement l'App GitHub"
    );

    await user.click(byId(container, "githubConfirmRun"));
    await waitFor(() =>
      expect(byId(container, "githubNotice")).toHaveTextContent(
        "App supprimée sur GitHub."
      )
    );
    expect(calls).toContainEqual({
      body: { deleteApp: true },
      method: "DELETE",
      path: "/github/app",
    });
  });

  it("reports the local warning when GitHub refused the removal", async () => {
    github = connectedGithub();
    removalWarnings = ["La suppression sur GitHub a échoué."];
    const user = userEvent.setup();
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "githubConnection")).toHaveTextContent(
        "Connecté · 1 dépôt(s)"
      )
    );

    await user.click(byId(container, "githubUninstall"));
    await user.click(byId(container, "githubConfirmRun"));

    await waitFor(() =>
      expect(byId(container, "githubNotice")).toHaveTextContent(
        "Connexion locale effacée"
      )
    );
    expect(byId(container, "githubNotice")).toHaveTextContent(
      "La suppression sur GitHub a échoué."
    );
    expect(byId(container, "githubNotice")).not.toHaveTextContent(
      "App désinstallée sur GitHub."
    );
  });

  it("creates the App by submitting the manifest to GitHub as a form POST", async () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => undefined);
    const user = userEvent.setup();
    const { container } = renderSettings();

    await screen.findByText(FIRST_RUN_MESSAGE);

    const name = screen.getByLabelText<HTMLInputElement>(
      "Nom de votre App GitHub"
    );
    await user.clear(name);
    await user.type(name, "Canary-Test");
    await user.type(
      screen.getByLabelText<HTMLInputElement>(
        "Organisation GitHub (facultatif)"
      ),
      "fixture-org"
    );
    await user.click(byId(container, "githubCreateButton"));

    const form = await waitFor(() => {
      const found = container.querySelector<HTMLFormElement>(
        `form[action="${MANIFEST.action}"]`
      );
      if (!found) {
        throw new Error("Le formulaire du manifest n'est pas encore rendu");
      }
      return found;
    });
    const field = form.querySelector<HTMLInputElement>(
      'input[name="manifest"]'
    );
    expect(field?.value).toBe(JSON.stringify(MANIFEST.manifest));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual({
      body: { name: "Canary-Test", organization: "fixture-org" },
      method: "POST",
      path: "/github/app/manifest",
    });
  });

  it("submits the manifest form only once GitHub answered the creation", async () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => undefined);
    manifestFailure = new DashboardError("GitHub a refusé la création.");
    const user = userEvent.setup();
    const { container } = renderSettings();

    await screen.findByText(FIRST_RUN_MESSAGE);
    await user.click(byId(container, "githubCreateButton"));

    await waitFor(() =>
      expect(byId(container, "githubError")).toHaveTextContent(
        "GitHub a refusé la création."
      )
    );
    // The submission comes from the handler that received the manifest, so a
    // creation that never reached GitHub submits nothing and leaves no form
    // behind for a later reaction to pick up.
    expect(submit).not.toHaveBeenCalled();
    expect(container.querySelector(`form[action="${MANIFEST.action}"]`)).toBe(
      null
    );

    manifestFailure = undefined;
    await user.click(byId(container, "githubCreateButton"));

    const form = await waitFor(() => {
      const found = container.querySelector<HTMLFormElement>(
        `form[action="${MANIFEST.action}"]`
      );
      if (!found) {
        throw new Error("Le formulaire du manifest n'est pas encore rendu");
      }
      return found;
    });
    expect(
      form.querySelector<HTMLInputElement>('input[name="manifest"]')?.value
    ).toBe(JSON.stringify(MANIFEST.manifest));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed connection refresh in the card and the global alert", async () => {
    github = connectedGithub();
    refreshFailure = new DashboardError("L'accès a été refusé.", {
      code: "HTTP_403",
      requestId: "req-42",
    });
    const user = userEvent.setup();
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "githubConnection")).toHaveTextContent(
        "Connecté · 1 dépôt(s)"
      )
    );

    await user.click(byId(container, "githubRefresh"));

    await waitFor(() =>
      expect(byId(container, "githubError")).toHaveTextContent(
        "Référence : req-42"
      )
    );
    expect(byId(container, "githubError")).toHaveTextContent("a été refusé");
    expect(byId(container, "error")).toHaveTextContent("Référence : req-42");
    expect(byId(container, "githubRefresh")).not.toBeDisabled();
  });

  it("shows the AI catalogue and the preview constraints", async () => {
    models = { data: [{ id: "alpha" }, { id: "beta" }], defaultModel: "alpha" };
    const user = userEvent.setup();
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "aiConnection")).toHaveTextContent(
        "Catalogue accessible"
      )
    );
    expect(byId(container, "aiCatalog")).toHaveTextContent(
      "2 modèles disponibles"
    );
    expect(byId(container, "aiEndpoint")).toHaveTextContent(
      "Endpoint : ai.noext.fr"
    );
    expect(byId(container, "aiDefault")).toHaveTextContent(
      "Modèle par défaut : opencode-go/deepseek-v4.1-flash"
    );
    expect(byId(container, "previewMode")).toHaveTextContent(
      "Renseignez l'URL de test de chaque PR dans le formulaire."
    );
    expect(byId(container, "previewHosts")).toHaveTextContent(
      "Hôtes autorisés : preview.example.com"
    );
    expect(byId(container, "previewProof")).toHaveTextContent(
      "En-tête de version : x-commit-sha"
    );

    const before = calls.filter((call) => call.path === "/models").length;
    await user.click(byId(container, "retryModels"));
    await waitFor(() =>
      expect(
        calls.filter((call) => call.path === "/models").length
      ).toBeGreaterThan(before)
    );
  });

  it("flags the AI connection when the catalogue cannot be loaded", async () => {
    modelsFailure = new DashboardError("Le fournisseur a refusé la requête.");
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "aiConnection")).toHaveTextContent(
        "Connexion à vérifier"
      )
    );
    expect(byId(container, "aiCatalog")).toHaveTextContent(
      "Le fournisseur a refusé la requête."
    );
  });

  it("keeps the preview card readable when the server hides its constraints", async () => {
    setup = {
      ai: {
        defaultModel: "opencode-go/deepseek-v4.1-flash",
        endpoint: "ai.noext.fr",
      },
      github: { autoRepos: [], mode: "app", repositories: ["fixture/app"] },
      preview: { automatic: true },
    };
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "previewMode")).toHaveTextContent(
        "Canary déduit l'URL de test à partir du déploiement de la PR."
      )
    );
    expect(byId(container, "previewHosts")).toHaveTextContent(
      "Les hôtes sont définis par l'opérateur du serveur."
    );
    expect(byId(container, "previewProof")).toHaveTextContent(
      "L'application doit exposer le commit dans un en-tête de version."
    );
  });

  it("saves the host list an administrator edits and follows the reloaded status", async () => {
    const user = userEvent.setup();
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "previewHostList")).toHaveTextContent(
        "preview.example.com"
      )
    );
    expect(byId(container, "previewHostsDefault")).toHaveTextContent(
      "Liste initiale du serveur : preview.example.com"
    );
    // Nothing to restore while the enforced list is still the server one.
    expect(byId(container, "previewHostReset")).toBeDisabled();

    await user.type(
      byId(container, "previewHostInput"),
      " New.Example.com:8443 "
    );
    await user.click(byId(container, "previewHostAdd"));
    expect(byId(container, "previewHostList")).toHaveTextContent(
      "new.example.com:8443"
    );
    await user.type(
      byId(container, "previewHostInput"),
      " *.Preview.Example.com "
    );
    await user.click(byId(container, "previewHostAdd"));
    expect(byId(container, "previewHostList")).toHaveTextContent(
      "*.preview.example.com"
    );
    await user.type(byId(container, "previewHostInput"), "PREVIEW.EXAMPLE.COM");
    await user.click(byId(container, "previewHostAdd"));
    expect(byId(container, "previewHostsError")).toHaveTextContent(
      settings.preview.hostsDuplicate
    );

    await user.click(byId(container, "previewHostSave"));
    await waitFor(() =>
      expect(byId(container, "previewHostsSaved")).toHaveTextContent(
        settings.preview.hostsSaved
      )
    );
    expect(calls).toContainEqual({
      body: {
        hosts: [
          "preview.example.com",
          "new.example.com:8443",
          "*.preview.example.com",
        ],
      },
      method: "PUT",
      path: "/dashboard/preview-hosts",
    });
    // The summary line reports what the server enforces, not the local draft.
    expect(byId(container, "previewHosts")).toHaveTextContent(
      "Hôtes autorisés : preview.example.com, new.example.com:8443"
    );
  });

  it("refuses a malformed host without calling the server", async () => {
    const user = userEvent.setup();
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "previewHostList")).toHaveTextContent(
        "preview.example.com"
      )
    );
    for (const value of [
      "https://evil.test/path",
      "evil.test/*",
      "evil*.test",
      "*",
      "*.evil.test/",
      "user@evil.test",
    ]) {
      await user.clear(byId(container, "previewHostInput"));
      await user.type(byId(container, "previewHostInput"), value);
      await user.click(byId(container, "previewHostAdd"));
      expect(byId(container, "previewHostsError")).toHaveTextContent(
        settings.preview.hostsInvalid
      );
    }
    expect(
      calls.filter((call) => call.path === "/dashboard/preview-hosts")
    ).toEqual([]);
  });

  it("reports a rejected edit and restores the server list", async () => {
    const user = userEvent.setup();
    const { container } = renderSettings();

    await waitFor(() =>
      expect(byId(container, "previewHostList")).toHaveTextContent(
        "preview.example.com"
      )
    );
    const removal = within(byId(container, "previewHostList")).getByRole(
      "button",
      { name: settings.preview.hostsRemove("preview.example.com") }
    );
    await user.click(removal);
    // An empty list would block every run: the editor refuses to save it.
    expect(byId(container, "previewHostSave")).toBeDisabled();
    await user.type(byId(container, "previewHostInput"), "evil.test");
    await user.click(byId(container, "previewHostAdd"));

    hostsFailure = new DashboardError("Hôte(s) invalide(s) : evil.test", {
      code: "PREVIEW_HOSTS_INVALID",
    });
    await user.click(byId(container, "previewHostSave"));
    await waitFor(() =>
      expect(byId(container, "previewHostsError")).toHaveTextContent(
        "Hôte(s) invalide(s) : evil.test"
      )
    );

    hostsFailure = undefined;
    await user.click(byId(container, "previewHostReset"));
    await waitFor(() =>
      expect(byId(container, "previewHostsSaved")).toHaveTextContent(
        settings.preview.hostsResetDone
      )
    );
    expect(calls).toContainEqual({
      method: "DELETE",
      path: "/dashboard/preview-hosts",
    });
    expect(byId(container, "previewHosts")).toHaveTextContent(
      "Hôtes autorisés : preview.example.com"
    );
    expect(byId(container, "previewHostReset")).toBeDisabled();
  });
});
