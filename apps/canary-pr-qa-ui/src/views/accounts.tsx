import { type FormEvent, type ReactNode, useState } from "react";
import { api, errorText, post } from "@/api/client";
import type { LocalAccount, Role } from "@/api/contracts";
import { accountPayloadSchema, okSchema } from "@/api/schemas";
import { useSession } from "@/app/session";
import { useWorkspace } from "@/app/workspace";
import { Button } from "@/components/ui/button";
import { Notice, Pill } from "@/components/ui/feedback";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  FieldHelp,
  Input,
  Label,
  Select,
} from "@/components/ui/form";
import { common, roles, settings } from "@/i18n";
import { formatDate } from "@/lib/format";
import { createStore, type Store, useStore } from "@/lib/store";

const roleOptions: Role[] = ["viewer", "operator", "admin"];

interface AccountsState {
  accounts?: LocalAccount[];
  /** The operation in flight, so only the control that started it is disabled. */
  busy?: string;
  error?: string;
  notice?: string;
}

interface ReposDraft {
  repos: string[];
  role: Role;
}

interface CreateDraft {
  password: string;
  repos: string[];
  role: Role;
  username: string;
}

interface AccountActions {
  remove: (account: LocalAccount) => void;
  /** Answers whether the reset reached the server, so the field can be cleared. */
  reset: (account: LocalAccount, password: string) => Promise<boolean>;
  save: (account: LocalAccount, draft: ReposDraft) => void;
}

interface AccountRowProps {
  account: LocalAccount;
  actions: AccountActions;
  available: string[];
  busy?: string;
  /** Exactly one administrator exists: this account keeps the rights. */
  lastAdmin: boolean;
  ownId?: string;
}

/**
 * The list lives outside React, like the other screen stores: the subscription
 * React performs on mount starts the first load, and every write reloads the
 * list instead of patching a local guess of the server's answer.
 */
function createAccountsStore() {
  return createStore<AccountsState>({}, (store) => {
    void reload(store).catch(() => undefined);
  });
}

async function reload(store: Store<AccountsState>) {
  try {
    const data = await api("/accounts");
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
function offeredRepos(available: string[], account: LocalAccount): string[] {
  return account.repos.filter((repo) =>
    available.some((allowed) => allowed.toLowerCase() === repo.toLowerCase())
  );
}

/**
 * What the account can see, as the server stores it. An administrator follows
 * the GitHub selection, so its stored list says less than the truth and is
 * never shown as one.
 */
function reposSummary(account: LocalAccount): string {
  if (account.role === "admin") {
    return settings.accounts.reposFollowGithub;
  }
  return account.repos.length > 0
    ? settings.accounts.reposList(account.repos.join(", "))
    : settings.accounts.reposNone;
}

function ReposPicker({
  available,
  idPrefix,
  onChange,
  selected,
}: {
  available: string[];
  idPrefix: string;
  onChange: (repos: string[]) => void;
  selected: string[];
}): ReactNode {
  if (available.length === 0) {
    return (
      <FieldHelp id={`${idPrefix}-empty`}>
        {settings.accounts.reposNoneAvailable}
      </FieldHelp>
    );
  }
  return (
    <div className="mt-2 grid gap-1">
      {available.map((repo) => {
        const id = `${idPrefix}-${repo.replaceAll("/", "-")}`;
        return (
          <div className="flex items-center gap-2" key={repo}>
            <Checkbox
              checked={selected.includes(repo)}
              id={id}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, repo]
                    : selected.filter((entry) => entry !== repo)
                )
              }
            />
            <Label className="font-normal" htmlFor={id}>
              {repo}
            </Label>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One account and its own controls. The role and repository draft, the new
 * password and the pending confirmation are this row's state: a reload after a
 * write keeps them, so the row never jumps back to a value the user changed.
 */
function AccountRow({
  account,
  actions,
  available,
  busy,
  lastAdmin,
  ownId,
}: AccountRowProps): ReactNode {
  const [draft, setDraft] = useState<Partial<ReposDraft>>({});
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);

  // The row shows the user's edit when there is one, the server's value
  // otherwise: the offered repositories are only known once the workspace
  // status is loaded, so they can never be frozen into the initial state.
  const role = draft.role ?? account.role;
  const repos = draft.repos ?? offeredRepos(available, account);
  const self = ownId !== undefined && account.id === ownId;
  const protectedAdmin = lastAdmin && account.role === "admin";
  // An administrator's own list is never sent, so editing it is not a change
  // this screen can save.
  const dirty =
    role !== account.role ||
    (role !== "admin" &&
      repos.join(",") !== offeredRepos(available, account).join(","));

  return (
    <li
      className="rounded-lg border border-border px-3 py-3"
      id={`account-${account.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p
            className="font-medium text-sm"
            id={`account-username-${account.id}`}
          >
            {account.username}
          </p>
          <p
            className="mt-0.5 text-muted-foreground text-xs"
            id={`account-meta-${account.id}`}
          >
            {settings.accounts.createdAt(formatDate(account.createdAt))}
            {" · "}
            {reposSummary(account)}
          </p>
        </div>
        <Pill id={`account-role-pill-${account.id}`}>
          {roles[account.role]}
        </Pill>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-48">
          <Label htmlFor={`account-role-${account.id}`}>
            {settings.accounts.roleLabel}
          </Label>
          <Select
            disabled={protectedAdmin}
            id={`account-role-${account.id}`}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                role: event.target.value as Role,
              }))
            }
            value={role}
          >
            {roleOptions.map((roleOption) => (
              <option key={roleOption} value={roleOption}>
                {roles[roleOption]}
              </option>
            ))}
          </Select>
        </div>
        <Button
          disabled={!dirty || busy === `save-${account.id}`}
          id={`account-save-${account.id}`}
          onClick={() => actions.save(account, { repos, role })}
          variant="primary"
        >
          {settings.accounts.save}
        </Button>
        {protectedAdmin ? (
          <p
            className="pb-2 text-muted-foreground text-xs"
            id={`account-last-admin-${account.id}`}
          >
            {settings.accounts.lastAdmin}
          </p>
        ) : null}
      </div>
      <fieldset className="mt-3">
        <legend className="font-medium text-sm">
          {settings.accounts.reposTitle}
        </legend>
        {role === "admin" ? (
          <FieldHelp id={`account-repos-github-${account.id}`}>
            {settings.accounts.reposFollowGithub}
          </FieldHelp>
        ) : (
          <ReposPicker
            available={available}
            idPrefix={`account-repos-${account.id}`}
            onChange={(next) =>
              setDraft((current) => ({ ...current, repos: next }))
            }
            selected={repos}
          />
        )}
        <FieldHelp>{settings.accounts.reposHelp}</FieldHelp>
      </fieldset>
      <div className="mt-3 flex flex-wrap items-end gap-2 border-border border-t pt-3">
        <div className="min-w-56 flex-1">
          <Label htmlFor={`account-password-${account.id}`}>
            {settings.accounts.passwordLabel}
          </Label>
          <Input
            autoComplete="new-password"
            id={`account-password-${account.id}`}
            maxLength={128}
            minLength={12}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={settings.accounts.passwordPlaceholder}
            type="password"
            value={password}
          />
        </div>
        <Button
          aria-label={settings.accounts.passwordResetAria(account.username)}
          disabled={!password || busy === `password-${account.id}`}
          id={`account-password-reset-${account.id}`}
          onClick={() =>
            void actions
              .reset(account, password)
              .then((done) => (done ? setPassword("") : undefined))
          }
        >
          {settings.accounts.passwordReset}
        </Button>
      </div>
      <FieldHelp>{settings.accounts.passwordHelp}</FieldHelp>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-border border-t pt-3">
        <Button
          disabled={self || protectedAdmin || busy === `delete-${account.id}`}
          id={`account-delete-${account.id}`}
          onClick={() => setConfirming(true)}
          variant="danger"
        >
          {settings.accounts.delete}
        </Button>
        {self ? (
          <p
            className="text-muted-foreground text-xs"
            id={`account-self-${account.id}`}
          >
            {settings.accounts.deleteProtected}
          </p>
        ) : null}
        <Notice
          className="w-full"
          hidden={!confirming}
          id={`account-confirm-${account.id}`}
          tone="warning"
        >
          <p id={`account-confirm-text-${account.id}`}>
            {settings.accounts.confirmDelete(account.username)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              id={`account-confirm-run-${account.id}`}
              onClick={() => {
                setConfirming(false);
                actions.remove(account);
              }}
            >
              {common.confirm}
            </Button>
            <Button
              id={`account-confirm-cancel-${account.id}`}
              onClick={() => setConfirming(false)}
            >
              {common.cancel}
            </Button>
          </div>
        </Notice>
      </div>
    </li>
  );
}

function AccountsList({
  actions,
  available,
  busy,
  error,
  lastAdmin,
  ownId,
  rows,
}: {
  actions: AccountActions;
  available: string[];
  busy?: string;
  error?: string;
  lastAdmin: boolean;
  ownId?: string;
  rows?: LocalAccount[];
}): ReactNode {
  if (rows === undefined) {
    // The load failure is reported by the card; while it stands, announcing a
    // load in progress would contradict the message above it.
    return error ? null : (
      <p className="mt-3 text-muted-foreground text-sm" id="accountsLoading">
        {settings.accounts.loading}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="mt-3 text-muted-foreground text-sm" id="accountsEmpty">
        {settings.accounts.empty}
      </p>
    );
  }
  return (
    <ul className="mt-4 grid gap-3" id="accountsList">
      {rows.map((account) => (
        <AccountRow
          account={account}
          actions={actions}
          available={available}
          busy={busy}
          key={account.id}
          lastAdmin={lastAdmin}
          {...(ownId === undefined ? {} : { ownId })}
        />
      ))}
    </ul>
  );
}

function AccountsAdmin(): ReactNode {
  const [store] = useState(createAccountsStore);
  const { accounts, busy, error, notice } = useStore(store);
  const { user } = useSession();
  const { status } = useWorkspace();
  const [draft, setDraft] = useState<CreateDraft>({
    password: "",
    repos: [],
    role: "viewer",
    username: "",
  });

  const available = status?.github.repositories ?? [];
  const rows = accounts ?? [];
  // The server refuses to delete or demote the last administrator, and to
  // delete the caller's own account: the screen never offers an action it
  // knows will be refused.
  const lastAdmin =
    rows.filter((account) => account.role === "admin").length === 1;
  const ownId = user?.id.replace(/^local:/, "");

  const run = async (
    operation: string,
    action: () => Promise<string>
  ): Promise<boolean> => {
    store.set((current) => ({
      ...current,
      busy: operation,
      error: undefined,
      notice: undefined,
    }));
    try {
      const message = await action();
      await reload(store);
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
  };

  const actions: AccountActions = {
    remove: (account) =>
      void run(`delete-${account.id}`, async () => {
        await api(`/accounts/${account.id}`, {
          method: "DELETE",
          schema: okSchema,
        });
        return settings.accounts.deleted(account.username);
      }),
    reset: (account, password) =>
      run(`password-${account.id}`, async () => {
        await api(`/accounts/${account.id}`, {
          body: { password },
          method: "PATCH",
          schema: accountPayloadSchema,
        });
        return settings.accounts.passwordResetDone(account.username);
      }),
    save: (account, edited) =>
      void run(`save-${account.id}`, async () => {
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
      }),
  };

  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const username = draft.username.trim().toLowerCase();
    void run("create", async () => {
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
      setDraft((current) => ({ ...current, password: "", repos: [] }));
      return settings.accounts.created(username);
    });
  };

  return (
    <>
      <Notice className="mt-3 empty:hidden" id="accountsNotice" role="status">
        {notice}
      </Notice>
      <Notice
        className="mt-3 empty:hidden"
        id="accountsError"
        role="alert"
        tone="error"
      >
        {error}
        {error ? (
          <Button
            className="mt-2"
            onClick={() => void reload(store).catch(() => undefined)}
            type="button"
            variant="secondary"
          >
            {common.retry}
          </Button>
        ) : null}
      </Notice>
      <AccountsList
        actions={actions}
        available={available}
        busy={busy}
        error={error}
        lastAdmin={lastAdmin}
        ownId={ownId}
        rows={accounts}
      />
      <form
        className="mt-5 border-border border-t pt-4"
        id="accountsCreate"
        onSubmit={create}
      >
        <p className="font-medium text-sm">{settings.accounts.createTitle}</p>
        <div className="mt-3 grid gap-3">
          <div>
            <Label htmlFor="accountsUsername">
              {settings.accounts.usernameLabel}
            </Label>
            <Input
              autoComplete="off"
              id="accountsUsername"
              maxLength={64}
              minLength={3}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  username: event.target.value,
                }))
              }
              placeholder={settings.accounts.usernamePlaceholder}
              required
              value={draft.username}
            />
            <FieldHelp>{settings.accounts.usernameHelp}</FieldHelp>
          </div>
          <div>
            <Label htmlFor="accountsNewPassword">
              {settings.accounts.passwordLabel}
            </Label>
            <Input
              autoComplete="new-password"
              id="accountsNewPassword"
              maxLength={128}
              minLength={12}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  password: event.target.value,
                }))
              }
              placeholder={settings.accounts.passwordPlaceholder}
              required
              type="password"
              value={draft.password}
            />
            <FieldHelp>{settings.accounts.passwordHelp}</FieldHelp>
          </div>
          <div>
            <Label htmlFor="accountsNewRole">
              {settings.accounts.roleLabel}
            </Label>
            <Select
              id="accountsNewRole"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  role: event.target.value as Role,
                }))
              }
              value={draft.role}
            >
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {roles[role]}
                </option>
              ))}
            </Select>
          </div>
          <fieldset>
            <legend className="font-medium text-sm">
              {settings.accounts.reposTitle}
            </legend>
            {draft.role === "admin" ? (
              <FieldHelp id="accountsReposAdmin">
                {settings.accounts.reposFollowGithub}
              </FieldHelp>
            ) : (
              <ReposPicker
                available={available}
                idPrefix="accountsNewRepo"
                onChange={(repos) =>
                  setDraft((current) => ({ ...current, repos }))
                }
                selected={draft.repos}
              />
            )}
            <FieldHelp>{settings.accounts.reposHelp}</FieldHelp>
          </fieldset>
        </div>
        <Button
          className="mt-3"
          disabled={busy === "create"}
          id="accountsCreateSubmit"
          type="submit"
          variant="primary"
        >
          {settings.accounts.createCta}
        </Button>
      </form>
    </>
  );
}

/**
 * The local accounts that reach this dashboard, and the administrator's tools
 * to manage them: role, repositories, password and removal. Only an
 * administrator may read or change any of it, so every other role gets the
 * reason instead of a form whose requests the server would refuse.
 */
export function AccountsSettings(): ReactNode {
  const { isAdmin } = useSession();

  return (
    <Card id="accountsSettings">
      <CardHeader>
        <CardTitle>{settings.accounts.title}</CardTitle>
      </CardHeader>
      <CardDescription>{settings.accounts.intro}</CardDescription>
      {isAdmin ? (
        <AccountsAdmin />
      ) : (
        <Notice className="mt-3" id="accountsForbidden" tone="warning">
          {settings.accounts.forbidden}
        </Notice>
      )}
    </Card>
  );
}
