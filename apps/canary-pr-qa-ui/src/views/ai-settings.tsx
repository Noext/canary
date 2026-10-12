import type { ReactNode } from "react";
import { useWorkspace } from "@/app/workspace";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/feedback";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/form";
import { settings } from "@/i18n";
import type { Tone } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Copy the shared i18n module does not carry yet. */
const AI_VERIFYING = "Vérification…";
const AI_CATALOG_ACCESSIBLE = "Catalogue accessible";
const AI_NEEDS_ATTENTION = "Connexion à vérifier";

function aiConnectionFor(
  hasCatalog: boolean,
  failure: string | undefined
): { label: string; tone: Tone } {
  if (failure) {
    return { label: AI_NEEDS_ATTENTION, tone: "failed" };
  }
  if (hasCatalog) {
    return { label: AI_CATALOG_ACCESSIBLE, tone: "success" };
  }
  return { label: AI_VERIFYING, tone: "neutral" };
}

export function AiSettings(): ReactNode {
  const { loadModels, models, modelsBusy, modelsError, status } =
    useWorkspace();

  const connection = aiConnectionFor(Boolean(models), modelsError);
  const catalog =
    modelsError ?? (models ? settings.ai.catalog(models.data.length) : "");

  return (
    <Card>
      <CardHeader>
        <div>
          <p className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
            {settings.eyebrow}
          </p>
          <CardTitle>{settings.ai.title}</CardTitle>
        </div>
        <Pill id="aiConnection" tone={connection.tone}>
          {connection.label}
        </Pill>
      </CardHeader>
      <CardDescription>{settings.ai.intro}</CardDescription>
      <p className="mt-2 text-sm" id="aiEndpoint">
        {status ? settings.ai.endpoint(status.ai.endpoint) : ""}
      </p>
      <p className="mt-1 text-sm" id="aiDefault">
        {status ? settings.ai.defaultModel(status.ai.defaultModel) : ""}
      </p>
      <small
        className={cn(
          "mt-1 block text-xs",
          modelsError ? "text-on-fail" : "text-muted-foreground"
        )}
        id="aiCatalog"
      >
        {catalog}
      </small>
      <Button
        className="mt-3"
        disabled={modelsBusy}
        id="retryModels"
        onClick={() => void loadModels()}
      >
        {settings.ai.retry}
      </Button>
      <details className="mt-4 rounded-lg border border-border px-3 py-2">
        <summary className="cursor-pointer font-medium text-sm">
          {settings.ai.failureSummary}
        </summary>
        <p className="mt-2 text-muted-foreground text-sm">
          {settings.ai.failureHelp}
        </p>
      </details>
    </Card>
  );
}
