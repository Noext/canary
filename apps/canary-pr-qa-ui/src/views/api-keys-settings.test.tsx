import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { DashboardError } from "@/api/client";
import type { ApiKeyCreated, ApiKeyRow } from "@/api/contracts";
import { errorMessages, settings } from "@/i18n";
import { formatDate } from "@/lib/format";
import { ApiKeysSettings } from "./api-keys-settings";

interface ApiCall {
  body?: unknown;
  method: string;
  path: string;
}

const { apiMock } = vi.hoisted(() => ({
  apiMock:
    vi.fn<
      (
        path: string,
        options?: { body?: unknown; method?: string }
      ) => Promise<unknown>
    >(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: apiMock };
});

const ACTIVE: ApiKeyRow = {
  createdAt: "2026-01-02T03:04:05.000Z",
  id: "key-1",
  lastUsedAt: "2026-01-03T04:05:06.000Z",
  name: "Agent de support",
  prefix: "qa_live_7f3c",
  repos: ["fixture/app"],
  revokedAt: null,
};

const REVOKED: ApiKeyRow = {
  ...ACTIVE,
  id: "key-2",
  lastUsedAt: null,
  name: "Ancienne intégration",
  prefix: "qa_live_9a1b",
  revokedAt: "2026-01-04T05:06:07.000Z",
};

/** What `POST /dashboard/api-keys/:id/secret` hands back for the active key. */
const SECRET = "qa_live_7f3c0000000000000000000000000000abc";

const CREATED_TOKEN = "qa_live_5e2d0000000000000000000000000000def";

function byId(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[id="${id}"]`);
  if (!element) {
    throw new Error(`Missing control #${id}`);
  }
  return element;
}

function bodyName(body: unknown): string {
  if (typeof body !== "object" || body === null || !("name" in body)) {
    return "";
  }
  return String(body.name);
}

function withClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

/**
 * A user-event user for a test that copies. `userEvent.setup()` installs its own
 * clipboard stub, so the stub the test asserts on is installed after it.
 */
function setupUser(write: (text: string) => Promise<void> = writeText) {
  const user = userEvent.setup();
  withClipboard(write);
  return user;
}

function failingClipboard(): Mock<(text: string) => Promise<void>> {
  return vi
    .fn<(text: string) => Promise<void>>()
    .mockRejectedValue(new Error("denied"));
}

let calls: ApiCall[] = [];
let rows: ApiKeyRow[] = [];
let createFailure: DashboardError | undefined;
let copyFailure: DashboardError | undefined;
let revokeFailure: DashboardError | undefined;
let writeText: Mock<(text: string) => Promise<void>>;

beforeEach(() => {
  calls = [];
  rows = [{ ...ACTIVE }, { ...REVOKED }];
  createFailure = undefined;
  copyFailure = undefined;
  revokeFailure = undefined;
  writeText = vi
    .fn<(text: string) => Promise<void>>()
    .mockResolvedValue(undefined);

  apiMock.mockReset();
  apiMock.mockImplementation(async (path, options) => {
    const call: ApiCall = { method: options?.method ?? "GET", path };
    if (options?.body !== undefined) {
      call.body = options.body;
    }
    calls.push(call);

    if (path === "/dashboard/api-keys" && call.method === "GET") {
      return rows;
    }
    if (path === "/dashboard/api-keys" && call.method === "POST") {
      if (createFailure) {
        throw createFailure;
      }
      const created: ApiKeyCreated = {
        ...ACTIVE,
        id: "key-3",
        lastUsedAt: null,
        name: bodyName(options?.body),
        prefix: CREATED_TOKEN.slice(0, 12),
        token: CREATED_TOKEN,
      };
      rows = [created, ...rows];
      return created;
    }
    const secret = /^\/dashboard\/api-keys\/(.+)\/secret$/.exec(path);
    if (secret) {
      if (copyFailure) {
        throw copyFailure;
      }
      return { token: SECRET };
    }
    const revoke = /^\/dashboard\/api-keys\/([^/]+)$/.exec(path);
    if (revoke && call.method === "DELETE") {
      if (revokeFailure) {
        throw revokeFailure;
      }
      const id = revoke[1] ?? "";
      const revokedAt = "2026-01-05T06:07:08.000Z";
      rows = rows.map((row) => (row.id === id ? { ...row, revokedAt } : row));
      return { id, revokedAt };
    }
    throw new Error(`Unexpected API call ${call.method} ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("ApiKeysSettings", () => {
  it("lists every key, its prefix, its last use and a revoked marker", async () => {
    const { container } = render(<ApiKeysSettings />);

    await waitFor(() =>
      expect(byId(container, "apiKeyRow-key-1")).toHaveTextContent(ACTIVE.name)
    );
    expect(calls).toContainEqual({
      method: "GET",
      path: "/dashboard/api-keys",
    });
    expect(byId(container, "apiKeyRow-key-1")).toHaveTextContent(ACTIVE.prefix);
    expect(byId(container, "apiKeyRow-key-1")).toHaveTextContent(
      settings.apiKeys.lastUsed(formatDate(ACTIVE.lastUsedAt))
    );
    expect(byId(container, "apiKeyRow-key-1")).toHaveTextContent(
      settings.apiKeys.copy
    );
    // A key that was never used says so instead of showing an empty date.
    expect(byId(container, "apiKeyRow-key-2")).toHaveTextContent(
      settings.apiKeys.revoked
    );
    expect(byId(container, "apiKeyRow-key-2")).toHaveTextContent(
      settings.apiKeys.revokedAt(formatDate(REVOKED.revokedAt))
    );
    // A revoked key keeps its row but loses every action.
    expect(byId(container, "apiKeyRevoked-key-2")).toHaveTextContent(
      settings.apiKeys.revoked
    );
    expect(
      container.querySelector("#apiKeyCopy-key-2")
    ).not.toBeInTheDocument();
    expect(
      container.querySelector("#apiKeyRevoke-key-2")
    ).not.toBeInTheDocument();
  });

  it("renders an empty list without breaking the card", async () => {
    rows = [];
    const { container } = render(<ApiKeysSettings />);

    await waitFor(() => expect(byId(container, "apiKeyEmpty")).toBeVisible());
    expect(byId(container, "apiKeyEmpty")).toHaveTextContent(
      settings.apiKeys.empty
    );
    expect(byId(container, "apiKeyList")).not.toBeVisible();
    expect(byId(container, "apiKeyListTitle")).toHaveTextContent(
      settings.apiKeys.listTitle
    );
  });

  it("creates a key with the typed name and shows its token once", async () => {
    const user = setupUser();
    const { container } = render(<ApiKeysSettings />);
    await waitFor(() => expect(byId(container, "apiKeyList")).toBeVisible());

    expect(byId(container, "apiKeyCreate")).toBeDisabled();
    await user.type(byId(container, "apiKeyName"), "Agent de veille");
    await user.click(byId(container, "apiKeyCreate"));

    await waitFor(() =>
      expect(byId(container, "apiKeyToken")).toHaveTextContent(CREATED_TOKEN)
    );
    expect(calls).toContainEqual({
      body: { name: "Agent de veille" },
      method: "POST",
      path: "/dashboard/api-keys",
    });
    expect(byId(container, "apiKeyTokenBlock")).toBeVisible();
    expect(byId(container, "apiKeyTokenWarning")).toHaveTextContent(
      settings.apiKeys.tokenWarning
    );
    expect(byId(container, "apiKeyNotice")).toHaveTextContent(
      settings.apiKeys.created("Agent de veille")
    );
    // The new key is the newest one: the list shows it first, and the draft is
    // cleared so the same name cannot be created twice by mistake.
    expect(byId(container, "apiKeyList")).toHaveTextContent("Agent de veille");
    expect(byId(container, "apiKeyName")).toHaveValue("");

    // The displayed token is the one the copy button puts in the clipboard,
    // and the receipt names the key it belongs to.
    await user.click(byId(container, "apiKeyTokenCopy"));
    expect(writeText).toHaveBeenCalledWith(CREATED_TOKEN);
    await waitFor(() =>
      expect(byId(container, "apiKeyTokenReceipt")).toHaveTextContent(
        settings.apiKeys.receipt("Agent de veille")
      )
    );
  });

  it("copies a row token without ever showing it", async () => {
    const user = setupUser();
    const { container } = render(<ApiKeysSettings />);
    await waitFor(() => expect(byId(container, "apiKeyList")).toBeVisible());

    await user.click(byId(container, "apiKeyCopy-key-1"));

    await waitFor(() =>
      expect(byId(container, "apiKeyNotice")).toHaveTextContent(
        settings.apiKeys.receipt(ACTIVE.name)
      )
    );
    expect(calls).toContainEqual({
      method: "POST",
      path: "/dashboard/api-keys/key-1/secret",
    });
    expect(writeText).toHaveBeenCalledWith(SECRET);
    // The row kept its masked form: the clear token never reached the screen.
    expect(byId(container, "apiKeyRow-key-1")).toHaveTextContent(ACTIVE.prefix);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("says so when the browser refuses the copy", async () => {
    const user = setupUser(failingClipboard());
    const { container } = render(<ApiKeysSettings />);
    await waitFor(() => expect(byId(container, "apiKeyList")).toBeVisible());

    await user.click(byId(container, "apiKeyCopy-key-1"));

    await waitFor(() =>
      expect(byId(container, "apiKeyError")).toHaveTextContent(
        settings.apiKeys.copyFailed
      )
    );
  });

  it("keeps a revoked key visible and drops its actions", async () => {
    const user = setupUser();
    const { container } = render(<ApiKeysSettings />);
    await waitFor(() => expect(byId(container, "apiKeyList")).toBeVisible());

    await user.click(byId(container, "apiKeyRevoke-key-1"));

    await waitFor(() =>
      expect(byId(container, "apiKeyRow-key-1")).toHaveTextContent(
        settings.apiKeys.revoked
      )
    );
    expect(calls).toContainEqual({
      method: "DELETE",
      path: "/dashboard/api-keys/key-1",
    });
    expect(byId(container, "apiKeyNotice")).toHaveTextContent(
      settings.apiKeys.revokeDone(ACTIVE.name)
    );
    expect(byId(container, "apiKeyRow-key-1")).toHaveTextContent(
      settings.apiKeys.revokedAt(formatDate("2026-01-05T06:07:08.000Z"))
    );
    expect(container.querySelector("#apiKeyCopy-key-1")).toBeNull();
    expect(container.querySelector("#apiKeyRevoke-key-1")).toBeNull();
  });

  it("explains a refused copy in French and leaves the row alone", async () => {
    copyFailure = new DashboardError("Jeton indisponible.", {
      code: "API_KEY_REVOKED",
      status: 409,
    });
    const user = setupUser();
    const { container } = render(<ApiKeysSettings />);
    await waitFor(() => expect(byId(container, "apiKeyList")).toBeVisible());

    await user.click(byId(container, "apiKeyCopy-key-1"));

    await waitFor(() =>
      expect(byId(container, "apiKeyError")).toHaveTextContent(
        errorMessages.API_KEY_REVOKED ?? ""
      )
    );
    expect(container.querySelector("#apiKeyCopy-key-1")).not.toBeNull();
  });

  it("keeps the draft when the server refuses the name", async () => {
    createFailure = new DashboardError("Nom refusé.", {
      code: "API_KEY_NAME",
      status: 400,
    });
    const user = setupUser();
    const { container } = render(<ApiKeysSettings />);
    await waitFor(() => expect(byId(container, "apiKeyList")).toBeVisible());

    await user.type(byId(container, "apiKeyName"), "Nom refusé");
    await user.click(byId(container, "apiKeyCreate"));

    await waitFor(() =>
      expect(byId(container, "apiKeyError")).toHaveTextContent(
        errorMessages.API_KEY_NAME ?? ""
      )
    );
    expect(byId(container, "apiKeyName")).toHaveValue("Nom refusé");
    // No token means no key: the block that shows it stays hidden.
    expect(byId(container, "apiKeyTokenBlock")).not.toBeVisible();
  });

  it("reports a failed list instead of pretending there is no key", async () => {
    apiMock.mockImplementation(async (path, options) => {
      calls.push({ method: options?.method ?? "GET", path });
      throw new DashboardError("Liste indisponible.", {
        code: "API_KEY_UNKNOWN",
        status: 404,
      });
    });
    const { container } = render(<ApiKeysSettings />);

    await waitFor(() =>
      expect(byId(container, "apiKeyError")).toHaveTextContent(
        errorMessages.API_KEY_UNKNOWN ?? ""
      )
    );
    expect(byId(container, "apiKeyEmpty")).not.toBeVisible();
  });
});
