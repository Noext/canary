import type { ReactNode } from "react";
import type { SettingsSection } from "@/i18n";
import { AccountsSettings } from "./accounts";
import { AiSettings } from "./ai-settings";
import { ApiKeysSettings } from "./api-keys-settings";
import { GithubSettings } from "./github-settings";
import { PreviewSettings } from "./preview-settings";

/**
 * One settings page at a time. The shell picks the section from the sidebar
 * submenu (or from `#settings=<section>`), so a page never renders the panels
 * the operator is not looking at: the GitHub card is no longer in the DOM while
 * they read the API keys.
 *
 * `data-section` names the visible page, so a test can assert which one is on
 * screen without reading the submenu.
 */
export function SettingsView({
  section,
}: {
  section: SettingsSection;
}): ReactNode {
  return (
    <section data-panel="settings" data-section={section} id="settingsPanel">
      {section === "github" ? <GithubSettings /> : null}
      {section === "ai" ? <AiSettings /> : null}
      {section === "preview" ? <PreviewSettings /> : null}
      {section === "apiKeys" ? <ApiKeysSettings /> : null}
      {section === "accounts" ? <AccountsSettings /> : null}
    </section>
  );
}
