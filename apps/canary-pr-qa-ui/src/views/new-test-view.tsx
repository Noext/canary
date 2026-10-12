import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, post } from "@/api/client";
import type { ModelCatalog } from "@/api/contracts";
import { runCreatedSchema } from "@/api/schemas";
import { useError } from "@/app/errors";
import { useNavigation } from "@/app/navigation";
import { useWorkspace } from "@/app/workspace";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/feedback";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
} from "@/components/ui/form";
import { newTest } from "@/i18n";

/**
 * Model-field copy the shared i18n module does not carry yet. Same constraint
 * as the rest of the screen: the catalogue is never guessed, so an empty
 * selection after a successful load must ask for an explicit choice.
 */
const modelUnavailable = "Catalogue indisponible";
const modelChoose = "Choisir un modèle";
const modelRequired =
  "Modèle précédent ou par défaut indisponible : choisissez explicitement un modèle.";
const modelAvailable = (count: number) =>
  `${count} modèles disponibles · aucun remplacement automatique.`;

interface RunInput {
  model: string;
  previewUrl?: string;
  prUrl: string;
}

function buildInput(prUrl: string, preview: string, model: string): RunInput {
  const previewUrl = preview.trim();
  return {
    prUrl: prUrl.trim(),
    ...(previewUrl ? { previewUrl } : {}),
    model,
  };
}

const asJson = (value: RunInput) => JSON.stringify(value);

function placeholderFor(
  catalog: ModelCatalog | undefined,
  error: string | undefined
): string {
  if (catalog) {
    return modelChoose;
  }
  return error ? modelUnavailable : newTest.modelLoading;
}

function modelStateText(
  catalog: ModelCatalog | undefined,
  error: string | undefined,
  busy: boolean,
  ready: boolean
): string {
  if (busy) {
    return newTest.modelLoading;
  }
  if (error) {
    return error;
  }
  if (!catalog) {
    return newTest.modelLoading;
  }
  return ready ? modelAvailable(catalog.data.length) : modelRequired;
}

export function NewTestView() {
  const { clear, report } = useError();
  const { openRun } = useNavigation();
  const {
    githubReady,
    loadModels,
    model,
    models,
    modelsBusy,
    modelsError,
    modelReady,
    preflight,
    preflightBusy,
    setModel,
    setPreflight,
    setPreflightBusy,
  } = useWorkspace();

  const form = useRef<HTMLFormElement>(null);
  const [pr, setPr] = useState("");
  const [preview, setPreview] = useState("");
  const [feedback, setFeedback] = useState("");
  const [summary, setSummary] = useState("");
  const [launchBusy, setLaunchBusy] = useState(false);

  const input = useMemo(
    () => buildInput(pr, preview, model),
    [pr, preview, model]
  );
  const latestInput = useRef(input);

  useEffect(() => {
    const previous = latestInput.current;
    latestInput.current = input;
    if (asJson(previous) === asJson(input)) {
      return;
    }
    // Editing a verified field drops the preflight: the launch button may only
    // stay armed for the exact parameters that were checked.
    setPreflight(undefined);
    setSummary("");
    setFeedback("");
  }, [input, setPreflight]);

  const check = async () => {
    if (form.current && !form.current.reportValidity()) {
      return;
    }
    const requested = latestInput.current;
    clear();
    setPreflight(undefined);
    setSummary("");
    setPreflightBusy(true);
    setFeedback(newTest.checkReading);
    try {
      const checked = await api("/runs/preflight", post(requested));
      if (asJson(latestInput.current) !== asJson(requested)) {
        setFeedback(newTest.checkChanged);
        return;
      }
      const host = new URL(checked.preview.url).host;
      setPreflight(checked);
      setSummary(
        newTest.summary({
          host,
          number: checked.pr.number,
          repo: checked.pr.repo,
          sha: checked.pr.sha,
          title: checked.pr.title,
        })
      );
      setFeedback(newTest.checkReady);
    } catch (failure) {
      setFeedback(errorText(failure));
      report(failure);
    } finally {
      setPreflightBusy(false);
    }
  };

  const launch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!preflight) {
      setFeedback(newTest.checkRequired);
      return;
    }
    setLaunchBusy(true);
    setFeedback(newTest.launching);
    try {
      const run = await api("/runs", {
        body: { ...latestInput.current, publish: true },
        method: "POST",
        schema: runCreatedSchema,
      });
      setPreflight(undefined);
      setSummary("");
      // Opening the run switches to the history view, which reloads the run
      // list on mount with the created test included.
      openRun(run.id);
    } catch (failure) {
      report(failure);
    } finally {
      setLaunchBusy(false);
    }
  };

  const options = models?.data ?? [];
  const placeholder = placeholderFor(models, modelsError);
  const modelState = modelStateText(
    models,
    modelsError,
    modelsBusy,
    modelReady
  );

  return (
    <section id="launchSection">
      <div className="grid grid-cols-1 items-start gap-5 min-[1080px]:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{newTest.title}</CardTitle>
              <CardDescription>{newTest.intro}</CardDescription>
            </div>
          </CardHeader>
          {githubReady ? null : (
            <Notice className="mb-4" id="runBlocker" tone="warning">
              {newTest.blocker}
            </Notice>
          )}
          <form
            className="grid gap-4"
            id="runForm"
            onSubmit={launch}
            ref={form}
          >
            <Field help={newTest.prHelp} htmlFor="pr" label={newTest.prLabel}>
              <Input
                id="pr"
                onChange={(event) => setPr(event.target.value)}
                placeholder="https://github.com/votre-equipe/projet/pull/123"
                required
                type="url"
                value={pr}
              />
            </Field>
            <Field
              help={newTest.previewHelp}
              htmlFor="preview"
              label={newTest.previewLabel}
            >
              <Input
                id="preview"
                onChange={(event) => setPreview(event.target.value)}
                placeholder="https://preview-de-votre-pr.example.com"
                type="url"
                value={preview}
              />
            </Field>
            <Field htmlFor="model" label={newTest.modelLabel}>
              <div className="flex gap-2">
                <Select
                  disabled={!models}
                  id="model"
                  onChange={(event) => setModel(event.target.value)}
                  required
                  value={model}
                >
                  <option value="">{placeholder}</option>
                  {options.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.id}
                    </option>
                  ))}
                </Select>
                <Button
                  className="mt-1 shrink-0"
                  disabled={modelsBusy}
                  id="refreshModels"
                  onClick={() => void loadModels()}
                  variant="secondary"
                >
                  {newTest.modelRefresh}
                </Button>
              </div>
              <p
                className={
                  modelsError
                    ? "mt-1 text-on-fail text-xs"
                    : "mt-1 text-muted-foreground text-xs"
                }
                id="modelState"
                role="status"
              >
                {modelState}
              </p>
            </Field>
            {preflight ? (
              <Notice id="preflightResult">
                <strong>{newTest.verified}</strong>
                <p id="preflightSummary">{summary}</p>
              </Notice>
            ) : null}
            <div
              className="text-muted-foreground text-sm"
              id="runFeedback"
              role="status"
            >
              {feedback}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!(githubReady && modelReady) || preflightBusy}
                id="checkRun"
                onClick={() => void check()}
              >
                {newTest.check}
              </Button>
              <Button
                disabled={
                  !(githubReady && modelReady && preflight) ||
                  preflightBusy ||
                  launchBusy
                }
                id="startRun"
                type="submit"
                variant="primary"
              >
                {newTest.launch}
              </Button>
            </div>
            <small className="text-muted-foreground text-xs">
              {newTest.publishedNotice}
            </small>
          </form>
        </Card>
        <aside className="hidden min-[1080px]:block">
          <p className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
            {newTest.guide.eyebrow}
          </p>
          <h3 className="mt-1 font-semibold text-base">
            {newTest.guide.title}
          </h3>
          <ol className="mt-3 flex flex-col gap-3 text-sm">
            {newTest.guide.items.map(([title, body]) => (
              <li key={title}>
                <strong className="block">{title}</strong>
                <span className="text-muted-foreground">{body}</span>
              </li>
            ))}
          </ol>
          <div className="my-4 h-px bg-line" />
          <small className="text-muted-foreground text-xs">
            {newTest.guide.fence}
          </small>
        </aside>
      </div>
    </section>
  );
}
