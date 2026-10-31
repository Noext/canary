import { isDeepStrictEqual } from "node:util";
import { foldTypography } from "./canary.js";
import type { Assertion, Plan, Scenario } from "./schema.js";

/**
 * Les mots réels d'un texte, typographie et accents repliés : « Écart justifié »
 * lit `ecart` et `justifie`, comme la citation `ecart-justifie`. Sans le repli
 * des accents, `[^a-z0-9]` coupait chaque mot accentué (« Écart » donnait
 * « cart », « justifié » donnait « justifi ») et refusait un libellé que la
 * ligne citée écrit. Partagé avec la porte de provenance : la justification et
 * l'exemption de saisie relue lisent les mêmes mots.
 */
const foldedWords = (text: string) =>
  new Set(
    foldTypography(text)
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4)
  );

/**
 * La valeur attendue est-elle justifiée par l'exigence citée ?
 *
 * Tolérante à dessein — une valeur calculée n'apparaît jamais telle quelle dans
 * le code qui la produit — mais elle exige un mot réel commun : un attendu qui
 * ne partage rien avec la ligne citée est une valeur inventée.
 */
export function justifiedByExpectedValue(
  expected: string,
  requirement: { behavior?: string; quote?: string }
): boolean {
  const source = foldedWords(
    `${requirement.quote ?? ""} ${requirement.behavior ?? ""}`
  );
  const target = foldedWords(expected);
  if (source.size === 0 || target.size === 0) {
    return true;
  }
  return [...target].some((word) => source.has(word));
}

/**
 * L'attendu est-il la valeur que le scénario a LUI-MÊME saisie plus tôt, relue
 * ailleurs après une action réelle ?
 *
 * La porte de provenance exige qu'un attendu littéral soit justifié par
 * l'exigence citée. Une valeur que le scénario tape — un commentaire, un motif —
 * n'apparaît jamais dans le code qui l'enregistre ou l'affiche : c'est la
 * saisie qui la justifie, l'exigence citée justifiant qu'elle soit conservée.
 * Premier plan réel de la PR #20 : « Rendu de monnaie à un client » saisi dans
 * le commentaire, relu dans l'historique après la clôture, refusé comme valeur
 * inventée.
 *
 * Étroite à dessein, chaque condition fermant un faux vert démontré :
 * - `transition` ou `persisted` seulement : l'exécuteur exige alors que la
 *   valeur DIFFÈRE de sa sonde d'avant l'étape d'ancrage. Relire en `state` le
 *   champ qu'on vient de remplir passait sinon au vert sur une application
 *   inerte (ancrage sur une observation, intention `invariant`, `ifPresent`
 *   sauté) ;
 * - la saisie (`fill` ou `select`, identique aux espaces de bord près) précède
 *   STRICTEMENT l'étape d'ancrage ;
 * - l'exigence citée partage un mot réel avec la cible ou la description de
 *   l'assertion : une valeur tapée dans un champ quelconque ne se blanchit pas
 *   en citant une exigence étrangère.
 */
export function echoesEarlierInput(
  scenario: Scenario,
  assertion: Assertion,
  cited: { behavior?: string; quote?: string },
  expected: string
): boolean {
  const { afterStep, verification } = assertion;
  if (
    afterStep === undefined ||
    (verification !== "transition" && verification !== "persisted")
  ) {
    return false;
  }
  const anchor = scenario.steps.findIndex((step) => step.id === afterStep);
  const typed = expected.trim();
  if (anchor <= 0 || typed.length === 0) {
    return false;
  }
  const requirement = foldedWords(
    `${cited.quote ?? ""} ${cited.behavior ?? ""}`
  );
  const read = foldedWords(
    `${JSON.stringify(assertion.target ?? "")} ${assertion.description}`
  );
  if (![...read].some((word) => requirement.has(word))) {
    return false;
  }
  return scenario.steps
    .slice(0, anchor)
    .some(
      ({ action }) =>
        (action.type === "fill" || action.type === "select") &&
        action.value.trim() === typed
    );
}

/**
 * Une relecture en `state` de la valeur saisie, ancrée sur un clic RÉEL sur un
 * AUTRE élément que le champ rempli : la forme du premier plan réel de la PR #20
 * (run 3), le commentaire saisi puis relu dans l'historique après « Clôturer la
 * session ». En `state`, rien n'exige que le clic ait produit la valeur ; en
 * `transition`, l'exécuteur exige qu'elle DIFFÈRE de sa sonde d'avant le clic.
 *
 * Chaque condition ferme une relecture que `transition` ne rendrait pas sûre :
 * - intention non déclarée : `invariant` affirme que rien ne bouge, et
 *   `persistence` exige `persisted` (refus de `persistence-intent.ts`) ;
 * - ancrage sur un `click` sans `ifPresent` : une observation ou un clic
 *   d'établissement sauté ne déplace rien ;
 * - la saisie précède strictement le clic, le clic ne vise pas le champ rempli
 *   et l'assertion ne relit pas un champ rempli : relire la saisie elle-même ne
 *   prouve que la frappe.
 */
function upgradableStateRead(
  scenario: Scenario,
  assertion: Assertion,
  typed: string
): boolean {
  if (
    (assertion.verification ?? "state") !== "state" ||
    assertion.assertionIntent !== undefined ||
    assertion.afterStep === undefined
  ) {
    return false;
  }
  const anchor = scenario.steps.findIndex(
    (step) => step.id === assertion.afterStep
  );
  const click = scenario.steps[anchor]?.action;
  if (click?.type !== "click" || click.ifPresent === true) {
    return false;
  }
  const fields = scenario.steps.flatMap(({ action }) =>
    action.type === "fill" || action.type === "select" ? [action] : []
  );
  const typedBefore = scenario.steps
    .slice(0, anchor)
    .some(
      ({ action }) =>
        (action.type === "fill" || action.type === "select") &&
        action.value.trim() === typed
    );
  return (
    typedBefore &&
    !fields.some(
      ({ locator }) =>
        isDeepStrictEqual(locator, click.locator) ||
        isDeepStrictEqual(locator, assertion.target)
    )
  );
}

/**
 * Surclasse en `transition` une saisie relue en `state` après un clic réel sur
 * un autre élément, au lieu de la laisser refuser comme valeur inventée.
 *
 * `transition` est strictement plus forte que `state` à l'exécution : la valeur
 * doit correspondre ET différer de sa sonde d'avant le clic. Une application
 * inerte, ou un historique qui affichait déjà la saisie, ne passe donc jamais au
 * vert (TRANSITION_ON_INVARIANT ou TRANSITION_NOT_OBSERVED). Rien ne repose sur
 * STATE_ALREADY_SATISFIED, qui ne protège que si la sonde d'avant est mesurée.
 *
 * Seule une assertion que la provenance refuserait est touchée : attendu
 * littéral que l'exigence citée ne justifie pas, et que l'exemption de saisie
 * relue accepte une fois lue en `transition`. Une relecture justifiée garde sa
 * vérification ; une relecture non surclassée reste refusée. Rend les
 * assertions surclassées, que l'appelant journalise.
 */
export function upgradeEchoedStateReads(
  plan: Plan
): { assertionId: string; scenarioId: string }[] {
  const upgraded: { assertionId: string; scenarioId: string }[] = [];
  for (const scenario of plan.scenarios) {
    for (const assertion of scenario.assertions) {
      const cited =
        assertion.requirement === undefined
          ? undefined
          : scenario.requirements[assertion.requirement];
      const { expected } = assertion as { expected?: unknown };
      if (
        cited === undefined ||
        (assertion.kind !== "text" && assertion.kind !== "value") ||
        typeof expected !== "string" ||
        expected.trim().length === 0 ||
        justifiedByExpectedValue(expected, cited) ||
        !upgradableStateRead(scenario, assertion, expected.trim()) ||
        !echoesEarlierInput(
          scenario,
          { ...assertion, verification: "transition" },
          cited,
          expected
        )
      ) {
        continue;
      }
      assertion.verification = "transition";
      upgraded.push({ assertionId: assertion.id, scenarioId: scenario.id });
    }
  }
  return upgraded;
}
