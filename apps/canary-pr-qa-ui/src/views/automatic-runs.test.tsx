import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardError } from "@/api/client";
import type {
  AutomaticAttempt,
  AutomaticStatus,
  Principal,
  SetupStatus,
} from "@/api/contracts";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { NavigationProvider, useNavigation } from "@/app/navigation";
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

/** The principal `/me` answers with; a test that needs a reader replaces it. */
let me: Principal = admin;

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

/** The failure the home block reports, and the attempt a retry re-arms. */
function expiredStatus(): AutomaticStatus {
  return {
    attempts: [attempt({ state: "expired" })],
    enabledRepos: ["fixture/app"],
    summary: { expired: 1, rateLimited: 0, waiting: 0 },
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
let deleteRefused = false;
let setup: SetupStatus;
let calls: ApiCall[] = [];

/** The list the home block reads after the attempt it showed is gone. */
function emptyStatus(): AutomaticStatus {
  return {
    attempts: [],
    enabledRepos: ["fixture/app"],
    summary: { expired: 0, rateLimited: 0, waiting: 0 },
  };
}

beforeEach(() => {
  calls = [];
  deleteRefused = false;
  me = admin;
  automaticStatus = waitingStatus();
  window.scrollTo = vi.fn();
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
    // A retry re-arms the same attempt: the server answers with it and the next
    // read of the list reports it as waiting, which is what this fixture models.
    if (path === "/dashboard/automatic/delivery-1/retry") {
      automaticStatus = waitingStatus();
      return { attempt: attempt(), timeline: [] };
    }
    // A delete removes the attempt from what the next read reports, and a
    // refused one leaves it in place: the reload is what the operator sees.
    if (options?.method === "DELETE") {
      if (deleteRefused) {
        throw new DashboardError("Tentative relancée entre-temps", {
          code: "AUTOMATIC_NOT_DELETABLE",
        });
      }
      automaticStatus = emptyStatus();
      return attempt();
    }
    switch (path) {
      case "/auth/status":
        return { initialized: true };
      case "/me":
        return me;
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
        <NavigationProvider>
          <WorkspaceProvider>
            <AutomaticRuns />
            <RouteProbe />
          </WorkspaceProvider>
        </NavigationProvider>
      </SessionProvider>
    </ErrorProvider>
  );
}

function RouteProbe() {
  const { requestedAutomatic, view } = useNavigation();
  return <p data-testid="route">{`${view}:${requestedAutomatic ?? ""}`}</p>;
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
      "Canary n’a trouvé aucune application de test pour ce commit"
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

  it("opens the detail screen of an attempt from its link", async () => {
    const user = userEvent.setup();
    const container = await rendered();

    await user.click(byId(container, "automaticAttempt-delivery-1"));

    expect(screen.getByTestId("route")).toHaveTextContent(
      "automatic:delivery-1"
    );
  });

  it("re-arms a failed attempt and shows it waiting again", async () => {
    const user = userEvent.setup();
    automaticStatus = expiredStatus();
    const container = await rendered();
    expect(byId(container, "automaticSummary")).toHaveTextContent(
      "1 délai(s) dépassé(s)"
    );

    await user.click(byId(container, "automaticRetry-delivery-1"));

    expect(calls).toContainEqual({
      method: "POST",
      path: "/dashboard/automatic/delivery-1/retry",
    });
    // What the operator sees next comes from the reloaded list, not from the
    // response of the write: an expired attempt is waiting again.
    await waitFor(() =>
      expect(byId(container, "automaticAttempts")).toHaveTextContent(
        "En attente de la préversion"
      )
    );
    expect(byId(container, "automaticAttempts")).not.toHaveTextContent(
      "Délai dépassé"
    );
    expect(byId(container, "automaticSummary")).toHaveTextContent(
      "1 en attente"
    );
  });

  it("offers no retry on an attempt the probe loop still owns", async () => {
    const container = await rendered();

    // A waiting attempt has nothing to re-arm: the next probe is scheduled.
    expect(document.getElementById("automaticRetry-delivery-1")).toBeNull();
    // And nothing an operator can give up on either: it is still being probed.
    expect(document.getElementById("automaticDelete-delivery-1")).toBeNull();
    expect(byId(container, "automaticAttempts")).toHaveTextContent(
      "En attente de la préversion"
    );
  });

  it("offers no retry to a reader the write would be refused for", async () => {
    me = { ...admin, role: "viewer", username: "ui-reader" };
    automaticStatus = expiredStatus();
    const container = await rendered();

    expect(document.getElementById("automaticRetry-delivery-1")).toBeNull();
    // The delete is the same write, refused for the same reason.
    expect(document.getElementById("automaticDelete-delivery-1")).toBeNull();
    // The failure itself is still reported, with the screens that explain it.
    expect(byId(container, "automaticAttempts")).toHaveTextContent(
      "Délai dépassé"
    );
    expect(byId(container, "automaticAttempt-delivery-1")).toBeInTheDocument();
  });

  it("deletes a failure once the confirmation is answered, and reloads without it", async () => {
    const user = userEvent.setup();
    automaticStatus = expiredStatus();
    const container = await rendered();

    await user.click(byId(container, "automaticDelete-delivery-1"));

    // Revealing the question deletes nothing: the second click is the decision.
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(
      byId(container, "automaticDelete-delivery-1-question")
    ).not.toHaveAttribute("hidden");

    await user.click(byId(container, "automaticDelete-delivery-1-confirm"));

    expect(calls).toContainEqual({
      method: "DELETE",
      path: "/dashboard/automatic/delivery-1",
    });
    // What the operator sees next comes from the reloaded list: the failure is
    // gone, and so is its count in the summary.
    await waitFor(() =>
      expect(byId(container, "automaticEmpty")).not.toHaveAttribute("hidden")
    );
    expect(byId(container, "automaticAttempts")).toHaveAttribute("hidden");
    expect(byId(container, "automaticSummary")).toHaveTextContent(
      "0 délai(s) dépassé(s)"
    );
  });

  it("lets the operator walk out of the question without deleting", async () => {
    const user = userEvent.setup();
    automaticStatus = expiredStatus();
    const container = await rendered();

    await user.click(byId(container, "automaticDelete-delivery-1"));
    await user.click(byId(container, "automaticDelete-delivery-1-cancel"));

    expect(
      byId(container, "automaticDelete-delivery-1-question")
    ).toHaveAttribute("hidden");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(byId(container, "automaticAttempts")).toHaveTextContent(
      "Délai dépassé"
    );
    expect(byId(container, "automaticDelete-delivery-1")).not.toBeDisabled();
  });

  it("reports a refused delete and shows the state the list really has", async () => {
    const user = userEvent.setup();
    deleteRefused = true;
    automaticStatus = expiredStatus();
    const container = await rendered();

    await user.click(byId(container, "automaticDelete-delivery-1"));
    await user.click(byId(container, "automaticDelete-delivery-1-confirm"));

    // Another operator re-armed the attempt between the read and the write: the
    // server refuses, and the reload is what tells this operator.
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Tentative relancée entre-temps"
      )
    );
    expect(byId(container, "automaticAttempts")).toHaveTextContent(
      "Délai dépassé"
    );
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
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
