import { createLogger } from "@usecanary/logger";
import { type Canary, compileProbe, type Observation } from "./canary.js";
import type { Config } from "./config.js";
import { type Diagnostic, diagnose, QaError } from "./diagnostics.js";
import type { explainMissingTarget } from "./missing-target.js";
import type { ProgressEvent } from "./progress.js";

const logger = createLogger({ name: "pr-qa-baselines" });

import type { Assertion, Scenario, ScenarioResult } from "./schema.js";

/**
 * Ce que devient une étape finie : son entrée d'artefact, son verdict, la ligne
 */
/**
 * Une cible qui n'apparaît jamais est une promesse non tenue, pas une panne :
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
 */
/**
 * L'étape a échoué et la reprise n'a rien pu corriger : le résultat consigne
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

/**
 * L'invariant I3 : un scénario n'est vert que si l'assertion qui prouve son
 */

export function recordUnprovenAssertion(
  result: ScenarioResult,
  assertion: Assertion,
  verification: string,
  matched: boolean,
  unchanged: boolean,
  config: Config,
  alreadySatisfied = false
) {
  const step = assertion.afterStep ?? "the interaction";
  /**
   * Une assertion d'état dont la valeur était déjà celle de l'attendu avant
   * l'étape, et que l'étape laisse identique, ne démontre pas l'interaction qu'elle
   * accompagne : elle constate l'état initial. Le verdict reste non vert — jamais
   * `passed` — et le blâme revient au plan, comme pour `TRANSITION_ON_INVARIANT`,
   * parce que l'application montre exactement ce que l'assertion réclame.
   */
  if (alreadySatisfied) {
    result.outcome = "blocked";
    result.diagnostic = diagnose(
      new QaError(
        "STATE_ALREADY_SATISFIED",
        `Assertion ${assertion.id}: the value after step ${step} is identical to the baseline probed before it, and that baseline already satisfied the expected one, so the step produced nothing this assertion can be credited with — the state is proven, the interaction is not`,
        "Attach the assertion to the step that produces the value it checks, or verify a value the step really moves. To assert an invariance, or to establish a state the page may already hold, declare the step ifPresent: the plan then says the step may be a no-op, and the state assertion stays legitimate. An unchanged value cannot demonstrate a step that claims to have acted on its own."
      ),
      config
    );
    result.error = result.diagnostic.message;
    return;
  }
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

export async function readPersisted(
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
      ...(assertion.requirement === undefined
        ? {}
        : { requirement: assertion.requirement }),
    });
    result.outcome = "failed";
    result.diagnostic = diagnostic;
    result.error = `Assertion ${assertion.id} failed: the value observed before the reload is no longer present in the target after it — persistence is not demonstrated — ${diagnostic.message}`;
    return { handled: true };
  }
}
