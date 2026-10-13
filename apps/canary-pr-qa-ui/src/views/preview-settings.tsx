import { type ReactNode, useState } from "react";
import { api, errorText } from "@/api/client";
import type { SetupStatus } from "@/api/contracts";
import { useWorkspace } from "@/app/workspace";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/feedback";
import {
  Card,
  CardDescription,
  CardTitle,
  Input,
  Label,
} from "@/components/ui/form";
import { settings } from "@/i18n";

function previewModeFor(preview: SetupStatus["preview"] | undefined): string {
  if (!preview) {
    return "";
  }
  return preview.automatic
    ? settings.preview.modeAutomatic
    : settings.preview.modeManual;
}

/**
 * The server omits the preview constraints for non-admins, so the card keeps a
 * readable fallback instead of an empty line.
 */
function proofFor(preview: SetupStatus["preview"] | undefined): string {
  if (preview?.shaPath) {
    return settings.preview.proofPath(preview.shaPath);
  }
  if (preview?.shaHeader) {
    return settings.preview.proofHeader(preview.shaHeader);
  }
  return settings.preview.proofFallback;
}

function sameHosts(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((host, i) => host === right[i])
  );
}

/**
 * Cheap guard for the input row only: the server owns the allowlist format and
 * its rejection is rendered as-is, so the two can never drift apart silently.
 */
function inputProblem(host: string, hosts: string[]): string | undefined {
  if (!host) {
    return settings.preview.hostsEmpty;
  }
  if (hosts.includes(host)) {
    return settings.preview.hostsDuplicate;
  }
  if (/[\s/@*]|:\/\//.test(host)) {
    return settings.preview.hostsInvalid;
  }
  return;
}

function HostsEditor({
  hosts: enforced,
  hostsDefault,
}: {
  hosts: string[];
  hostsDefault: string[];
}): ReactNode {
  const { loadStatus } = useWorkspace();
  const [draft, setDraft] = useState<string[]>();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // The draft is the user's edit when there is one, the server list otherwise:
  // a reload after saving never leaves a stale row behind.
  const hosts = draft ?? enforced;
  // Resetting only makes sense once the enforced list no longer matches the one
  // the server ships in its environment, or while an unsaved draft exists.
  const canReset = Boolean(draft) || !sameHosts(enforced, hostsDefault);

  const edit = (next: string[]) => {
    setDraft(next);
    setError("");
    setNotice("");
  };

  const add = () => {
    const host = input.trim().toLowerCase();
    const problem = inputProblem(host, hosts);
    if (problem) {
      setError(problem);
      return;
    }
    edit([...hosts, host]);
    setInput("");
  };

  const run = async (operation: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      setDraft(undefined);
      await loadStatus();
      setNotice(done);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-border border-t pt-4" id="previewHostEditor">
      <p className="font-medium text-sm">{settings.preview.hostsEditorTitle}</p>
      <p className="mt-1 text-muted-foreground text-xs">
        {settings.preview.hostsEditorIntro}
      </p>
      {hostsDefault.length > 0 ? (
        <p
          className="mt-2 text-muted-foreground text-xs"
          id="previewHostsDefault"
        >
          {settings.preview.hostsDefault(hostsDefault.join(", "))}
        </p>
      ) : null}
      <ul className="mt-3 space-y-2" id="previewHostList">
        {hosts.map((host) => (
          <li
            className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-1.5 text-sm"
            key={host}
          >
            <span className="break-all">{host}</span>
            <Button
              aria-label={settings.preview.hostsRemove(host)}
              disabled={busy}
              onClick={() => edit(hosts.filter((entry) => entry !== host))}
              variant="quiet"
            >
              {settings.preview.hostsRemoveLabel}
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <Label htmlFor="previewHostInput">
            {settings.preview.hostsInput}
          </Label>
          <Input
            id="previewHostInput"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
            placeholder={settings.preview.hostsPlaceholder}
            value={input}
          />
        </div>
        <Button
          disabled={busy}
          id="previewHostAdd"
          onClick={add}
          variant="quiet"
        >
          {settings.preview.hostsAdd}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          disabled={busy || !draft || !hosts.length}
          id="previewHostSave"
          onClick={() =>
            run(
              () =>
                api("/dashboard/preview-hosts", {
                  body: { hosts },
                  method: "PUT",
                }),
              settings.preview.hostsSaved
            )
          }
          variant="primary"
        >
          {busy ? settings.preview.hostsSaving : settings.preview.hostsSave}
        </Button>
        <Button
          disabled={busy || !canReset}
          id="previewHostReset"
          onClick={() =>
            run(
              () => api("/dashboard/preview-hosts", { method: "DELETE" }),
              settings.preview.hostsResetDone
            )
          }
        >
          {settings.preview.hostsReset}
        </Button>
      </div>
      {error ? (
        <Notice
          className="mt-3"
          id="previewHostsError"
          role="alert"
          tone="error"
        >
          {error}
        </Notice>
      ) : null}
      {notice ? (
        <Notice className="mt-3" id="previewHostsSaved" tone="success">
          {notice}
        </Notice>
      ) : null}
    </div>
  );
}

export function PreviewSettings(): ReactNode {
  const { status } = useWorkspace();
  const preview = status?.preview;
  const editor = Boolean(preview?.hosts);
  const hosts = preview?.hosts?.length
    ? settings.preview.hosts(preview.hosts.join(", "))
    : settings.preview.hostsFallback;

  return (
    <Card>
      <CardTitle>{settings.preview.title}</CardTitle>
      <CardDescription className="mt-1">
        {settings.preview.intro}
      </CardDescription>
      <p className="mt-2 text-sm" id="previewMode">
        {previewModeFor(preview)}
      </p>
      <details className="mt-4 rounded-lg border border-border px-3 py-2">
        <summary className="cursor-pointer font-medium text-sm">
          {settings.preview.versionSummary}
        </summary>
        <p className="mt-2 text-muted-foreground text-sm" id="previewHosts">
          {hosts}
        </p>
        <p className="mt-2 text-muted-foreground text-sm" id="previewProof">
          {proofFor(preview)}
        </p>
        <p className="mt-2 text-muted-foreground text-sm">
          {settings.preview.help}
        </p>
      </details>
      {editor ? (
        <HostsEditor
          hosts={preview?.hosts ?? []}
          hostsDefault={preview?.hostsDefault ?? []}
        />
      ) : null}
    </Card>
  );
}
