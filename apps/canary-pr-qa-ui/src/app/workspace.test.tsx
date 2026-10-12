import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace, WorkspaceProvider } from "./workspace";

const apiMock = vi.fn();

vi.mock("@/api/client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

vi.mock("./session", () => ({
  useSession: () => ({ canWrite: true, isAdmin: false }),
}));

const setupStatus = {
  ai: { defaultModel: "model-x", endpoint: "ai.example.com" },
  github: { mode: "app" as const, repositories: ["o/r"] },
  preview: { automatic: false },
};

function Probe() {
  const { loadModels, model, models, modelsBusy } = useWorkspace();
  return (
    <div>
      <span data-testid="busy">{String(modelsBusy)}</span>
      <span data-testid="count">{models?.data.length ?? -1}</span>
      <span data-testid="model">{model}</span>
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
