import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertionMatches,
  type Canary,
  compileAction,
  compileProbe,
  type Observation,
} from "./canary.js";
import type { Config } from "./config.js";
import { diagnose, QaError } from "./diagnostics.js";
import { prepareScenario } from "./fixtures.js";
import { explainMissingTarget } from "./missing-target.js";
import type { Model } from "./model.js";
import type { ProgressEvent } from "./progress.js";
import type {
  Assertion,
  Scenario,
  ScenarioResult,
  SourceLineMaterial,
} from "./schema.js";
import {
  captureBaselines,
  finish,
  recordStepPlayed,
  reportStepFailure,
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
async function readPersisted(
  sessionId: string,
  assertion: Assertion,
  observation: Observation,
  result: ScenarioResult,
  preview: string,
  canary: Canary,
  config: Config,
  baseline: unknown
): Promise<{ handled: true } | { handled: false; persisted: unknown }> {
  try {
    const persisted = (
      await canary.act(
        sessionId,
        `persistence-${assertion.id}`,
        compileProbe(assertion, preview, true)
      )
    ).actual;
    return { handled: false, persisted };
  } catch (error) {
    const diagnostic = diagnose(error, config);
    if (
      diagnostic.code !== "TARGET_NOT_FOUND" ||
      observation.actual === undefined
    ) {
      throw error;
    }
    result.assertions.push({
      id: assertion.id,
      passed: false,
      actual: observation.actual,
      baseline,
    });
    result.outcome = "failed";
    result.diagnostic = diagnostic;
    result.error = `Assertion ${assertion.id} failed: the value observed before the reload is no longer present in the target after it — persistence is not demonstrated — ${diagnostic.message}`;
    return { handled: true };
  }
}
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
  let persisted: unknown;
  if (assertion.verification === "persisted") {
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
  const preMatched =
    baselines.has(assertion.id) &&
    assertion.kind !== "visual" &&
    assertionMatches(assertion, baseline);
  const passed =
    matched &&
    (!["transition", "persisted"].includes(verification) ||
      (baselines.has(assertion.id) &&
        !isDeepStrictEqual(baseline, observation.actual))) &&
    (verification !== "persisted" || assertionMatches(assertion, persisted));
  // A transition whose value did not change proves nothing: the element may be
  // broken or invariant, and the identical baseline cannot tell the two apart.
  const unchanged =
    ["transition", "persisted"].includes(verification) &&
    baselines.has(assertion.id) &&
    isDeepStrictEqual(baseline, observation.actual);
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
  });
  if (!passed) {
    recordUnprovenAssertion(
      result,
      assertion,
      verification,
      matched,
      unchanged,
      config
    );
  }
}
/**
 * Ce qu'un relevé non conforme veut dire. Une valeur inchangée qui satisfait
 * déjà l'attendu rejette la faute sur le plan : elle montre exactement ce que
 * l'assertion demande, donc c'est la vérification choisie qui est fausse, pas la
 * fonctionnalité. Mesuré sur le lot AM (runs 59edcd21 et 9599ccc1), où le plan
 * exigeait une `transition` sur un libellé et sur un attribut d'état qui
 * RESTENT à leur valeur tant que la justification manque. Le verdict reste non
 * vert — `blocked`, statut de commit en erreur — donc rien ne passe en silence ;
 * seul le blâme change de camp. Un changement vers une autre valeur reste
 * `failed`, comme une valeur inchangée qui n'atteint pas l'attendu, et
 * `persisted` garde la règle précédente.
 */
function recordUnprovenAssertion(
  result: ScenarioResult,
  assertion: Assertion,
  verification: string,
  matched: boolean,
  unchanged: boolean,
  config: Config
) {
  const step = assertion.afterStep ?? "the interaction";
  if (unchanged && verification === "transition" && matched) {
    result.outcome = "blocked";
    result.diagnostic = diagnose(
      new QaError(
        "TRANSITION_ON_INVARIANT",
        `Assertion ${assertion.id}: the plan requires a change on a value that does not change — the value after step ${step} is identical to the baseline probed before it, and that unchanged value already satisfies the expected one, so the application shows what the assertion asks for and the verification is what is wrong`,
        `Verify this value with "state" and afterStep set to the interaction: an invariant cannot demonstrate a transition. Move the "transition" to the output the step really moves, or drop the interaction if nothing is meant to change.`
      ),
      config
    );
    result.error = result.diagnostic.message;
    return;
  }
  result.outcome = "failed";
  if (unchanged) {
    // Naming the missing transition, not recopying the assertion description:
    // "the element still shows X" reads as a regression while actual and
    // baseline agree, and sends the operator after an innocent element.
    result.diagnostic = diagnose(
      new QaError(
        "TRANSITION_NOT_OBSERVED",
        `Assertion ${assertion.id}: no change observed — the value after step ${step} is identical to the baseline probed before it, so the required ${verification} is not demonstrated`,
        `Require a change only from a value that must change. For an invariance after an interaction, use verification "state" with afterStep set to the interaction step (the element is still there after clicking X).`
      ),
      config
    );
    result.error = result.diagnostic.message;
    return;
  }
  result.error = `Assertion ${assertion.id} failed: ${assertion.description}`;
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
      return { repairedTo };
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
      const chosen =
        attempt === 1
          ? await repairStepTarget({
              model,
              preview,
              scenario: result.scenario.title,
              step,
              targets: failure.targets,
            })
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
  await canary.act(
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
    const started = Date.now();
    await captureBaselines(
      sessionId,
      result.scenario,
      step.action.type === "observe" ? undefined : step.id,
      baselines,
      preview,
      canary
    );
    await record({
      phase: "execution",
      scenarioId: result.scenario.id,
      step: index,
      action: step.action.type,
    });
    const { failure, repairedTo } = await playStepWithRepair({
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
      step,
    });
    if (failure === undefined) {
      await recordStepPlayed(result, step, index, repairedTo, record, started);
    } else {
      await reportStepFailure(failure, step, index, result, baselines, record);
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
   * Fourni par le runner. Absent en test unitaire : la reprise de cible est
   * alors purement désactivée, et l'échec reste l'échec — aucun test ne peut
   * passer grâce à une reprise qu'il n'a pas demandée.
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
  await record({
    phase: "execution",
    scenarioId: scenario.id,
    outcome: result.outcome,
    diagnostic: result.diagnostic,
  });
  return result;
}
