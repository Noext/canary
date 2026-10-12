import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupStatus } from "@/api/contracts";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { NavigationProvider, useNavigation } from "@/app/navigation";
import { common, home as copy, newTest } from "@/i18n";
import { HomeView } from "@/views/home-view";

const session = vi.hoisted(() => ({ canWrite: true, isAdmin: true }));

const workspace = vi.hoisted(() => ({
  models: undefined as unknown,
  modelsBusy: false,
  modelsError: undefined as string | undefined,
}));

const wire = vi.hoisted(() => ({
  calls: [] as string[],
  handler: undefined as (() => unknown) | undefined,
}));

vi.mock("@/app/session", () => ({
  useSession: () => ({ canWrite: session.canWrite, isAdmin: session.isAdmin }),
}));

vi.mock("@/app/workspace", () => ({
  useWorkspace: () => ({
    models: workspace.models,
    modelsBusy: workspace.modelsBusy,
    modelsError: workspace.modelsError,
  }),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: (path: string) => {
      wire.calls.push(path);
      const handler = wire.handler;
      if (path === "/dashboard/automatic") {
        return Promise.resolve({
          attempts: [],
          enabledRepos: [],
          summary: { expired: 0, rateLimited: 0, waiting: 0 },
        });
      }
      if (path === "/runs" && handler) {
        // Resolve in a task so a throwing handler becomes a rejection, exactly
        // like the real client.
        return Promise.resolve().then(handler);
      }
      return Promise.reject(new Error(`Unexpected api call: ${path}`));
    },
  };
});

const runId = "3f2a1c4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const otherRunId = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f3a4b5c6d";

function job(overrides: Record<string, unknown> = {}) {
  return {
    cancel_requested: false,
    created_at: "2026-01-02T03:04:05.000Z",
    id: runId,
    owner: "ui-admin",
    pr: 1,
    repo: "fixture/app",
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    status: "queued",
    updated_at: "2026-01-02T03:04:06.000Z",
    ...overrides,
  };
}

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`#${id} is not rendered`);
  }
  return node;
}

function RouteProbe() {
  const { requestedRun, view } = useNavigation();
  return <p data-testid="route">{`${view}:${requestedRun ?? ""}`}</p>;
}

function Harness({ children }: { children?: ReactNode }) {
  return (
    <ErrorProvider>
      <ErrorAlert />
      <NavigationProvider>
        {children}
        <RouteProbe />
      </NavigationProvider>
    </ErrorProvider>
  );
}

interface HomeProps {
  githubReady?: boolean;
  modelReady?: boolean;
  status?: SetupStatus;
}

function homeElement(props: HomeProps) {
  return (
    <HomeView
      githubReady={props.githubReady ?? false}
      modelReady={props.modelReady ?? false}
      {...(props.status ? { status: props.status } : {})}
    />
  );
}

function renderHome(props: HomeProps = {}, strict = false) {
  const tree = <Harness>{homeElement(props)}</Harness>;
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const appStatus: SetupStatus = {
  ai: { defaultModel: "fixture-model", endpoint: "https://ai.example.com/v1" },
  github: {
    autoRepos: ["fixture/app"],
    mode: "app",
    repositories: ["fixture/app"],
  },
  preview: { automatic: true },
};

beforeEach(() => {
  session.canWrite = true;
  session.isAdmin = true;
  workspace.models = undefined;
  workspace.modelsBusy = false;
  workspace.modelsError = undefined;
  wire.calls.length = 0;
  wire.handler = undefined;
  window.scrollTo = vi.fn();
});

afterEach(cleanup);

describe("HomeView hero", () => {
  it("offers the viewer hero and the read-only action to a viewer", async () => {
    const user = userEvent.setup();
    session.canWrite = false;
    wire.handler = () => [];
    renderHome();

    await waitFor(() => expect(wire.calls).toContain("/runs"));
    expect(byId("welcomeTitle").textContent).toBe(copy.titleViewer);
    expect(byId("welcomeIntro").textContent).toBe(copy.introViewer);
    expect(byId("welcomeAction").textContent).toBe(copy.actionViewer);
    expect(byId("welcomeNote").textContent).toBe(copy.noteViewer);
    expect(byId("onboarding")).toHaveAttribute("hidden");

    await user.click(byId("welcomeAction"));
    expect(screen.getByTestId("route")).toHaveTextContent("runs:");
  });

  it("offers the first-run hero and both connections to check", async () => {
    wire.handler = () => [];
    renderHome({ status: appStatus });

    await waitFor(() => expect(byId("countTotal").textContent).toBe("0"));
    expect(byId("welcomeTitle").textContent).toBe(copy.titleDefault);
    expect(byId("welcomeIntro").textContent).toBe(copy.introDefault);
    expect(byId("welcomeAction").textContent).toBe(copy.onboarding.githubTitle);
    expect(byId("welcomeNote").textContent).toBe(copy.noteProgress);
    expect(byId("overviewEmpty")).not.toHaveAttribute("hidden");
  });

  it("offers the returning hero once a run exists and both connections are ready", async () => {
    wire.handler = () => [job(), job({ id: otherRunId, pr: 2 })];
    renderHome({ githubReady: true, modelReady: true, status: appStatus });

    await waitFor(() =>
      expect(byId("welcomeTitle").textContent).toBe(copy.titleReturning)
    );
    expect(byId("welcomeIntro").textContent).toBe(copy.introReturning);
    expect(byId("welcomeAction").textContent).toBe(copy.actionRun);
    expect(byId("welcomeNote").textContent).toBe(copy.noteReady);
    expect(byId("overviewEmpty")).toHaveAttribute("hidden");
  });
});

describe("HomeView onboarding steps", () => {
  it("reports each step's state and the ready connection count", async () => {
    wire.handler = () => [];
    renderHome({ githubReady: true, modelReady: true, status: appStatus });

    await waitFor(() => expect(wire.calls).toContain("/runs"));
    expect(byId("stepGitHubState").textContent).toBe("Connecté · 1 dépôt(s)");
    expect(byId("stepModelState").textContent).toBe(copy.modelStateReady);
    expect(byId("stepFirstRun").textContent).toContain(copy.onboarding.runCta);
    expect(byId("setupCount").textContent).toBe("2/2 connexions prêtes");
  });

  it("asks for an explicit model when the catalogue exposes no default", async () => {
    workspace.models = { data: [{ id: "model-y" }] };
    wire.handler = () => [];
    renderHome({ status: appStatus });

    await waitFor(() =>
      expect(byId("stepModelState").textContent).toContain(
        "choisissez explicitement un modèle"
      )
    );
    expect(byId("setupCount").textContent).toBe("0/2 connexions prêtes");
  });

  it("shows the catalogue as loading while no answer is available yet", async () => {
    wire.handler = () => [];
    renderHome();

    await waitFor(() => expect(wire.calls).toContain("/runs"));
    expect(byId("stepModelState").textContent).toBe(newTest.modelLoading);
    expect(byId("stepGitHubState").textContent).toBe(common.checking);
  });
});

describe("HomeView counts", () => {
  it("counts the whole account from /runs, not the history filters", async () => {
    wire.handler = () => [
      job({ status: "running" }),
      job({ id: otherRunId, pr: 2, status: "queued" }),
      job({ id: "run-3", outcome: "passed", pr: 3, status: "completed" }),
      job({ id: "run-4", outcome: "failed", pr: 4, status: "failed" }),
    ];
    renderHome();

    await waitFor(() => expect(byId("countTotal").textContent).toBe("4"));
    expect(byId("countActive").textContent).toBe("2");
    expect(byId("countPassed").textContent).toBe("1");
  });

  it("shows what is happening instead of zeros while loading", async () => {
    let settle: (rows: unknown) => void = () => undefined;
    wire.handler = () =>
      new Promise((resolve) => {
        settle = resolve;
      });
    renderHome();

    await waitFor(() => expect(wire.calls).toContain("/runs"));
    expect(byId("countTotal").textContent).toBe("…");
    expect(screen.getByText(copy.runsLoading)).toBeVisible();

    settle([job()]);
    await waitFor(() => expect(byId("countTotal").textContent).toBe("1"));
  });
});

describe("HomeView recent runs", () => {
  it("shows at most three recent runs and opens one from its link", async () => {
    const user = userEvent.setup();
    wire.handler = () => [
      job(),
      job({ id: otherRunId, pr: 2 }),
      job({ id: "run-3", pr: 3 }),
      job({ id: "run-4", pr: 4 }),
    ];
    renderHome();

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "fixture/app #1" })).toBeVisible()
    );
    expect(byId("recentRuns").querySelectorAll("a")).toHaveLength(3);
    expect(
      screen.queryByRole("link", { name: "fixture/app #4" })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "fixture/app #1" }));
    expect(screen.getByTestId("route")).toHaveTextContent(`runs:${runId}`);
    expect(
      screen.getByRole("link", { name: "fixture/app #1" })
    ).toHaveAttribute("href", `#${runId}`);
  });

  it("opens the history from the card action", async () => {
    const user = userEvent.setup();
    wire.handler = () => [job()];
    renderHome();

    await waitFor(() => expect(byId("recentRuns").children).toHaveLength(1));
    await user.click(byId("showHistory"));
    expect(screen.getByTestId("route")).toHaveTextContent("runs:");
  });
});

describe("HomeView failure", () => {
  it("surfaces a failed /runs through the error alert, not zeros", async () => {
    wire.handler = () => {
      throw new Error("Le serveur est injoignable.");
    };
    renderHome();

    await waitFor(() =>
      expect(byId("error").textContent).toContain("Le serveur est injoignable.")
    );
    expect(byId("countTotal").textContent).toBe("—");
    expect(byId("countActive").textContent).toBe("—");
    expect(byId("overviewEmpty")).toHaveAttribute("hidden");
  });

  it("loads the runs once even under StrictMode's double subscription", async () => {
    wire.handler = () => [job()];
    renderHome({}, true);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "fixture/app #1" })).toBeVisible()
    );
    expect(wire.calls.filter((path) => path === "/runs")).toHaveLength(1);
  });

  it("never reports a failure from a screen that has been abandoned", async () => {
    let rejectRun: (failure: unknown) => void = () => undefined;
    wire.handler = () =>
      new Promise((_resolve, reject) => {
        rejectRun = reject;
      });
    const view = renderHome();
    await waitFor(() => expect(wire.calls).toContain("/runs"));

    view.rerender(<Harness />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejectRun(new Error("Trop tard."));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(byId("error").textContent).toBe("");
  });
});
