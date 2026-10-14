import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider, useNavigation } from "./navigation";

let session = { canWrite: true, isAdmin: false };

vi.mock("./session", () => ({ useSession: () => session }));

function Probe() {
  const { navigate, openSection, section, view } = useNavigation();
  return (
    <div>
      <span data-testid="view">{view}</span>
      <span data-testid="section">{section}</span>
      <button onClick={() => navigate("settings")} type="button">
        settings
      </button>
      <button onClick={() => navigate("new")} type="button">
        new
      </button>
      <button onClick={() => openSection("accounts")} type="button">
        accounts
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

describe("NavigationProvider settings pages", () => {
  beforeEach(() => {
    session = { canWrite: true, isAdmin: true };
    window.history.replaceState(null, "", "/");
  });

  it("opens the first settings page and writes its address", async () => {
    renderAt("home");
    expect(screen.getByTestId("section")).toHaveTextContent("github");

    await userEvent.click(screen.getByRole("button", { name: "settings" }));

    expect(screen.getByTestId("view")).toHaveTextContent("settings");
    // The section is part of the address: a reload reopens the same page.
    expect(window.location.hash).toBe("#settings=github");
  });

  it("switches page without leaving the settings panel", async () => {
    renderAt("settings");

    await userEvent.click(screen.getByRole("button", { name: "accounts" }));

    expect(screen.getByTestId("view")).toHaveTextContent("settings");
    expect(screen.getByTestId("section")).toHaveTextContent("accounts");
    expect(window.location.hash).toBe("#settings=accounts");
  });

  it("keeps the section when the sidebar reopens the settings", async () => {
    renderAt("settings");

    await userEvent.click(screen.getByRole("button", { name: "accounts" }));
    await userEvent.click(screen.getByRole("button", { name: "new" }));
    await userEvent.click(screen.getByRole("button", { name: "settings" }));

    expect(screen.getByTestId("section")).toHaveTextContent("accounts");
    expect(window.location.hash).toBe("#settings=accounts");
  });

  it("refuses a page the role may not read", async () => {
    session = { canWrite: true, isAdmin: false };
    renderAt("home");

    await userEvent.click(screen.getByRole("button", { name: "accounts" }));

    expect(screen.getByTestId("view")).toHaveTextContent("home");
    expect(screen.getByTestId("section")).toHaveTextContent("accounts");
    expect(window.location.hash).toBe("");
  });
});
