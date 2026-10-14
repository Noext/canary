import { useState } from "react";
import { ErrorAlert, ErrorProvider } from "@/app/errors";
import { NavigationProvider } from "@/app/navigation";
import { type InitialRoute, readInitialRoute, viewOf } from "@/app/routing";
import { SessionProvider, useSession } from "@/app/session";
import { WorkspaceProvider } from "@/app/workspace";
import { LoginView } from "@/views/login-view";
import { Shell } from "./app/shell";

function Screens({ initial }: { initial: InitialRoute }) {
  const { phase, user } = useSession();
  if (phase !== "authenticated" || !user) {
    return <LoginView />;
  }
  const { route } = initial;
  return (
    <WorkspaceProvider>
      <NavigationProvider
        {...(route.kind === "runs" && route.runId
          ? { initialRun: route.runId }
          : {})}
        {...(route.kind === "run" ? { initialRunScreen: route.id } : {})}
        {...(route.kind === "automatic" ? { initialAutomatic: route.id } : {})}
        {...(route.kind === "settings"
          ? { initialSection: route.section }
          : {})}
        // Le retour du callback GitHub ouvre la connexion à GitHub des réglages :
        // c'est le seul écran que l'adresse ne nomme pas elle-même.
        initialView={initial.github ? "settings" : viewOf(route)}
      >
        <Shell />
      </NavigationProvider>
    </WorkspaceProvider>
  );
}

export function App() {
  const [initial] = useState(readInitialRoute);
  return (
    <ErrorProvider>
      <SessionProvider
        {...(initial.setupCode ? { setupCode: initial.setupCode } : {})}
      >
        <ErrorAlert />
        <Screens initial={initial} />
      </SessionProvider>
    </ErrorProvider>
  );
}
