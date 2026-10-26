import { createLogger } from "@usecanary/logger";
import { type Canary, compileProbe } from "./canary.js";
import { type Diagnostic, QaError } from "./diagnostics.js";
import type { explainMissingTarget } from "./missing-target.js";
import type { ProgressEvent } from "./progress.js";

const logger = createLogger({ name: "pr-qa-baselines" });

import type { Scenario, ScenarioResult } from "./schema.js";

/**
 * Ce que devient une étape finie : son entrée d'artefact, son verdict, la ligne
 * de contrat qu'elle ajoute, et la reprise qui l'a éventuellement rejouée.
 * Isolé de l'exécuteur pour qu'`executor.ts` ne porte que la conduite du
 * scénario — c'est cette séparation qui garde le module sous le seuil de
 * responsabilités de la porte d'architecture.
 */
/**
 * Une cible qui n'apparaît jamais est une promesse non tenue, pas une panne :
 * un `assert` affirme qu'un élément existe, donc son échec est une assertion
 * fausse et le scénario échoue. Un clic dont la même cible ne résout jamais
 * reste une panne d'exécution (`false`) : l'action n'a pas atteint son but.
 */
function failAssertionOnMissingTarget(
  result: ScenarioResult,
  step: Scenario["steps"][number],
  diagnostic: Diagnostic,
  baselines: Map<string, unknown>
): boolean {
  if (step.action.type !== "assert" || diagnostic.code !== "TARGET_NOT_FOUND") {
    return false;
  }
  const { assertionId } = step.action;
  if (!result.assertions.some((item) => item.id === assertionId)) {
    result.assertions.push({
      id: assertionId,
      passed: false,
      actual: undefined,
      baseline: baselines.get(assertionId),
    });
  }
  result.outcome = "failed";
  result.diagnostic = diagnostic;
  result.error = `Assertion ${assertionId} failed: the target never appeared — ${diagnostic.message}`;
  return true;
}
/**
 * Joue une étape, et la rejoue UNE fois sur une cible observée quand elle a
 * échoué faute de cible. Rend l'échec qui reste, ou rien quand l'étape a été
 * jouée — `repairedTo` disant alors sur quelle cible la reprise l'a fait.
 */
/**
 * L'étape a échoué et la reprise n'a rien pu corriger : le résultat consigne
 * l'échec, le verdict est posé, et l'erreur remonte avec le diagnostic déjà
 * établi. Une assertion sur une cible absente est une PROMESSE NON TENUE, donc
 * un échec ; un clic qui n'atteint jamais sa cible reste une panne.
 */
export async function reportStepFailure(
  failure: Awaited<ReturnType<typeof explainMissingTarget>>,
  step: Scenario["steps"][number],
  index: number,
  result: ScenarioResult,
  baselines: Map<string, unknown>,
  record: (event: ProgressEvent) => Promise<void>
) {
  result.steps.push({
    index,
    stepId: step.id,
    action: step.action,
    ok: false,
    reason: failure.diagnostic.message,
    observation: failure.diagnostic.message,
    // Les noms observés vivent ici, dans l'artefact du run, et nulle part dans
    // ce qui se publie : `reportMarkdown` ne lit pas ce champ.
    observedTargets: failure.observedTargets,
  });
  await record({
    phase: "execution",
    scenarioId: result.scenario.id,
    step: index,
    action: step.action.type,
    outcome: "error",
    diagnostic: failure.diagnostic,
  });
  if (
    failAssertionOnMissingTarget(result, step, failure.diagnostic, baselines)
  ) {
    return;
  }
  throw new QaError(
    failure.diagnostic.code,
    failure.diagnostic.message,
    failure.diagnostic.hint
  );
}

/**
 * L'étape a été jouée : elle entre au contrat, et le résultat consigne la
 * reprise éventuelle. `observe` comprise — l'ancien exécuteur l'excluait quand
 * elle était un coup d'œil libre du modèle, et l'exclure faisait refuser par
 * `finish()` un contrat pourtant joué en entier (run 91fb1e35 : 6 scénarios sur
 * 6, zéro étape en échec, zéro assertion fausse).
 */
export async function recordStepPlayed(
  result: ScenarioResult,
  step: Scenario["steps"][number],
  index: number,
  repairedTo: string | undefined,
  record: (event: ProgressEvent) => Promise<void>,
  started: number
) {
  result.contract?.completedSteps.push(step.id);
  const played = [...result.steps]
    .reverse()
    .find((entry) => entry.stepId === step.id && entry.ok);
  if (played && repairedTo) {
    played.repairedTarget = repairedTo;
  }
  let stepOutcome = "ok";
  if (result.outcome === "failed") {
    stepOutcome = "failed";
  }
  if (played?.skipped === true) {
    stepOutcome = "skipped";
  }
  await record({
    phase: "execution",
    scenarioId: result.scenario.id,
    step: index,
    action: step.action.type,
    outcome: stepOutcome,
    durationMs: Date.now() - started,
  });
}

export /**
 * Le contrat joué doit être EXACTEMENT le contrat planifié : mêmes identifiants,
 * même ordre. Comparer les longueurs laissait passer une étape jouée deux fois
 * compensant une étape sautée, et surtout ne disait pas laquelle manquait : le
 * hint nomme les étapes absentes du relevé.
 */
function finish(result: ScenarioResult) {
  const planned = result.scenario.steps.map((step) => step.id);
  const played = result.contract?.completedSteps ?? [];
  if (
    played.length !== planned.length ||
    played.some((id, index) => id !== planned[index])
  ) {
    const missing = planned.filter((id) => !played.includes(id));
    throw new QaError(
      "CONTRACT_INCOMPLETE",
      "AI attempted to finish before all planned assertions and required steps completed",
      `Execute the original ordered contract; do not omit actions or weaken assertions.${missing.length > 0 ? ` Missing steps: ${missing.join(", ")}.` : ""}`
    );
  }
  if (
    !result.scenario.assertions.every((a) =>
      result.assertions.some((item) => item.id === a.id && item.passed)
    )
  ) {
    throw new Error(
      "AI attempted to finish before all planned assertions passed"
    );
  }
  result.outcome = "passed";
}

/**
 * Le relevé d'avant-étape : une assertion `transition` ou `persisted` compare à
 * la valeur mesurée AVANT l'interaction, une seule fois par assertion.
 */
export async function captureBaselines(
  sessionId: string,
  scenario: Scenario,
  stepId: string | undefined,
  baselines: Map<string, unknown>,
  preview: string,
  canary: Canary
) {
  for (const assertion of scenario.assertions) {
    if (
      assertion.afterStep === stepId &&
      // Toute assertion peut être déjà satisfaite par ce qu'un scénario
      // précédent a laissé : la mesure d'avant l'étape n'est pas réservée aux
      // vérifications de changement. Elle n'est relevée que pour un pas
      // d'interaction — une assertion ancrée sur `goto` ne peut rien hériter
      // d'un scénario précédent, elle lit la page telle qu'elle arrive.
      (!["state"].includes(assertion.verification) ||
        interactionStep(scenario, stepId)) &&
      !baselines.has(assertion.id)
    ) {
      // Une sonde qui échoue ne doit JAMAIS faire tomber le scénario : la cible
      // peut légitimement ne pas exister encore (un marqueur rendu après
      // l'interaction). Sans mesure, `preMatched` reste absent — donc inconnu,
      // jamais silencieusement « pas hérité ».
      try {
        const observation = await canary.act(
          sessionId,
          `baseline-${assertion.id}`,
          compileProbe(assertion, preview)
        );
        baselines.set(assertion.id, observation.actual);
      } catch (error) {
        logger.info(
          {
            assertion: assertion.id,
            error:
              error instanceof Error ? error.message.slice(0, 120) : "unknown",
          },
          "Baseline probe failed, keeping the assertion unflagged"
        );
      }
    }
  }
}

/** Vrai quand l'étape nommée écrit quelque chose, plutôt que d'ouvrir la page. */
function interactionStep(
  scenario: Scenario,
  stepId: string | undefined
): boolean {
  const step = scenario.steps.find((item) => item.id === stepId);
  if (!step) {
    return false;
  }
  return ["check", "click", "fill", "press", "select"].includes(
    step.action.type
  );
}
