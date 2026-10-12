import { type FormEvent, useMemo, useRef, useState } from "react";
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
import { common, newTest } from "@/i18n";
import { createStore, useStore } from "@/lib/store";

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

/** Identity of a run input: exactly the parameters a preflight is verified for. */
function inputKey(pr: string, preview: string, model: string): string {
  return JSON.stringify(buildInput(pr, preview, model));
}

interface RunDraft {
  pr: string;
  preview: string;
}

/**
 * The last `/runs/preflight` call: the input it ran on and the line to show for
 * it. The line is bound to that input instead of being cleared by a reaction:
 * as soon as the form leaves those parameters the message no longer describes
 * it, so it stops rendering.
 */
interface PreflightCall {
  input: string;
  message: string;
  summary?: string;
}

interface NewTestState {
  call?: PreflightCall;
  draft: RunDraft;
  launchBusy: boolean;
}

function createNewTestStore() {
  return createStore<NewTestState>({
    draft: { pr: "", preview: "" },
    launchBusy: false,
  });
}

/**
 * The catalogue is never guessed, so an empty selection after a successful load
 * must ask for an explicit choice.
 */
function placeholderFor(
  catalog: ModelCatalog | undefined,
  error: string | undefined,
  busy: boolean
): string {
  if (catalog) {
    return newTest.modelChoose;
  }
  if (busy) {
    return newTest.modelLoading;
  }
  return error ? newTest.modelUnavailable : newTest.modelChoose;
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
    // Nothing is loading and nothing arrived: say so instead of pretending to
    // still be loading, so "Actualiser les modèles" is the obvious next move.
    return newTest.modelUnavailable;
  }
  return ready
    ? newTest.modelAvailable(catalog.data.length)
    : newTest.modelRequired;
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
    loadStatus,
    statusError,
  } = useWorkspace();

  const form = useRef<HTMLFormElement>(null);
  // The form and the check it is armed by live in a store: a preflight answer
  // arrives after the fact and must be compared with the parameters the form
  // holds then, which is not what the render that sent it captured.
  const [store] = useState(() => createNewTestStore());
  const { call, draft, launchBusy } = useStore(store);

  const currentKey = useMemo(
    () => inputKey(draft.pr, draft.preview, model),
    [draft.pr, draft.preview, model]
  );
  // The notice and the armed launch belong to the exact input that was checked,
  // so editing a field is enough to disarm them: nothing has to be cleared.
  // `preflight` is the verified result the workspace shares with the rest of the
  // dashboard, the local call only says which input it belongs to.
  const summary =
    call?.summary !== undefined &&
    call.input === currentKey &&
    preflight !== undefined
      ? call.summary
      : undefined;
  const verified = summary !== undefined;
  const feedback =
    call !== undefined && call.input === currentKey ? call.message : "";

  const editPr = (value: string) =>
    store.set((current) => ({
      ...current,
      draft: { ...current.draft, pr: value },
    }));

  const editPreview = (value: string) =>
    store.set((current) => ({
      ...current,
      draft: { ...current.draft, preview: value },
    }));

  const check = async () => {
    if (form.current && !form.current.reportValidity()) {
      return;
    }
    const requested = store.getSnapshot().draft;
    const requestedKey = inputKey(requested.pr, requested.preview, model);
    clear();
    setPreflight(undefined);
    setPreflightBusy(true);
    store.set((current) => ({
      ...current,
      call: { input: requestedKey, message: newTest.checkReading },
    }));
    try {
      const checked = await api(
        "/runs/preflight",
        post(buildInput(requested.pr, requested.preview, model))
      );
      const edited = store.getSnapshot().draft;
      const editedKey = inputKey(edited.pr, edited.preview, model);
      if (editedKey !== requestedKey) {
        // The answer describes parameters the form no longer holds: say so
        // instead of arming the launch on a stale preflight. It is never
        // handed to the workspace.
        store.set((current) => ({
          ...current,
          call: { input: editedKey, message: newTest.checkChanged },
        }));
        return;
      }
      const host = new URL(checked.preview.url).host;
      setPreflight(checked);
      store.set((current) => ({
        ...current,
        call: {
          input: requestedKey,
          message: newTest.checkReady,
          summary: newTest.summary({
            host,
            number: checked.pr.number,
            repo: checked.pr.repo,
            sha: checked.pr.sha,
            title: checked.pr.title,
          }),
        },
      }));
    } catch (failure) {
      store.set((current) => ({
        ...current,
        call: { input: requestedKey, message: errorText(failure) },
      }));
      report(failure);
    } finally {
      setPreflightBusy(false);
    }
  };

  const launch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (summary === undefined) {
      store.set((current) => ({
        ...current,
        call: { input: currentKey, message: newTest.checkRequired },
      }));
      return;
    }
    const requested = store.getSnapshot().draft;
    store.set((current) => ({
      ...current,
      call: { input: currentKey, message: newTest.launching },
      launchBusy: true,
    }));
    try {
      const run = await api("/runs", {
        body: {
          ...buildInput(requested.pr, requested.preview, model),
          publish: true,
        },
        method: "POST",
        schema: runCreatedSchema,
      });
      // The preflight is consumed by the launch, the "Création du test…" line
      // stays until the history view replaces this one.
      setPreflight(undefined);
      // Opening the run switches to the history view, which reloads the run
      // list on mount with the created test included.
      openRun(run.id);
    } catch (failure) {
      report(failure);
    } finally {
      store.set((current) => ({ ...current, launchBusy: false }));
    }
  };

  const options = models?.data ?? [];
  const placeholder = placeholderFor(models, modelsError, modelsBusy);
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
          {githubReady && !statusError ? null : (
            <Notice className="mb-4" id="runBlocker" tone="warning">
              {statusError ?? newTest.blocker}
              {statusError ? (
                <Button
                  className="mt-2"
                  onClick={() => void loadStatus()}
                  type="button"
                  variant="secondary"
                >
                  {common.retry}
                </Button>
              ) : null}
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
                onChange={(event) => editPr(event.target.value)}
                placeholder={newTest.prPlaceholder}
                required
                type="url"
                value={draft.pr}
              />
            </Field>
            <Field
              help={newTest.previewHelp}
              htmlFor="preview"
              label={newTest.previewLabel}
            >
              <Input
                id="preview"
                onChange={(event) => editPreview(event.target.value)}
                placeholder={newTest.previewPlaceholder}
                type="url"
                value={draft.preview}
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
            {summary === undefined ? null : (
              <Notice id="preflightResult">
                <strong>{newTest.verified}</strong>
                <p id="preflightSummary">{summary}</p>
              </Notice>
            )}
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
                  !(githubReady && modelReady && verified) ||
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
