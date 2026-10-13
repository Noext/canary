import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { RunDetail } from "./run-detail";

const apiMock = vi.fn();

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/client")>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

const RUN_ID = "11111111-1111-1111-1111-111111111111";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  readyState = 0;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

const job = (overrides: Record<string, unknown> = {}) => ({
  cancel_requested: false,
  created_at: "2026-01-01T00:00:00.000Z",
  id: RUN_ID,
  input: { model: "model-x" },
  outcome: "passed",
  owner: "admin",
  pr: 1,
  repo: "fixture/app",
  sha: "1".repeat(40),
  status: "completed",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const result = {
  endedAt: "2026-01-01T00:05:00.000Z",
  id: RUN_ID,
  outcome: "failed",
  prUrl: "https://github.com/fixture/app/pull/1",
  scenarios: [
    {
      artifacts: [],
      assertions: [
        { id: "greeting", passed: true },
        { actual: "Welcome Grace", id: "saved", passed: false },
      ],
      outcome: "failed",
      scenario: {
        assertions: [
          { description: "Le message d'accueil s'affiche", id: "greeting" },
          { description: "Le nom est enregistré", id: "saved" },
        ],
        id: "welcome",
        title: "Submitting the name saves a welcome message",
      },
    },
  ],
  sha: "1".repeat(40),
  startedAt: "2026-01-01T00:00:00.000Z",
};

function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`#${id} is missing from the run detail`);
  }
  return node;
}

/** A run the server stopped, with the fields the diagnostic block reads. */
function mockBlocked(
  resultOverrides: Record<string, unknown>,
  jobOverrides: Record<string, unknown> = {}
) {
  apiMock.mockImplementation((path: string) => {
    if (path.endsWith("/result.json")) {
      return Promise.resolve({
        ...result,
        outcome: "blocked",
        ...resultOverrides,
      });
    }
    return Promise.resolve(
      job({
        outcome: "blocked",
        progress: { phase: "preview" },
        status: "failed",
        ...jobOverrides,
      })
    );
  });
}

function renderDetail(onUpdate?: () => void) {
  return render(
    <ErrorProvider>
      <ErrorAlert />
      <RunDetail canWrite onUpdate={onUpdate} runId={RUN_ID} />
    </ErrorProvider>
  );
}

beforeEach(() => {
  apiMock.mockReset();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RunDetail", () => {
  it("renders every executed assertion, labelled by the planned one", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/result.json")) {
        return Promise.resolve(result);
      }
      return Promise.resolve(job());
    });
    renderDetail();
    await waitFor(() =>
      expect(screen.getByText("1/2 assertions validées")).toBeVisible()
    );
    expect(screen.getByText("Le message d'accueil s'affiche")).toBeVisible();
    // A failed assertion exposes what the browser actually observed.
    expect(
      screen.getByText("Le nom est enregistré — Welcome Grace")
    ).toBeVisible();
  });

  it("does not open an event stream for a finished run", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/result.json")) {
        return Promise.resolve(result);
      }
      return Promise.resolve(job());
    });
    renderDetail();
    await waitFor(() =>
      expect(screen.getByText("Suivi terminé")).toBeVisible()
    );
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("renders the usage line through the shared copy", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/result.json")) {
        return Promise.resolve({
          ...result,
          usage: {
            calls: 2,
            costUsd: 0.5,
            pricingConfigured: true,
            tokens: 1200,
          },
        });
      }
      return Promise.resolve(job());
    });
    renderDetail();
    await waitFor(() =>
      expect(
        screen.getByText("1200 tokens · coût estimé $0.5000")
      ).toBeVisible()
    );
  });

  it("says the cost is not configured when the server has no pricing", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/result.json")) {
        return Promise.resolve({
          ...result,
          usage: { costUsd: 0, pricingConfigured: false, tokens: 900 },
        });
      }
      return Promise.resolve(job());
    });
    renderDetail();
    await waitFor(() =>
      expect(screen.getByText("900 tokens · coût non configuré")).toBeVisible()
    );
  });

  it("does not claim an estimate when pricing was never recorded", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/result.json")) {
        // A result persisted before `pricingConfigured` existed: absent, not
        // false. Nothing proves a tariff was configured.
        return Promise.resolve({
          ...result,
          usage: { costUsd: 0.5, tokens: 1200 },
        });
      }
      return Promise.resolve(job());
    });
    renderDetail();
    await waitFor(() =>
      expect(screen.getByText("1200 tokens · coût non configuré")).toBeVisible()
    );
  });

  it("refreshes the history when a run is already finished", async () => {
    const onUpdate = vi.fn();
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/result.json")) {
        return Promise.resolve(result);
      }
      return Promise.resolve(job());
    });
    renderDetail(onUpdate);
    // No stream fires for a finished run, so this callback is the only chance
    // for the table to drop its stale "en cours" row.
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  });

  it("follows a running run once the run is validated", async () => {
    apiMock.mockResolvedValue(job({ outcome: undefined, status: "running" }));
    renderDetail();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]?.url).toBe(`/runs/${RUN_ID}/events`);
  });

  it("never streams a run the account cannot read", async () => {
    apiMock.mockRejectedValue(new Error("Run not found"));
    renderDetail();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Run not found")
    );
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

describe("RunDetail diagnostic", () => {
  it("gives the server code, its message and the next step of a blocked run", async () => {
    mockBlocked({
      diagnostic: {
        code: "PREVIEW_SHA_MISMATCH",
        hint: "Redéployez la version de test sur le commit attendu, puis relancez.",
        message:
          "La version servie ne porte pas le SHA complet de la pull request.",
      },
    });
    renderDetail();

    await waitFor(() => expect(element("runDiagnostic")).toBeVisible());
    expect(element("runDiagnostic").textContent).toContain(
      "Pourquoi ce test n’est pas allé au bout"
    );
    // A stopped run is an error, not a warning: the block never plays it down.
    expect(element("runDiagnostic").className).toContain("border-destructive");
    expect(element("runDiagnosticCode").textContent).toBe(
      "Code : PREVIEW_SHA_MISMATCH"
    );
    expect(element("runDiagnostic").textContent).toContain(
      "La version servie ne porte pas le SHA complet de la pull request."
    );
    expect(element("runDiagnosticHint").textContent).toBe(
      "À faire : Redéployez la version de test sur le commit attendu, puis relancez."
    );
    // The phase belongs to the job: it is what says how far the run got.
    expect(element("runDiagnosticPhase").textContent).toBe(
      "Phase atteinte : Vérification de la version de votre application"
    );
  });

  it("gives the generic next step when the report carries no diagnostic", async () => {
    // An older report omits the field, a replayed one may carry null: both mean
    // the server recorded no cause, so both get the same advice.
    for (const diagnostic of [undefined, null]) {
      mockBlocked({ diagnostic });
      const view = renderDetail();

      await waitFor(() => expect(element("runDiagnostic")).toBeVisible());
      expect(element("runDiagnosticHint").textContent).toBe(
        "Relancez un test sur le même commit après avoir corrigé la cause, ou ouvrez le rapport pour le déroulé complet."
      );
      expect(document.getElementById("runDiagnosticCode")).toBeNull();
      view.unmount();
    }
  });

  it("omits the reached phase when the job has not reported one", async () => {
    mockBlocked(
      {
        diagnostic: {
          code: "PREVIEW_SHA_MISMATCH",
          hint: "Redéployez la version de test sur le commit attendu, puis relancez.",
          message:
            "La version servie ne porte pas le SHA complet de la pull request.",
        },
      },
      { progress: undefined }
    );
    renderDetail();

    await waitFor(() => expect(element("runDiagnostic")).toBeVisible());
    expect(document.getElementById("runDiagnosticPhase")).toBeNull();
  });

  it("repeats the diagnostic of the scenarios that stopped on an error", async () => {
    mockBlocked({
      scenarios: [
        {
          artifacts: [],
          diagnostic: {
            code: "SCENARIO_STEP_FAILED",
            hint: "Vérifiez le formulaire de connexion.",
            message: "Le clic est resté sans effet.",
          },
          error: "Le bouton de connexion n’a pas répondu",
          outcome: "failed",
          scenario: { id: "login", title: "Connexion" },
        },
        {
          artifacts: [],
          outcome: "passed",
          scenario: { id: "welcome", title: "Accueil" },
        },
      ],
    });
    renderDetail();

    await waitFor(() => expect(element("runDiagnostic")).toBeVisible());
    const block = element("runDiagnostic").textContent ?? "";
    // Only the scenario that really stopped is counted and listed.
    expect(block).toContain("1 scénario s’est arrêté sur une erreur");
    expect(block).toContain("Connexion");
    expect(block).toContain("Le bouton de connexion n’a pas répondu");
    expect(block).toContain("À faire : Vérifiez le formulaire de connexion.");
    expect(block).not.toContain("Accueil");
  });

  it("shows no diagnostic for a run that passed", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/result.json")) {
        return Promise.resolve({
          ...result,
          diagnostic: null,
          outcome: "passed",
          scenarios: [],
        });
      }
      return Promise.resolve(job({ outcome: "passed", status: "completed" }));
    });
    renderDetail();

    await waitFor(() => expect(element("resultSummary")).toBeVisible());
    expect(document.getElementById("runDiagnostic")).toBeNull();
  });
});
