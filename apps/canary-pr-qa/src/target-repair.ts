import { createLogger } from "@usecanary/logger";
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

const logger = createLogger({ name: "canary-pr-qa" });

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
/** Le libellé qu'une action nomme, quand elle en nomme un. */
function requestedLabel(
  action: Scenario["steps"][number]["action"]
): string | undefined {
  const locator = (
    action as { locator?: { by: string; name?: string; value: string } }
  ).locator;
  if (!locator) {
    return;
  }
  if (locator.by === "role") {
    return locator.name;
  }
  return locator.by === "label" ? locator.value : undefined;
}

const words = (label: string) =>
  label.trim().toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Le remplacement DÉTERMINISTE quand un seul candidat observé ne diffère du
 * libellé demandé que par **un mot alphabétique**.
 *
 * Mesuré (lot QQ) : cinq scénarios bloqués en `TARGET_NOT_FOUND`, cinq étapes
 * avec des cibles observées, **zéro réparation** — le modèle a refusé, faute de
 * candidat qu'il jugeait sûr, alors que la page exposait « Billet de 20 € » là où
 * le plan écrivait « Pièce de 20 € ». La substitution reste bornée : un seul
 * candidat, un seul mot de différence, et **jamais quand la différence est un
 * nombre** — remplacer « Billet de 5 € » par « Billet de 10 € » changerait ce que
 * le test prouve.
 */
export function nearestObservedTarget(
  action: Scenario["steps"][number]["action"],
  targets: ObservedTarget[]
): ObservedTarget | undefined {
  const label = requestedLabel(action);
  if (!label) {
    return;
  }
  const wanted = words(label);
  const candidates = targets.filter((target) => {
    const offered = words(target.name);
    if (offered.length !== wanted.length) {
      return false;
    }
    const different = wanted.filter((word, index) => word !== offered[index]);
    if (different.length !== 1) {
      return false;
    }
    // La différence doit être un mot, jamais un nombre : une quantité substituée
    // change le comportement testé au lieu de réparer une cible.
    return !(
      /\d/.test(different[0] ?? "") ||
      /\d/.test(offered[wanted.indexOf(different[0] ?? "")] ?? "")
    );
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

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
  /**
   * Pourquoi une reprise s'écarte : mesuré, pas supposé. Le run ff87a97b a bloqué
   * quatre scénarios sur la même cible inventée sans qu'aucune reprise ne parte,
   * et l'artefact ne dit pas laquelle des gardes l'a empêchée.
   */
  const skip = (reason: string): undefined => {
    logger.info(
      {
        action: step.action.type,
        reason,
        scenario: args.scenario,
        targets: targets?.length ?? 0,
      },
      "Target repair skipped"
    );
    return;
  };
  if (model === undefined) {
    return skip("no-model");
  }
  if (
    step.action.type === "assert" ||
    step.action.type === "observe" ||
    step.action.type === "goto"
  ) {
    return skip("not-repairable-action");
  }
  if ((targets?.length ?? 0) === 0) {
    return skip("no-observed-targets");
  }
  const scope = runScope.getStore();
  if (scope && (scope.targetRepairs ?? 0) >= MAX_TARGET_REPAIRS_PER_RUN) {
    return skip("run-cap");
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
    logger.info(
      { scenario: args.scenario },
      "Target repair failed, keeping the failure"
    );
    /**
     * Une reprise qui échoue ne remplace jamais l'échec d'origine : sans
     * fournisseur configuré, ou sans réponse, le scénario garde son
     * `TARGET_NOT_FOUND` au lieu de le voir remplacé par un `QA_ERROR`.
     */
    return;
  }
  if (!chosen) {
    // Le modèle refuse quand aucun candidat ne lui paraît sûr. Un candidat qui
    // ne diffère du libellé demandé que par UN mot alphabétique est pourtant une
    // réparation démontrable : mesuré (lot QQ), cinq scénarios perdaient leur
    // étape sur « Pièce de 20 € » là où la page expose « Billet de 20 € ». Un
    // nombre n'est jamais substitué : il changerait ce que le test prouve.
    const nearest = nearestObservedTarget(step.action, targets ?? []);
    if (!nearest) {
      return skip("model-declined");
    }
    return {
      step: {
        ...step,
        action: { ...step.action, locator: repairedLocator(nearest) },
      } as Scenario["steps"][number],
      target: nearest,
    };
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
