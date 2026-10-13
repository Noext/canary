import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardError } from "@/api/client";
import type { LocalAccount, Role } from "@/api/contracts";
import { roles, settings } from "@/i18n";
import { AccountsSettings } from "./accounts";

interface ApiCall {
  body?: unknown;
  method: string;
  path: string;
}

const session = vi.hoisted(() => ({
  isAdmin: true,
  refreshUser: vi.fn(),
  userId: "",
}));

const workspace = vi.hoisted(() => ({ repositories: [] as string[] }));

const apiMock = vi.fn();

vi.mock("@/app/session", () => ({
  useSession: () => ({
    isAdmin: session.isAdmin,
    refreshUser: session.refreshUser,
    user: { id: session.userId, repos: [], role: "admin" },
  }),
}));

vi.mock("@/app/workspace", () => ({
  useWorkspace: () => ({
    status: { github: { repositories: workspace.repositories } },
  }),
}));

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/client")>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

const ADMIN_ID = "11111111-1111-1111-1111-111111111111";
const OPERATOR_ID = "22222222-2222-2222-2222-222222222222";
const PASSWORD = "motdepasse-123";

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`#${id} is missing from the accounts screen`);
  }
  return node;
}

function bodyOf(
  options: { body?: unknown } | undefined
): Record<string, unknown> {
  const body = options?.body;
  if (typeof body !== "object" || body === null) {
    return {};
  }
  return body as Record<string, unknown>;
}

let rows: LocalAccount[] = [];
let calls: ApiCall[] = [];
/** Set once a write demoted the caller: the admin-only read is refused after it. */
let readForbidden = false;

function seed(): void {
  rows = [
    {
      createdAt: "2026-01-02T09:30:00.000Z",
      id: ADMIN_ID,
      repos: [],
      role: "admin",
      username: "ui-admin",
    },
    {
      createdAt: "2026-02-03T10:00:00.000Z",
      id: OPERATOR_ID,
      repos: ["fixture/app"],
      role: "operator",
      username: "reviewer",
    },
  ];
}

beforeEach(() => {
  session.isAdmin = true;
  session.refreshUser.mockReset();
  session.userId = `local:${ADMIN_ID}`;
  workspace.repositories = ["fixture/app", "fixture/private"];
  readForbidden = false;
  seed();
  calls = [];
  apiMock.mockReset();
  apiMock.mockImplementation(
    async (path: string, options?: { body?: unknown; method?: string }) => {
      const method = options?.method ?? "GET";
      const body = bodyOf(options);
      calls.push({
        method,
        path,
        ...(options?.body === undefined ? {} : { body: options.body }),
      });
      if (path === "/accounts" && method === "GET") {
        if (readForbidden) {
          throw new DashboardError("Project access denied", { status: 403 });
        }
        return { accounts: rows };
      }
      if (path === "/accounts" && method === "POST") {
        const account: LocalAccount = {
          createdAt: "2026-03-04T08:00:00.000Z",
          id: `created-${rows.length}`,
          repos: (body.repos ?? []) as string[],
          role: body.role as Role,
          username: String(body.username),
        };
        rows = [...rows, account];
        return { account };
      }
      const id = path.startsWith("/accounts/")
        ? path.slice("/accounts/".length)
        : "";
      const target = rows.find((row) => row.id === id);
      if (!target) {
        throw new Error(`Compte introuvable : ${path}`);
      }
      if (method === "PATCH") {
        const updated: LocalAccount = {
          ...target,
          ...(body.role ? { role: body.role as Role } : {}),
          ...(body.repos ? { repos: body.repos as string[] } : {}),
        };
        rows = rows.map((row) => (row.id === id ? updated : row));
        return { account: updated };
      }
      if (method === "DELETE") {
        rows = rows.filter((row) => row.id !== id);
        return { ok: true };
      }
      throw new Error(`Unexpected api call: ${method} ${path}`);
    }
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AccountsSettings", () => {
  it("lists the accounts with their role, repositories and creation date", async () => {
    render(<AccountsSettings />);

    await waitFor(() =>
      expect(byId(`account-username-${ADMIN_ID}`)).toBeVisible()
    );
    expect(byId(`account-username-${ADMIN_ID}`).textContent).toBe("ui-admin");
    expect(byId(`account-role-pill-${ADMIN_ID}`).textContent).toBe(roles.admin);
    // An administrator follows the GitHub selection: its stored list is not
    // presented as the repositories it may test.
    expect(byId(`account-meta-${ADMIN_ID}`).textContent).toContain(
      settings.accounts.reposFollowGithub
    );
    expect(byId(`account-username-${OPERATOR_ID}`).textContent).toBe(
      "reviewer"
    );
    expect(byId(`account-role-pill-${OPERATOR_ID}`).textContent).toBe(
      roles.operator
    );
    expect(byId(`account-meta-${OPERATOR_ID}`).textContent).toContain(
      settings.accounts.reposList("fixture/app")
    );
    expect(byId(`account-meta-${OPERATOR_ID}`).textContent).toContain(
      "Créé le"
    );
    expect(calls).toContainEqual({ method: "GET", path: "/accounts" });
  });

  it("creates the account with the chosen role and repositories", async () => {
    const user = userEvent.setup();
    render(<AccountsSettings />);
    await waitFor(() => expect(byId("accountsList")).toBeTruthy());

    await user.type(byId("accountsUsername"), "New.Reviewer");
    await user.type(byId("accountsNewPassword"), PASSWORD);
    await user.selectOptions(byId("accountsNewRole"), "operator");
    await user.click(byId("accountsNewRepo-fixture-private"));
    await user.click(byId("accountsCreateSubmit"));

    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST")).toBe(true)
    );
    // The identifier is normalised, and the repositories are the ones ticked.
    expect(calls).toContainEqual({
      body: {
        password: PASSWORD,
        repos: ["fixture/private"],
        role: "operator",
        username: "new.reviewer",
      },
      method: "POST",
      path: "/accounts",
    });
    // The list comes back from the server, not from a local append.
    await waitFor(() =>
      expect(byId("accountsNotice").textContent).toBe(
        settings.accounts.created("new.reviewer")
      )
    );
    expect(byId("accountsList").textContent).toContain("new.reviewer");
  });

  it("changes a role and the repositories on the server", async () => {
    const user = userEvent.setup();
    render(<AccountsSettings />);
    await waitFor(() => expect(byId("accountsList")).toBeTruthy());

    await user.selectOptions(byId(`account-role-${OPERATOR_ID}`), "viewer");
    await user.click(byId(`account-repos-${OPERATOR_ID}-fixture-private`));
    await user.click(byId(`account-save-${OPERATOR_ID}`));

    await waitFor(() =>
      expect(byId(`account-role-pill-${OPERATOR_ID}`).textContent).toBe(
        roles.viewer
      )
    );
    expect(calls).toContainEqual({
      body: { repos: ["fixture/app", "fixture/private"], role: "viewer" },
      method: "PATCH",
      path: `/accounts/${OPERATOR_ID}`,
    });
    expect(byId("accountsNotice").textContent).toBe(
      settings.accounts.saved("reviewer")
    );
  });

  it("reports a write it can no longer read as applied, and reloads the session", async () => {
    const user = userEvent.setup();
    // A second administrator exists: demoting the caller is allowed, and it is
    // exactly the case where the write outlives the right to re-read the list.
    rows = [
      ...rows,
      {
        createdAt: "2026-02-10T08:00:00.000Z",
        id: "33333333-3333-3333-3333-333333333333",
        repos: [],
        role: "admin",
        username: "second-admin",
      },
    ];
    render(<AccountsSettings />);
    await waitFor(() => expect(byId("accountsList")).toBeTruthy());

    readForbidden = true;
    await user.selectOptions(byId(`account-role-${ADMIN_ID}`), "operator");
    await user.click(byId(`account-save-${ADMIN_ID}`));

    await waitFor(() =>
      expect(byId("accountsNotice").textContent).toBe(
        settings.accounts.saved("ui-admin")
      )
    );
    // The save is not reported as failed, and the session is asked to reload so
    // the screen stops offering controls the server would now refuse.
    expect(byId("accountsError").textContent).toBe("");
    expect(session.refreshUser).toHaveBeenCalledTimes(1);
  });

  it("resets a password through the same account endpoint", async () => {
    const user = userEvent.setup();
    render(<AccountsSettings />);
    await waitFor(() => expect(byId("accountsList")).toBeTruthy());

    await user.type(byId(`account-password-${OPERATOR_ID}`), PASSWORD);
    await user.click(byId(`account-password-reset-${OPERATOR_ID}`));

    await waitFor(() =>
      expect(byId("accountsNotice").textContent).toBe(
        settings.accounts.passwordResetDone("reviewer")
      )
    );
    expect(calls).toContainEqual({
      body: { password: PASSWORD },
      method: "PATCH",
      path: `/accounts/${OPERATOR_ID}`,
    });
    // The field never keeps a password the screen already sent.
    expect(byId(`account-password-${OPERATOR_ID}`)).toHaveValue("");
  });

  it("deletes an account only once the removal is confirmed", async () => {
    const user = userEvent.setup();
    render(<AccountsSettings />);
    await waitFor(() => expect(byId("accountsList")).toBeTruthy());

    await user.click(byId(`account-delete-${OPERATOR_ID}`));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(byId(`account-confirm-${OPERATOR_ID}`)).not.toHaveAttribute(
      "hidden"
    );
    expect(byId(`account-confirm-text-${OPERATOR_ID}`).textContent).toBe(
      settings.accounts.confirmDelete("reviewer")
    );

    await user.click(byId(`account-confirm-run-${OPERATOR_ID}`));
    await waitFor(() =>
      expect(byId("accountsList").textContent).not.toContain("reviewer")
    );
    expect(calls).toContainEqual({
      method: "DELETE",
      path: `/accounts/${OPERATOR_ID}`,
    });
    expect(byId("accountsNotice").textContent).toBe(
      settings.accounts.deleted("reviewer")
    );
  });

  it("refuses to remove the caller's own account", async () => {
    const user = userEvent.setup();
    render(<AccountsSettings />);
    await waitFor(() => expect(byId("accountsList")).toBeVisible());

    expect(byId(`account-delete-${ADMIN_ID}`)).toBeDisabled();
    expect(byId(`account-self-${ADMIN_ID}`).textContent).toBe(
      settings.accounts.deleteProtected
    );
    expect(byId(`account-delete-${OPERATOR_ID}`)).toBeEnabled();

    await user.click(byId(`account-delete-${ADMIN_ID}`));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("refuses to demote or remove the last administrator", async () => {
    // The caller is another administrator: what protects this account is the
    // rule that someone must keep the rights, not the self-check above.
    session.userId = "local:99999999-9999-9999-9999-999999999999";
    rows = rows.filter((row) => row.role === "admin");
    const user = userEvent.setup();
    render(<AccountsSettings />);
    await waitFor(() => expect(byId("accountsList")).toBeVisible());

    expect(byId(`account-role-${ADMIN_ID}`)).toBeDisabled();
    expect(byId(`account-last-admin-${ADMIN_ID}`).textContent).toBe(
      settings.accounts.lastAdmin
    );
    await user.click(byId(`account-delete-${ADMIN_ID}`));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("offers nothing but the reason to a non-administrator", async () => {
    session.isAdmin = false;
    render(<AccountsSettings />);

    expect(byId("accountsForbidden").textContent).toBe(
      settings.accounts.forbidden
    );
    expect(document.getElementById("accountsList")).toBeNull();
    expect(document.getElementById("accountsCreate")).toBeNull();
    // The screen never asks for a list the server would refuse to give.
    expect(calls).toEqual([]);
  });
});
