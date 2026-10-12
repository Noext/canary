import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: apiMock };
});

import { type ApiOptions, DashboardError, post } from "@/api/client";
import type { Principal } from "@/api/contracts";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { SessionProvider } from "@/app/session";
import { auth } from "@/i18n";
import { LoginView } from "./login-view";

/** The accessible name of `#showPassword`, spelled out with its target. */
const passwordToggleAria = {
  hide: "Masquer le mot de passe",
  show: "Afficher le mot de passe",
} as const;

const admin: Principal = {
  id: "user-admin",
  repos: ["fixture/app"],
  role: "admin",
  username: "ui-admin",
};

type ApiHandler = (options: ApiOptions | undefined) => Promise<unknown>;

let handlers: Record<string, ApiHandler> = {};

const anonymous: ApiHandler = async () => {
  throw new DashboardError("Session absente.");
};

beforeEach(() => {
  handlers = {
    "/auth/status": async () => ({ initialized: true }),
    "/me": anonymous,
  };
  apiMock.mockReset();
  apiMock.mockImplementation((path: string, options?: ApiOptions) => {
    const handler = handlers[path];
    if (!handler) {
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }
    return handler(options);
  });
});

afterEach(() => {
  cleanup();
});

function renderLogin(setupCode?: string) {
  render(
    <ErrorProvider>
      <SessionProvider {...(setupCode ? { setupCode } : {})}>
        <ErrorAlert />
        <LoginView />
      </SessionProvider>
    </ErrorProvider>
  );
}

function alertText() {
  return screen.getByRole("alert").textContent ?? "";
}

describe("LoginView", () => {
  it("shows the first-run copy and blocks submit without a setup code", async () => {
    handlers["/auth/status"] = async () => ({ initialized: false });
    renderLogin();

    const title = await screen.findByRole("heading", {
      level: 2,
      name: auth.firstRun.title,
    });
    expect(title).toHaveAttribute("id", "authTitle");
    expect(screen.getByText(auth.firstRun.intro)).toHaveAttribute(
      "id",
      "authIntro"
    );

    const submit = screen.getByRole("button", { name: auth.createAccount });
    expect(submit).toHaveAttribute("id", "accountSubmit");
    expect(submit).toBeDisabled();

    expect(screen.getByLabelText(auth.confirmation)).toBeVisible();
    expect(screen.getByText(auth.setupInstructions)).toBeVisible();
    expect(screen.getByText(auth.setupPrivacy)).toBeVisible();
    expect(
      screen.getByText(`${auth.setupCommandPrefix}${window.location.origin}`)
    ).toHaveAttribute("id", "setupCommand");
    expect(screen.getByText(auth.alreadyHaveAccount)).toBeVisible();

    const username = screen.getByLabelText(auth.usernameLabel);
    expect(username).toHaveAttribute("autocomplete", "username");
    expect(username).toHaveAttribute("minlength", "3");
    expect(username).toHaveAttribute("maxlength", "64");
    expect(username).toHaveAttribute(
      "pattern",
      "[A-Za-z0-9][A-Za-z0-9_.@-]{2,63}"
    );
    expect(username).toBeRequired();
    expect(screen.getByLabelText(auth.passwordLabel)).toHaveAttribute(
      "autocomplete",
      "new-password"
    );
    expect(screen.getByRole("banner")).toHaveAttribute("id", "authHeader");
    expect(screen.getByRole("status")).toHaveAttribute("id", "authStatus");
  });

  it("enables account creation when the setup link carries a code", async () => {
    handlers["/auth/status"] = async () => ({ initialized: false });
    renderLogin("code-de-test");

    const submit = await screen.findByRole("button", {
      name: auth.createAccount,
    });
    expect(submit).toBeEnabled();
    expect(screen.getByLabelText(auth.confirmation)).toBeVisible();
    expect(screen.getByText(auth.setupInstructions)).not.toBeVisible();
  });

  it("rejects a mismatched confirmation and keeps submit enabled", async () => {
    handlers["/auth/status"] = async () => ({ initialized: false });
    const user = userEvent.setup();
    renderLogin("code-de-test");

    const submit = screen.getByRole("button", { name: auth.createAccount });
    await user.type(screen.getByLabelText(auth.usernameLabel), "ui-admin");
    await user.type(
      screen.getByLabelText(auth.passwordLabel),
      "ui-password-long-2026"
    );
    await user.type(
      screen.getByLabelText(auth.confirmation),
      "ui-password-long-2027"
    );
    await user.click(submit);

    await waitFor(() => expect(alertText()).toBe(auth.passwordMismatch));
    expect(apiMock).not.toHaveBeenCalledWith("/auth/setup", expect.anything());
    expect(submit).toBeEnabled();
  });

  it("signs in with the local account and reports progress", async () => {
    let resolveLogin: (value: Principal) => void = () => undefined;
    handlers["/auth/login"] = async () =>
      new Promise<Principal>((resolve) => {
        resolveLogin = resolve;
      });
    const user = userEvent.setup();
    renderLogin();

    await screen.findByRole("heading", { name: auth.loginTitle });
    expect(screen.getByText(auth.loginIntro)).toBeVisible();
    expect(screen.getByText(auth.setupInstructions)).not.toBeVisible();
    expect(screen.getByLabelText(auth.passwordLabel)).toHaveAttribute(
      "autocomplete",
      "current-password"
    );

    await user.type(screen.getByLabelText(auth.usernameLabel), "ui-admin");
    await user.type(
      screen.getByLabelText(auth.passwordLabel),
      "ui-password-long-2026"
    );
    const submit = screen.getByRole("button", { name: auth.login });
    await user.click(submit);

    expect(apiMock).toHaveBeenCalledWith(
      "/auth/login",
      post({ password: "ui-password-long-2026", username: "ui-admin" })
    );
    expect(screen.getByRole("status")).toHaveTextContent(auth.loggingIn);
    expect(submit).toBeDisabled();

    resolveLogin(admin);
    await waitFor(() => expect(submit).toBeEnabled());
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByLabelText(auth.passwordLabel)).toHaveValue("");
  });

  it("surfaces a failed sign-in and re-enables the submit button", async () => {
    handlers["/auth/login"] = async () => {
      throw new DashboardError("Identifiant ou mot de passe incorrect.");
    };
    const user = userEvent.setup();
    renderLogin();

    await screen.findByRole("heading", { name: auth.loginTitle });
    await user.type(screen.getByLabelText(auth.usernameLabel), "ui-admin");
    await user.type(
      screen.getByLabelText(auth.passwordLabel),
      "ui-password-long-2026"
    );
    const submit = screen.getByRole("button", { name: auth.login });
    await user.click(submit);

    await waitFor(() =>
      expect(alertText()).toBe("Identifiant ou mot de passe incorrect.")
    );
    expect(submit).toBeEnabled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("signs in with a technical token and clears the field", async () => {
    handlers["/session"] = async () => admin;
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByText(auth.technicalSummary));
    const token = screen.getByLabelText(auth.tokenLabel);
    await user.type(token, "qa-token-de-test");
    await user.click(screen.getByRole("button", { name: auth.technicalLogin }));

    await waitFor(() => expect(token).toHaveValue(""));
    expect(apiMock).toHaveBeenCalledWith("/session", {
      headers: { Authorization: "Bearer qa-token-de-test" },
      method: "POST",
    });
  });

  it("toggles the password visibility", async () => {
    const user = userEvent.setup();
    renderLogin();

    await screen.findByRole("heading", { name: auth.loginTitle });
    const field = screen.getByLabelText(auth.passwordLabel);
    const toggle = screen.getByRole("button", {
      name: passwordToggleAria.show,
    });
    expect(toggle).toHaveAttribute("id", "showPassword");
    expect(field).toHaveAttribute("type", "password");

    await user.click(toggle);
    expect(field).toHaveAttribute("type", "text");
    expect(toggle).toHaveTextContent(auth.hidePassword);
    expect(toggle).toHaveAttribute("aria-label", passwordToggleAria.hide);

    await user.click(toggle);
    expect(field).toHaveAttribute("type", "password");
    expect(toggle).toHaveTextContent(auth.showPassword);
    expect(toggle).toHaveAttribute("aria-label", passwordToggleAria.show);
  });
});
