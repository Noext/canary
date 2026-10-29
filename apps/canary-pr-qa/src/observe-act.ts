import { foldTypography, type Observation } from "./canary.js";
import { diagnose, QaError } from "./diagnostics.js";
import type { Scenario } from "./schema.js";

/**
 * Le cœur du chemin observe→act : une action ne se joue que sur une cible
 */
/**
 * Un sélecteur `css` de forme `[aria-label="X"]` (ou `input[aria-label="X"]`)
 * vise un NOM ACCESSIBLE : c'est ce nom que l'observation expose, pas la
 * syntaxe du sélecteur. Sans cette lecture, `intendedName` rendait le sélecteur
 * entier, `presentInObservation` ne le trouvait jamais dans l'instantané, et le
 * score de `resolveObservedName` était dilué par les mots de syntaxe (`input`,
 * `aria`, `label`) : mesuré sur la forme dominante du corpus — 1066 des 3396
 * locators — la résolution échouait TOUJOURS, même quand la cible existait.
 */
const ARIA_LABEL_CSS = /^\s*(?:[a-zA-Z][\w-]*)?\[aria-label="([^"]+)"\]\s*$/;

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
  const label = ARIA_LABEL_CSS.exec(value ?? "")?.[1];
  return label ?? value;
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
  "PERSISTENCE_INTENT_MISMATCH",
  "PRECONDITION_UNVERIFIED",
  "REQUIREMENT_UNGROUNDED",
  "STATE_ALREADY_SATISFIED",
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
 * Les noms accessibles réellement présents dans l'instantané.
 *
 * L'instantané de la session liste les contrôles sous la forme `rôle "nom"` :
 * ces noms sont la seule liste dans laquelle une action peut choisir sa cible.
 */
export function observedNames(observation: Observation): string[] {
  const names = new Set<string>();
  for (const match of (observation.snapshot ?? "").matchAll(
    /"([^"]{1,200})"/g
  )) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * Les nombres écrits dans un nom. `words()` jette tout ce qui fait moins de trois
 * caractères, donc `5` et `2` n'y figurent pas : sans cette garde, extraire le
 * libellé d'un sélecteur faisait résoudre « Quantité · Pièce de 5 € » vers
 * « Quantité · Pièce de 2 € » — une autre coupure, donc un autre contrôle, et un
 * clic sur le mauvais élément. Un candidat doit porter EXACTEMENT les nombres de
 * la cible : c'est la preuve disponible la moins ambiguë.
 */
const numbers = (text: string) =>
  [
    ...new Set(
      (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((value) =>
        value.replace(",", ".")
      )
    ),
  ].sort();

function sameNumbers(wanted: string[], candidate: string[]): boolean {
  return (
    wanted.length === candidate.length &&
    wanted.every((value, index) => value === candidate[index])
  );
}

/** Un nom observé doit désigner UN élément : deux occurrences rendent le pas ambigu. */
function occurrences(observation: Observation, name: string): number {
  return (observation.snapshot ?? "").split(`"${name}"`).length - 1;
}

/** Remplace le libellé d'un `[aria-label="…"]` en gardant son préfixe d'élément. */
function relabel(selector: string, observed: string): string {
  return selector.replace(
    /(\[aria-label=")[^"]*("\])/,
    (_match, open: string, close: string) => `${open}${observed}${close}`
  );
}

const words = (text: string) =>
  new Set(
    foldTypography(text)
      .toLowerCase()
      .split(/[^a-z0-9\u00e0-\u00ff]+/)
      .filter((word) => word.length >= 3)
  );

/**
 * Choisit, dans l'observation, le contrôle qui réalise l'intention du pas.
 *
 * Ce n'est plus une simple présence : si le nom écrit par le plan n'existe pas,
 * l'exécution cherche le nom observé qui partage le plus de mots avec lui, et ne
 * le retient que s'il est unique et suffisamment proche. L'action est alors
 * rejouée avec la cible observée ; sinon le pas est indéterminé. Aucun modèle
 * n'est appelé : la résolution est déterministe et bornée.
 */
export function resolveObservedName(
  observation: Observation,
  step: Scenario["steps"][number]
): string | undefined {
  const intended = intendedName(step);
  if (intended === undefined) {
    return;
  }
  const target = words(intended);
  if (target.size === 0) {
    return;
  }
  const wanted = numbers(intended);
  const scored = observedNames(observation)
    .filter((name) => sameNumbers(wanted, numbers(name)))
    .filter((name) => occurrences(observation, name) === 1)
    .map((name) => {
      const source = words(name);
      const shared = [...target].filter((word) => source.has(word)).length;
      return { name, score: shared / target.size };
    })
    .filter((candidate) => candidate.score >= 0.5)
    .sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best) {
    return;
  }
  const tied = scored.filter((candidate) => candidate.score === best.score);
  return tied.length === 1 ? best.name : undefined;
}

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

/**
 * La résolution complète du pas, dans l'ordre de la décision d'architecture :
 * on regarde l'observation, on choisit une cible observée, et sinon le pas est
 * indéterminé — sans jamais jouer une cible que la page n'expose pas.
 */
export function resolveStepFromObservation(input: {
  config: { QA_OBSERVE_ACT: boolean };
  index: number;
  observation: Observation;
  result: Parameters<typeof gateUnobservedStep>[0]["result"];
  step: Scenario["steps"][number];
}):
  | { step: Scenario["steps"][number]; reanchoredTo?: string }
  | { blocked: true } {
  const { config, index, observation, result, step } = input;
  if (!config.QA_OBSERVE_ACT || presentInObservation(observation, step)) {
    return { step };
  }
  const observed = resolveObservedName(observation, step);
  if (
    observed !== undefined &&
    "locator" in step.action &&
    step.action.locator
  ) {
    /**
     * Un locator `css` ne porte pas de `name` : `compileAction` compile
     * `page.locator(value)` et ignore tout champ ajouté. Ré-ancrer en posant un
     * `name` sur un `css` produisait donc un pas qui rejouait l'ANCIEN sélecteur —
     * mesuré : les deux scénarios `TARGET_NOT_FOUND` restaient en timeout de
     * 10 s alors que la résolution avait trouvé « Quantité · Pièce de 5 c ».
     * Le sélecteur est donc réécrit sur le libellé observé, en gardant son
     * préfixe d'élément.
     */
    const locator =
      step.action.locator.by === "css"
        ? {
            ...step.action.locator,
            value: relabel(step.action.locator.value, observed),
          }
        : { ...step.action.locator, name: observed };
    return {
      reanchoredTo: observed,
      step: {
        ...step,
        action: { ...step.action, locator },
      } as Scenario["steps"][number],
    };
  }
  return gateUnobservedStep({ config, index, observation, result, step })
    ? { blocked: true }
    : { step };
}
