import { foldTypography } from "./canary.js";
import type { Assertion, Scenario } from "./schema.js";

/**
 * Les mots réels d'un texte, typographie et accents repliés : « Écart justifié »
 * lit `ecart` et `justifie`, comme la citation `ecart-justifie`. Sans le repli
 * des accents, `[^a-z0-9]` coupait chaque mot accentué (« Écart » donnait
 * « cart », « justifié » donnait « justifi ») et refusait un libellé que la
 * ligne citée écrit. Partagé avec la porte de provenance : la justification et
 * l'exemption de saisie relue lisent les mêmes mots.
 */
export const foldedWords = (text: string) =>
  new Set(
    foldTypography(text)
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4)
  );

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
