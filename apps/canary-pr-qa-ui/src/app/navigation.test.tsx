import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider, useNavigation } from "./navigation";

let session = { canWrite: true, isAdmin: false };

vi.mock("./session", () => ({ useSession: () => session }));

function Probe() {
  const { navigate, view } = useNavigation();
  return (
    <div>
      <span data-testid="view">{view}</span>
      <button onClick={() => navigate("settings")} type="button">
        settings
      </button>
      <button onClick={() => navigate("new")} type="button">
        new
      </button>
    </div>
  );
}

function renderAt(initialView: "home" | "new" | "settings") {
  return render(
    <NavigationProvider initialView={initialView}>
      <Probe />
    </NavigationProvider>
  );
}

beforeEach(() => {
  session = { canWrite: true, isAdmin: false };
});

describe("NavigationProvider role gating", () => {
  it("ignores a deep link to a panel the role may not read", () => {
    // `/?github=installed` sends anyone to settings; an operator must land home.
    renderAt("settings");
    expect(screen.getByTestId("view")).toHaveTextContent("home");
  });

  it("keeps the admin panel for an administrator", () => {
    session = { canWrite: true, isAdmin: true };
    renderAt("settings");
    expect(screen.getByTestId("view")).toHaveTextContent("settings");
  });

  it("coerces a write-only panel for a viewer", () => {
    session = { canWrite: false, isAdmin: false };
    renderAt("new");
    expect(screen.getByTestId("view")).toHaveTextContent("home");
    expect(screen.getByTestId("view")).not.toHaveTextContent("new");
  });

  it("leaves a panel the role loses", async () => {
    session = { canWrite: true, isAdmin: true };
    const { rerender } = renderAt("settings");
    expect(screen.getByTestId("view")).toHaveTextContent("settings");
    session = { canWrite: true, isAdmin: false };
    rerender(
      <NavigationProvider initialView="settings">
        <Probe />
      </NavigationProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: "settings" }));
    expect(screen.getByTestId("view")).toHaveTextContent("home");
  });
});
