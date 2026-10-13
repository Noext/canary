import { type FormEvent, type ReactNode, useState } from "react";
import type { LocalAccount, Role } from "@/api/contracts";
import { useSession } from "@/app/session";
import { useWorkspace } from "@/app/workspace";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/feedback";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  FieldHelp,
  Input,
  Label,
  Select,
} from "@/components/ui/form";
import { common, roles, settings } from "@/i18n";
import { useStore } from "@/lib/store";
import { AccountRow, ReposPicker } from "./accounts-row";
import {
  type AccountActions,
  accountActions,
  type CreateDraft,
  createAccountsStore,
  reload,
  roleOptions,
} from "./accounts-store";

function AccountsList({
  actions,
  available,
  busy,
  error,
  lastAdmin,
  ownId,
  reposKnown,
  rows,
}: {
  actions: AccountActions;
  available: string[];
  busy?: string;
  error?: string;
  lastAdmin: boolean;
  ownId?: string;
  reposKnown: boolean;
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
          reposKnown={reposKnown}
        />
      ))}
    </ul>
  );
}

function CreateForm({
  available,
  busy,
  create,
  reposKnown,
}: {
  available: string[];
  busy?: string;
  create: (draft: CreateDraft) => Promise<boolean>;
  reposKnown: boolean;
}): ReactNode {
  const [draft, setDraft] = useState<CreateDraft>({
    password: "",
    repos: [],
    role: "viewer",
    username: "",
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void create(draft).then((created) =>
      created
        ? setDraft((current) => ({ ...current, password: "", repos: [] }))
        : undefined
    );
  };

  return (
    <form
      className="mt-5 border-border border-t pt-4"
      id="accountsCreate"
      onSubmit={submit}
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
          <Label htmlFor="accountsNewRole">{settings.accounts.roleLabel}</Label>
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
              known={reposKnown}
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
        disabled={busy === "create" || (draft.role !== "admin" && !reposKnown)}
        id="accountsCreateSubmit"
        type="submit"
        variant="primary"
      >
        {settings.accounts.createCta}
      </Button>
    </form>
  );
}

function AccountsAdmin(): ReactNode {
  const [store] = useState(createAccountsStore);
  const { accounts, busy, error, notice } = useStore(store);
  const { refreshUser, user } = useSession();
  const { status } = useWorkspace();

  const available = status?.github.repositories ?? [];
  // An unknown selection is not an empty one: writing the fallback would revoke
  // the repositories of every account whose role is edited before it loads.
  const reposKnown = status !== undefined;
  const rows = accounts ?? [];
  // The server refuses to delete or demote the last administrator, and to
  // delete the caller's own account: the screen never offers an action it
  // knows will be refused.
  const lastAdmin =
    rows.filter((account) => account.role === "admin").length === 1;
  const ownId = user?.id.replace(/^local:/, "");
  // A write can change the caller's own role: the session is reloaded so the
  // screen stops showing controls the server would now refuse.
  const actions = accountActions(store, available, () => void refreshUser());

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
        reposKnown={reposKnown}
        rows={accounts}
      />
      <CreateForm
        available={available}
        busy={busy}
        create={actions.create}
        reposKnown={reposKnown}
      />
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
