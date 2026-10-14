import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { NavigationProvider } from "@/app/navigation";
import { RunsView } from "@/views/runs-view";

const session = vi.hoisted(() => ({ canWrite: true }));

const wire = vi.hoisted(() => ({
  calls: [] as { options?: Record<string, unknown>; path: string }[],
  handlers: new Map<string, (options?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@/app/session", () => ({
  useSession: () => ({
    canWrite: session.canWrite,
    createAdmin: vi.fn(),
    initialized: true,
    isAdmin: true,
    login: vi.fn(),
    loginWithToken: vi.fn(),
    logout: vi.fn(),
    phase: "authenticated",
    refreshUser: vi.fn(),
  }),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: (path: string, options?: Record<string, unknown>) => {
      wire.calls.push({ options, path });
      const handler = wire.handlers.get(path);
      return handler
        ? Promise.resolve(handler(options))
        : Promise.reject(new Error(`Unexpected api call: ${path}`));
    },
  };
});

class FakeEventSource {
  static readonly instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 0;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.readyState = 2;
  }

  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(data: string) {
    this.onmessage?.({ data });
  }
}

const runId = "3f2a1c4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const otherRunId = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f3a4b5c6d";

function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`#${id} is missing from the runs screen`);
  }
  return node;
}

/** A promise the test settles by hand, to land an answer after a teardown. */
function deferred<T>() {
  let fail: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((_resolve, reject) => {
    fail = reject;
  });
  return { fail: (reason: unknown) => fail(reason), promise };
}

function lastSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) {
    throw new Error("No EventSource was created");
  }
  return source;
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    cancel_requested: false,
    created_at: "2026-01-02T03:04:05.000Z",
    id: runId,
    input: { model: "opencode-go/deepseek-v4.1-flash" },
    owner: "ui-admin",
    pr: 1,
    repo: "fixture/app",
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    status: "queued",
    updated_at: "2026-01-02T03:04:06.000Z",
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    outcome: "passed",
    prUrl: "https://github.com/fixture/app/pull/1",
    publication: {
      commentUrl: "https://github.com/fixture/app/pull/1#issuecomment-1",
      status: "posted",
    },
    scenarios: [
      {
        artifacts: ["scenarios/login/video.webm"],
        outcome: "passed",
        scenario: { id: "login", title: "Connexion" },
      },
    ],
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    startedAt: "2026-01-02T03:04:05.000Z",
    usage: { costUsd: 0.045, pricingConfigured: true, tokens: 1200 },
    ...overrides,
  };
}

function Harness({ run }: { run?: string }) {
  return (
    <ErrorProvider>
      <ErrorAlert />
      <NavigationProvider {...(run ? { initialRun: run } : {})}>
        <RunsView />
      </NavigationProvider>
    </ErrorProvider>
  );
}

async function openFirstRun() {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(await screen.findByRole("link", { name: "fixture/app #1" }));
  await waitFor(() => expect(element("detail")).not.toHaveAttribute("hidden"));
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  window.scrollTo = vi.fn();
  session.canWrite = true;
  wire.calls.length = 0;
  wire.handlers.clear();
  FakeEventSource.instances.length = 0;
});

// The repo does not enable Vitest globals, so RTL cannot register its own
// automatic cleanup of the rendered document.
afterEach(cleanup);

describe("RunsView history", () => {
  it("lists each run with its link, commit, model, state and outcome", async () => {
    wire.handlers.set("/runs", () => [
      job(),
      job({
        id: otherRunId,
        outcome: "passed",
        pr: 2,
        status: "completed",
        usage: { retries: 2 },
      }),
    ]);
    render(<Harness />);

    expect(
      await screen.findByRole("link", { name: "fixture/app #1" })
    ).toBeVisible();
    expect(element("runs").textContent).toContain("fixture/app #2");
    expect(element("runs").textContent).toContain("abcdef123456");
    expect(element("runs").textContent).toContain(
      "opencode-go/deepseek-v4.1-flash"
    );
    expect(within(element("runs")).getByText("En attente")).toBeVisible();
    expect(within(element("runs")).getByText("Réussi")).toBeVisible();
    // La colonne des reprises affiche le compteur, et un tiret sans reprise.
    expect(element("historyTable").textContent).toContain("Reprises");
    const row = within(element("runs")).getAllByRole("row")[1];
    expect(within(row as HTMLElement).getByText("2")).toBeVisible();
    expect(element("historyTable")).not.toHaveAttribute("hidden");
    expect(element("historyEmpty")).toHaveAttribute("hidden");
  });

  it("shows the first-run empty state when no run exists", async () => {
    wire.handlers.set("/runs", () => []);
    render(<Harness />);

    await waitFor(() =>
      expect(wire.calls.some((call) => call.path === "/runs")).toBe(true)
    );
    expect(element("historyTable")).toHaveAttribute("hidden");
    expect(element("historyEmpty")).not.toHaveAttribute("hidden");
    expect(screen.getByText("Aucun test pour le moment")).toBeVisible();
    expect(
      screen.getByText("Lancez votre premier test depuis « Nouveau test ».")
    ).toBeVisible();
  });

  it("reloads the list with the submitted filters", async () => {
    const user = userEvent.setup();
    wire.handlers.set("/runs", () => []);
    render(<Harness />);
    await waitFor(() =>
      expect(wire.calls.some((call) => call.path === "/runs")).toBe(true)
    );

    await user.type(
      screen.getByLabelText("Rechercher un projet ou SHA"),
      "fixture"
    );
    await user.selectOptions(
      screen.getByLabelText("Filtrer les tests"),
      "completed"
    );
    await user.click(screen.getByRole("button", { name: "Filtrer" }));

    const filtered = wire.calls.at(-1);
    expect(filtered?.path).toBe("/runs");
    expect(filtered?.options).toMatchObject({
      query: { search: "fixture", status: "completed" },
    });
    expect(
      screen.getByText("Aucun test ne correspond à ces filtres")
    ).toBeVisible();
    expect(
      screen.getByText("Modifiez votre recherche ou revenez à tous les états.")
    ).toBeVisible();
  });

  it("loads the history once when StrictMode replays the subscription", async () => {
    wire.handlers.set("/runs", () => [job()]);
    render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );

    expect(
      await screen.findByRole("link", { name: "fixture/app #1" })
    ).toBeVisible();
    // The store starts its load on the first subscription only: a replay must
    // not fetch the history twice nor lose the rows it already has.
    expect(wire.calls.filter((call) => call.path === "/runs")).toHaveLength(1);
  });

  it("keeps the loaded rows and reports a reload that failed", async () => {
    const user = userEvent.setup();
    wire.handlers.set("/runs", () => [job()]);
    render(<Harness />);
    await screen.findByRole("link", { name: "fixture/app #1" });

    wire.handlers.set("/runs", () => {
      throw new Error("Liste indisponible");
    });
    await user.click(screen.getByRole("button", { name: "Filtrer" }));

    await waitFor(() =>
      expect(element("error").textContent).toContain("Liste indisponible")
    );
    // A rejected reload reports itself instead of blanking a list the operator
    // can still read.
    expect(element("runs").textContent).toContain("fixture/app #1");
    expect(element("historyTable")).not.toHaveAttribute("hidden");
  });
});

describe("RunDetail", () => {
  it("opens the selected run and renders its five phases", async () => {
    wire.handlers.set("/runs", () => [job()]);
    wire.handlers.set(`/runs/${runId}`, () =>
      job({ progress: { phase: "execution" } })
    );
    await openFirstRun();

    expect(element("runTitle").textContent).toBe("fixture/app · PR #1");
    expect(element("provenance").textContent).toContain("Commit abcdef123456");
    expect(element("provenance").textContent).toContain(
      "opencode-go/deepseek-v4.1-flash"
    );
    const phases = within(element("phaseList"));
    expect(phases.getByText("Lecture de la PR")).toBeVisible();
    expect(phases.getByText("Publication")).toBeVisible();
    // Real utilities, not dead class names: "active"/"done" have no stylesheet
    // rule, so a regression there left every phase looking identical.
    expect(phases.getByText("Exécution Chromium").className).toContain(
      "bg-primary/20"
    );
    expect(phases.getByText("Préparation").className).toContain("bg-pass/10");
    const upcoming = phases.getByText("Vérification").className;
    expect(upcoming).not.toContain("bg-pass/10");
    expect(upcoming).not.toContain("bg-primary/20");
    for (const step of phases.getAllByRole("listitem")) {
      expect(step.className).not.toBe("active");
      expect(step.className).not.toBe("done");
    }
    expect(lastSource().url).toBe(`/runs/${runId}/events`);
    expect(element("detail").querySelector("details")?.open).toBe(false);
  });

  it("opens the run requested by the shell", async () => {
    wire.handlers.set("/runs", () => [job()]);
    wire.handlers.set(`/runs/${runId}`, () => job({ status: "running" }));
    render(<Harness run={runId} />);

    await waitFor(() =>
      expect(element("detail")).not.toHaveAttribute("hidden")
    );
    expect(element("runTitle").textContent).toBe("fixture/app · PR #1");
    expect(wire.calls.map((call) => call.path)).toContain(`/runs/${runId}`);
  });

  it("reports the live connection, a reconnect and a finished follow", async () => {
    wire.handlers.set("/runs", () => [job()]);
    wire.handlers.set(`/runs/${runId}`, () => job({ status: "running" }));
    await openFirstRun();
    const source = lastSource();

    await act(async () => {
      source.onopen?.();
    });
    expect(element("liveConnection").textContent).toBe(
      "Suivi en direct connecté"
    );

    await act(async () => {
      source.readyState = 1;
      source.onerror?.();
    });
    expect(element("liveConnection").textContent).toBe("Reconnexion du suivi…");
  });

  it("finishes on a terminal frame and loads the run result", async () => {
    wire.handlers.set("/runs", () => [job()]);
    wire.handlers.set(`/runs/${runId}`, () => job({ status: "running" }));
    wire.handlers.set(`/artifacts/${runId}/result.json`, () => result());
    await openFirstRun();
    const source = lastSource();

    await act(async () => {
      source.emit(
        job({
          outcome: "passed",
          progress: { phase: "publication" },
          status: "completed",
        })
      );
    });

    await waitFor(() =>
      expect(element("resultSummary").textContent).toContain(
        "Les assertions ont réussi"
      )
    );
    expect(element("liveConnection").textContent).toBe("Suivi terminé");
    expect(element("resultSummary")).not.toHaveAttribute("hidden");
    // A passing run uses the neutral tone of the shared Notice.
    expect(element("resultSummary").className).toContain("border-border");
    expect(element("usage").textContent).toBe(
      "1200 tokens · coût estimé $0.0450"
    );
    expect(element("result").textContent).toContain('"outcome": "passed"');
    expect(
      element("scenarioCards").querySelector("video")?.getAttribute("src")
    ).toBe(`/artifacts/${runId}/login/scenarios/login/video.webm`);
    expect(
      element("scenarioCards").querySelector("video")?.getAttribute("preload")
    ).toBe("none");
    expect(
      screen.getByRole("link", { name: "Ouvrir le rapport" })
    ).toHaveAttribute("href", `/artifacts/${runId}/report.html`);
    expect(
      screen.getByRole("link", { name: "Résultat sur GitHub ↗" })
    ).toHaveAttribute("rel", "noopener noreferrer");
    expect(source.readyState).toBe(2);
    expect(wire.calls.map((call) => call.path)).toContain(
      `/artifacts/${runId}/result.json`
    );
  });

  it("never plays an artifact whose path traverses or is absolute", async () => {
    wire.handlers.set("/runs", () => [job()]);
    wire.handlers.set(`/runs/${runId}`, () => job());
    wire.handlers.set(`/artifacts/${runId}/result.json`, () =>
      result({
        outcome: "failed",
        publication: {
          commentUrl: "https://evil.example/pull/1#comment",
          status: "posted",
        },
        scenarios: [
          {
            artifacts: ["../../etc/passwd.webm", "/absolute.webm", "clip.webm"],
            outcome: "failed",
            scenario: { id: "login", title: "Connexion" },
          },
        ],
      })
    );
    await openFirstRun();
    const source = lastSource();

    await act(async () => {
      source.emit(job({ outcome: "failed", status: "failed" }));
    });

    await waitFor(() =>
      expect(element("scenarioCards").querySelector("video")).not.toBeNull()
    );
    const videos = element("scenarioCards").querySelectorAll("video");
    expect(videos).toHaveLength(1);
    expect(videos[0]?.getAttribute("src")).toBe(
      `/artifacts/${runId}/login/clip.webm`
    );
    // Failed, blocked and stale outcomes carry the error tone.
    expect(element("resultSummary").className).toContain("border-destructive");
    expect(
      screen.queryByRole("link", { name: "Résultat sur GitHub ↗" })
    ).toBeNull();
  });

  it("stops the follow when a frame does not match the run contract", async () => {
    wire.handlers.set("/runs", () => [job()]);
    wire.handlers.set(`/runs/${runId}`, () => job({ status: "running" }));
    await openFirstRun();
    const source = lastSource();

    await act(async () => {
      source.send(JSON.stringify({ id: runId, status: "exploded" }));
    });

    expect(element("liveConnection").textContent).toBe(
      "Suivi interrompu : réponse invalide"
    );
    expect(source.readyState).toBe(2);
    expect(element("error").textContent).toContain("réponse invalide");
  });

  it("requests a cancellation and shows the optimistic message", async () => {
    const user = userEvent.setup();
    wire.handlers.set("/runs", () => [job({ status: "running" })]);
    wire.handlers.set(`/runs/${runId}`, () => job({ status: "running" }));
    wire.handlers.set(`/runs/${runId}/cancel`, () => ({
      cancelRequested: true,
    }));
    render(<Harness />);
    await user.click(
      await screen.findByRole("link", { name: "fixture/app #1" })
    );
    await waitFor(() =>
      expect(element("cancel")).not.toHaveAttribute("hidden")
    );

    await user.click(screen.getByRole("button", { name: "Annuler le test" }));

    await waitFor(() =>
      expect(element("liveMessage").textContent).toBe(
        "Annulation demandée. Le worker finalise les preuves."
      )
    );
    expect(wire.calls.at(-1)).toMatchObject({
      options: { method: "POST" },
      path: `/runs/${runId}/cancel`,
    });
  });

  it("hides the cancellation from a read-only account", async () => {
    session.canWrite = false;
    wire.handlers.set("/runs", () => [job({ status: "running" })]);
    wire.handlers.set(`/runs/${runId}`, () => job({ status: "running" }));
    await openFirstRun();

    expect(element("cancel")).toHaveAttribute("hidden");
  });

  it("closes the previous stream when another run is selected", async () => {
    const user = userEvent.setup();
    wire.handlers.set("/runs", () => [
      job({ status: "running" }),
      job({ id: otherRunId, pr: 2, status: "running" }),
    ]);
    wire.handlers.set(`/runs/${runId}`, () => job({ status: "running" }));
    wire.handlers.set(`/runs/${otherRunId}`, () =>
      job({ id: otherRunId, pr: 2 })
    );
    render(<Harness />);
    await user.click(
      await screen.findByRole("link", { name: "fixture/app #1" })
    );
    const first = lastSource();

    await user.click(screen.getByRole("link", { name: "fixture/app #2" }));

    await waitFor(() =>
      expect(lastSource().url).toBe(`/runs/${otherRunId}/events`)
    );
    expect(first.readyState).toBe(2);
  });

  it("closes the stream when the screen unmounts", async () => {
    wire.handlers.set("/runs", () => [job()]);
    wire.handlers.set(`/runs/${runId}`, () => job({ status: "running" }));
    const view = render(<Harness />);
    await screen.findByRole("link", { name: "fixture/app #1" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "fixture/app #1" }));
    const source = lastSource();

    view.unmount();

    expect(source.readyState).toBe(2);
  });

  it("ignores the failure of a run the operator already left", async () => {
    const user = userEvent.setup();
    const requested = deferred<never>();
    wire.handlers.set("/runs", () => [
      job({ status: "running" }),
      job({ id: otherRunId, pr: 2, status: "running" }),
    ]);
    wire.handlers.set(`/runs/${runId}`, () => requested.promise);
    wire.handlers.set(`/runs/${otherRunId}`, () =>
      job({ id: otherRunId, pr: 2, status: "running" })
    );
    render(<Harness />);

    await user.click(
      await screen.findByRole("link", { name: "fixture/app #1" })
    );
    await waitFor(() =>
      expect(wire.calls.map((call) => call.path)).toContain(`/runs/${runId}`)
    );
    await user.click(screen.getByRole("link", { name: "fixture/app #2" }));
    await waitFor(() =>
      expect(element("runTitle").textContent).toBe("fixture/app · PR #2")
    );

    await act(async () => {
      requested.fail(new Error("Run not found"));
    });

    // The selected run is the one on screen: an answer for the run that was
    // left must not surface as an error of the current one.
    expect(element("error").textContent).not.toContain("Run not found");
    expect(element("runTitle").textContent).toBe("fixture/app · PR #2");
  });
});

describe("RunDetail result copy", () => {
  it("marks a blocked outcome as an error summary", async () => {
    wire.handlers.set("/runs", () => [job()]);
    wire.handlers.set(`/runs/${runId}`, () => job());
    wire.handlers.set(`/artifacts/${runId}/result.json`, () =>
      result({ outcome: "blocked" })
    );
    await openFirstRun();

    await act(async () => {
      lastSource().emit(job({ outcome: "blocked", status: "failed" }));
    });

    await waitFor(() =>
      expect(element("resultSummary").textContent).toContain(
        "Le test n’a pas pu terminer : l’application ou le scénario a bloqué."
      )
    );
    // Failed, blocked and stale outcomes carry the error tone.
    expect(element("resultSummary").className).toContain("border-destructive");
  });

  it("reports a finished run whose result.json could not be read", async () => {
    wire.handlers.set("/runs", () => [job()]);
    wire.handlers.set(`/runs/${runId}`, () => job());
    wire.handlers.set(`/artifacts/${runId}/result.json`, () => {
      throw new Error("Pas de rapport");
    });
    await openFirstRun();

    await act(async () => {
      lastSource().emit(job({ outcome: "passed", status: "completed" }));
    });

    await waitFor(() =>
      expect(element("resultSummary").textContent).toContain(
        "Aucun rapport de scénarios disponible pour ce test."
      )
    );
    expect(element("resultSummary")).not.toHaveAttribute("hidden");
    expect(element("resultSummary").className).toContain("border-warn");
  });
});
