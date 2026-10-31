import { diffAddedLiteral } from "./added-literal.js";
import {
  type Category,
  classify,
  declaresNoBehaviorChange,
  REFACTOR_RULE,
} from "./baseline-classify.js";
import type { Config } from "./config.js";
import { diagnose, QaError } from "./diagnostics.js";
import type { PrContext } from "./github.js";
import type {
  BaselineAssertionDiff,
  BaselineComparison,
  RunResult,
  ScenarioResult,
} from "./results.js";

/**
 * La préversion de base comme oracle indépendant : le planificateur peut prendre
 * le NOUVEAU code pour la vérité (PR 21 : « Écart de 40,00 » attendu, valeur du
 * bug). Le même contrat rejoué sur la base, sans modèle, donne une seconde
 * lecture, comparée par identifiant d'assertion dans le même scénario.
 *
 * - base verte, tête rouge : la PR casse ce qui marchait — régression produit ;
 * - tête verte, base rouge (ou cible absente) : comportement modifié, listé ;
 *   pour un scénario `regression`, ou tout scénario d'une PR `refactor`, qui le
 *   déclarent inchangé, c'est une régression (`src/baseline-classify.ts`) ;
 * - verte des deux côtés : l'assertion ne distingue pas la PR de la base ; si
 *   c'est la preuve du scénario, il passerait sans la PR et n'est pas prouvé ;
 * - rouge des deux côtés, base non exécutable : non concluant, publié, jamais
 *   converti en vert ou en rouge.
 */

type RecordedAssertion = ScenarioResult["assertions"][number];
type AddedLiteral = ReturnType<typeof diffAddedLiteral>;

/** Pourquoi l'écart d'une assertion annexe d'un scénario `regression` reste un changement. */
const ADDED_LITERAL_RULE =
  "secondary assertion of a regression scenario on a literal the diff adds: the base cannot show it, so the difference is a change, not a regression";

const VALUE_CHARS = 160;
const LIST = {
  changed: "changes",
  inconclusive: "inconclusive",
  notDiscriminating: "notDiscriminating",
  regression: "regressions",
} as const satisfies Record<Category, keyof BaselineComparison>;

const short = (sha: string) => sha.slice(0, 7);

function side(item: RecordedAssertion) {
  return {
    passed: item.passed,
    ...(item.actual === undefined ? {} : { actual: item.actual }),
  };
}

function markRegression(
  head: ScenarioResult,
  entry: BaselineAssertionDiff,
  sha: string,
  config: Config
) {
  const { id, kind } = head.scenario;
  const declared =
    kind === "regression"
      ? `Regression scenario ${id}: the PR changes behavior this scenario declares unchanged`
      : `Scenario ${id}: ${REFACTOR_RULE}; if the change is intended, the PR is not a refactor`;
  const error = new QaError(
    "BASELINE_REGRESSION",
    entry.head?.passed
      ? `${declared} (assertion ${entry.assertionId} reads a different value on the PR head than on the base commit ${short(sha)})`
      : `Assertion ${entry.assertionId} passes on the base commit ${short(sha)} and fails on the PR head: the PR breaks behavior that works on the base`,
    "Both observed values are in the base comparison of the private report and result.json (baselineComparison.regressions), never in this message. Fix the regression; if the change is intended, the plan must expect the new behavior from the diff."
  );
  const previous = head.error;
  head.outcome = "failed";
  head.classification = "failed";
  head.diagnostic = diagnose(error, config);
  head.error = previous
    ? `${head.diagnostic.message} — head: ${previous}`
    : head.diagnostic.message;
}

function markNotDiscriminating(
  head: ScenarioResult,
  proof: string[],
  sha: string,
  config: Config
) {
  const { id, objective } = head.scenario;
  const error = new QaError(
    "OBJECTIVE_NOT_DISCRIMINATING",
    objective
      ? `Scenario ${id}: its objective assertion ${objective} also passes on the base commit ${short(sha)}, so the scenario would be green without the PR and proves nothing about the change`
      : `Scenario ${id}: none of its assertions (${proof.join(", ")}) fails on the base commit ${short(sha)}, so the scenario would be green without the PR and proves nothing about the change`,
    "Read a value the PR changes, with the expected value the head must show and the base does not: the base comparison of the report lists what the base showed. A scenario that passes identically before the change is not evidence of it."
  );
  head.outcome = "blocked";
  head.classification = "test-defect";
  head.diagnostic = diagnose(error, config);
  head.error = head.diagnostic.message;
}

/**
 * Compare la tête et la base, puis applique les deux seuls effets sur le verdict :
 * régression (rouge) et preuve qui ne distingue pas la PR (bloqué). Sans
 * `QA_BASELINE_URL_TEMPLATE`, rien ne change. Le runner recalcule l'issue du run
 * après cet appel. Un `title` de PR `refactor` déclare un comportement
 * inchangé : chaque scénario y est jugé comme un scénario `regression`. Les
 * `files` du diff disent quels littéraux la PR ajoute (`src/added-literal.ts`).
 */
export function compareWithBaseline(
  result: RunResult,
  config: Config,
  title?: string,
  files?: PrContext["files"]
): void {
  const baseline = result.baseline;
  if (baseline === undefined) {
    return;
  }
  const comparison: BaselineComparison = {
    status: baseline.diagnostic ? "unavailable" : "compared",
    sha: baseline.sha,
    ...(baseline.diagnostic ? { diagnostic: baseline.diagnostic } : {}),
    changes: [],
    regressions: [],
    notDiscriminating: [],
    inconclusive: [],
  };
  result.baselineComparison = comparison;
  if (baseline.diagnostic) {
    return;
  }
  const bases = new Map(
    baseline.scenarios.map((item) => [item.scenario.id, item])
  );
  const refactor = declaresNoBehaviorChange(title);
  // Une PR `refactor` déclare TOUT inchangé : un littéral ajouté y est déjà
  // un comportement nouveau, donc aucune exemption.
  const added = refactor ? undefined : diffAddedLiteral(files);
  for (const head of result.scenarios) {
    const { regression, undiscriminated } = diffScenario(
      head,
      bases.get(head.scenario.id),
      comparison,
      { added, unchanged: refactor || head.scenario.kind === "regression" }
    );
    if (regression) {
      markRegression(head, regression, baseline.sha, config);
      continue;
    }
    const proof = head.scenario.objective
      ? [head.scenario.objective]
      : head.scenario.assertions.map((item) => item.id);
    // Un scénario `regression` prouve justement qu'il passe des deux côtés.
    if (
      head.outcome === "passed" &&
      head.scenario.kind !== "regression" &&
      proof.length > 0 &&
      proof.every((id) => undiscriminated.has(id))
    ) {
      markNotDiscriminating(head, proof, baseline.sha, config);
    }
  }
}

/** Les entrées d'un scénario, rangées dans `comparison`, et ce qu'elles imposent. */
function diffScenario(
  head: ScenarioResult,
  base: ScenarioResult | undefined,
  comparison: BaselineComparison,
  intent: { added: AddedLiteral; unchanged: boolean }
) {
  const undiscriminated = new Set<string>();
  let regression: BaselineAssertionDiff | undefined;
  for (const planned of head.scenario.assertions) {
    const h = head.assertions.find((item) => item.id === planned.id);
    const b = base?.assertions.find((item) => item.id === planned.id);
    if (h === undefined && b === undefined) {
      continue;
    }
    const { categories, reason } = secondaryAddition(
      head,
      planned,
      h,
      intent.added,
      classify(head, base, h, b, intent.unchanged)
    );
    const entry: BaselineAssertionDiff = {
      scenarioId: head.scenario.id,
      assertionId: planned.id,
      objective: head.scenario.objective === planned.id,
      ...("expected" in planned && planned.expected !== undefined
        ? { expected: planned.expected }
        : {}),
      ...(h ? { head: side(h) } : {}),
      ...(b ? { base: side(b) } : {}),
      ...(reason ? { reason } : {}),
    };
    for (const category of categories) {
      comparison[LIST[category]].push(entry);
    }
    if (categories.includes("notDiscriminating")) {
      undiscriminated.add(planned.id);
    }
    if (categories.includes("regression")) {
      regression ??= entry;
    }
  }
  return { regression, undiscriminated };
}

/**
 * L'assertion ANNEXE (un objectif est déclaré, ce n'est pas lui) d'un scénario
 * `regression`, verte sur la tête, qui lit un littéral que le diff ajoute :
 * la base échoue faute de l'élément, ce n'est pas une régression. Tout le
 * reste garde son classement — objectif, tête rouge, interface existante.
 */
function secondaryAddition(
  head: ScenarioResult,
  planned: ScenarioResult["scenario"]["assertions"][number],
  h: RecordedAssertion | undefined,
  added: AddedLiteral,
  classified: ReturnType<typeof classify>
): ReturnType<typeof classify> {
  const { kind, objective } = head.scenario;
  return kind === "regression" &&
    objective !== undefined &&
    objective !== planned.id &&
    h?.passed === true &&
    classified.categories.includes("regression") &&
    added?.(planned) === true
    ? { categories: ["changed"], reason: ADDED_LITERAL_RULE }
    : classified;
}

/** Le texte affiché, centré sur `from` : une longue lecture de vue montre où elle diffère. */
function shown(value: unknown, from = 0): string {
  if (value === undefined) {
    return "cible absente";
  }
  const text =
    typeof value === "string"
      ? value.replace(/\s+/g, " ").trim()
      : JSON.stringify(value);
  const start = text.length > VALUE_CHARS ? Math.max(0, from - 60) : 0;
  const bounded = `${start > 0 ? "…" : ""}${text.slice(start, start + VALUE_CHARS)}${start + VALUE_CHARS < text.length ? "…" : ""}`;
  return typeof value === "string" ? `« ${bounded} »` : bounded;
}

/** Premier caractère qui diffère entre les deux lectures repliées. */
function firstDifference(entry: BaselineAssertionDiff): number {
  const fold = (value: unknown) =>
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const [a, b] = [fold(entry.head?.actual), fold(entry.base?.actual)];
  let index = 0;
  while (index < a.length && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

function sideText(
  label: string,
  value: BaselineAssertionDiff["head"],
  withValues: boolean,
  from = 0
): string {
  if (value === undefined) {
    return `${label} : non exécutée`;
  }
  const verdict = value.passed ? "passe" : "échoue";
  return withValues
    ? `${label} : ${shown(value.actual, from)} (${verdict})`
    : `${label} : ${verdict}`;
}

function line(entry: BaselineAssertionDiff, withValues: boolean): string {
  const expected =
    entry.expected === undefined ? "" : ` (attendu ${shown(entry.expected)})`;
  const reason = entry.reason ? ` — ${entry.reason}` : "";
  const from = firstDifference(entry);
  return `${entry.scenarioId} · ${entry.assertionId}${entry.objective ? " [objectif]" : ""}${expected} : ${sideText("main", entry.base, withValues, from)} → ${sideText("PR", entry.head, withValues, from)}${reason}`;
}

/**
 * Les sections du rapport, en tête. `withValues` faux pour le commentaire
 * publié : les valeurs lues dans la page ne restent que dans le rapport privé.
 */
export function comparisonSections(
  result: RunResult,
  withValues: boolean
): { items: string[]; title: string }[] {
  const comparison = result.baselineComparison;
  if (comparison === undefined) {
    return [];
  }
  const base = `base ${short(comparison.sha)}`;
  if (comparison.status === "unavailable") {
    return [
      {
        title: `Comparaison à main indisponible (${base})`,
        items: [
          `${comparison.diagnostic?.code ?? "UNKNOWN"} — ${comparison.diagnostic?.message ?? ""}`,
          "Le verdict ne repose que sur la tête de la PR : aucun comportement modifié n'a pu être relevé.",
        ],
      },
    ];
  }
  const hidden = withValues
    ? []
    : ["Valeurs observées : dans le rapport privé (result.json, report.md)."];
  const sections = [
    {
      title: `Comportements modifiés par rapport à main (${base})`,
      entries: comparison.changes,
    },
    {
      title: `Régressions par rapport à main (${base})`,
      entries: comparison.regressions,
    },
    {
      title: `Assertions qui passent aussi sur main (${base})`,
      entries: comparison.notDiscriminating,
    },
    {
      title: `Comparaison à main non concluante (${base})`,
      entries: comparison.inconclusive,
    },
  ]
    .filter((section) => section.entries.length > 0)
    .map((section) => ({
      title: section.title,
      items: [
        ...section.entries.map((entry) => line(entry, withValues)),
        ...hidden,
      ],
    }));
  return sections.length > 0
    ? sections
    : [
        {
          title: `Comparaison à main (${base})`,
          items: ["Aucune assertion comparée."],
        },
      ];
}

/** Le résumé de la comparaison, pour la description du statut de commit. */
export function comparisonStatusNote(result: RunResult): string {
  const comparison = result.baselineComparison;
  if (comparison === undefined) {
    return "";
  }
  const base = `base ${short(comparison.sha)}`;
  if (comparison.status === "unavailable") {
    return `${base} comparison unavailable`;
  }
  const count = (n: number, label: string) =>
    n > 0 ? [`${n} ${label}${n > 1 ? "s" : ""}`] : [];
  const parts = [
    ...count(comparison.regressions.length, "regression"),
    ...count(comparison.changes.length, "behavior change"),
    ...count(comparison.inconclusive.length, "inconclusive comparison"),
  ];
  return parts.length > 0
    ? `${parts.join(", ")} vs ${base}, see report`
    : `no change vs ${base}`;
}
