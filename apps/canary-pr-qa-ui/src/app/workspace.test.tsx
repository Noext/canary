import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace, WorkspaceProvider } from "./workspace";

const apiMock = vi.fn();

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/client")>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

let session = { canWrite: true, isAdmin: false };

vi.mock("./session", () => ({ useSession: () => session }));

const setupStatus = {
  ai: { defaultModel: "model-x", endpoint: "ai.example.com" },
  github: { mode: "app" as const, repositories: ["o/r"] },
  preview: { automatic: false },
};

function Probe() {
  const {
    githubError,
    loadGithub,
    loadModels,
    loadStatus,
    model,
    models,
    modelsBusy,
    statusError,
  } = useWorkspace();
  return (
    <div>
      <span data-testid="busy">{String(modelsBusy)}</span>
      <span data-testid="count">{models?.data.length ?? -1}</span>
      <span data-testid="model">{model}</span>
      <span data-testid="statusError">{statusError ?? ""}</span>
      <span data-testid="githubError">{githubError ?? ""}</span>
      <button onClick={() => void loadStatus()} type="button">
        status
      </button>
      <button onClick={() => void loadGithub()} type="button">
        github
      </button>
      <button onClick={() => void loadModels()} type="button">
        reload
      </button>
    </div>
  );
}

function modelsCalls(): number {
  return apiMock.mock.calls.filter(([path]) => path === "/models").length;
}

function renderWorkspace() {
  return render(
    <StrictMode>
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>
    </StrictMode>
  );
}

beforeEach(() => {
  session = { canWrite: true, isAdmin: false };
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    if (path === "/models") {
      return Promise.resolve({
        data: [{ id: "model-x" }, { id: "model-y" }],
        defaultModel: "model-x",
      });
    }
    return Promise.resolve(setupStatus);
  });
});

describe("WorkspaceProvider", () => {
  it("exposes a failed setup status instead of pretending GitHub is absent", async () => {
    let failing = true;
    apiMock.mockImplementation((path: string) => {
      if (path === "/dashboard/status" && failing) {
        return Promise.reject(new Error("Le serveur est injoignable."));
      }
      if (path === "/models") {
        return Promise.resolve({
          data: [{ id: "model-x" }],
          defaultModel: "model-x",
        });
      }
      return Promise.resolve(setupStatus);
    });
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("statusError")).toHaveTextContent("injoignable")
    );
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "status" }));
    await waitFor(() =>
      expect(screen.getByTestId("statusError")).toHaveTextContent("")
    );
  });

  it("exposes a failed GitHub status so the panel can ask to retry", async () => {
    session = { canWrite: true, isAdmin: true };
    apiMock.mockImplementation((path: string) => {
      if (path === "/github/app") {
        return Promise.reject(new Error("Contrat GitHub indisponible."));
      }
      if (path === "/models") {
        return Promise.resolve({
          data: [{ id: "model-x" }],
          defaultModel: "model-x",
        });
      }
      return Promise.resolve(setupStatus);
    });
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("githubError")).toHaveTextContent(
        "Contrat GitHub indisponible."
      )
    );
  });

  it("loads the catalogue once, even under StrictMode's double effect", async () => {
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("count")).toHaveTextContent("2")
    );
    // Give any stray effect a chance to fire again before counting.
    await waitFor(() =>
      expect(screen.getByTestId("busy")).toHaveTextContent("false")
    );
    expect(modelsCalls()).toBe(1);
    expect(screen.getByTestId("model")).toHaveTextContent("model-x");
  });

  it("reloads the catalogue only when the user asks for it", async () => {
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("count")).toHaveTextContent("2")
    );
    await userEvent.click(screen.getByRole("button", { name: "reload" }));
    await waitFor(() => expect(modelsCalls()).toBe(2));
  });

  it("drops a selected model the refreshed catalogue no longer offers", async () => {
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("model")).toHaveTextContent("model-x")
    );
    apiMock.mockImplementation((path: string) => {
      if (path === "/models") {
        return Promise.resolve({
          data: [{ id: "model-z" }],
          defaultModel: "model-z",
        });
      }
      return Promise.resolve(setupStatus);
    });
    await userEvent.click(screen.getByRole("button", { name: "reload" }));
    // The refreshed catalogue exposes the configured default again, so the
    // stale selection is replaced rather than silently kept.
    await waitFor(() =>
      expect(screen.getByTestId("model")).toHaveTextContent("model-z")
    );
  });

  it("clears the selection when the refreshed catalogue offers no default", async () => {
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("model")).toHaveTextContent("model-x")
    );
    apiMock.mockImplementation((path: string) => {
      if (path === "/models") {
        return Promise.resolve({
          data: [{ id: "model-y" }],
          defaultModel: "configured-but-absent",
        });
      }
      return Promise.resolve(setupStatus);
    });
    await userEvent.click(screen.getByRole("button", { name: "reload" }));
    await waitFor(() =>
      expect(screen.getByTestId("count")).toHaveTextContent("1")
    );
    // Not ready: the interface must ask for an explicit choice again.
    expect(screen.getByTestId("model")).toHaveTextContent("");
  });

  it("never selects a model the provider does not expose", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/models") {
        return Promise.resolve({
          data: [{ id: "model-y" }],
          defaultModel: "model-configured-but-absent",
        });
      }
      return Promise.resolve(setupStatus);
    });
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("count")).toHaveTextContent("1")
    );
    expect(screen.getByTestId("model")).toHaveTextContent("");
    expect(modelsCalls()).toBe(1);
  });
});
