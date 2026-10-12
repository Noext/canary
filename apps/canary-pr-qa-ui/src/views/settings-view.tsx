import type { ReactNode } from "react";
import type { SetupStatus } from "@/api/contracts";
import { useWorkspace } from "@/app/workspace";
import { Card, CardDescription, CardTitle } from "@/components/ui/form";
import { settings } from "@/i18n";
import { AiSettings } from "./ai-settings";
import { GithubSettings } from "./github-settings";

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

function PreviewSettings(): ReactNode {
  const { status } = useWorkspace();
  const preview = status?.preview;
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
    </Card>
  );
}

export function SettingsView(): ReactNode {
  return (
    <section data-panel="settings" id="settingsPanel">
      <div className="grid gap-5 lg:grid-cols-2">
        <GithubSettings />
        <div className="flex flex-col gap-5">
          <AiSettings />
          <PreviewSettings />
        </div>
      </div>
    </section>
  );
}
