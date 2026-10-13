import type { ReactNode } from "react";
import { useError } from "@/app/errors";
import { useNavigation } from "@/app/navigation";
import { useSession } from "@/app/session";
import { useWorkspace } from "@/app/workspace";
import { Pill } from "@/components/ui/feedback";
import { home, roles, shell, type ViewName, views } from "@/i18n";
import { cn } from "@/lib/utils";
import { AutomaticDetailView } from "@/views/automatic-detail";
import { HomeView } from "@/views/home-view";
import { NewTestView } from "@/views/new-test-view";
import { RunScreenView } from "@/views/run-screen";
import { RunsView } from "@/views/runs-view";
import { SettingsView } from "@/views/settings-view";

const navItems: { id: string; label: string; view: ViewName }[] = [
  { id: "nav-home", label: shell.nav.home, view: "home" },
  { id: "nav-new", label: shell.nav.new, view: "new" },
  { id: "nav-runs", label: shell.nav.runs, view: "runs" },
  { id: "nav-settings", label: shell.nav.settings, view: "settings" },
];

/**
 * The nav entry a screen belongs to, so the sidebar still shows where the
 * operator is while a deep-linked detail is open.
 */
const navParent: Partial<Record<ViewName, ViewName>> = {
  automatic: "home",
  run: "runs",
};

function Logo() {
  return (
    <div className="flex items-center gap-2 font-semibold text-base">
      <span
        aria-hidden="true"
        className="size-4 rounded-full border-2 border-primary-edge bg-primary"
      />
      Canary
    </div>
  );
}

export function Shell() {
  const { canWrite, isAdmin, logout, user } = useSession();
  const { report } = useError();
  const { navigate, view } = useNavigation();
  const { githubReady, modelReady, status } = useWorkspace();
  const copy = views[view];
  const current = navParent[view] ?? view;

  const visible = navItems.filter((item) => {
    if (item.view === "settings") {
      return isAdmin;
    }
    if (item.view === "new") {
      return canWrite;
    }
    return true;
  });

  return (
    <div
      className="grid min-h-screen grid-cols-1 md:grid-cols-[16rem_1fr]"
      id="work"
    >
      <aside className="border-border border-b bg-well px-4 py-5 md:border-r md:border-b-0">
        <Logo />
        <small className="mt-1 block text-muted-foreground text-xs">
          {shell.tagline}
        </small>
        <nav
          aria-label="Navigation principale"
          className="mt-6 flex flex-col gap-1"
        >
          {visible.map((item) => (
            <button
              aria-current={current === item.view ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-2 text-left text-sm",
                current === item.view
                  ? "bg-primary/20 font-semibold text-ink-strong"
                  : "text-foreground hover:bg-well-2"
              )}
              id={item.id}
              key={item.id}
              onClick={() => navigate(item.view)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="mt-6 border-line border-t pt-4 text-muted-foreground text-xs">
          <strong className="block text-foreground">{shell.footer}</strong>
          {shell.footerDetail}
        </div>
      </aside>
      <main className="min-w-0 px-4 py-5 md:px-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <span className="text-muted-foreground text-sm" id="breadcrumb">
            {copy.breadcrumb}
          </span>
          <div className="flex items-center gap-3">
            <Pill id="connection">
              {user
                ? `${user.username ?? user.id} • ${roles[user.role]}`
                : shell.account}
            </Pill>
            <button
              className="rounded-md px-2 py-1 text-muted-foreground text-sm underline-offset-4 hover:underline"
              id="logout"
              onClick={() =>
                void logout().catch((failure: unknown) => report(failure))
              }
              type="button"
            >
              {shell.logout}
            </button>
          </div>
        </header>
        <div className="mb-6">
          <h1 className="font-semibold text-2xl" id="viewTitle">
            {copy.title}
          </h1>
          <p className="text-muted-foreground text-sm" id="viewIntro">
            {copy.intro}
          </p>
        </div>
        {view === "home" ? (
          <HomeView
            githubReady={githubReady}
            modelReady={modelReady}
            status={status}
          />
        ) : null}
        {view === "new" ? <NewTestView /> : null}
        {view === "runs" ? <RunsView /> : null}
        {view === "run" ? <RunScreenView /> : null}
        {view === "automatic" ? <AutomaticDetailView /> : null}
        {view === "settings" ? <SettingsView /> : null}
        {view === "home" && !canWrite ? (
          <p className="sr-only">{home.titleViewer}</p>
        ) : null}
      </main>
    </div>
  );
}

export function ShellFallback({ children }: { children: ReactNode }) {
  return <div id="work">{children}</div>;
}
