import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationProvider, useNavigation } from "./navigation";

const RUN_ID = "74422b90-c70a-11f1-8b8c-69d5033ed7fd";

let session = { canWrite: true, isAdmin: false };

vi.mock("./session", () => ({ useSession: () => session }));

function Probe() {
  const { navigate, openRun, openSection, section, view } = useNavigation();
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
      <button onClick={() => navigate("home")} type="button">
        home
      </button>
      <button onClick={() => navigate("runs")} type="button">
        runs
      </button>
      <button onClick={() => openSection("accounts")} type="button">
        accounts
      </button>
      <button onClick={() => openRun(RUN_ID)} type="button">
        run
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

/**
 * Puts the document on the entry the browser restored, the way a Back does: the
 * address moves, and the browser announces it to the page.
 */
function restore(url: string) {
  window.history.replaceState(null, "", url);
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

beforeEach(() => {
  session = { canWrite: true, isAdmin: false };
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
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
    // The screen the load asked for, and nothing else, is what the bar keeps.
    expect(window.location.hash).toBe("#settings=github");
  });

  it("coerces a write-only panel for a viewer", () => {
    session = { canWrite: false, isAdmin: false };
    // A shared `/new-test` link names a screen a viewer may not open.
    window.history.replaceState(null, "", "/new-test");
    renderAt("new");
    expect(screen.getByTestId("view")).toHaveTextContent("home");
    expect(screen.getByTestId("view")).not.toHaveTextContent("new");
    // The address it named never stays in the bar under that role.
    expect(window.location.pathname).toBe("/");
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
    expect(window.location.hash).toBe("");
  });

  it("corrects the address of a panel the role loses while it is open", () => {
    session = { canWrite: true, isAdmin: true };
    const { rerender } = renderAt("settings");
    expect(window.location.hash).toBe("#settings=github");

    session = { canWrite: true, isAdmin: false };
    rerender(
      <NavigationProvider initialView="settings">
        <Probe />
      </NavigationProvider>
    );

    expect(screen.getByTestId("view")).toHaveTextContent("home");
    // A page this role may not read is not an address the bar may keep.
    expect(window.location.hash).toBe("");
  });
});

describe("NavigationProvider settings pages", () => {
  beforeEach(() => {
    session = { canWrite: true, isAdmin: true };
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

describe("NavigationProvider addresses", () => {
  beforeEach(() => {
    session = { canWrite: true, isAdmin: true };
  });

  it("pushes the path of a screen instead of rewriting the address", async () => {
    const pushed = vi.spyOn(window.history, "pushState");
    renderAt("home");
    // A load writes its own entry at most once: nothing is pushed for it.
    expect(pushed).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "new" }));

    expect(screen.getByTestId("view")).toHaveTextContent("new");
    expect(pushed).toHaveBeenCalledWith(null, "", "/new-test");
  });

  it("pushes the history path, then the run link it selects", async () => {
    const pushed = vi.spyOn(window.history, "pushState");
    renderAt("home");

    await userEvent.click(screen.getByRole("button", { name: "runs" }));
    expect(window.location.pathname).toBe("/history");

    await userEvent.click(screen.getByRole("button", { name: "run" }));
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe(`#${RUN_ID}`);
    expect(pushed).toHaveBeenNthCalledWith(1, null, "", "/history");
    expect(pushed).toHaveBeenNthCalledWith(2, null, "", `/#${RUN_ID}`);
  });

  it("replays the screen an entry names when the browser goes back", async () => {
    const pushed = vi.spyOn(window.history, "pushState");
    renderAt("home");

    await userEvent.click(screen.getByRole("button", { name: "runs" }));
    await userEvent.click(screen.getByRole("button", { name: "home" }));
    expect(screen.getByTestId("view")).toHaveTextContent("home");
    pushed.mockClear();

    restore("/history");

    expect(screen.getByTestId("view")).toHaveTextContent("runs");
    // Replaying an entry never adds one: Back must stay free.
    expect(pushed).not.toHaveBeenCalled();
  });

  it("brings a forbidden entry home and corrects the address", () => {
    session = { canWrite: true, isAdmin: false };
    renderAt("home");

    restore("/#settings=accounts");

    expect(screen.getByTestId("view")).toHaveTextContent("home");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/");
  });

  it("corrects a path the load was not served for, without pushing an entry", () => {
    const pushed = vi.spyOn(window.history, "pushState");
    window.history.replaceState(null, "", "/ancien-chemin");

    renderAt("home");

    expect(window.location.pathname).toBe("/");
    expect(pushed).not.toHaveBeenCalled();
  });
});

/**
 * Un écran qui lit son lien une seule fois, comme l'historique, le rapport ou
 * la tentative : le shell le remonte sur l'entrée restaurée.
 */
function RunsScreen() {
  const { consumeRun } = useNavigation();
  const [selected] = useState(() => consumeRun());
  return <span data-testid="selected">{selected ?? "aucun"}</span>;
}

function RestoredRuns() {
  const { restoreCount } = useNavigation();
  return <RunsScreen key={restoreCount} />;
}

describe("NavigationProvider restored entries", () => {
  it("re-seeds a screen that reads its link once", () => {
    window.history.replaceState(null, "", "/history");
    render(
      <NavigationProvider initialView="runs">
        <RestoredRuns />
      </NavigationProvider>
    );
    expect(screen.getByTestId("selected")).toHaveTextContent("aucun");

    // Retour sur une entrée qui nomme un test : le détail suit l'adresse.
    restore(`/#${RUN_ID}`);
    expect(screen.getByTestId("selected")).toHaveTextContent(RUN_ID);

    // Et l'entrée sans test ne garde pas le détail de la précédente.
    restore("/history");
    expect(screen.getByTestId("selected")).toHaveTextContent("aucun");
  });
});
