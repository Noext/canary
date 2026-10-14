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
import { common, settings } from "@/i18n";
import type { Tone } from "@/lib/format";
import { cn } from "@/lib/utils";

function aiConnectionFor(
  hasCatalog: boolean,
  failure: string | undefined
): { label: string; tone: Tone } {
  if (failure) {
    return { label: settings.ai.needsAttention, tone: "failed" };
  }
  if (hasCatalog) {
    return { label: settings.ai.catalogAccessible, tone: "success" };
  }
  return { label: common.checking, tone: "neutral" };
}

export function AiSettings(): ReactNode {
  const { loadModels, models, modelsBusy, modelsError, status } =
    useWorkspace();

  const connection = aiConnectionFor(Boolean(models), modelsError);
  const catalog =
    modelsError ?? (models ? settings.ai.catalog(models.data.length) : "");

  return (
    <Card id="aiSettings">
      <CardHeader>
        <CardTitle>{settings.ai.title}</CardTitle>
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
