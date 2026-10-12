import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, useSession } from "./session";

const apiMock = vi.fn();

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/client")>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

function Probe({ onFailure }: { onFailure: (message: string) => void }) {
  const { logout } = useSession();
  return (
    <button
      onClick={() =>
        void logout().catch((error: unknown) => {
          onFailure(error instanceof Error ? error.message : String(error));
        })
      }
      type="button"
    >
      logout
    </button>
  );
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({ initialized: true });
});

describe("SessionProvider logout", () => {
  it("reports a failed logout instead of reporting success", async () => {
    const failures: string[] = [];
    apiMock.mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path === "/session" && options?.method === "DELETE") {
          return Promise.reject(new Error("Session serveur indisponible."));
        }
        return Promise.resolve({ initialized: true });
      }
    );
    render(
      <SessionProvider>
        <Probe onFailure={(message) => failures.push(message)} />
      </SessionProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: "logout" }));
    // The page must not reload on a failure: the cookie is still valid, and the
    // operator has to be told rather than sent back to a signed-in dashboard.
    await waitFor(() =>
      expect(failures).toEqual(["Session serveur indisponible."])
    );
    const deleteCall = apiMock.mock.calls.find(
      ([path, options]) =>
        path === "/session" &&
        (options as { method?: string })?.method === "DELETE"
    );
    expect(deleteCall).toBeDefined();
  });
});
