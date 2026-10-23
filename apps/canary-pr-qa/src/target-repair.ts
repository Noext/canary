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
 * La cible à jouer pour une reprise, construite sans toucher à l'action du plan.
 * Le plan est partagé — `result.plan.scenarios`, `result.scenario`, l'entrée
 * d'artefact de la tentative échouée — et `ScenarioResult.contract.hash` a été
 * calculée sur lui AVANT l'exécution : réécrire son locator en place laissait un
 * plan enregistré qui ne correspondait plus à son propre hash, et une tentative
 * échouée qui affichait la cible de la reprise (revue du 23 oct. 2026).
 */
function repairedLocator(chosen: ObservedTarget): Locator {
  return { by: "role", name: chosen.name, value: chosen.role };
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
}): Promise<
  { step: Scenario["steps"][number]; target: ObservedTarget } | undefined
> {
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
  /**
   * La reprise est comptée AVANT la requête : une réponse `null`, une réponse
   * refusée par le schéma ou une panne du modèle consomme une capacité d'appel
   * et des jetons réels. Ne la compter qu'en cas de succès laissait un run
   * dépasser le plafond de quatre reprises — et de fait le budget partagé de
   * `MAX_MODEL_CALLS_PER_RUN` (revue du 23 oct. 2026).
   */
  if (scope) {
    scope.targetRepairs = (scope.targetRepairs ?? 0) + 1;
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
  if (!chosen) {
    return;
  }
  // La tentative rejouée porte sa propre copie de l'action : le plan partagé,
  // son hash de contrat et l'entrée de la tentative échouée gardent la cible
  // que le planificateur avait écrite (revue du 23 oct. 2026).
  const action = {
    ...step.action,
    locator: repairedLocator(chosen),
  } as Scenario["steps"][number]["action"];
  return {
    step: { ...step, action } as Scenario["steps"][number],
    target: chosen,
  };
}
