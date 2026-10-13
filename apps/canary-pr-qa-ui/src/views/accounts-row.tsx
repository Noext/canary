import { type ReactNode, useState } from "react";
import type { LocalAccount, Role } from "@/api/contracts";
import { Button } from "@/components/ui/button";
import { Notice, Pill } from "@/components/ui/feedback";
import {
  Checkbox,
  FieldHelp,
  Input,
  Label,
  Select,
} from "@/components/ui/form";
import { common, roles, settings } from "@/i18n";
import { formatDate } from "@/lib/format";
import {
  type AccountActions,
  offeredRepos,
  type ReposDraft,
  reposSummary,
  roleOptions,
} from "./accounts-store";

interface AccountRowProps {
  account: LocalAccount;
  actions: AccountActions;
  available: string[];
  busy?: string;
  /** Exactly one administrator exists: this account keeps the rights. */
  lastAdmin: boolean;
  ownId?: string;
}

export function ReposPicker({
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
export function AccountRow({
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
