import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertionMatches,
  type Canary,
  compileAction,
  type Observation,
} from "./canary.js";
import type { Config } from "./config.js";
import { diagnose } from "./diagnostics.js";
import { prepareScenario } from "./fixtures.js";
import { explainMissingTarget } from "./missing-target.js";
import type { Model } from "./model.js";
import {
  classifyScenarioResult,
  resolveStepFromObservation,
} from "./observe-act.js";
import type { ProgressEvent } from "./progress.js";
import { captureReadings, reentryEvidence } from "./reentry.js";
import type {
  Assertion,
  Scenario,
  ScenarioResult,
  SourceLineMaterial,
} from "./schema.js";
import {
  finish,
  readPersisted,
  recordStepPlayed,
  recordUnprovenAssertion,
  reportStepFailure,
  stateAlreadySatisfied,
} from "./step-outcome.js";
import { describeTarget, repairStepTarget } from "./target-repair.js";
import { compareVisual } from "./visual.js";

async function performStep(
  sessionId: string,
  step: Scenario["steps"][number],
  index: number,
  result: ScenarioResult,
  preview: string,
  canary: Canary,
  baselines: Map<string, unknown>,
  config: Config,
  repo: string
) {
  const { action } = step;
  const assertion =
    action.type === "assert" ||
    action.type === "download" ||
    action.type === "popup"
      ? result.scenario.assertions.find(
          (item) => item.id === action.assertionId
        )
      : undefined;
  if (
    action.type === "assert" &&
    result.assertions.some((item) => item.id === action.assertionId)
  ) {
    throw new Error("Assertion has already been evaluated");
  }
  const observation = await canary.act(
    sessionId,
    `${index}-${action.type}`,
    compileAction(
      action.type === "assert"
        ? {
            type: "assert",
            assertionId: action.assertionId,
            ...(assertion?.target ? { locator: assertion.target } : {}),
          }
        : action,
      preview,
      assertion
    )
  );

  if (assertion) {
    await evaluateAssertion(
      sessionId,
      assertion,
      observation,
      result,
      preview,
      canary,
      baselines,
      config,
      repo
    );
  }
  // Un clic d'établissement dont la cible est absente n'a rien fait : l'état
  // qu'il visait était déjà en place. L'étape reste dans le contrat joué, elle
  // est marquée sautée pour que le rapport dise ce qui s'est réellement passé.
  const skipped =
    action.type === "click" &&
    action.ifPresent === true &&
    observation.actual === false;
  result.steps.push({
    index,
    stepId: step.id,
    reason: skipped
      ? `${step.description} — skipped: the target is absent, so the state it establishes is already in place`
      : step.description,
    action,
    ok: true,
    ...(skipped ? { skipped: true } : {}),
    observation: JSON.stringify(observation),
  });
}
/**
 * Relit la cible après le rechargement pour prouver une `persisted`. Une cible
 * qui disparaît entre la première lecture et cette relecture n'efface pas la
 * valeur déjà lue : c'est une régression réelle, enregistrée avec cette valeur
 * plutôt qu'annoncée comme une cible « jamais apparue ».
 *
 * Cette valeur ne remonte jamais dans `result.error` : le message est repris par
 * `reportMarkdown` et publié en commentaire de PR dès que la publication est
 * active, alors qu'une valeur lue dans la page peut venir d'une session
 * authentifiée. Elle reste dans l'assertion, c'est-à-dire dans l'artefact
 * d'assertion servi derrière l'autorisation du tableau de bord.
 */
async function evaluateAssertion(
  sessionId: string,
  assertion: Assertion,
  observation: Observation,
  result: ScenarioResult,
  preview: string,
  canary: Canary,
  baselines: Map<string, unknown>,
  config: Config,
  repo: string
) {
  const baseline = baselines.get(assertion.id);
  // Aller-retour prouvé sans écriture durable dans le diff : la persistance se
  // juge à la réentrée, sans rechargement (voir `reentry.ts`).
  const reentry = reentryEvidence(result, assertion, baseline);
  let persisted: unknown;
  if (assertion.verification === "persisted" && !reentry) {
    const probe = await readPersisted(
      sessionId,
      assertion,
      observation,
      result,
      preview,
      canary,
      config,
      baseline
    );
    if (probe.handled) {
      return;
    }
    persisted = probe.persisted;
  }
  const actual =
    assertion.kind === "visual"
      ? await compareVisual(
          observation.actual,
          assertion.expected,
          repo,
          config
        )
      : observation.actual;
  const verification = assertion.verification ?? "state";
  const matched =
    assertion.kind === "visual"
      ? (actual as { passed: boolean }).passed
      : assertionMatches(assertion, actual);
  const measured = baselines.has(assertion.id);
  const preMatched =
    measured &&
    assertion.kind !== "visual" &&
    assertionMatches(assertion, baseline);
  const unchangedSinceBaseline =
    measured && isDeepStrictEqual(baseline, observation.actual);
  const alreadySatisfied = stateAlreadySatisfied({
    afterStep: assertion.afterStep,
    assertionIntent: assertion.assertionIntent,
    baselineMatches: preMatched,
    baselineMeasured: measured,
    steps: result.steps,
    unchanged: unchangedSinceBaseline,
    verification,
  });
  const passed =
    matched &&
    !alreadySatisfied &&
    (!["transition", "persisted"].includes(verification) ||
      (measured && !unchangedSinceBaseline)) &&
    (verification !== "persisted" ||
      reentry !== undefined ||
      assertionMatches(assertion, persisted));
  // A transition whose value did not change proves nothing: the element may be
  // broken or invariant, and the identical baseline cannot tell the two apart.
  const unchanged =
    ["transition", "persisted"].includes(verification) &&
    unchangedSinceBaseline;
  if (assertion.kind === "visual") {
    observation.actual = actual;
  }
  result.assertions.push({
    id: assertion.id,
    passed,
    actual,
    baseline,
    persisted,
    ...(preMatched ? { preMatched } : {}),
    verification: verification as "state" | "transition" | "persisted",
    assertionIntent: assertion.assertionIntent,
    ...(measured ? { changed: !unchangedSinceBaseline } : {}),
    ...reentry,
    ...(assertion.requirement === undefined
      ? {}
      : { requirement: assertion.requirement }),
  });
  if (!passed) {
    recordUnprovenAssertion(
      result,
      assertion,
      verification,
      matched,
      unchanged,
      config,
      alreadySatisfied
    );
  }
}
async function playStepWithRepair(args: {
  baselines: Map<string, unknown>;
  canary: Canary;
  config: Config;
  index: number;
  material: SourceLineMaterial[];
  model?: Model;
  preview: string;
  repo: string;
  result: ScenarioResult;
  sessionId: string;
  step: Scenario["steps"][number];
}): Promise<{
  failure?: Awaited<ReturnType<typeof explainMissingTarget>>;
  observation?: Observation;
  repairedTo?: string;
}> {
  const { sessionId, step, index, result, preview, canary, baselines, config } =
    args;
  const { repo, material, model } = args;
  let repairedTo: string | undefined;
  // La tentative rejouée porte sa propre copie de l'action : le plan partagé,
  // son hash de contrat et l'entrée de la tentative échouée gardent la cible
  // que le planificateur avait écrite.
  let attemptStep = step;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await performStep(
        sessionId,
        attemptStep,
        index,
        result,
        preview,
        canary,
        baselines,
        config,
        repo
      );
      const observation = config.QA_OBSERVE_ACT
        ? await canary.act(
            sessionId,
            `observe-after-${index}`,
            compileAction({ type: "observe" }, preview)
          )
        : undefined;
      return { repairedTo, observation };
    } catch (error) {
      const failure = await explainMissingTarget(
        error,
        sessionId,
        step,
        result.scenario,
        preview,
        canary,
        config,
        material
      );
      // La reprise par inclusion est déterministe et sans modèle : elle passe
      // avant la reprise par modèle, base comprise (`missing-target.ts`).
      const chosen =
        attempt === 1
          ? (failure.contained ??
            (await repairStepTarget({
              model,
              preview,
              scenario: result.scenario.title,
              step,
              targets: failure.targets,
            })))
          : undefined;
      if (!chosen) {
        return { failure };
      }
      repairedTo = describeTarget(chosen.target);
      attemptStep = chosen.step;
      // La cible d'origine reste lisible : le résultat dit ce qui a été visé,
      // puis ce qui a été joué, et la reprise ne se confond pas avec un plan
      // qui aurait eu raison.
      result.steps.push({
        action: step.action,
        index,
        ok: false,
        reason: `cible absente, reprise tentée sur ${repairedTo}`,
        observation: `cible absente, reprise tentée sur ${repairedTo}`,
        observedTargets: failure.observedTargets,
        stepId: step.id,
      });
    }
  }
}

async function driveScenario(
  sessionId: string,
  result: ScenarioResult,
  preview: string,
  config: Config,
  canary: Canary,
  record: (event: ProgressEvent) => Promise<void>,
  repo: string,
  material: SourceLineMaterial[],
  model?: Model
) {
  let current = await canary.act(
    sessionId,
    "open-preview",
    compileAction({ type: "goto", path: preview }, preview)
  );
  const baselines = new Map<string, unknown>();
  // Le plan est un contrat figé : l'hôte joue chaque étape dans l'ordre, sans
  // consulter le modèle. Une cible que l'IA choisirait autrement n'existe plus,
  // et aucun jeton d'exécution n'est dépensé pour recopier le plan.
  for (const [offset, step] of result.scenario.steps.entries()) {
    const index = offset + 1;
    // Chemin observe→act : la cible est choisie dans l'observation courante,
    // jamais dans le plan seul. Une cible absente qui ne peut pas être ré-ancrée
    // sur un contrôle observé n'est jamais jouée : le pas est consigné et le
    // scénario se classe `indeterminate`.
    const resolution = resolveStepFromObservation({
      config,
      index,
      observation: current,
      result,
      step,
    });
    if ("blocked" in resolution) {
      return;
    }
    const effective = resolution.step;
    const started = Date.now();
    await captureReadings({
      baselines,
      canary,
      material,
      preview,
      result,
      sessionId,
      stepId: effective.action.type === "observe" ? undefined : effective.id,
    });
    await record({
      phase: "execution",
      scenarioId: result.scenario.id,
      step: index,
      action: effective.action.type,
    });
    const played = await playStepWithRepair({
      baselines,
      canary,
      config,
      index,
      material,
      model,
      preview,
      repo,
      result,
      sessionId,
      step: effective,
    });
    current = played.observation ?? current;
    const { failure, repairedTo } = played;
    if (failure === undefined) {
      await recordStepPlayed(
        result,
        effective,
        index,
        repairedTo ?? resolution.reanchoredTo,
        record,
        started
      );
    } else {
      await reportStepFailure(
        failure,
        effective,
        index,
        result,
        baselines,
        record
      );
    }
    // Un verdict déjà posé arrête le scénario : `finish()` exigerait toutes les
    // assertions vertes et remplacerait le diagnostic par son message. Le
    // contrôle vaut aussi pour une étape JOUÉE dont l'assertion a échoué — sans
    // lui, le `finish` suivant écrase le verdict par « finish before all planned
    // assertions passed ».
    if (result.outcome === "failed" || result.diagnostic) {
      return;
    }
  }
  finish(result);
}
export async function executeScenario(
  scenario: Scenario,
  preview: string,
  root: string,
  config: Config,
  canary: Canary,
  record: (event: ProgressEvent) => Promise<void> = async () =>
    Promise.resolve(),
  repo = "",
  material: SourceLineMaterial[] = [],
  /**
   * Fourni par le runner. Absent en test unitaire et sur la base : la reprise
   * par modèle est alors désactivée ; seule reste la reprise par inclusion,
   * déterministe (un champ unique, mêmes nombres, `missing-target.ts`).
   */
  model?: Model
): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    scenario,
    outcome: "blocked",
    steps: [],
    assertions: [],
    artifacts: [],
    contract: {
      completedSteps: [],
      totalSteps: scenario.steps.length,
      hash: createHash("sha256").update(JSON.stringify(scenario)).digest("hex"),
    },
  };
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const prepared = await prepareScenario(scenario, repo, config);
    cleanup = prepared.cleanup;
    result.sessionId = await canary.start(scenario.title, prepared.auth);
    await driveScenario(
      result.sessionId,
      result,
      preview,
      config,
      canary,
      record,
      repo,
      material,
      model
    );
  } catch (error) {
    result.diagnostic = diagnose(error, config);
    result.error = result.diagnostic.message;
  } finally {
    if (result.sessionId) {
      try {
        await record({ phase: "evidence", scenarioId: scenario.id });
        result.artifacts = await canary.end(
          result.sessionId,
          join(root, scenario.id)
        );
      } catch (error) {
        result.outcome = "blocked";
        result.diagnostic = diagnose(error, config);
        result.error = `${result.error ?? ""} Evidence finalization: ${result.diagnostic.message}`;
        await canary.abort(result.sessionId);
      }
    }
  }
  try {
    await cleanup?.();
  } catch (error) {
    result.outcome = "blocked";
    result.diagnostic = diagnose(error, config);
    result.error = `Fixture cleanup failed: ${result.diagnostic.message}`;
  }
  classifyScenarioResult(result);
  await record({
    phase: "execution",
    scenarioId: scenario.id,
    outcome: result.outcome,
    diagnostic: result.diagnostic,
  });
  return result;
}
