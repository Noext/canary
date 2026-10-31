import { isDeepStrictEqual } from "node:util";
import type { ScenarioResult } from "./results.js";

/**
 * Le classement d'une assertion entre la tête et la base
 * (`src/baseline-diff.ts`), et l'intention que la PR déclare : un comportement
 * modifié n'est une régression que là où il est déclaré inchangé.
 */

export type Category =
  | "changed"
  | "inconclusive"
  | "notDiscriminating"
  | "regression";
type RecordedAssertion = ScenarioResult["assertions"][number];

/** Pourquoi l'écart d'un scénario non `regression` d'une PR `refactor` est une régression. */
export const REFACTOR_RULE =
  "the PR title declares a refactor, which declares no behavior change: a value the base does not show is a regression";

/**
 * Vrai pour un titre Conventional Commits `refactor:` ou `refactor(scope):` : la
 * PR déclare qu'aucun comportement observable ne change. `refactor!:` annonce
 * une rupture et n'en fait pas partie ; `chore`, `perf` et `style` non plus,
 * faute de mesure.
 */
export function declaresNoBehaviorChange(title: string | undefined): boolean {
  return /^refactor(\([^)]*\))?:/i.test((title ?? "").trim());
}

/**
 * Codes où la valeur satisfait déjà l'attendu et où seule la vérification échoue :
 * l'état laissé par un run antérieur l'explique aussi bien qu'un changement de
 * code, des deux côtés (environnements persistants que chaque run écrit).
 */
const VALUE_SATISFIED = new Set([
  "STATE_ALREADY_SATISFIED",
  "TRANSITION_ON_INVARIANT",
]);

/**
 * L'exécuteur compare un texte par inclusion, blancs repliés : deux textes qui ne
 * diffèrent que par leurs blancs sont la même valeur, et deux textes différents
 * peuvent satisfaire le même attendu — d'où la comparaison des valeurs, pas des
 * seuls verdicts.
 */
function sameValue(head: unknown, base: unknown): boolean {
  const fold = (value: unknown) =>
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
  return isDeepStrictEqual(fold(head), fold(base));
}

/**
 * Vrai quand l'assertion a échoué sur une valeur qui satisfaisait déjà
 * l'attendu avant son étape : ce côté montre ce que le plan demande, seule la
 * preuve que l'étape l'a produit manque.
 */
function valueSatisfied(
  scenario: ScenarioResult,
  item: RecordedAssertion
): string | undefined {
  const code = scenario.diagnostic?.code ?? "";
  if (VALUE_SATISFIED.has(code)) {
    return code;
  }
  return item.preMatched === true
    ? "value already satisfied before the step"
    : undefined;
}

/**
 * La cible qu'un côté a jouée à la place de celle du plan (reprise par le
 * modèle, ré-ancrage observe→act) : le hash du contrat est calculé sur le plan
 * d'origine, il ne voit pas cette substitution.
 */
function substitutedTarget(
  head: ScenarioResult,
  base: ScenarioResult
): string | undefined {
  for (const [label, item] of [
    ["head", head],
    ["base", base],
  ] as const) {
    const step = item.steps.find((entry) => entry.repairedTarget !== undefined);
    if (step) {
      // La cible jouée vient de la page : elle reste dans `steps`, jamais ici.
      return `the ${label} played a substituted target at step ${step.stepId ?? step.index}, not the planned one`;
    }
  }
  return;
}

/** Les fixtures sont semées pour l'environnement de tête : la base ne rejoue pas ces scénarios. */
function fixtureBacked(scenario: ScenarioResult["scenario"]): boolean {
  return scenario.preconditions.some((item) => item.startsWith("fixture:"));
}

function inconclusive(reason: string): {
  categories: Category[];
  reason: string;
} {
  return { categories: ["inconclusive"], reason };
}

function headMissing(
  head: ScenarioResult,
  base: ScenarioResult,
  b: RecordedAssertion | undefined
) {
  const code = head.diagnostic?.code ?? "";
  // La tête s'est arrêtée avant l'assertion que la base a jouée et passée : le
  // plan est écrit pour la tête, donc une cible renommée par la PR et une cible
  // supprimée par erreur se ressemblent ici. Le scénario garde son verdict non
  // vert ; la comparaison dit ce que la base a montré.
  return b?.passed && base.outcome === "passed"
    ? inconclusive(
        `the head stopped before this assertion${code ? ` (${code})` : ""} while the base played the same contract and passed it: the PR may have removed or renamed what the plan uses`
      )
    : inconclusive("not executed on the head");
}

/** Base verte, tête rouge : régression, sauf si un état antérieur l'explique. */
function headFailed(
  head: ScenarioResult,
  h: RecordedAssertion,
  b: RecordedAssertion
) {
  const satisfied = valueSatisfied(head, h);
  if (satisfied) {
    return inconclusive(
      `the head value already satisfied the expectation; only its verification failed on the head (${satisfied})`
    );
  }
  // Une transition se juge depuis la valeur d'avant l'étape : deux points de
  // départ différents (état laissé par un autre run, données de
  // l'environnement) expliquent l'écart aussi bien que le code.
  if (
    h.verification !== "state" &&
    h.changed !== undefined &&
    b.changed !== undefined &&
    !sameValue(h.baseline, b.baseline)
  ) {
    return inconclusive(
      "different starting state: the value probed before the step differs between the head and the base"
    );
  }
  return { categories: ["regression" as const] };
}

/** Tête verte, base rouge : changement, sauf si la base montre la même chose. */
function baseFailed(
  base: ScenarioResult,
  h: RecordedAssertion,
  b: RecordedAssertion
) {
  const satisfied = valueSatisfied(base, b);
  if (satisfied) {
    return inconclusive(
      `the base value already satisfied the expectation; only its verification failed on the base (${satisfied})`
    );
  }
  if (sameValue(h.actual, b.actual) && sameValue(h.persisted, b.persisted)) {
    return inconclusive(
      `the base shows the same value as the head; only its verification failed on the base (${base.diagnostic?.code ?? "unknown"})`
    );
  }
  return { categories: ["changed" as const] };
}

export function classify(
  head: ScenarioResult,
  base: ScenarioResult | undefined,
  h: RecordedAssertion | undefined,
  b: RecordedAssertion | undefined,
  unchanged: boolean
): { categories: Category[]; reason?: string } {
  if (base === undefined) {
    return inconclusive(
      fixtureBacked(head.scenario)
        ? "scenario not replayed on the base: its fixtures are seeded for the head environment only"
        : "scenario not executed on the base"
    );
  }
  if (base.contract?.hash !== head.contract?.hash) {
    return inconclusive("the base played a different contract");
  }
  const substituted = substitutedTarget(head, base);
  if (substituted) {
    return inconclusive(substituted);
  }
  if (h === undefined) {
    return headMissing(head, base, b);
  }
  if (b === undefined) {
    const code = base.diagnostic?.code;
    return inconclusive(`not executed on the base${code ? ` (${code})` : ""}`);
  }
  if (b.passed && !h.passed) {
    return headFailed(head, h, b);
  }
  if (!h.passed) {
    return inconclusive("fails on both the head and the base");
  }
  if (!b.passed) {
    const changed = baseFailed(base, h, b);
    // `regression` (ou une PR `refactor`) déclare un comportement inchangé : une
    // autre valeur que la base est la régression (PR 21 : « -240,00 € » sur
    // main, « 240,00 € » sur la PR ; banc du 31/10/2026 : « Billet de 20 € »
    // épinglé à 25,00 € par un `edge_case` d'une PR `refactor`, 20,00 € en base).
    if (!(unchanged && changed.categories.includes("changed"))) {
      return changed;
    }
    return head.scenario.kind === "regression"
      ? { categories: ["changed", "regression"] }
      : { categories: ["changed", "regression"], reason: REFACTOR_RULE };
  }
  return {
    categories: sameValue(h.actual, b.actual)
      ? ["notDiscriminating"]
      : ["changed", "notDiscriminating"],
  };
}
