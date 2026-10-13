import { useState } from "react";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { NavigationProvider } from "@/app/navigation";
import { type InitialRoute, readInitialRoute } from "@/app/routing";
import { SessionProvider, useSession } from "@/app/session";
import { WorkspaceProvider } from "@/app/workspace";
import type { ViewName } from "@/i18n";
import { LoginView } from "@/views/login-view";
import { Shell } from "./app/shell";

/** A deep link wins over the post-callback destination. */
function initialViewFor(route: InitialRoute): ViewName {
  if (route.screen) {
    return route.screen.kind === "run" ? "run" : "automatic";
  }
  if (route.runId) {
    return "runs";
  }
  return route.github ? "settings" : "home";
}

function Screens({ route }: { route: InitialRoute }) {
  const { phase, user } = useSession();
  if (phase !== "authenticated" || !user) {
    return <LoginView />;
  }
  return (
    <WorkspaceProvider>
      <NavigationProvider
        {...(route.runId ? { initialRun: route.runId } : {})}
        {...(route.screen?.kind === "run"
          ? { initialRunScreen: route.screen.id }
          : {})}
        {...(route.screen?.kind === "automatic"
          ? { initialAutomatic: route.screen.id }
          : {})}
        initialView={initialViewFor(route)}
      >
        <Shell />
      </NavigationProvider>
    </WorkspaceProvider>
  );
}

export function App() {
  const [route] = useState(readInitialRoute);
  return (
    <ErrorProvider>
      <SessionProvider
        {...(route.setupCode ? { setupCode: route.setupCode } : {})}
      >
        <ErrorAlert />
        <Screens route={route} />
      </SessionProvider>
    </ErrorProvider>
  );
}
