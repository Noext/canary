import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { api, errorText, post } from "@/api/client";
import type { GitHubRepository, GitHubStatus } from "@/api/contracts";
import { githubRemovalSchema } from "@/api/schemas";
import { useError } from "@/app/errors";
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
} from "@/components/ui/form";
import { common, settings } from "@/i18n";
import { formatDate, type Tone } from "@/lib/format";

type RemovalKind = "delete" | "uninstall";
type Operation = RemovalKind | "create" | "install" | "refresh" | "save";

const removalCopy: Record<RemovalKind, string> = {
  delete: settings.github.confirmDelete,
  uninstall: settings.github.confirmUninstall,
};

/** The list says why it is empty: no repository at all, or none matching. */
function emptyReposMessage(
  total: number,
  shown: number,
  query: string
): string {
  if (total === 0) {
    return settings.github.emptyRepos;
  }
  return shown === 0 ? settings.github.noMatch(query.trim()) : "";
}

interface ManifestPost {
  action: string;
  value: string;
}

/** A repository the server allowlist refuses stays visible but cannot be saved. */
function isRestricted(fullName: string, restriction: string[]): boolean {
  return (
    restriction.length > 0 && !restriction.includes(fullName.toLowerCase())
  );
}

function connectionFor(
  app: GitHubStatus["app"],
  enabledCount: number
): { label: string; tone: Tone } {
  if (!app) {
    return { label: settings.github.notConnected, tone: "neutral" };
  }
  if (enabledCount > 0) {
    return {
      label: settings.github.connected(enabledCount),
      tone: "success",
    };
  }
  return { label: settings.github.toFinish, tone: "pending" };
}

function baseMessageFor(
  app: GitHubStatus["app"],
  enabledCount: number,
  legacyConfigured: boolean
): string {
  if (app) {
    return enabledCount > 0
      ? settings.github.messageConnected
      : settings.github.created;
  }
  return legacyConfigured
    ? settings.github.legacyConfigured
    : settings.github.messageFirstRun;
}

function removalNotice(deleteApp: boolean, warnings: string[]): string {
  if (warnings.length > 0) {
    return settings.github.removalWarning(warnings.join(" "));
  }
  return deleteApp
    ? settings.github.removalDeleted
    : settings.github.removalUninstalled;
}

export function GithubSettings(): ReactNode {
  const { github, githubError, loadGithub, loadStatus } = useWorkspace();
  const { refreshUser } = useSession();
  const { report } = useError();

  const [name, setName] = useState(
    () => `Canary-QA-${Math.random().toString(36).slice(2, 8)}`
  );
  const [organization, setOrganization] = useState("");
  const [busy, setBusy] = useState<Operation>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedMessage, setSavedMessage] = useState<string>();
  const [removal, setRemoval] = useState<RemovalKind>();
  const [repoQuery, setRepoQuery] = useState("");
  const [edited, setEdited] = useState<Record<string, boolean>>({});
  const [autoEdited, setAutoEdited] = useState<Record<string, boolean>>({});
  const [manifestPost, setManifestPost] = useState<ManifestPost>();
  const manifestForm = useRef<HTMLFormElement>(null);

  const run = useCallback(
    async (operation: Operation, action: () => Promise<void>) => {
      setBusy(operation);
      setError("");
      try {
        await action();
      } catch (failure) {
        setError(errorText(failure));
        report(failure);
      } finally {
        setBusy(undefined);
      }
    },
    [report]
  );

  const createApp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run("create", async () => {
      const trimmed = organization.trim();
      const result = await api(
        "/github/app/manifest",
        post({
          name,
          ...(trimmed ? { organization: trimmed } : {}),
        })
      );
      // GitHub only accepts the App manifest as a cross-origin form POST. The
      // manifest is submitted from the handler that received it: flushing the
      // state puts the form in the DOM first, so no reaction to the state is
      // needed to submit it.
      flushSync(() =>
        setManifestPost({
          action: result.action,
          value: JSON.stringify(result.manifest),
        })
      );
      manifestForm.current?.submit();
    });
  };

  const installApp = () =>
    void run("install", async () => {
      const result = await api("/github/app/install", post({}));
      window.location.assign(result.url);
    });

  const refresh = () =>
    void run("refresh", async () => {
      setNotice("");
      setSavedMessage(undefined);
      // The refresh endpoint re-syncs the installations server-side; the card
      // always reads the shared status, so reload it instead of rendering a
      // second copy of the same payload.
      await api("/github/app/refresh", post({}));
      await loadGithub();
      setEdited({});
      setAutoEdited({});
      await refreshUser();
      await loadStatus();
    });

  const disconnect = (kind: RemovalKind) =>
    void run(kind, async () => {
      const deleteApp = kind === "delete";
      const data = await api("/github/app", {
        ...post({ deleteApp }),
        method: "DELETE",
        schema: githubRemovalSchema,
      });
      setSavedMessage(undefined);
      await loadGithub();
      setEdited({});
      setAutoEdited({});
      const warnings = data.disconnected.warnings;
      setNotice(removalNotice(deleteApp, warnings));
      await refreshUser();
      await loadStatus();
    });

  const saveRepositories = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run("save", async () => {
      const restriction = github?.restriction ?? [];
      const saveable = (github?.repositories ?? []).filter(
        (repository) => !isRestricted(repository.full_name, restriction)
      );
      const repositories = saveable
        .filter((repository) => isSelected(repository))
        .map((repository) => repository.full_name);
      // Automatic runs follow the checked rows, and only those: the server
      // refuses an auto-run repository that is not selected, so an unselected
      // row can never leak its (defaulted) auto-run state into the request.
      const autoRepos = saveable
        .filter((repository) => isSelected(repository) && isAutoRun(repository))
        .map((repository) => repository.full_name);
      await api("/github/app/repositories", {
        ...post({ repositories, autoRepos }),
        method: "PUT",
      });
      setNotice("");
      await loadGithub();
      setEdited({});
      setAutoEdited({});
      setSavedMessage(settings.github.messageSaved);
      await refreshUser();
      await loadStatus();
    });
  };

  const confirmRemoval = () => {
    const kind = removal;
    if (!kind) {
      return;
    }
    setRemoval(undefined);
    disconnect(kind);
  };

  const app = github?.app ?? null;
  const restriction = github?.restriction ?? [];
  const repositories = github?.repositories ?? [];
  // The search narrows the rendered rows only: the save path always reads the
  // whole status, so a filtered-out repository keeps its saved selection.
  const query = repoQuery.trim().toLowerCase();
  const visibleRepositories = query
    ? repositories.filter((repository) =>
        repository.full_name.toLowerCase().includes(query)
      )
    : repositories;
  const emptyRepos = emptyReposMessage(
    repositories.length,
    visibleRepositories.length,
    repoQuery
  );
  // The checkbox state is the user's edit when there is one, the server value
  // otherwise: a fresh status never leaves a tick behind.
  const isSelected = (repository: GitHubRepository): boolean =>
    edited[repository.full_name] ?? repository.enabled;
  const isAutoRun = (repository: GitHubRepository): boolean =>
    autoEdited[repository.full_name] ?? repository.auto_run;
  const enabled = repositories.filter(
    (repository) =>
      repository.enabled && !isRestricted(repository.full_name, restriction)
  );
  // A failed status request means the connection is unknown, not absent: never
  // advertise "À connecter" and the creation form on a transient error. With a
  // cached status the panel stays readable, but it must say the last reload
  // failed instead of passing the cache off as the current state.
  const stale = Boolean(githubError);
  const pending = !github && stale;
  const connection = pending
    ? { label: common.checking, tone: "neutral" as const }
    : connectionFor(app, enabled.length);
  const delivery =
    app && github?.lastDelivery
      ? settings.github.webhookLast(
          formatDate(github.lastDelivery.created_at),
          github.lastDelivery.status
        )
      : "";
  const baseMessage = baseMessageFor(
    app,
    enabled.length,
    github?.legacyConfigured ?? false
  );
  const message = github ? (savedMessage ?? `${baseMessage}${delivery}`) : "";

  return (
    <Card id="githubSettings">
      <CardHeader>
        <div>
          <p className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
            {settings.eyebrowGithub}
          </p>
          <CardTitle>{settings.github.title}</CardTitle>
        </div>
        <Pill id="githubConnection" tone={connection.tone}>
          {connection.label}
        </Pill>
      </CardHeader>
      <CardDescription>{settings.github.intro}</CardDescription>
      <div className="mt-3 flex flex-wrap gap-2 text-muted-foreground text-xs">
        {settings.github.trail.map((step) => (
          <span
            className="rounded-full border border-border px-2 py-0.5"
            key={step}
          >
            {step}
          </span>
        ))}
      </div>
      <Notice className="mt-3 empty:hidden" id="githubMessage" role="status">
        {message}
      </Notice>
      <Notice className="mt-3 empty:hidden" id="githubNotice" role="status">
        {notice}
      </Notice>
      <p
        className="mt-3 text-on-fail text-sm empty:hidden"
        id="githubError"
        role="alert"
      >
        {error}
      </p>
      {stale ? (
        <Notice className="mt-3" id="githubPending" tone="error">
          {githubError}
          <Button
            className="mt-2"
            onClick={() => void loadGithub().catch(() => undefined)}
            type="button"
            variant="secondary"
          >
            {common.retry}
          </Button>
        </Notice>
      ) : null}
      <form
        className="mt-4 grid gap-3"
        hidden={pending || Boolean(app)}
        id="githubCreate"
        onSubmit={createApp}
      >
        <div>
          <Label htmlFor="githubName">{settings.github.nameLabel}</Label>
          <Input
            id="githubName"
            maxLength={100}
            minLength={3}
            onChange={(event) => setName(event.target.value)}
            placeholder={settings.github.namePlaceholder}
            required
            value={name}
          />
        </div>
        <div>
          <Label htmlFor="githubOrg">{settings.github.orgLabel}</Label>
          <Input
            id="githubOrg"
            onChange={(event) => setOrganization(event.target.value)}
            placeholder={settings.github.orgPlaceholder}
            value={organization}
          />
          <FieldHelp>{settings.github.orgHelp}</FieldHelp>
        </div>
        <Button
          disabled={busy === "create"}
          id="githubCreateButton"
          type="submit"
          variant="primary"
        >
          {settings.github.createCta}
        </Button>
      </form>
      <div hidden={pending || !app} id="githubAppActions">
        <p className="mt-4 text-muted-foreground text-sm" id="githubAppName">
          {app ? settings.github.appName(app.slug, app.id) : ""}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={busy === "install"}
            id="githubInstall"
            onClick={installApp}
            variant="primary"
          >
            {settings.github.installCta}
          </Button>
          <Button
            disabled={busy === "refresh"}
            id="githubRefresh"
            onClick={refresh}
          >
            {settings.github.refresh}
          </Button>
        </div>
        <form className="mt-4" id="githubRepos" onSubmit={saveRepositories}>
          <fieldset>
            <legend className="font-medium text-sm">
              {settings.github.reposLegend}
            </legend>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <Label htmlFor="githubRepoSearch">
                  {settings.github.searchLabel}
                </Label>
                <Input
                  autoComplete="off"
                  id="githubRepoSearch"
                  onChange={(event) => setRepoQuery(event.target.value)}
                  placeholder={settings.github.searchPlaceholder}
                  type="search"
                  value={repoQuery}
                />
              </div>
              <p
                className="pb-2 text-muted-foreground text-xs"
                id="githubRepoCount"
              >
                {settings.github.repoCount(
                  visibleRepositories.length,
                  repositories.length
                )}
              </p>
            </div>
            <div
              className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-border"
              id="githubRepoList"
            >
              {emptyRepos ? (
                <p className="px-3 py-2 text-muted-foreground text-sm">
                  {emptyRepos}
                </p>
              ) : (
                visibleRepositories.map((repository) => {
                  const restricted = isRestricted(
                    repository.full_name,
                    restriction
                  );
                  const slug = repository.full_name.replaceAll("/", "-");
                  const inputId = `repo-${slug}`;
                  const autoId = `repo-auto-${slug}`;
                  return (
                    <div
                      className="flex items-center gap-3 border-border border-t px-3 py-2 first:border-t-0"
                      key={repository.full_name}
                    >
                      <Checkbox
                        checked={isSelected(repository)}
                        disabled={restricted}
                        id={inputId}
                        onChange={(event) =>
                          setEdited((current) => ({
                            ...current,
                            [repository.full_name]: event.target.checked,
                          }))
                        }
                        value={repository.full_name}
                      />
                      <div className="min-w-0 flex-1">
                        <Label
                          className="flex items-center gap-1 font-normal"
                          htmlFor={inputId}
                          title={repository.full_name}
                        >
                          <span className="truncate">
                            {repository.full_name}
                          </span>
                          {restricted ? (
                            <span className="shrink-0 text-muted-foreground text-xs">
                              {settings.github.restricted}
                            </span>
                          ) : null}
                        </Label>
                        <div className="mt-0.5 flex items-center gap-2">
                          <Checkbox
                            checked={isAutoRun(repository)}
                            disabled={restricted}
                            id={autoId}
                            onChange={(event) =>
                              setAutoEdited((current) => ({
                                ...current,
                                [repository.full_name]: event.target.checked,
                              }))
                            }
                          />
                          <Label
                            className="truncate font-normal text-muted-foreground text-xs"
                            htmlFor={autoId}
                            title={settings.github.autoRunLabel}
                          >
                            {settings.github.autoRunLabel}
                          </Label>
                        </div>
                      </div>
                      <Pill>
                        {repository.private
                          ? settings.github.private
                          : settings.github.public}
                      </Pill>
                    </div>
                  );
                })
              )}
            </div>
            <FieldHelp>{settings.github.autoRunHelp}</FieldHelp>
          </fieldset>
          <Button
            className="mt-3"
            disabled={busy === "save"}
            id="githubSave"
            type="submit"
          >
            {settings.github.saveRepos}
          </Button>
        </form>
        <details
          className="mt-4 rounded-lg border border-border px-3 py-2"
          id="githubDanger"
        >
          <summary className="cursor-pointer font-medium text-sm">
            {settings.github.dangerSummary}
          </summary>
          <p className="mt-2 text-muted-foreground text-sm">
            {settings.github.dangerBody}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              disabled={busy === "uninstall"}
              id="githubUninstall"
              onClick={() => setRemoval("uninstall")}
            >
              {settings.github.uninstallCta}
            </Button>
            <Button
              disabled={busy === "delete"}
              id="githubDeleteApp"
              onClick={() => setRemoval("delete")}
              variant="danger"
            >
              {settings.github.deleteApp}
            </Button>
          </div>
          <Notice
            className="mt-3"
            hidden={removal === undefined}
            id="githubConfirm"
            tone="warning"
          >
            <p id="githubConfirmText">{removal ? removalCopy[removal] : ""}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button id="githubConfirmRun" onClick={confirmRemoval}>
                {common.confirm}
              </Button>
              <Button
                id="githubConfirmCancel"
                onClick={() => setRemoval(undefined)}
              >
                {common.cancel}
              </Button>
            </div>
          </Notice>
        </details>
      </div>
      <details className="mt-4 rounded-lg border border-border px-3 py-2">
        <summary className="cursor-pointer font-medium text-sm">
          {settings.github.permissionsSummary}
        </summary>
        <p className="mt-2 text-muted-foreground text-sm">
          {settings.github.permissionsBody}
        </p>
        <p className="mt-2 text-muted-foreground text-sm" id="githubOriginHint">
          {settings.github.originHint}
        </p>
      </details>
      {manifestPost ? (
        <form
          action={manifestPost.action}
          hidden
          method="POST"
          ref={manifestForm}
        >
          <input name="manifest" type="hidden" value={manifestPost.value} />
        </form>
      ) : null}
    </Card>
  );
}
