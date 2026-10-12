import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AutomaticAttempt,
  AutomaticStatus,
  Principal,
  SetupStatus,
} from "@/api/contracts";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { SessionProvider } from "@/app/session";
import { WorkspaceProvider } from "@/app/workspace";
import { automatic } from "@/i18n";
import { AutomaticRuns } from "./automatic-runs";

interface ApiCall {
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

const admin: Principal = {
  id: "user-1",
  repos: ["fixture/app"],
  role: "admin",
  username: "ui-admin",
};

const SHA = "0123456789abcdef0123456789abcdef01234567";

function attempt(overrides: Partial<AutomaticAttempt> = {}): AutomaticAttempt {
  return {
    attempts: 3,
    deadlineAt: "2026-01-02T04:00:00.000Z",
    id: "delivery-1",
    reason: "PREVIEW_NOT_FOUND",
    pr: 42,
    repo: "fixture/app",
    runId: null,
    sha: SHA,
    state: "waiting",
    updatedAt: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}

function waitingStatus(): AutomaticStatus {
  return {
    attempts: [attempt()],
    enabledRepos: ["fixture/app"],
    summary: { expired: 0, rateLimited: 0, waiting: 1 },
  };
}

function byId(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[id="${id}"]`);
  if (!element) {
    throw new Error(`Missing control #${id}`);
  }
  return element;
}

let automaticStatus: AutomaticStatus;
let setup: SetupStatus;
let calls: ApiCall[] = [];

beforeEach(() => {
  calls = [];
  automaticStatus = waitingStatus();
  setup = {
    ai: { defaultModel: "fixture-model", endpoint: "ai.example.com" },
    github: {
      autoRepos: ["fixture/app"],
      mode: "app",
      repositories: ["fixture/app"],
    },
    preview: { automatic: true },
  };

  apiMock.mockReset();
  apiMock.mockImplementation(async (path, options) => {
    calls.push({ method: options?.method ?? "GET", path });
    switch (path) {
      case "/auth/status":
        return { initialized: true };
      case "/me":
        return admin;
      case "/dashboard/automatic":
        return automaticStatus;
      case "/dashboard/status":
        return setup;
      case "/github/app":
        return {
          app: null,
          lastDelivery: null,
          legacyConfigured: false,
          repositories: [],
          restriction: [],
        };
      case "/models":
        return { data: [], defaultModel: "" };
      default:
        throw new Error(`Unexpected API path ${path}`);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderBlock(): ReturnType<typeof render> {
  return render(
    <ErrorProvider>
      <ErrorAlert />
      <SessionProvider>
        <WorkspaceProvider>
          <AutomaticRuns />
        </WorkspaceProvider>
      </SessionProvider>
    </ErrorProvider>
  );
}

async function rendered(): Promise<HTMLElement> {
  const { container } = renderBlock();
  await waitFor(() =>
    expect(byId(container, "automaticRuns")).toBeInTheDocument()
  );
  await waitFor(() =>
    expect(byId(container, "automaticAttempts")).not.toHaveAttribute("hidden")
  );
  return container;
}

describe("AutomaticRuns", () => {
  it("lists a waiting attempt with its PR link, commit, state, reason, probes and deadline", async () => {
    const container = await rendered();

    expect(
      screen.getByRole("link", { name: "fixture/app #42" })
    ).toHaveAttribute("href", "https://github.com/fixture/app/pull/42");
    expect(byId(container, "automaticAttempts").textContent).toContain(
      "0123456789ab"
    );
    expect(byId(container, "automaticAttempts")).toHaveTextContent(
      "En attente de la préversion"
    );
    expect(byId(container, "automaticAttempts")).toHaveTextContent(
      "Aucune application de test publiée pour ce commit."
    );
    expect(byId(container, "automaticAttempts")).toHaveTextContent(
      "3 tentatives"
    );
    expect(byId(container, "automaticAttempts")).toHaveTextContent("Délai :");
    expect(byId(container, "automaticSummary")).toHaveTextContent(
      "1 en attente"
    );
    expect(byId(container, "automaticEnabledRepos")).toHaveTextContent(
      "1 dépôt(s) en lancement automatique"
    );
    expect(byId(container, "automaticManualHint")).toHaveTextContent(
      "Un lancement manuel reste possible"
    );
    expect(byId(container, "automaticEmpty")).toHaveAttribute("hidden");
  });

  it("explains an expired attempt and counts it in the summary", async () => {
    automaticStatus = {
      attempts: [
        attempt({
          attempts: 1,
          deadlineAt: "2026-01-02T03:34:05.000Z",
          state: "expired",
        }),
      ],
      enabledRepos: ["fixture/app"],
      summary: { expired: 1, rateLimited: 0, waiting: 0 },
    };
    const container = await rendered();

    expect(byId(container, "automaticAttempts")).toHaveTextContent(
      "Délai dépassé"
    );
    expect(byId(container, "automaticSummary")).toHaveTextContent(
      "1 délai(s) dépassé(s)"
    );
    expect(byId(container, "automaticAttempts")).toHaveTextContent(
      "1 tentative"
    );
    expect(byId(container, "automaticSummary")).not.toHaveTextContent(
      "1 en attente"
    );
  });

  it("names GitHub's rate limit instead of the raw reason code", async () => {
    automaticStatus = {
      attempts: [
        attempt({
          attempts: 6,
          reason: "WEBHOOK_RATE_LIMIT",
          state: "rate_limited",
        }),
      ],
      enabledRepos: ["fixture/app"],
      summary: { expired: 0, rateLimited: 1, waiting: 0 },
    };
    const container = await rendered();

    expect(byId(container, "automaticAttempts")).toHaveTextContent(
      "Quota horaire atteint"
    );
    expect(byId(container, "automaticAttempts")).toHaveTextContent(
      "Le budget horaire de lancements automatiques de Canary (global ou par dépôt) est atteint. Ce commit n'est pas rejoué automatiquement : attendez la prochaine fenêtre, poussez un nouveau commit ou lancez le test depuis « Nouveau test »."
    );
    expect(byId(container, "automaticAttempts")).not.toHaveTextContent(
      "WEBHOOK_RATE_LIMIT"
    );
    expect(byId(container, "automaticSummary")).toHaveTextContent(
      "1 refusé(s) par le quota horaire"
    );
  });

  it("keeps an unknown reason code visible", async () => {
    automaticStatus = {
      attempts: [attempt({ reason: "SOMETHING_NEW" })],
      enabledRepos: ["fixture/app"],
      summary: { expired: 0, rateLimited: 0, waiting: 1 },
    };
    const container = await rendered();

    expect(byId(container, "automaticAttempts")).toHaveTextContent(
      "Cause à vérifier : SOMETHING_NEW."
    );
  });

  it("shows the empty state when no attempt is waiting", async () => {
    automaticStatus = {
      attempts: [],
      enabledRepos: ["fixture/app"],
      summary: { expired: 0, rateLimited: 0, waiting: 0 },
    };
    const { container } = renderBlock();

    await waitFor(() =>
      expect(byId(container, "automaticEmpty")).not.toHaveAttribute("hidden")
    );
    expect(byId(container, "automaticEmpty")).toHaveTextContent(
      automatic.empty
    );
    expect(byId(container, "automaticAttempts")).toHaveAttribute("hidden");
    expect(byId(container, "automaticSummary")).toHaveTextContent(
      "0 en attente"
    );
  });

  it("renders nothing while GitHub is not connected", async () => {
    setup = {
      ...setup,
      github: { autoRepos: [], mode: "missing", repositories: [] },
    };
    const { container } = renderBlock();

    await waitFor(() =>
      expect(calls.some((call) => call.path === "/dashboard/status")).toBe(true)
    );
    expect(container.querySelector('[id="automaticRuns"]')).toBeNull();
    expect(calls.some((call) => call.path === "/dashboard/automatic")).toBe(
      false
    );
  });
});
