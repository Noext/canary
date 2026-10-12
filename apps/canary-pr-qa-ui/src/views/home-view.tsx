import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { RunJob, SetupStatus } from "@/api/contracts";
import { useError } from "@/app/errors";
import { useNavigation } from "@/app/navigation";
import { useSession } from "@/app/session";
import { useWorkspace } from "@/app/workspace";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/feedback";
import { Card, CardHeader, CardTitle } from "@/components/ui/form";
import { home, settings, type ViewName } from "@/i18n";
import { outcomeLabel, stateLabel, type Tone, toneFor } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AutomaticRuns } from "./automatic-runs";

/**
 * Copy this screen owns. `src/i18n.ts` is shared and edited by several agents
 * at once, so these stay local until they are promoted there.
 */
const copy = {
  actionChooseModel: "Choisir mon modèle IA",
  actionConnectGithub: "Connecter GitHub",
  githubChooseRepos: "Choisir vos dépôts →",
  githubConnect: "Connecter GitHub →",
  githubStateChecking: "Vérification…",
  githubTechnical: "Accès technique actif",
  modelStateBusy: "Chargement du catalogue…",
  modelStateLoading: "Chargement des modèles…",
  modelStateReady: "Modèle disponible",
  modelStateRetry: "Vérifier la connexion →",
  modelStateUnavailable:
    "Modèle par défaut indisponible : choisissez explicitement un modèle.",
  noteProgress:
    "Votre progression est enregistrée. Commencez par l’étape indiquée.",
  noteReady: "PR + application de test → scénarios, vidéos et résultat.",
  noteViewer: "Votre compte dispose d’un accès en lecture.",
  onboardingIntro:
    "Suivez ces étapes dans l’ordre. Votre configuration est conservée.",
  runsLoading: "Chargement de vos tests…",
  setupCount: (ready: number) => `${ready}/2 connexions prêtes`,
} as const;

/** The label of `#welcomeAction`, derived from readiness exactly like the legacy `syncReadiness()`. */
function welcomeActionLabel(githubReady: boolean, modelReady: boolean): string {
  if (!githubReady) {
    return copy.actionConnectGithub;
  }
  return modelReady ? home.actionRun : copy.actionChooseModel;
}

function githubStepState(
  status: SetupStatus | undefined,
  githubReady: boolean
): string {
  if (!status) {
    return copy.githubStateChecking;
  }
  if (githubReady) {
    return status.github.mode === "app"
      ? settings.github.connected(status.github.repositories.length)
      : copy.githubTechnical;
  }
  return status.github.mode === "app"
    ? copy.githubChooseRepos
    : copy.githubConnect;
}

function modelStepState(state: {
  catalogFailed: boolean;
  catalogLoaded: boolean;
  modelReady: boolean;
  modelsBusy: boolean;
}): string {
  if (state.modelReady) {
    return copy.modelStateReady;
  }
  if (state.modelsBusy) {
    return copy.modelStateBusy;
  }
  if (state.catalogLoaded) {
    return copy.modelStateUnavailable;
  }
  return state.catalogFailed ? copy.modelStateRetry : copy.modelStateLoading;
}

/** The pill follows the run's outcome, falling back to its status. */
function recentRunLabel(run: RunJob): string {
  return run.outcome ? outcomeLabel(run.outcome) : stateLabel(run.status);
}

function Stat({
  hint,
  id,
  label,
  value,
}: {
  hint: string;
  id: string;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <span className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </span>
      <strong className="mt-1 block font-semibold text-2xl" id={id}>
        {value}
      </strong>
      <small className="text-muted-foreground text-xs">{hint}</small>
    </div>
  );
}

function StepButton({
  active,
  body,
  done,
  id,
  number,
  onClick,
  state,
  stateId,
  title,
}: {
  active: boolean;
  body: string;
  done: boolean;
  id: string;
  number: string;
  onClick: () => void;
  state: string;
  stateId?: string;
  title: string;
}) {
  return (
    <button
      className={cn(
        "flex h-full flex-col items-start gap-2 rounded-lg border p-4 text-left",
        stepClass(done, active)
      )}
      id={id}
      onClick={onClick}
      type="button"
    >
      <span className="font-semibold text-muted-foreground text-xs">
        {number}
      </span>
      <h3 className="font-semibold text-sm">{title}</h3>
      <p className="text-muted-foreground text-xs">{body}</p>
      <span className="font-medium text-xs" id={stateId}>
        {state}
      </span>
    </button>
  );
}

function stepClass(done: boolean, active: boolean): string {
  if (done) {
    return "border-pass/40 bg-pass/10";
  }
  return active
    ? "border-primary-edge bg-primary/10"
    : "border-border bg-card hover:bg-well";
}

function readinessTone(readyCount: number): Tone {
  if (readyCount === 2) {
    return "success";
  }
  return readyCount === 1 ? "pending" : "neutral";
}

function heroTitle(canWrite: boolean, returning: boolean): string {
  if (!canWrite) {
    return home.titleViewer;
  }
  return returning ? home.titleReturning : home.titleDefault;
}

function heroIntro(canWrite: boolean, returning: boolean): string {
  if (!canWrite) {
    return home.introViewer;
  }
  return returning ? home.introReturning : home.introDefault;
}

function heroNote(
  canWrite: boolean,
  githubReady: boolean,
  modelReady: boolean
): string {
  if (!canWrite) {
    return copy.noteViewer;
  }
  return githubReady && modelReady ? copy.noteReady : copy.noteProgress;
}

function heroActionTarget(
  canWrite: boolean,
  githubReady: boolean,
  isAdmin: boolean
): ViewName {
  if (!canWrite) {
    return "runs";
  }
  return !githubReady && isAdmin ? "settings" : "new";
}

function activeStepFor(
  githubReady: boolean,
  modelReady: boolean
): "github" | "model" | null {
  if (!githubReady) {
    return "github";
  }
  return modelReady ? null : "model";
}

/**
 * Home screen: readiness, the three bootstrap steps, the run counters and the
 * three most recent runs. The counts come from the runs of the whole account,
 * never from the history filters of the runs screen.
 */
export function HomeView({
  githubReady,
  modelReady,
  status,
}: {
  githubReady: boolean;
  modelReady: boolean;
  status?: SetupStatus;
}) {
  const { canWrite, isAdmin } = useSession();
  const { models, modelsBusy, modelsError } = useWorkspace();
  const { navigate, openRun } = useNavigation();
  const { report } = useError();
  const [runs, setRuns] = useState<RunJob[]>();

  useEffect(() => {
    let active = true;
    api("/runs")
      .then((rows) => {
        if (active) {
          setRuns(rows);
        }
      })
      .catch((failure: unknown) => {
        if (!active) {
          return;
        }
        report(failure);
        setRuns([]);
      });
    return () => {
      active = false;
    };
  }, [report]);

  const loading = runs === undefined;
  const all = runs ?? [];
  const recent = all.slice(0, 3);
  const counts = {
    active: all.filter(
      (run) => run.status === "queued" || run.status === "running"
    ).length,
    passed: all.filter((run) => run.outcome === "passed").length,
    total: all.length,
  };
  const returning = canWrite && all.length > 0;
  const readyCount = Number(githubReady) + Number(modelReady);
  const activeStep = activeStepFor(githubReady, modelReady);
  const stepTarget: ViewName = isAdmin ? "settings" : "new";
  const actionTarget = heroActionTarget(canWrite, githubReady, isAdmin);

  return (
    <>
      <Card className="mb-5">
        <p className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
          {home.heroEyebrow}
        </p>
        <h2 className="mt-1 font-semibold text-xl" id="welcomeTitle">
          {heroTitle(canWrite, returning)}
        </h2>
        <p
          className="mt-2 max-w-prose text-muted-foreground text-sm"
          id="welcomeIntro"
        >
          {heroIntro(canWrite, returning)}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            id="welcomeAction"
            onClick={() => navigate(actionTarget)}
            variant="primary"
          >
            {canWrite
              ? welcomeActionLabel(githubReady, modelReady)
              : home.actionViewer}
          </Button>
          <span className="text-muted-foreground text-xs" id="welcomeNote">
            {heroNote(canWrite, githubReady, modelReady)}
          </span>
        </div>
      </Card>

      <AutomaticRuns />

      <Card className="mb-5" hidden={!canWrite} id="onboarding">
        <CardHeader>
          <div>
            <CardTitle>{home.onboarding.title}</CardTitle>
            <p className="text-muted-foreground text-sm">
              {copy.onboardingIntro}
            </p>
          </div>
          <Pill id="setupCount" tone={readinessTone(readyCount)}>
            {copy.setupCount(readyCount)}
          </Pill>
        </CardHeader>
        <div className="grid gap-3 md:grid-cols-3">
          <StepButton
            active={activeStep === "github"}
            body={home.onboarding.githubBody}
            done={githubReady}
            id="stepGitHub"
            number="1"
            onClick={() => navigate(stepTarget)}
            state={githubStepState(status, githubReady)}
            stateId="stepGitHubState"
            title={home.onboarding.githubTitle}
          />
          <StepButton
            active={activeStep === "model"}
            body={home.onboarding.modelBody}
            done={modelReady}
            id="stepModel"
            number="2"
            onClick={() => navigate(stepTarget)}
            state={modelStepState({
              catalogFailed: modelsError !== undefined,
              catalogLoaded: models !== undefined,
              modelReady,
              modelsBusy,
            })}
            stateId="stepModelState"
            title={home.onboarding.modelTitle}
          />
          <StepButton
            active={activeStep === null}
            body={home.onboarding.runBody}
            done={false}
            id="stepFirstRun"
            number="3"
            onClick={() => navigate("new")}
            state={home.onboarding.runCta}
            title={home.onboarding.runTitle}
          />
        </div>
      </Card>

      <div className="mb-5 grid gap-3 sm:grid-cols-3" id="overviewStats">
        <Stat
          hint={home.stats.totalHint}
          id="countTotal"
          label={home.stats.total}
          value={counts.total}
        />
        <Stat
          hint={home.stats.activeHint}
          id="countActive"
          label={home.stats.active}
          value={counts.active}
        />
        <Stat
          hint={home.stats.passedHint}
          id="countPassed"
          label={home.stats.passed}
          value={counts.passed}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{home.cardTitle}</CardTitle>
          <Button
            id="showHistory"
            onClick={() => navigate("runs")}
            variant="quiet"
          >
            {home.showHistory}
          </Button>
        </CardHeader>
        {loading ? (
          <p className="text-muted-foreground text-sm" role="status">
            {copy.runsLoading}
          </p>
        ) : null}
        <div
          className="py-6 text-center"
          hidden={loading || all.length > 0}
          id="overviewEmpty"
        >
          <div aria-hidden="true" className="text-2xl">
            ✓
          </div>
          <h3 className="mt-2 font-semibold text-sm">{home.emptyTitle}</h3>
          <p className="mt-1 text-muted-foreground text-sm">
            {home.emptyIntro}
          </p>
        </div>
        <div className="grid gap-2" id="recentRuns">
          {recent.map((run) => (
            <div
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              key={run.id}
            >
              <a
                className="font-medium text-sm underline-offset-4 hover:underline"
                href={`#${run.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  openRun(run.id);
                }}
              >
                {`${run.repo} #${run.pr}`}
              </a>
              <Pill tone={toneFor(run.outcome ?? run.status)}>
                {recentRunLabel(run)}
              </Pill>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
