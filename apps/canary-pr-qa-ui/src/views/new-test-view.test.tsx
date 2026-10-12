import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardError } from "@/api/client";
import type {
  ModelCatalog,
  Preflight,
  Principal,
  SetupStatus,
} from "@/api/contracts";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { NavigationProvider, useNavigation } from "@/app/navigation";
import { SessionProvider } from "@/app/session";
import { WorkspaceProvider } from "@/app/workspace";
import { common, newTest } from "@/i18n";
import { NewTestView } from "./new-test-view";

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

const ADMIN: Principal = {
  id: "ui-admin",
  repos: ["fixture/app"],
  role: "admin",
  username: "ui-admin",
};

const READY_STATUS: SetupStatus = {
  ai: { defaultModel: "fixture-model", endpoint: "https://ai.example.com/v1" },
  github: { mode: "app", repositories: ["fixture/app"] },
  preview: { automatic: true },
};

const CATALOG: ModelCatalog = {
  data: [{ id: "fixture-model" }, { id: "fixture-alternate-model" }],
  defaultModel: "fixture-model",
};

const PR_URL = "https://github.com/fixture/app/pull/42";
const PREVIEW_URL = "https://preview.example.com";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const PREFLIGHT: Preflight = {
  model: "fixture-alternate-model",
  pr: { number: 42, repo: "fixture/app", sha: SHA, title: "Ajoute le panier" },
  preview: { sha: SHA, url: `${PREVIEW_URL}/` },
  ready: true,
};

function defaultResponse(path: string): unknown {
  switch (path) {
    case "/auth/status":
      return { initialized: true };
    case "/me":
      return ADMIN;
    case "/dashboard/status":
      return READY_STATUS;
    case "/models":
      return CATALOG;
    case "/github/app":
      return {
        app: { id: "1", origin: "https://qa.example.com", slug: "canary-qa" },
        lastDelivery: null,
        legacyConfigured: false,
        repositories: [],
        restriction: [],
      };
    default:
      throw new Error(`Unexpected request: ${path}`);
  }
}

function serve(match: (path: string) => boolean, value: unknown) {
  apiMock.mockImplementation(async (path: string) => {
    if (match(path)) {
      return value;
    }
    return defaultResponse(path);
  });
}

function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`#${id} is not rendered`);
  }
  return node;
}

const bodiesFor = (path: string) =>
  apiMock.mock.calls
    .filter(([called]) => called === path)
    .map(([, options]) => options?.body);

function RouteProbe() {
  const { requestedRun, view } = useNavigation();
  return <p data-testid="route">{`${view}:${requestedRun ?? ""}`}</p>;
}

/** The form can be unmounted and mounted again under the same workspace. */
function RemountableScreen() {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button
        id="toggleRunForm"
        onClick={() => setShown((current) => !current)}
        type="button"
      >
        Basculer le formulaire
      </button>
      {shown ? <NewTestView /> : null}
      <RouteProbe />
    </>
  );
}

function renderScreen() {
  return render(
    <ErrorProvider>
      <ErrorAlert />
      <SessionProvider>
        <WorkspaceProvider>
          <NavigationProvider>
            <NewTestView />
            <RouteProbe />
          </NavigationProvider>
        </WorkspaceProvider>
      </SessionProvider>
    </ErrorProvider>
  );
}

async function readyScreen() {
  renderScreen();
  await waitFor(() => expect(byId("model")).toBeEnabled());
  await waitFor(() => expect(byId("checkRun")).toBeEnabled());
}

async function verifyAccess() {
  await userEvent.selectOptions(byId("model"), "fixture-alternate-model");
  await userEvent.type(byId("pr"), PR_URL);
  await userEvent.type(byId("preview"), PREVIEW_URL);
  await userEvent.click(byId("checkRun"));
  await screen.findByText(newTest.checkReady);
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => defaultResponse(path));
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
});

describe("NewTestView", () => {
  it("exposes the launch form with the preflight controls", async () => {
    await readyScreen();

    expect(byId("runForm")).toBeInTheDocument();
    expect(byId("pr")).toHaveAttribute("type", "url");
    expect(byId("pr")).toBeRequired();
    expect(byId("preview")).toHaveAttribute("type", "url");
    expect(byId("model")).toBeRequired();
    expect(byId("refreshModels")).toHaveTextContent(newTest.modelRefresh);
    expect(byId("checkRun")).toHaveTextContent(newTest.check);
    expect(byId("startRun")).toHaveTextContent(newTest.launch);
    expect(byId("modelState")).toHaveAttribute("role", "status");
    expect(byId("runFeedback")).toHaveAttribute("role", "status");
    expect(document.getElementById("preflightResult")).toBeNull();
    expect(document.getElementById("runBlocker")).toBeNull();
  });

  it("keeps the launch disabled until a repository is connected", async () => {
    serve((path) => path === "/dashboard/status", {
      ...READY_STATUS,
      github: { mode: "missing", repositories: [] },
    });
    renderScreen();

    await screen.findByText(newTest.blocker);
    expect(byId("runBlocker")).toHaveTextContent(newTest.blocker);
    expect(byId("checkRun")).toBeDisabled();
    expect(byId("startRun")).toBeDisabled();
  });

  it("asks for an explicit model when the configured default is absent", async () => {
    serve((path) => path === "/models", {
      data: [{ id: "fixture-alternate-model" }],
      defaultModel: "gone-model",
    });
    renderScreen();

    await waitFor(() => expect(byId("model")).toBeEnabled());
    expect(byId("model")).toHaveValue("");
    expect(byId("modelState")).toHaveTextContent("choisissez explicitement");
    expect(byId("checkRun")).toBeDisabled();
    expect(byId("startRun")).toBeDisabled();
  });

  it("reports a catalogue failure on the model field", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/models") {
        throw new DashboardError("Catalogue injoignable.");
      }
      return defaultResponse(path);
    });
    renderScreen();

    await waitFor(() =>
      expect(byId("modelState")).toHaveTextContent("Catalogue injoignable.")
    );
    await waitFor(() => expect(byId("model")).toBeDisabled());
    expect(byId("model")).toHaveTextContent("Catalogue indisponible");
    expect(byId("checkRun")).toBeDisabled();
  });

  it("reloads the catalogue when the refresh is clicked", async () => {
    const refresh = deferred<ModelCatalog>();
    let calls = 0;
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/models") {
        calls += 1;
        return calls === 1 ? CATALOG : refresh.promise;
      }
      return defaultResponse(path);
    });
    renderScreen();

    await waitFor(() => expect(byId("model")).toBeEnabled());
    expect(byId("model")).toHaveTextContent("fixture-alternate-model");
    expect(byId("modelState")).toHaveTextContent("2 modèles disponibles");
    expect(calls).toBe(1);

    await userEvent.click(byId("refreshModels"));

    expect(byId("modelState")).toHaveTextContent(newTest.modelLoading);
    expect(byId("refreshModels")).toBeDisabled();
    expect(calls).toBe(2);

    refresh.settle({
      data: [{ id: "fixture-new-model" }],
      defaultModel: "fixture-new-model",
    });

    await waitFor(() =>
      expect(byId("model")).toHaveTextContent("fixture-new-model")
    );
    await waitFor(() =>
      expect(byId("modelState")).toHaveTextContent("1 modèles disponibles")
    );
  });

  it("shows the verified summary and enables the launch after a preflight", async () => {
    serve((path) => path === "/runs/preflight", PREFLIGHT);
    await readyScreen();
    await verifyAccess();

    expect(bodiesFor("/runs/preflight")).toEqual([
      {
        model: "fixture-alternate-model",
        previewUrl: PREVIEW_URL,
        prUrl: PR_URL,
      },
    ]);
    expect(byId("preflightResult")).toBeVisible();
    expect(byId("preflightSummary")).toHaveTextContent(
      "Ajoute le panier · fixture/app #42 · version 0123456789ab · preview.example.com"
    );
    expect(byId("runFeedback")).toHaveTextContent(newTest.checkReady);
    expect(byId("checkRun")).toBeEnabled();
    expect(byId("startRun")).toBeEnabled();
  });

  it("discards a preflight whose parameters changed in flight", async () => {
    const pending = deferred<Preflight>();
    serve((path) => path === "/runs/preflight", pending.promise);
    await readyScreen();

    await userEvent.selectOptions(byId("model"), "fixture-alternate-model");
    await userEvent.type(byId("pr"), PR_URL);
    await userEvent.click(byId("checkRun"));

    expect(byId("runFeedback")).toHaveTextContent(newTest.checkReading);
    expect(byId("checkRun")).toBeDisabled();
    expect(byId("startRun")).toBeDisabled();

    await userEvent.type(byId("pr"), "3");
    pending.settle(PREFLIGHT);

    await screen.findByText(newTest.checkChanged);
    expect(document.getElementById("preflightResult")).toBeNull();
    expect(byId("startRun")).toBeDisabled();
  });

  it("clears the preflight when a verified field is edited", async () => {
    serve((path) => path === "/runs/preflight", PREFLIGHT);
    await readyScreen();
    await verifyAccess();

    await userEvent.selectOptions(byId("model"), "fixture-model");

    await waitFor(() =>
      expect(document.getElementById("preflightResult")).toBeNull()
    );
    expect(byId("startRun")).toBeDisabled();
    expect(byId("runFeedback")).toHaveTextContent("");

    await userEvent.selectOptions(byId("model"), "fixture-alternate-model");
    await userEvent.click(byId("checkRun"));
    await screen.findByText(newTest.checkReady);

    await userEvent.type(byId("preview"), "/second");

    await waitFor(() =>
      expect(document.getElementById("preflightResult")).toBeNull()
    );
    expect(byId("startRun")).toBeDisabled();
    expect(byId("runFeedback")).toHaveTextContent("");
  });

  it("keeps the verified notice bound to the parameters it was checked for", async () => {
    serve((path) => path === "/runs/preflight", PREFLIGHT);
    await readyScreen();
    await verifyAccess();

    await userEvent.selectOptions(byId("model"), "fixture-model");
    await waitFor(() =>
      expect(document.getElementById("preflightResult")).toBeNull()
    );

    // Coming back to the checked parameters arms the launch again: the
    // preflight belongs to that input, it is not consumed by the first edit.
    await userEvent.selectOptions(byId("model"), "fixture-alternate-model");
    await waitFor(() =>
      expect(document.getElementById("preflightResult")).not.toBeNull()
    );
    expect(byId("preflightSummary")).toHaveTextContent("Ajoute le panier");
    expect(byId("runFeedback")).toHaveTextContent(newTest.checkReady);
    expect(byId("startRun")).toBeEnabled();

    // The request is built from the trimmed URLs, so a trailing blank is not a
    // change of parameters and must not disarm the launch.
    await userEvent.type(byId("preview"), " ");
    expect(document.getElementById("preflightResult")).not.toBeNull();
    expect(byId("startRun")).toBeEnabled();
  });

  it("requires a new check for a form that was mounted again", async () => {
    serve((path) => path === "/runs/preflight", PREFLIGHT);
    render(
      <ErrorProvider>
        <ErrorAlert />
        <SessionProvider>
          <WorkspaceProvider>
            <NavigationProvider>
              <RemountableScreen />
            </NavigationProvider>
          </WorkspaceProvider>
        </SessionProvider>
      </ErrorProvider>
    );
    await waitFor(() => expect(byId("model")).toBeEnabled());
    await verifyAccess();
    expect(byId("startRun")).toBeEnabled();

    await userEvent.click(byId("toggleRunForm"));
    await waitFor(() => expect(document.getElementById("runForm")).toBeNull());
    await userEvent.click(byId("toggleRunForm"));
    await waitFor(() => expect(byId("runForm")).toBeInTheDocument());

    // The workspace still holds the verified preflight, the empty form does
    // not: it must check its own input before arming the launch.
    expect(document.getElementById("preflightResult")).toBeNull();
    expect(byId("startRun")).toBeDisabled();
  });

  it("reports a preflight failure on the feedback line and the alert", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/runs/preflight") {
        throw new DashboardError("Aucune application de test", {
          code: "PREVIEW_NOT_FOUND",
          requestId: "req-42",
        });
      }
      return defaultResponse(path);
    });
    await readyScreen();
    await userEvent.selectOptions(byId("model"), "fixture-alternate-model");
    await userEvent.type(byId("pr"), PR_URL);
    await userEvent.click(byId("checkRun"));

    await waitFor(() =>
      expect(byId("runFeedback")).toHaveTextContent(
        "Aucune application de test trouvée pour cette PR."
      )
    );
    expect(byId("runFeedback")).toHaveTextContent("req-42");
    expect(byId("error")).toHaveTextContent(
      "Aucune application de test trouvée pour cette PR."
    );
    expect(byId("startRun")).toBeDisabled();
  });

  it("reports a preview URL it cannot read instead of arming the launch", async () => {
    serve((path) => path === "/runs/preflight", {
      ...PREFLIGHT,
      preview: { sha: SHA, url: "pas-une-url" },
    });
    await readyScreen();
    await userEvent.selectOptions(byId("model"), "fixture-alternate-model");
    await userEvent.type(byId("pr"), PR_URL);
    await userEvent.click(byId("checkRun"));
    await waitFor(() =>
      expect(byId("runFeedback").textContent ?? "").not.toBe("")
    );

    const feedback = byId("runFeedback").textContent ?? "";
    expect(byId("error").textContent).toBe(feedback);
    expect(document.getElementById("preflightResult")).toBeNull();
    expect(byId("startRun")).toBeDisabled();
  });

  it("publishes the run then opens it in the history", async () => {
    apiMock.mockImplementation(async (path: string) => {
      // The POST answers with the created run; the history list reload belongs
      // to the sibling screen that mounts once the run is opened.
      if (path === "/runs") {
        return {
          id: RUN_ID,
          reportUrl: `/artifacts/${RUN_ID}/report.html`,
          statusUrl: `/runs/${RUN_ID}`,
        };
      }
      if (path === "/runs/preflight") {
        return PREFLIGHT;
      }
      return defaultResponse(path);
    });
    await readyScreen();
    await verifyAccess();

    await userEvent.click(byId("startRun"));

    await waitFor(() =>
      expect(screen.getByTestId("route")).toHaveTextContent(`runs:${RUN_ID}`)
    );
    expect(bodiesFor("/runs")).toEqual([
      {
        model: "fixture-alternate-model",
        previewUrl: PREVIEW_URL,
        prUrl: PR_URL,
        publish: true,
      },
    ]);
    expect(window.location.hash).toBe(`#${RUN_ID}`);
    expect(document.getElementById("preflightResult")).toBeNull();
    expect(byId("startRun")).toBeDisabled();
  });

  it("explains a failed setup status and lets the operator retry it", async () => {
    let failing = true;
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/dashboard/status" && failing) {
        throw new DashboardError("Le serveur est injoignable.");
      }
      return defaultResponse(path);
    });
    renderScreen();

    const blocker = await screen.findByText("Le serveur est injoignable.");
    expect(blocker).toBeVisible();
    expect(
      within(byId("runBlocker")).getByRole("button", { name: common.retry })
    ).toBeVisible();

    failing = false;
    await userEvent.click(
      within(byId("runBlocker")).getByRole("button", { name: common.retry })
    );
    await waitFor(() =>
      expect(document.getElementById("runBlocker")).toBeNull()
    );
  });

  it("keeps the guide and the publication footnote", async () => {
    await readyScreen();

    expect(screen.getByText(newTest.guide.eyebrow)).toBeInTheDocument();
    expect(screen.getByText(newTest.guide.title)).toBeInTheDocument();
    expect(screen.getByText(newTest.guide.fence)).toBeInTheDocument();
    expect(byId("runForm")).toHaveTextContent(newTest.publishedNotice);
    for (const [title] of newTest.guide.items) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });
});
