import { foldTypography, type Observation } from "./canary.js";
import { diagnose, QaError } from "./diagnostics.js";
import type { Scenario } from "./schema.js";

/**
 * Le cœur du chemin observe→act : une action ne se joue que sur une cible
 */
function intendedName(step: Scenario["steps"][number]): string | undefined {
  const action = step.action;
  if (!("locator" in action) || action.locator === undefined) {
    return;
  }
  const { name, role, value } = action.locator as {
    name?: string;
    role?: string;
    value?: string;
  };
  if (name) {
    return name;
  }
  // Un sélecteur de rôle sans nom (« button ») ne désigne rien d'observable :
  // la valeur du sélecteur est alors le seul texte vérifiable.
  if (role && value) {
    return value;
  }
  return value;
}

/** Le texte visible dans lequel une cible doit apparaître. */
function observedText(observation: Observation): string {
  return foldTypography(
    `${observation.snapshot ?? ""}\n${observation.url ?? ""}`
  ).toLowerCase();
}

/**
 * Vrai quand la cible du pas est présente dans l'observation, ou quand le pas
 */
function presentInObservation(
  observation: Observation,
  step: Scenario["steps"][number]
): boolean {
  const name = intendedName(step);
  if (name === undefined) {
    return true;
  }
  const needle = foldTypography(name).toLowerCase();
  return needle.length === 0 || observedText(observation).includes(needle);
}

/** Les codes qui accusent le plan, pas le produit. */
const PLAN_DEFECT_CODES = new Set([
  "CONTRACT_INCOMPLETE",
  "COVERAGE_REQUIREMENT_SOURCE_MISSING",
  "CRITICAL_COVERAGE_MISSING",
  "MARKER_ORDER_UNREACHABLE",
  "PLAN_ATTRIBUTE_VALUE_READ_AS_TEXT",
  "PLAN_CHANGED_FILE_UNCOVERED",
  "PLAN_EVIDENCE_INCOMPLETE",
  "PLAN_SCHEMA_INVALID",
  "PLAN_STATE_TARGET_READ_AS_TEXT",
  "PRECONDITION_UNVERIFIED",
  "REQUIREMENT_UNGROUNDED",
  "TARGET_NOT_FOUND",
  "TRANSITION_NOT_OBSERVED",
  "TRANSITION_ON_INVARIANT",
]);

/**
 * Le classement explicite du chemin observe→act : ce qui est démontré, ce qui a
 */
export function classifyScenarioResult(result: {
  classification?: "proven" | "failed" | "test-defect" | "indeterminate";
  diagnostic?: { code: string };
  outcome: string;
}): void {
  if (result.classification !== undefined) {
    return;
  }
  if (result.outcome === "passed") {
    result.classification = "proven";
    return;
  }
  if (result.outcome === "failed") {
    result.classification = "failed";
    return;
  }
  result.classification = PLAN_DEFECT_CODES.has(result.diagnostic?.code ?? "")
    ? "test-defect"
    : "indeterminate";
}

/**
 * Ce qu'il faut publier quand une cible du plan n'existe pas dans l'observation
 */

/**
 * La porte du chemin observe→act, en une appel : si la cible du pas n'est pas
 * dans l'observation courante, l'étape est consignée, le scénario est classé
 * `indeterminate` avec un code nommé, et rien n'est joué. Rend `true` quand elle
 * a tranché — l'appelant s'arrête alors sans autre branche.
 */
export function gateUnobservedStep(input: {
  config: { QA_OBSERVE_ACT: boolean };
  index: number;
  observation: Observation;
  result: {
    classification?: "proven" | "failed" | "test-defect" | "indeterminate";
    diagnostic?: { code: string; hint?: string; message?: string };
    error?: string;
    outcome: string;
    scenario: { id: string };
    steps: {
      action: Scenario["steps"][number]["action"];
      index: number;
      ok: boolean;
      observation: string;
      reason: string;
      stepId?: string;
    }[];
  };
  step: Scenario["steps"][number];
}): boolean {
  const { config, index, observation, result, step } = input;
  if (!config.QA_OBSERVE_ACT || presentInObservation(observation, step)) {
    return false;
  }
  const name = intendedName(step) ?? step.action.type;
  result.steps.push({
    action: step.action,
    index,
    ok: false,
    observation: (observation.snapshot ?? "").slice(0, 300),
    reason: `cible absente de l'observation courante : ${name}`,
    stepId: step.id,
  });
  result.outcome = "blocked";
  result.classification = "indeterminate";
  result.diagnostic = diagnose(
    new QaError(
      "TARGET_NOT_FOUND",
      `Step ${index} of scenario ${result.scenario.id} targets ${JSON.stringify(name)}, which the current observation does not expose, so nothing was played`,
      "Target an element the current snapshot lists, or establish the state that makes this control appear before this step."
    ),
    config as never
  );
  result.error = result.diagnostic.message;
  return true;
}
