import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardError } from "@/api/client";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { runs as copy, errorMessages, runAdvice, runScreen } from "@/i18n";
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
      artifacts: ["report.html", "trace.zip"],
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
  Reflect.deleteProperty(navigator, "clipboard");
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

  it("links each scenario to its Canary session report", async () => {
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
    // The session report is the scenario's own page (steps, commands, console,
    // network); an authorized user opens it without any raw-evidence setting.
    expect(
      screen.getByRole("link", { name: copy.sessionReport })
    ).toHaveAttribute("href", `/artifacts/${RUN_ID}/welcome/report.html`);
  });

  it("offers no session report to a scenario that never produced one", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/result.json")) {
        // A planning refusal or a lost evidence finalization exports no report.
        return Promise.resolve({
          ...result,
          scenarios: [{ ...result.scenarios[0], artifacts: [] }],
        });
      }
      return Promise.resolve(job());
    });
    renderDetail();
    await waitFor(() =>
      expect(screen.getByText("1/2 assertions validées")).toBeVisible()
    );
    expect(screen.queryByRole("link", { name: copy.sessionReport })).toBeNull();
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

  it("shows the transport retry while the run waits", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/result.json")) {
        return Promise.resolve(result);
      }
      return Promise.resolve(
        job({
          progress: {
            phase: "planning",
            retry: { attempt: 1, code: "ECONNRESET", max: 3 },
          },
          status: "running",
        })
      );
    });
    renderDetail();
    await waitFor(() =>
      expect(
        screen.getByText(
          "Reprise 1/3 de l'appel au modèle après une coupure réseau (ECONNRESET)"
        )
      ).toBeVisible()
    );
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

  it("keeps the worst-case reserve of a lost attempt visible, apart from the spend", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/result.json")) {
        return Promise.resolve({
          ...result,
          usage: {
            calls: 2,
            costUsd: 0.5,
            estimated: true,
            pricingConfigured: true,
            reservedCostUsd: 0.0012,
            reservedTokens: 403_443,
            retries: 1,
            tokens: 36,
          },
        });
      }
      return Promise.resolve(job());
    });
    renderDetail();
    await waitFor(() =>
      expect(
        screen.getByText(
          "36 tokens · coût estimé $0.5000 · 1 reprise · jusqu'à 403443 tokens et $0.0012 d'un essai perdu"
        )
      ).toBeVisible()
    );
  });

  it("names the transport retries when the worker recorded some", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/result.json")) {
        return Promise.resolve({
          ...result,
          usage: {
            calls: 1,
            costUsd: 0,
            pricingConfigured: false,
            retries: 2,
            tokens: 900,
          },
        });
      }
      return Promise.resolve(job());
    });
    renderDetail();
    await waitFor(() =>
      expect(
        screen.getByText("900 tokens · coût non configuré · 2 reprises")
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

  it("keeps an operational failure out of the missing state", async () => {
    // Only a verdict on the run selects the missing state: a 5xx, a dropped
    // connection or a broken contract must stay a reportable incident.
    apiMock.mockRejectedValue(
      new DashboardError("Le serveur n’a pas répondu (HTTP 502).", {
        status: 502,
      })
    );
    renderDetail();

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("HTTP 502")
    );
    expect(document.getElementById("runMissing")).toBeNull();
  });

  it("never streams a run the account cannot read", async () => {
    apiMock.mockRejectedValue(new Error("Run not found"));
    renderDetail();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Run not found")
    );
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("says the run is missing instead of announcing a connection forever", async () => {
    // The panel the history mounts has nowhere else to put this: a purged or
    // forbidden run never produces a frame, so the alert alone would leave it
    // showing its initial connection state indefinitely.
    apiMock.mockRejectedValue(
      new DashboardError("Ce test n’existe pas ou a été purgé.", {
        code: "RUN_NOT_FOUND",
        status: 404,
      })
    );
    renderDetail();

    await waitFor(() =>
      expect(element("runMissing").textContent).toBe(runScreen.missing)
    );
    expect(element("runIdentifier").textContent).toContain(RUN_ID);
    expect(document.getElementById("liveConnection")).toBeNull();
  });
});

describe("RunDetail diagnostic", () => {
  it("explains a known failure in French and gives the next step", async () => {
    mockBlocked({
      diagnostic: {
        code: "PREVIEW_SHA_MISMATCH",
        hint: "Deploy the PR head commit and expose its full SHA.",
        message: "Preview SHA mismatch or missing provenance",
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
    // The interface is French only, and `diagnose()` writes its hint in English:
    // a code this build knows is explained from the shared catalogue instead.
    expect(element("runDiagnostic").textContent).toContain(
      errorMessages.PREVIEW_SHA_MISMATCH!
    );
    expect(element("runDiagnosticHint").textContent).toBe(
      `À faire : ${runAdvice.PREVIEW_SHA_MISMATCH!}`
    );
    expect(element("runDiagnosticHint").textContent).not.toContain(
      "Deploy the PR head commit"
    );
    // The phase belongs to the job: it is what says how far the run got.
    expect(element("runDiagnosticPhase").textContent).toBe(
      "Phase atteinte : Vérification de la version de votre application"
    );
  });

  it("keeps the server wording for a code this build does not know", async () => {
    mockBlocked({
      diagnostic: {
        code: "SOMETHING_NEW",
        hint: "Open the report and inspect the failing step.",
        message: "A cause this dashboard has no translation for.",
      },
    });
    renderDetail();

    await waitFor(() => expect(element("runDiagnostic")).toBeVisible());
    // The advice Canary was given is never swallowed by a missing translation.
    expect(element("runDiagnostic").textContent).toContain(
      "A cause this dashboard has no translation for."
    );
    expect(element("runDiagnosticHint").textContent).toBe(
      "À faire : Open the report and inspect the failing step."
    );
  });

  it("does not repeat the raw server error next to its French explanation", async () => {
    mockBlocked({
      diagnostic: {
        code: "PREVIEW_SHA_MISMATCH",
        hint: "Deploy the PR head commit.",
        message: "Preview SHA mismatch or missing provenance",
      },
      error: "Preview SHA mismatch or missing provenance",
    });
    renderDetail();

    await waitFor(() => expect(element("runDiagnostic")).toBeVisible());
    // The summary keeps the shared sentence; the cause lives in the block below.
    expect(element("resultSummary").textContent).toBe(
      "Le test n’a pas pu terminer : l’application ou le scénario a bloqué."
    );
  });

  it("still shows the raw server error when no diagnostic was recorded", async () => {
    mockBlocked({
      diagnostic: undefined,
      error: "Une panne sans code enregistré",
    });
    renderDetail();

    await waitFor(() => expect(element("runDiagnostic")).toBeVisible());
    // Nothing else carries the cause, so the summary is the only place for it.
    expect(element("resultSummary").textContent).toContain(
      "Une panne sans code enregistré"
    );
  });

  it("leaves out the terminal marker the runner records when it finishes", async () => {
    // `done` is not a phase a run can fail in: announcing it would say nothing.
    mockBlocked(
      {
        diagnostic: {
          code: "RUN_DEADLINE",
          hint: "Inspect the last progress phase.",
          message: "Run deadline exceeded",
        },
      },
      { progress: { phase: "done" } }
    );
    renderDetail();

    await waitFor(() => expect(element("runDiagnostic")).toBeVisible());
    expect(document.getElementById("runDiagnosticPhase")).toBeNull();
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
    // An unknown scenario code keeps the scenario's own wording and hint.
    expect(block).toContain("Le bouton de connexion n’a pas répondu");
    expect(block).toContain("À faire : Vérifiez le formulaire de connexion.");
    expect(block).not.toContain("Accueil");
  });

  it("shows no failure diagnostic for an outcome that is not a failure", async () => {
    // `skipped` is the outcome of a sound run whose plan retained nothing safe
    // to drive: it is documented as distinct from a failure, so the block must
    // not flatten it into a red "why did this fail" panel.
    for (const outcome of ["passed", "skipped"]) {
      apiMock.mockImplementation((path: string) => {
        if (path.endsWith("/result.json")) {
          return Promise.resolve({
            ...result,
            diagnostic: null,
            outcome,
            scenarios: [],
          });
        }
        return Promise.resolve(job({ outcome, status: "completed" }));
      });
      const view = renderDetail();

      await waitFor(() => expect(element("resultSummary")).toBeVisible());
      expect(element("resultSummary").textContent).toBe(
        outcome === "skipped"
          ? "Aucun scénario n’a été exécuté : le planificateur n’a rien retenu de sûr."
          : "Les assertions ont réussi sur la version testée."
      );
      expect(document.getElementById("runDiagnostic")).toBeNull();
      view.unmount();
    }
  });

  it("copies a JSON block exactly as the dashboard shows it", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    // Defined after `setup`: user-event installs its own clipboard stub.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/result.json")) {
        return Promise.resolve(result);
      }
      return Promise.resolve(job({ progress: { phase: "coverage" } }));
    });
    renderDetail();

    await waitFor(() =>
      expect(element("result").textContent).toContain('"outcome": "failed"')
    );
    const button = screen.getByRole("button", {
      name: `${copy.copyAction} : ${copy.resultLabel}`,
    });
    const status = element("copyResultStatus");
    expect(status).toHaveAttribute("role", "status");
    expect(status.textContent).toBe("");

    await user.click(button);
    // The paste is the block itself, not a re-serialisation that could drift.
    expect(writeText).toHaveBeenCalledWith(element("result").textContent);
    expect(button).toHaveTextContent(copy.copyDone);
    // The button keeps naming the action: `aria-label` overrides its text, so a
    // screen reader hears the outcome from the status region, not from here.
    expect(button).toHaveAccessibleName(
      `${copy.copyAction} : ${copy.resultLabel}`
    );
    expect(status.textContent).toBe(`${copy.copyDone} : ${copy.resultLabel}`);

    // A refused copy says so instead of showing a success nobody can paste from.
    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(button);
    expect(button).toHaveTextContent(copy.copyFailed);
    expect(status.textContent).toBe(`${copy.copyFailed} : ${copy.resultLabel}`);
  });

  it("offers nothing to copy before the run result is loaded", async () => {
    apiMock.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith("/result.json") ? undefined : job())
    );
    renderDetail();

    await waitFor(() => expect(element("events")).toHaveTextContent("{"));
    expect(element("copyResult")).toBeDisabled();
  });
});
