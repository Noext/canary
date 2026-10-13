import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { NavigationProvider, useNavigation } from "@/app/navigation";
import { RunScreenView } from "@/views/run-screen";

vi.mock("@/app/session", () => ({
  useSession: () => ({ canWrite: true, isAdmin: true }),
}));

const wire = vi.hoisted(() => ({
  calls: [] as string[],
  handlers: new Map<string, () => unknown>(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: (path: string) => {
      wire.calls.push(path);
      const handler = wire.handlers.get(path);
      // Resolve in a task so a throwing handler rejects, exactly like the real
      // client, instead of escaping `api()` synchronously.
      return handler
        ? Promise.resolve().then(() => handler())
        : Promise.reject(new Error(`Unexpected api call: ${path}`));
    },
  };
});

const runId = "3f2a1c4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";

function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`#${id} is missing from the run screen`);
  }
  return node;
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    cancel_requested: false,
    created_at: "2026-01-02T03:04:05.000Z",
    id: runId,
    input: { model: "opencode-go/deepseek-v4.1-flash" },
    outcome: "passed",
    owner: "ui-admin",
    pr: 1,
    repo: "fixture/app",
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    status: "completed",
    updated_at: "2026-01-02T03:04:06.000Z",
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    outcome: "passed",
    prUrl: "https://github.com/fixture/app/pull/1",
    scenarios: [],
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    startedAt: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}

/** The navigation state the buttons of this screen are expected to move. */
function NavigationProbe() {
  const { requestedRun, requestedRunScreen, view } = useNavigation();
  return (
    <div>
      <span id="probeView">{view}</span>
      <span id="probeRequestedRun">{requestedRun ?? "none"}</span>
      <span id="probeRequestedRunScreen">{requestedRunScreen ?? "none"}</span>
    </div>
  );
}

function Harness({ run }: { run?: string }) {
  return (
    <ErrorProvider>
      <ErrorAlert />
      <NavigationProvider
        initialView="run"
        {...(run ? { initialRunScreen: run } : {})}
      >
        <RunScreenView />
        <NavigationProbe />
      </NavigationProvider>
    </ErrorProvider>
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  wire.calls.length = 0;
  wire.handlers.clear();
});

describe("RunScreenView", () => {
  it("renders the deep-linked run and consumes the link once", async () => {
    wire.handlers.set(`/runs/${runId}`, () => job());
    wire.handlers.set(`/artifacts/${runId}/result.json`, () => result());

    render(<Harness run={runId} />);

    await waitFor(() =>
      expect(element("runTitle").textContent).toBe("fixture/app · PR #1")
    );
    // The link became the run of this screen: it is consumed, not left pending
    // for a later mount to re-open the same run.
    expect(element("probeRequestedRunScreen").textContent).toBe("none");
    expect(
      screen.getByRole("button", { name: "Ouvrir dans l’historique" })
    ).toBeVisible();
    expect(wire.calls.filter((path) => path === `/runs/${runId}`)).toHaveLength(
      1
    );
    expect(element("detail")).not.toHaveAttribute("hidden");
  });

  it("keeps the run when StrictMode replays the subscription", async () => {
    wire.handlers.set(`/runs/${runId}`, () => job());

    render(
      <StrictMode>
        <Harness run={runId} />
      </StrictMode>
    );

    await waitFor(() =>
      expect(element("runTitle").textContent).toBe("fixture/app · PR #1")
    );
    expect(element("probeRequestedRunScreen").textContent).toBe("none");
  });

  it("explains a missing run instead of an empty screen", () => {
    render(<Harness />);

    expect(element("runScreenMissing").textContent).toBe(
      "Ce test est introuvable : il a peut-être été purgé, ou il appartient à un dépôt auquel vous n’avez pas accès."
    );
    expect(document.getElementById("runScreenSeenIn")).toBeNull();
    expect(document.getElementById("detail")).toBeNull();
    expect(wire.calls).toHaveLength(0);
  });

  it("replaces the detail with the missing state when the run cannot be read", async () => {
    // A syntactically valid link whose run was purged, or belongs to another
    // account: no frame will ever arrive, so the screen must say so rather than
    // leave a detail announcing a connection forever.
    wire.handlers.set(`/runs/${runId}`, () => {
      throw new Error("Not found");
    });
    render(<Harness run={runId} />);

    await waitFor(() =>
      expect(element("runScreenMissing").textContent).toBe(
        "Ce test est introuvable : il a peut-être été purgé, ou il appartient à un dépôt auquel vous n’avez pas accès."
      )
    );
    expect(document.getElementById("detail")).toBeNull();
    expect(document.getElementById("runScreenSeenIn")).toBeNull();
    // The way back stays available: the screen is not a dead end.
    expect(element("runScreenBack")).toBeInTheDocument();
  });

  it("goes back to the history", async () => {
    const user = userEvent.setup();
    wire.handlers.set(`/runs/${runId}`, () => job());
    render(<Harness run={runId} />);
    await waitFor(() =>
      expect(element("runTitle").textContent).toBe("fixture/app · PR #1")
    );

    await user.click(
      screen.getByRole("button", { name: "Retour à l’historique" })
    );

    expect(element("probeView").textContent).toBe("runs");
    // Going back is not a selection: the history opens on what it already had.
    expect(element("probeRequestedRun").textContent).toBe("none");
  });

  it("selects the very run in the history", async () => {
    const user = userEvent.setup();
    wire.handlers.set(`/runs/${runId}`, () => job());
    render(<Harness run={runId} />);
    await waitFor(() =>
      expect(element("runTitle").textContent).toBe("fixture/app · PR #1")
    );

    await user.click(
      screen.getByRole("button", { name: "Ouvrir dans l’historique" })
    );

    expect(element("probeView").textContent).toBe("runs");
    expect(element("probeRequestedRun").textContent).toBe(runId);
  });
});
