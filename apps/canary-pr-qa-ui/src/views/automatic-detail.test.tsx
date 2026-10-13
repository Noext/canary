import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardError } from "@/api/client";
import type { AutomaticDetail } from "@/api/contracts";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { NavigationProvider, useNavigation } from "@/app/navigation";
import { automaticAdvice, automaticDetail, automaticReasons } from "@/i18n";
import { AutomaticDetailView } from "./automatic-detail";
import { createAutomaticDetailStore } from "./automatic-detail-store";

const session = vi.hoisted(() => ({ canWrite: true, isAdmin: true }));

vi.mock("@/app/session", () => ({
  useSession: () => ({ canWrite: session.canWrite, isAdmin: session.isAdmin }),
}));

const wire = vi.hoisted(() => ({
  calls: [] as string[],
  handler: undefined as ((path: string) => unknown) | undefined,
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: (path: string) => {
      wire.calls.push(path);
      const handler = wire.handler;
      // Resolve in a task so a throwing handler becomes a rejection, exactly
      // like the real client.
      return handler
        ? Promise.resolve().then(() => handler(path))
        : Promise.reject(new Error(`Unexpected api call: ${path}`));
    },
  };
});

const DELIVERY_ID = "delivery-1";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function detail(overrides: Partial<AutomaticDetail> = {}): AutomaticDetail {
  return {
    attempt: {
      attempts: 3,
      deadlineAt: "2026-01-02T04:00:00.000Z",
      id: DELIVERY_ID,
      pr: 42,
      reason: "PREVIEW_NOT_FOUND",
      repo: "fixture/app",
      runId: null,
      sha: SHA,
      state: "expired",
      updatedAt: "2026-01-02T03:04:05.000Z",
    },
    timeline: [],
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
  const { requestedAutomatic, view } = useNavigation();
  return <p data-testid="route">{`${view}:${requestedAutomatic ?? ""}`}</p>;
}

function Harness({
  children,
  initialAutomatic,
}: {
  children?: ReactNode;
  initialAutomatic?: string;
}) {
  return (
    <ErrorProvider>
      <ErrorAlert />
      <NavigationProvider
        {...(initialAutomatic ? { initialAutomatic } : {})}
        initialView={initialAutomatic ? "automatic" : "home"}
      >
        {children}
        <RouteProbe />
      </NavigationProvider>
    </ErrorProvider>
  );
}

beforeEach(() => {
  session.canWrite = true;
  session.isAdmin = true;
  wire.calls.length = 0;
  wire.handler = undefined;
  window.scrollTo = vi.fn();
});

afterEach(cleanup);

describe("createAutomaticDetailStore", () => {
  it("reads the requested id once and clears the pending link", async () => {
    wire.handler = () => detail();
    const consumeRequest = vi.fn(() => undefined);
    const store = createAutomaticDetailStore({
      consumeRequest,
      report: vi.fn(),
      requested: DELIVERY_ID,
    });

    // The link is consumed at construction, before any subscription.
    expect(consumeRequest).toHaveBeenCalledTimes(1);

    const release = store.subscribe(() => undefined);
    await waitFor(() =>
      expect(wire.calls).toContain(`/dashboard/automatic/${DELIVERY_ID}`)
    );
    release();
  });

  it("falls back to the consumer when no id was passed", async () => {
    wire.handler = () => detail();
    const consumeRequest = vi.fn(() => DELIVERY_ID);
    const store = createAutomaticDetailStore({
      consumeRequest,
      report: vi.fn(),
    });

    expect(consumeRequest).toHaveBeenCalledTimes(1);

    store.subscribe(() => undefined);
    await waitFor(() =>
      expect(wire.calls).toContain(`/dashboard/automatic/${DELIVERY_ID}`)
    );
  });

  it("agrees a linkless screen is missing without issuing a call", async () => {
    const consumeRequest = vi.fn(() => undefined);
    const store = createAutomaticDetailStore({
      consumeRequest,
      report: vi.fn(),
    });

    expect(store.getSnapshot().missing).toBe(true);
    expect(store.getSnapshot().loading).toBe(false);

    store.subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wire.calls).toEqual([]);
  });

  it("reads AUTOMATIC_UNKNOWN as missing rather than only an error", async () => {
    wire.handler = () => {
      throw new DashboardError("Tentative inconnue", {
        code: "AUTOMATIC_UNKNOWN",
      });
    };
    const report = vi.fn();
    const store = createAutomaticDetailStore({
      consumeRequest: () => DELIVERY_ID,
      report,
    });

    store.subscribe(() => undefined);
    await waitFor(() => expect(store.getSnapshot().missing).toBe(true));
    expect(store.getSnapshot().loading).toBe(false);
    // A purged attempt is a state, not a breakdown to raise in the alert.
    expect(report).not.toHaveBeenCalled();
  });
});

describe("AutomaticDetailView", () => {
  it("shows the missing notice and returns home when no link was requested", async () => {
    const user = userEvent.setup();
    render(
      <Harness>
        <AutomaticDetailView />
      </Harness>
    );

    await waitFor(() =>
      expect(byId("automaticDetailState")).toHaveTextContent(
        automaticDetail.missing
      )
    );
    expect(wire.calls).toEqual([]);

    await user.click(byId("automaticDetailBack"));
    expect(screen.getByTestId("route")).toHaveTextContent("home:");
  });

  it("renders the cause, the advice and the probe facts", async () => {
    wire.handler = () => detail();
    render(
      <Harness initialAutomatic={DELIVERY_ID}>
        <AutomaticDetailView />
      </Harness>
    );

    await waitFor(() =>
      expect(byId("automaticDetailCause")).toHaveTextContent(
        automaticReasons.PREVIEW_NOT_FOUND!
      )
    );
    expect(byId("automaticDetailAdvice")).toHaveTextContent(
      automaticAdvice.PREVIEW_NOT_FOUND!
    );
    expect(byId("automaticDetailFacts")).toHaveTextContent("3 vérifications");
    expect(byId("automaticDetailFacts")).toHaveTextContent(SHA);
    // The deep link is consumed: nothing would resurrect this screen.
    expect(screen.getByTestId("route")).toHaveTextContent("automatic:");
  });

  it("orders the timeline from the oldest step to the most recent", async () => {
    wire.handler = () =>
      detail({
        timeline: [
          {
            action: "automatic.preview_expired",
            at: "2026-01-02T05:00:00.000Z",
          },
          {
            action: "automatic.preview_wait",
            at: "2026-01-02T03:00:00.000Z",
            seconds: 30,
          },
        ],
      });
    render(
      <Harness initialAutomatic={DELIVERY_ID}>
        <AutomaticDetailView />
      </Harness>
    );

    await waitFor(() =>
      expect(
        within(byId("automaticDetailTimeline")).getAllByRole("listitem")
      ).toHaveLength(2)
    );
    const steps = within(byId("automaticDetailTimeline")).getAllByRole(
      "listitem"
    );
    expect(steps[0]).toHaveTextContent("nouvelle vérification programmée");
    expect(steps[0]).toHaveTextContent("30 s");
    expect(steps[1]).toHaveTextContent("Délai d’attente dépassé");
  });

  it("renders a waiting attempt as waiting, not as a failure", async () => {
    wire.handler = () =>
      detail({
        attempt: { ...detail().attempt, state: "waiting" },
      });
    render(
      <Harness initialAutomatic={DELIVERY_ID}>
        <AutomaticDetailView />
      </Harness>
    );

    await waitFor(() =>
      expect(byId("automaticDetailWaiting")).toHaveTextContent(
        automaticDetail.waiting
      )
    );
  });

  it("hides the preview block from a viewer who receives no topology", async () => {
    wire.handler = () => detail();
    render(
      <Harness initialAutomatic={DELIVERY_ID}>
        <AutomaticDetailView />
      </Harness>
    );

    await waitFor(() =>
      expect(byId("automaticDetailTimeline")).toBeInTheDocument()
    );
    expect(document.getElementById("automaticDetailPreview")).toBeNull();
  });

  it("shows the preview proof to an administrator who receives it", async () => {
    wire.handler = () =>
      detail({
        preview: {
          shaHeader: "x-commit-sha",
          shaPath: "/version",
          template: "https://preview.example.com",
        },
      });
    render(
      <Harness initialAutomatic={DELIVERY_ID}>
        <AutomaticDetailView />
      </Harness>
    );

    await waitFor(() =>
      expect(byId("automaticDetailPreview")).toHaveTextContent(
        automaticDetail.previewHeader("x-commit-sha")
      )
    );
    expect(byId("automaticDetailPreview")).toHaveTextContent(
      automaticDetail.previewPath("/version")
    );
  });

  it("points a promoted attempt at its run screen without still waiting", async () => {
    const user = userEvent.setup();
    // The delivery left the list when it was promoted: the state it is opened
    // with must say so instead of reusing the list's `waiting` fallback.
    wire.handler = () =>
      detail({
        attempt: { ...detail().attempt, runId: "run-9", state: "promoted" },
      });
    render(
      <Harness initialAutomatic={DELIVERY_ID}>
        <AutomaticDetailView />
      </Harness>
    );

    await waitFor(() =>
      expect(byId("automaticDetailPromoted")).toHaveTextContent(
        automaticDetail.promoted
      )
    );
    expect(byId("automaticDetailPill")).toHaveTextContent("Test lancé");
    expect(document.getElementById("automaticDetailWaiting")).toBeNull();
    await user.click(byId("automaticDetailRunCta"));
    expect(screen.getByTestId("route")).toHaveTextContent("run:");
  });

  it("does not keep advising a deploy once the run has started", async () => {
    // A promoted attempt kept the reason of the probes that failed before it, so
    // rendering the cause and the advice would tell the operator to deploy and
    // launch a test that is already running.
    wire.handler = () =>
      detail({
        attempt: {
          ...detail().attempt,
          reason: "PREVIEW_NOT_FOUND",
          runId: "run-9",
          state: "promoted",
        },
      });
    render(
      <Harness initialAutomatic={DELIVERY_ID}>
        <AutomaticDetailView />
      </Harness>
    );

    await waitFor(() =>
      expect(byId("automaticDetailPromoted")).toBeInTheDocument()
    );
    expect(document.getElementById("automaticDetailCause")).toBeNull();
    expect(document.getElementById("automaticDetailAdvice")).toBeNull();
    expect(document.getElementById("automaticDetailFacts")).toBeNull();
    // The history of the probes is still there: that is where it belongs.
    expect(byId("automaticDetailTimeline")).toBeInTheDocument();
  });

  it("tells a viewer what a refused attempt is instead of still waiting", async () => {
    wire.handler = () =>
      detail({
        attempt: {
          ...detail().attempt,
          reason: "AUTO_RUNS_DISABLED",
          state: "disabled",
        },
      });
    render(
      <Harness initialAutomatic={DELIVERY_ID}>
        <AutomaticDetailView />
      </Harness>
    );

    await waitFor(() =>
      expect(byId("automaticDetailPill")).toHaveTextContent(
        "Lancements désactivés"
      )
    );
    expect(document.getElementById("automaticDetailWaiting")).toBeNull();
  });

  it("explains a discarded attempt without reusing a stale reason", async () => {
    wire.handler = () =>
      detail({
        attempt: {
          ...detail().attempt,
          reason: "PREVIEW_NOT_FOUND",
          state: "discarded",
        },
      });
    render(
      <Harness initialAutomatic={DELIVERY_ID}>
        <AutomaticDetailView />
      </Harness>
    );

    await waitFor(() =>
      expect(byId("automaticDetailDiscarded")).toHaveTextContent(
        automaticDetail.discarded
      )
    );
    expect(document.getElementById("automaticDetailCause")).toBeNull();
    expect(document.getElementById("automaticDetailAdvice")).toBeNull();
  });

  it("offers a viewer the guidance instead of an action it cannot open", async () => {
    session.canWrite = false;
    wire.handler = () => detail();
    render(
      <Harness initialAutomatic={DELIVERY_ID}>
        <AutomaticDetailView />
      </Harness>
    );

    await waitFor(() =>
      expect(byId("automaticDetailRunViewer")).toHaveTextContent(
        automaticDetail.runViewer
      )
    );
    // `Nouveau test` is refused to a viewer by the navigation guard, so the
    // button would bounce them home without ever saying why.
    expect(document.getElementById("automaticDetailRunCta")).toBeNull();
  });

  it("keeps StrictMode's double subscription to a single call", async () => {
    wire.handler = () => detail();
    render(
      <StrictMode>
        <Harness initialAutomatic={DELIVERY_ID}>
          <AutomaticDetailView />
        </Harness>
      </StrictMode>
    );

    await waitFor(() =>
      expect(byId("automaticDetailCause")).toBeInTheDocument()
    );
    expect(
      wire.calls.filter(
        (path) => path === `/dashboard/automatic/${DELIVERY_ID}`
      )
    ).toHaveLength(1);
  });
});
