import { z } from "zod";
import type { Model } from "./model.js";
import { runScope } from "./run-scope.js";
import type { Action, Locator, Scenario } from "./schema.js";

/**
 * Reprises de cible autorisées par run. Un plan qui invente plusieurs libellés
 * reste un plan à corriger : la reprise rattrape l'écart mesuré, elle ne
 * remplace pas une planification. Quatre couvre les lots observés (le pire, le
 * 22 oct. 2026, en portait deux) sans transformer un run en boucle de
 * devinettes.
 */
const MAX_TARGET_REPAIRS_PER_RUN = 4;

/** Une cible telle que la page l'expose à l'instant de l'échec. */
export interface ObservedTarget {
  name: string;
  role: string;
}

const TARGET_REPAIR_PROMPT = [
  "A planned QA step failed because its target does not exist on the page.",
  "You receive the intended action and the list of targets the page ACTUALLY",
  "exposes at that moment, each with an index.",
  "",
  "Answer with the index of the single observed target the step meant,",
  'as {"index": <number>}. If none of them is what the step meant, answer',
  '{"index": null}. Never propose a target that is not in the list, never',
  "invent a name, never choose a target that would change what the step",
  "asserts: a step that meant a cash ticket of 20 € is not a coin of 2 €.",
].join("\n");

/**
 * Le choix est validé par INDEX : le modèle ne peut rendre qu'un élément de la
 * liste observée, ou `null`. Un nom libre serait une seconde occasion
 * d'inventer, et la validation d'appartenance porterait sur une chaîne que le
 * modèle vient d'écrire — c'est-à-dire sur rien.
 */
function targetChoiceSchema(observed: ObservedTarget[]) {
  return z
    .object({
      index:
        observed.length === 0
          ? z.null()
          : z
              .number()
              .int()
              .min(0)
              .max(observed.length - 1)
              .nullable(),
    })
    .strict();
}

/**
 * Demande au modèle quelle cible observée l'étape visait. Rend `undefined` si
 * aucune ne convient — l'échec d'origine reste alors l'échec du scénario, sans
 * conversion silencieuse.
 */
async function chooseObservedTarget(
  model: Model,
  action: Action,
  observed: ObservedTarget[],
  context: { preview: string; scenario: string }
): Promise<ObservedTarget | undefined> {
  if (observed.length === 0) {
    return;
  }
  const payload = {
    preview: context.preview,
    scenario: context.scenario,
    step: {
      action: action.type,
      locator: "locator" in action ? action.locator : undefined,
      value: "value" in action ? action.value : undefined,
    },
    observedTargets: observed.map((target, index) => ({ ...target, index })),
  };
  const answer = await model.json(
    TARGET_REPAIR_PROMPT,
    payload,
    targetChoiceSchema(observed)
  );
  return answer.index === null ? undefined : observed[answer.index];
}

/**
 * Réécrit la cible d'une étape sur un élément observé. Rend le locator appliqué
 * pour que le résultat du run le consigne, ou `undefined` quand l'étape n'a pas
 * de cible à réécrire.
 */
function applyTarget(
  action: Action,
  chosen: ObservedTarget
): Locator | undefined {
  // Toutes les actions qui visent un élément portent leur cible dans
  // `locator` (voir `ActionSchema`) : `fill`, `press`, `select`, `check`,
  // `click`, `download`, `popup`, et `assert` en option. Une action sans
  // `locator` — `goto`, `observe`, `finish`, `blocked` — n'a rien à réécrire.
  if (!("locator" in action) || action.locator === undefined) {
    return;
  }
  const locator: Locator = {
    by: "role",
    value: chosen.role,
    name: chosen.name,
  };
  (action as { locator?: Locator }).locator = locator;
  return locator;
}

/** La forme publiée dans l'artefact du run, jamais dans le rapport. */
export function describeTarget(target: ObservedTarget): string {
  return `role=${target.role} name=${JSON.stringify(target.name)}`;
}

/**
 * La garde complète d'une reprise, telle que l'exécuteur l'appelle : une seule
 * tentative par étape, jamais sur une assertion, jamais au-delà du plafond du
 * run, et jamais sur une réponse que le schéma refuse. Rend la cible choisie
 * quand l'étape peut être rejouée, `undefined` quand l'échec d'origine doit
 * rester l'échec du scénario.
 */
export async function repairStepTarget(args: {
  model: Model | undefined;
  preview: string;
  scenario: string;
  step: Scenario["steps"][number];
  targets: ObservedTarget[] | undefined;
}): Promise<ObservedTarget | undefined> {
  const { model, step, preview, targets } = args;
  if (
    model === undefined ||
    step.action.type === "assert" ||
    step.action.type === "observe" ||
    step.action.type === "goto" ||
    (targets?.length ?? 0) === 0
  ) {
    return;
  }
  const scope = runScope.getStore();
  if (scope && (scope.targetRepairs ?? 0) >= MAX_TARGET_REPAIRS_PER_RUN) {
    return;
  }
  let chosen: ObservedTarget | undefined;
  try {
    chosen = await chooseObservedTarget(model, step.action, targets ?? [], {
      preview,
      scenario: args.scenario,
    });
  } catch {
    /**
     * Une reprise qui échoue ne remplace jamais l'échec d'origine : sans
     * fournisseur configuré, ou sans réponse, le scénario garde son
     * `TARGET_NOT_FOUND` au lieu de le voir remplacé par un `QA_ERROR`.
     */
    return;
  }
  if (!(chosen && applyTarget(step.action, chosen))) {
    return;
  }
  if (scope) {
    scope.targetRepairs = (scope.targetRepairs ?? 0) + 1;
  }
  return chosen;
}
