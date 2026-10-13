import type { ReactNode } from "react";
import { AiSettings } from "./ai-settings";
import { ApiKeysSettings } from "./api-keys-settings";
import { GithubSettings } from "./github-settings";
import { PreviewSettings } from "./preview-settings";

export function SettingsView(): ReactNode {
  return (
    <section data-panel="settings" id="settingsPanel">
      <div className="grid gap-5 lg:grid-cols-2">
        <GithubSettings />
        <div className="flex flex-col gap-5">
          <AiSettings />
          <PreviewSettings />
          <ApiKeysSettings />
        </div>
      </div>
    </section>
  );
}
