import type { ReactNode } from "react";
import { useNavigation } from "@/app/navigation";
import { settingsNav, shell } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The settings submenu: one entry per settings page, in the order
 * `settingsNav` declares. It only renders while « Réglages » is the visible
 * panel, so the sidebar never grows a section list the operator cannot read.
 *
 * The addresses it writes (`#settings=<id>`) are the ones `readInitialRoute`
 * reads back, which is what makes a settings page shareable.
 */
export function SettingsNav(): ReactNode {
  const { openSection, section } = useNavigation();

  return (
    <ul
      aria-label={shell.settingsSections}
      className="mt-1 flex flex-col gap-1 border-line border-l pl-3"
      id="settingsNav"
    >
      {settingsNav.map((entry) => {
        const current = entry.id === section;
        return (
          <li key={entry.id}>
            <button
              aria-current={current ? "page" : undefined}
              className={cn(
                "w-full rounded-md px-3 py-1.5 text-left text-sm",
                current
                  ? "bg-primary/20 font-semibold text-ink-strong"
                  : "text-muted-foreground hover:bg-well-2 hover:text-foreground"
              )}
              id={`nav-settings-${entry.id}`}
              onClick={() => openSection(entry.id)}
              type="button"
            >
              {entry.label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
