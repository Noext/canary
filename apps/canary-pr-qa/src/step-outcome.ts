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
        /**
         * Une cible ABSENTE avant l'étape n'est pas une preuve manquante :
         * c'est l'état d'avant. Le noter (`null`) permet à une `transition`
         * d'être satisfaite par l'APPARITION de la cible avec la valeur
         * attendue — mesuré sur `afcc9846` : le texte attendu est observé après
         * l'étape, l'élément n'existait pas avant, et le verdict était `failed`
         * parce qu'aucune valeur d'avant n'avait pu être comparée. Toute autre
         * panne de sonde reste une preuve inconnue : rien n'est enregistré.
         */
        if (diagnose(error).code === "TARGET_NOT_FOUND") {
          baselines.set(assertion.id, null);
        }
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

/**
 * Vrai quand une assertion `state` constate l'état initial au lieu de l'effet de
 * l'étape : la valeur mesurée avant l'étape satisfaisait déjà l'attendu, l'étape
 * l'a laissée identique, et l'étape n'a pas déclaré son no-op (`ifPresent`
 * sautée).
 *
 * C'est la cause racine du faux vert mesuré (73/465 assertions de la campagne
 * entrelacée, 15,7 %) : le scénario était vert alors que l'interaction n'avait
 * rien produit, la valeur venant de la page telle qu'elle s'ouvre. La règle vit
 * ici, avec les autres lectures d'un relevé, et ne touche que la coïncidence des
 * deux états. Restent hors d'elle, par construction : une assertion ancrée sur
 * une navigation (aucune valeur d'avant relevée), une sonde d'avant en échec
 * (pré-satisfaction inconnue, jamais « pas héritée »), une valeur que l'étape a
 * déplacée (la preuve vient de l'exécution), et une valeur identique qui
 * n'atteint pas l'attendu (échec produit, pas défaut de plan).
 */
export function stateAlreadySatisfied(input: {
  afterStep?: string;
  /**
   * L'intention DÉCLARÉE par le plan. Une invariance déclarée est une preuve
   * recevable : l'étape a réellement été jouée, et la valeur qui n'a pas bougé
   * est exactement ce que l'invariant affirme. Sans déclaration, l'intention
   * reste inconnue et la règle s'applique — aucun plan ancien n'est converti.
   */
  assertionIntent?: "invariant" | "persistence";
  /** La valeur d'avant a été mesurée (une sonde en échec laisse ceci faux). */
  baselineMeasured: boolean;
  /** La valeur d'avant satisfaisait déjà l'attendu de l'assertion. */
  baselineMatches: boolean;
  /** Les étapes déjà jouées : l'ancre sautée est ce qui légitime le no-op. */
  steps: readonly { skipped?: boolean; stepId?: string }[];
  /** La valeur d'après est identique à celle d'avant. */
  unchanged: boolean;
  verification: string;
}): boolean {
  if (
    input.verification !== "state" ||
    !(input.baselineMeasured && input.unchanged && input.baselineMatches)
  ) {
    return false;
  }
  // Une invariance déclarée n'est pas un faux vert : le plan a dit ce qu'il
  // prouve, et l'étape d'ancrage a bien été jouée.
  if (input.assertionIntent === "invariant") {
    return false;
  }
  // Une étape `ifPresent` sautée a déclaré son no-op : l'assertion d'état qui la
  // suit constate l'état voulu sans prétendre qu'un clic l'a produit.
  return !input.steps.some(
    (played) => played.stepId === input.afterStep && played.skipped === true
  );
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
        'Attach the assertion to the step that produces the value it checks, or verify a value the step really moves. To assert that a value STAYS unchanged after an interaction, declare assertionIntent: "invariant" on the state assertion: the plan then states what it proves, and the unchanged value is its proof. To establish a state the page may already hold, declare the step ifPresent: the plan then says the step may be a no-op. An unchanged value cannot demonstrate a step that claims to have acted on its own, and an undeclared intent is never guessed.'
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
        `To verify that a value stays unchanged after an interaction, keep verification "state" with afterStep on that step AND declare assertionIntent: "invariant" — an invariant cannot demonstrate a transition, and an undeclared state assertion on an already-satisfied value is refused as a false green. Note that "persisted" does NOT fit here: it requires the value to differ from the baseline after the reload, so it cannot express a value that survived unchanged.`
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
        `Require a change only from a value that must change. For a value that must CHANGE and then survive a reload, use verification "persisted" with assertionIntent: "persistence": it reads the value again after a reload and requires it to differ from the baseline. For a value that must stay unchanged after an interaction, use verification "state" with afterStep on that step and declare assertionIntent: "invariant": the value that did not move is then the proof, and nothing is converted in silence.`
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
