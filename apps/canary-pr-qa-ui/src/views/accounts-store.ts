import { accountPayloadSchema, accountsSchema } from "@/api/account-schemas";
import { api, DashboardError, errorText, post } from "@/api/client";
import type { LocalAccount, Role } from "@/api/contracts";
import { settings } from "@/i18n";
import { createStore, type Store } from "@/lib/store";

export const roleOptions: Role[] = ["viewer", "operator", "admin"];

export interface AccountsState {
  accounts?: LocalAccount[];
  /** The operation in flight, so only the control that started it is disabled. */
  busy?: string;
  error?: string;
  notice?: string;
}

export interface ReposDraft {
  repos: string[];
  role: Role;
}

export interface CreateDraft {
  password: string;
  repos: string[];
  role: Role;
  username: string;
}

export interface AccountActions {
  /** Answers whether the account was created, so the form can clear its secret. */
  create: (draft: CreateDraft) => Promise<boolean>;
  remove: (account: LocalAccount) => void;
  /** Answers whether the reset reached the server, so the field can be cleared. */
  reset: (account: LocalAccount, password: string) => Promise<boolean>;
  save: (account: LocalAccount, draft: ReposDraft) => void;
}

/**
 * The list lives outside React, like the other screen stores: the subscription
 * React performs on mount starts the first load, and every write reloads the
 * list instead of patching a local guess of the server's answer.
 */
export function createAccountsStore() {
  return createStore<AccountsState>({}, (store) => {
    void reload(store).catch(() => undefined);
  });
}

export async function reload(store: Store<AccountsState>) {
  try {
    const data = await api("/accounts", { schema: accountsSchema });
    store.set((current) => ({
      ...current,
      accounts: data.accounts,
      error: undefined,
    }));
  } catch (failure) {
    // A reload that failed must not be reported as a saved edit: the rejection
    // is kept so the caller's own error handling still runs.
    store.set((current) => ({ ...current, error: errorText(failure) }));
    throw failure;
  }
}

/** An account's repositories, narrowed to the ones the server still allows. */
export function offeredRepos(
  available: string[],
  account: LocalAccount
): string[] {
  return account.repos.filter((repo) =>
    available.some((allowed) => allowed.toLowerCase() === repo.toLowerCase())
  );
}

/**
 * What the account can see, as the server stores it. An administrator follows
 * the GitHub selection, so its stored list says less than the truth and is
 * never shown as one.
 */
export function reposSummary(account: LocalAccount): string {
  if (account.role === "admin") {
    return settings.accounts.reposFollowGithub;
  }
  return account.repos.length > 0
    ? settings.accounts.reposList(account.repos.join(", "))
    : settings.accounts.reposNone;
}

/** The list is administrator-only: this refusal means the role is gone. */
function lostAdminAccess(failure: unknown): boolean {
  return failure instanceof DashboardError && failure.status === 403;
}

/**
 * One write: mark the control that started it, reload the authoritative list,
 * then report the notice or the failure. Returns whether it reached the server.
 * `onAccessLost` runs when the write applied but the caller can no longer read
 * the list, so the session can be reloaded instead of the screen lying.
 */
export async function runOperation(
  store: Store<AccountsState>,
  operation: string,
  action: () => Promise<string>,
  onAccessLost: () => void
): Promise<boolean> {
  store.set((current) => ({
    ...current,
    busy: operation,
    error: undefined,
    notice: undefined,
  }));
  try {
    const message = await action();
    try {
      await reload(store);
    } catch (failure) {
      // An administrator who demoted themselves — or who was demoted by
      // another one — keeps the write but loses the read: reporting a failed
      // save would be a lie, and the session still carries the old role.
      if (!lostAdminAccess(failure)) {
        throw failure;
      }
      store.set((current) => ({
        ...current,
        busy: undefined,
        error: undefined,
        notice: message,
      }));
      onAccessLost();
      return true;
    }
    store.set((current) => ({
      ...current,
      busy: undefined,
      notice: message,
    }));
    return true;
  } catch (failure) {
    store.set((current) => ({
      ...current,
      busy: undefined,
      error: errorText(failure),
    }));
    return false;
  }
}

/**
 * The writes this screen offers, bound to the store they report into. The
 * offered repositories are what an administrator may hand over: the whole
 * effective selection, which the server always accepts as a subset.
 */
export function accountActions(
  store: Store<AccountsState>,
  available: string[],
  onAccessLost: () => void
): AccountActions {
  return {
    create: (draft) =>
      runOperation(
        store,
        "create",
        async () => {
          const username = draft.username.trim().toLowerCase();
          await api("/accounts", {
            ...post({
              password: draft.password,
              // An administrator follows the GitHub selection, and the whole
              // allowed list is the subset the server always accepts.
              repos: draft.role === "admin" ? available : draft.repos,
              role: draft.role,
              username,
            }),
            schema: accountPayloadSchema,
          });
          return settings.accounts.created(username);
        },
        onAccessLost
      ),
    remove: (account) =>
      void runOperation(
        store,
        `delete-${account.id}`,
        async () => {
          await api(`/accounts/${account.id}`, {
            method: "DELETE",
            // The reload below carries the schema: this answer is not read.
            unvalidated: true,
          });
          return settings.accounts.deleted(account.username);
        },
        onAccessLost
      ),
    reset: (account, password) =>
      runOperation(
        store,
        `password-${account.id}`,
        async () => {
          await api(`/accounts/${account.id}`, {
            body: { password },
            method: "PATCH",
            schema: accountPayloadSchema,
          });
          return settings.accounts.passwordResetDone(account.username);
        },
        onAccessLost
      ),
    save: (account, edited) =>
      void runOperation(
        store,
        `save-${account.id}`,
        async () => {
          // An administrator follows the GitHub selection, so its own list is
          // left out of the request: a stored repository the server no longer
          // allows would otherwise fail a plain role change.
          await api(`/accounts/${account.id}`, {
            body:
              edited.role === "admin"
                ? { role: edited.role }
                : { repos: edited.repos, role: edited.role },
            method: "PATCH",
            schema: accountPayloadSchema,
          });
          return settings.accounts.saved(account.username);
        },
        onAccessLost
      ),
  };
}
