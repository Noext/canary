import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsNav, shell } from "@/i18n";
import { NavigationProvider, useNavigation } from "./navigation";
import { SettingsNav } from "./settings-nav";

let session = { canWrite: true, isAdmin: true };

vi.mock("./session", () => ({ useSession: () => session }));

/** Reports the page the submenu selected, the way the shell reads it back. */
function Current() {
  const { section, view } = useNavigation();
  return <span data-testid="current">{`${view}:${section}`}</span>;
}

function renderNav() {
  return render(
    <NavigationProvider initialSection="github" initialView="settings">
      <SettingsNav />
      <Current />
    </NavigationProvider>
  );
}

beforeEach(() => {
  session = { canWrite: true, isAdmin: true };
  window.history.replaceState(null, "", "/");
});

describe("SettingsNav", () => {
  it("lists every settings page in the declared order", () => {
    renderNav();
    const nav = screen.getByRole("list", { name: shell.settingsSections });

    expect(
      within(nav)
        .getAllByRole("button")
        .map((entry) => entry.getAttribute("id"))
    ).toEqual(settingsNav.map((entry) => `nav-settings-${entry.id}`));
    // The list is the submenu of « Réglages »: each entry names its page.
    expect(
      within(nav)
        .getAllByRole("button")
        .map((entry) => entry.textContent)
    ).toEqual(settingsNav.map((entry) => entry.label));
  });

  it("marks the visible page and opens the one that is clicked", async () => {
    renderNav();
    expect(screen.getByRole("button", { name: "GitHub" })).toHaveAttribute(
      "aria-current",
      "page"
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Comptes utilisateurs" })
    );

    expect(screen.getByTestId("current")).toHaveTextContent(
      "settings:accounts"
    );
    expect(
      screen.getByRole("button", { name: "Comptes utilisateurs" })
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "GitHub" })).not.toHaveAttribute(
      "aria-current"
    );
    expect(window.location.pathname).toBe("/settings/accounts");
  });
});
