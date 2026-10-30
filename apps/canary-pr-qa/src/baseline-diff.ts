import { isDeepStrictEqual } from "node:util";
import type { Config } from "./config.js";
import { diagnose, QaError } from "./diagnostics.js";
import type {
  BaselineAssertionDiff,
  BaselineComparison,
  RunResult,
  ScenarioResult,
} from "./results.js";

/**
 * La préversion de base comme oracle indépendant.
 *
 * Le planificateur écrit l'attendu en lisant le diff : quand il prend le NOUVEAU
 * code pour la vérité, l'assertion passe sur la tête quelle que soit la justesse
 * du changement (PR 21 de `pharmania/arpilabe-pilotage` : « Écart de 40,00 »
 * attendu, valeur que le bug produit). Le même contrat rejoué sur la base donne
 * une seconde lecture, sans appel modèle : pour chaque assertion, ce que la base
 * a montré et si elle a passé. La comparaison se fait par identifiant
 * d'assertion dans le même scénario, sur le contrat joué des deux côtés.
 *
 * - base verte, tête rouge : la PR casse ce qui marchait — régression produit ;
 * - tête verte, base rouge (ou cible absente) : comportement modifié par la PR,
 *   listé pour un humain, le verdict reste celui de la tête ;
 * - verte des deux côtés : l'assertion ne distingue pas la PR de la base ; si
 *   c'est la preuve du scénario, il passerait sans la PR et n'est pas prouvé ;
 * - rouge des deux côtés, base non exécutable : non concluant, publié, jamais
 *   converti en vert ou en rouge.
 */

type Category = "changed" | "inconclusive" | "notDiscriminating" | "regression";
type RecordedAssertion = ScenarioResult["assertions"][number];

/**
 * Codes où la valeur lue satisfait déjà l'attendu et où seule la vérification
 * échoue (valeur déjà en place avant l'étape) : l'état laissé par un run
 * antérieur sur cet environnement l'explique aussi bien qu'un changement de
 * code. Vaut pour les deux côtés : la base est un environnement persistant que
 * chaque run de QA écrit, la tête aussi.
 */
const VALUE_SATISFIED = new Set([
  "STATE_ALREADY_SATISFIED",
  "TRANSITION_ON_INVARIANT",
]);
const VALUE_CHARS = 160;
const LIST = {
  changed: "changes",
  inconclusive: "inconclusive",
  notDiscriminating: "notDiscriminating",
  regression: "regressions",
} as const satisfies Record<Category, keyof BaselineComparison>;

const short = (sha: string) => sha.slice(0, 7);

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

function side(item: RecordedAssertion) {
  return {
    passed: item.passed,
    ...(item.actual === undefined ? {} : { actual: item.actual }),
  };
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

function classify(
  head: ScenarioResult,
  base: ScenarioResult | undefined,
  h: RecordedAssertion | undefined,
  b: RecordedAssertion | undefined
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
    return baseFailed(base, h, b);
  }
  return {
    categories: sameValue(h.actual, b.actual)
      ? ["notDiscriminating"]
      : ["changed", "notDiscriminating"],
  };
}

function markRegression(
  head: ScenarioResult,
  entry: BaselineAssertionDiff,
  sha: string,
  config: Config
) {
  const error = new QaError(
    "BASELINE_REGRESSION",
    `Assertion ${entry.assertionId} passes on the base commit ${short(sha)} and fails on the PR head: the PR breaks behavior that works on the base`,
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
 * après cet appel.
 */
export function compareWithBaseline(result: RunResult, config: Config): void {
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
  for (const head of result.scenarios) {
    const { regression, undiscriminated } = diffScenario(
      head,
      bases.get(head.scenario.id),
      comparison
    );
    if (regression) {
      markRegression(head, regression, baseline.sha, config);
      continue;
    }
    const proof = head.scenario.objective
      ? [head.scenario.objective]
      : head.scenario.assertions.map((item) => item.id);
    if (
      head.outcome === "passed" &&
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
  comparison: BaselineComparison
) {
  const undiscriminated = new Set<string>();
  let regression: BaselineAssertionDiff | undefined;
  for (const planned of head.scenario.assertions) {
    const h = head.assertions.find((item) => item.id === planned.id);
    const b = base?.assertions.find((item) => item.id === planned.id);
    if (h === undefined && b === undefined) {
      continue;
    }
    const { categories, reason } = classify(head, base, h, b);
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

function shown(value: unknown): string {
  if (value === undefined) {
    return "cible absente";
  }
  const text =
    typeof value === "string"
      ? value.replace(/\s+/g, " ").trim()
      : JSON.stringify(value);
  const bounded =
    text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS)}…` : text;
  return typeof value === "string" ? `« ${bounded} »` : bounded;
}

function sideText(
  label: string,
  value: BaselineAssertionDiff["head"],
  withValues: boolean
): string {
  if (value === undefined) {
    return `${label} : non exécutée`;
  }
  const verdict = value.passed ? "passe" : "échoue";
  return withValues
    ? `${label} : ${shown(value.actual)} (${verdict})`
    : `${label} : ${verdict}`;
}

function line(entry: BaselineAssertionDiff, withValues: boolean): string {
  const expected =
    entry.expected === undefined ? "" : ` (attendu ${shown(entry.expected)})`;
  const reason = entry.reason ? ` — ${entry.reason}` : "";
  return `${entry.scenarioId} · ${entry.assertionId}${entry.objective ? " [objectif]" : ""}${expected} : ${sideText("main", entry.base, withValues)} → ${sideText("PR", entry.head, withValues)}${reason}`;
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
