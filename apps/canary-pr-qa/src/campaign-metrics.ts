import { INFRASTRUCTURE_CODES } from "./diagnostics.js";

/**
 * Les codes d'infrastructure **de la campagne** : ceux que le moteur connaît,
 * plus les deux pannes HTTP que le document de critères nomme explicitement
 * (`HTTP_429`, `HTTP_502`) et que le moteur ne classe pas comme telles. Aucun
 * autre code n'est ajouté : la liste des critères ne s'étend pas ici.
 */
const CAMPAIGN_INFRASTRUCTURE_CODES = new Set([
  ...INFRASTRUCTURE_CODES,
  "HTTP_429",
  "HTTP_502",
]);

/**
 * Statistiques de campagne, calculées à partir des runs réellement enregistrés.
 *
 * Ce module ne décide rien et ne produit aucun chiffre par défaut : sans run, il
 * rend des compteurs à zéro et le dit. Les seuils appliqués sont ceux de
 * `docs/pr-qa-campaign-criteria.md`, figés avant le premier run ; ils sont lus
 * ici, jamais redéfinis.
 *
 * Ce que ces fonctions ne mesurent pas, et ne doivent jamais laisser croire :
 * le taux de faux verts d'un corpus historique. Un faux vert est une assertion
 * pré-satisfaite qui a PASSÉ — `preMatchedPassed` — et il n'est calculable que
 * sur des runs dont l'artefact porte, par assertion, `verification`, `preMatched`
 * et `passed`. Un corpus qui ne stocke que des compteurs ne peut pas l'alimenter.
 */

/** Une assertion telle qu'un artefact de run la publie. */
export interface RecordedAssertion {
  changed?: boolean;
  passed: boolean;
  preMatched?: boolean;
  verification?: "state" | "transition" | "persisted";
}

/** Un scénario tel qu'un artefact de run le publie. */
export interface RecordedScenario {
  /** Code de diagnostic du scénario, quand il y en a un. */
  code?: string;
  outcome: string;
  /** Vrai quand le scénario n'a joué aucune étape : refusé avant exécution. */
  refused?: boolean;
}

/** Un run tel que le driver l'enregistre. */
export interface RecordedRun {
  arm: string;
  assertions: RecordedAssertion[];
  block: number;
  /**
   * Vrai quand le run n'a produit aucun `result.json` : le CLI a échoué ou
   * dépassé son délai. Un run incomplet n'est ni vert ni évaluable — il est
   * publié pour que l'opérateur le rejoue, jamais compté comme un succès.
   */
  incomplete?: boolean;
  /** Position dans le bloc, et début du run, pour l'audit de l'artefact. */
  index?: number;
  /** Issue du run (`passed`, `failed`, `blocked`, `skipped`, `stale`). */
  outcome: string;
  runId: string;
  scenarios: RecordedScenario[];
  /** Commit réellement servi pour ce run, vérifié par le driver. */
  sha: string;
  startedAt?: number;
  tokens?: number;
}

export interface VerificationBucket {
  /** Assertions de ce type, tous résultats confondus. */
  assertions: number;
  /** Assertions pré-satisfaites, quel que soit leur résultat. */
  preMatched: number;
  /** Assertions pré-satisfaites ET passées : le faux vert, par construction. */
  preMatchedPassed: number;
  /** Valeur laissée identique par l'étape, quand la mesure existe. */
  unchanged: number;
}

export interface ArmMetrics {
  arm: string;
  assertions: VerificationBucket;
  byVerification: Record<string, VerificationBucket>;
  /** Runs ni verts ni imputables à l'infrastructure : le dénominateur du taux. */
  evaluableRuns: number;
  /** Runs bloqués alors que tous leurs scénarios exécutés passent. */
  falseRefusals: number;
  /** Taux de runs entièrement verts, sur les runs évaluables. `undefined` si 0. */
  greenRate: number | undefined;
  /** Runs dont tous les scénarios sont `passed`. */
  greenRuns: number;
  /** Runs qui n'ont produit aucun résultat : rejoués, jamais comptés verts. */
  incompleteRuns: number;
  /** Runs dont au moins un code de diagnostic est un code d'infrastructure. */
  infrastructureRuns: number;
  /** Runs non verts portant au moins un code de plan (défaut du plan). */
  planDefectiveRuns: number;
  /** Runs non verts portant au moins un échec produit. */
  productFailureRuns: number;
  runs: number;
  tokens: number;
}

function emptyBucket(): VerificationBucket {
  return { assertions: 0, preMatched: 0, preMatchedPassed: 0, unchanged: 0 };
}

function addAssertion(
  bucket: VerificationBucket,
  assertion: RecordedAssertion
): void {
  bucket.assertions += 1;
  if (assertion.preMatched) {
    bucket.preMatched += 1;
    if (assertion.passed) {
      bucket.preMatchedPassed += 1;
    }
  }
  if (assertion.changed === false) {
    bucket.unchanged += 1;
  }
}

/** Les codes de plan qu'un scénario peut porter sans que le produit soit en cause. */
const PLAN_CODES: readonly string[] = [
  "CONTRACT_INCOMPLETE",
  "COVERAGE_REQUIREMENT_SOURCE_MISSING",
  "CRITICAL_COVERAGE_MISSING",
  "MARKER_ORDER_UNREACHABLE",
  "OBJECTIVE_NOT_DISCRIMINATING",
  "OBJECTIVE_UNWITNESSED",
  "PLAN_ATTRIBUTE_VALUE_READ_AS_TEXT",
  "PLAN_CHANGED_FILE_UNCOVERED",
  "PLAN_EVIDENCE_INCOMPLETE",
  "PLAN_SCHEMA_INVALID",
  "PLAN_SCENARIO_ID_RESERVED",
  "PLAN_STATE_TARGET_READ_AS_TEXT",
  "PLAN_TARGET_MISSING",
  "PERSISTENCE_INTENT_MISMATCH",
  "PRECONDITION_UNVERIFIED",
  "REQUIREMENT_UNGROUNDED",
  "STATE_ALREADY_SATISFIED",
  "TARGET_NOT_FOUND",
  "TRANSITION_NOT_OBSERVED",
  "TRANSITION_ON_INVARIANT",
  "WRITE_EVIDENCE_MISSING",
];

/** Vrai quand le run n'est pas évaluable : l'infrastructure l'a interrompu. */
export function isInfrastructureRun(run: RecordedRun): boolean {
  return run.scenarios.some(
    (scenario) =>
      scenario.code !== undefined &&
      CAMPAIGN_INFRASTRUCTURE_CODES.has(scenario.code)
  );
}

/** Vrai quand le run est bloqué alors que tous ses scénarios exécutés passent. */
export function isFalseRefusal(run: RecordedRun): boolean {
  if (run.outcome === "passed") {
    return false;
  }
  const executed = run.scenarios.filter(
    (scenario) => scenario.refused !== true
  );
  return (
    executed.length > 0 &&
    executed.every((scenario) => scenario.outcome === "passed")
  );
}

export function armMetrics(
  arm: string,
  runs: readonly RecordedRun[]
): ArmMetrics {
  const metrics: ArmMetrics = {
    arm,
    assertions: emptyBucket(),
    byVerification: {},
    evaluableRuns: 0,
    falseRefusals: 0,
    greenRate: undefined,
    greenRuns: 0,
    infrastructureRuns: 0,
    incompleteRuns: 0,
    planDefectiveRuns: 0,
    productFailureRuns: 0,
    runs: runs.length,
    tokens: 0,
  };
  for (const run of runs) {
    if (run.incomplete === true) {
      metrics.incompleteRuns += 1;
      continue;
    }
    const infrastructure = isInfrastructureRun(run);
    if (infrastructure) {
      metrics.infrastructureRuns += 1;
    } else {
      metrics.evaluableRuns += 1;
      if (run.outcome === "passed") {
        metrics.greenRuns += 1;
      }
    }
    if (isFalseRefusal(run)) {
      metrics.falseRefusals += 1;
    }
    const codes = run.scenarios.flatMap((scenario) =>
      scenario.code === undefined ? [] : [scenario.code]
    );
    if (codes.some((code) => PLAN_CODES.includes(code))) {
      metrics.planDefectiveRuns += 1;
    }
    if (run.outcome !== "passed" && codes.length === 0) {
      metrics.productFailureRuns += 1;
    }
    metrics.tokens += run.tokens ?? 0;
    for (const assertion of run.assertions) {
      addAssertion(metrics.assertions, assertion);
      const kind = assertion.verification ?? "unknown";
      metrics.byVerification[kind] ??= emptyBucket();
      addAssertion(
        metrics.byVerification[kind] as VerificationBucket,
        assertion
      );
    }
  }
  metrics.greenRate =
    metrics.evaluableRuns === 0
      ? undefined
      : metrics.greenRuns / metrics.evaluableRuns;
  return metrics;
}

export interface Interval {
  high: number;
  low: number;
}

/**
 * IC 95 % d'une proportion, par l'approximation normale — celle qu'emploie le
 * document de critères pour calculer sa puissance (`√(p(1−p)/n)`). Rendue pour
 * être publiée, jamais pour décider seule : le seuil de décision reste +20 points
 * avec un IC excluant zéro.
 */
export function proportionInterval(
  successes: number,
  total: number
): Interval | undefined {
  if (total === 0) {
    return;
  }
  const p = successes / total;
  const error = 1.96 * Math.sqrt((p * (1 - p)) / total);
  return { high: Math.min(1, p + error), low: Math.max(0, p - error) };
}

export interface ArmComparison {
  /** Écart de faux verts par assertion (candidat − référence), en points. */
  falseGreenDelta: number | undefined;
  /** Écart de taux de runs verts (candidat − référence), en points. */
  greenRateDelta: number | undefined;
  /** IC 95 % de cet écart, approximation normale sur les deux bras. */
  greenRateDeltaInterval: Interval | undefined;
  /** Vrai quand l'IC de l'écart exclut zéro : le document exige les deux. */
  significant: boolean;
}

function rate(value: number, total: number): number | undefined {
  return total === 0 ? undefined : value / total;
}

/**
 * Compare deux bras. Rend des écarts, jamais une conclusion : la conclusion est
 * écrite dans `campaignDecision`, qui applique les seuils figés.
 */
export function compareArms(
  reference: ArmMetrics,
  candidate: ArmMetrics
): ArmComparison {
  const referenceRate = rate(reference.greenRuns, reference.evaluableRuns);
  const candidateRate = rate(candidate.greenRuns, candidate.evaluableRuns);
  const greenRateDelta =
    referenceRate === undefined || candidateRate === undefined
      ? undefined
      : candidateRate - referenceRate;
  let greenRateDeltaInterval: Interval | undefined;
  if (
    referenceRate !== undefined &&
    candidateRate !== undefined &&
    reference.evaluableRuns > 0 &&
    candidate.evaluableRuns > 0
  ) {
    const variance =
      (referenceRate * (1 - referenceRate)) / reference.evaluableRuns +
      (candidateRate * (1 - candidateRate)) / candidate.evaluableRuns;
    const error = 1.96 * Math.sqrt(variance);
    greenRateDeltaInterval = {
      high: (greenRateDelta as number) + error,
      low: (greenRateDelta as number) - error,
    };
  }
  const referenceFalseGreen = rate(
    reference.assertions.preMatchedPassed,
    reference.assertions.assertions
  );
  const candidateFalseGreen = rate(
    candidate.assertions.preMatchedPassed,
    candidate.assertions.assertions
  );
  return {
    falseGreenDelta:
      referenceFalseGreen === undefined || candidateFalseGreen === undefined
        ? undefined
        : candidateFalseGreen - referenceFalseGreen,
    greenRateDelta,
    greenRateDeltaInterval,
    significant:
      greenRateDeltaInterval !== undefined &&
      (greenRateDeltaInterval.low > 0 || greenRateDeltaInterval.high < 0),
  };
}

export type CampaignVerdict =
  | "not-run"
  | "validated"
  | "not-demonstrated"
  | "regression"
  | "inconclusive";

/**
 * Applique les seuils figés de `docs/pr-qa-campaign-criteria.md` §2 et §5.
 *
 * `inconclusive` n'est pas une porte de sortie commode : c'est le cas où les deux
 * bras n'ont pas assez de runs évaluables pour calculer un écart, ou où un
 * garde-fou de dégradation est franchi — un garde-fou franchi interdit de
 * conclure à une validation, même avec un écart favorable.
 */
export function campaignDecision(input: {
  comparison: ArmComparison;
  candidate: ArmMetrics;
  reference: ArmMetrics;
}): { reasons: string[]; verdict: CampaignVerdict } {
  const { candidate, comparison, reference } = input;
  const reasons: string[] = [];
  if (reference.evaluableRuns === 0 || candidate.evaluableRuns === 0) {
    return {
      reasons: ["aucun run évaluable dans un des deux bras"],
      verdict: "not-run",
    };
  }
  if (comparison.greenRateDelta === undefined) {
    return { reasons: ["écart non calculable"], verdict: "inconclusive" };
  }
  if (candidate.falseRefusals > 0) {
    reasons.push(
      `garde-fou franchi : ${candidate.falseRefusals} faux refus (plafond : aucun)`
    );
  }
  if (
    comparison.falseGreenDelta !== undefined &&
    comparison.falseGreenDelta > 0.03
  ) {
    reasons.push(
      `garde-fou franchi : faux verts +${(comparison.falseGreenDelta * 100).toFixed(1)} points (plafond : +3)`
    );
  }
  const delta = comparison.greenRateDelta;
  if (reasons.length > 0) {
    return { reasons, verdict: "inconclusive" };
  }
  if (delta >= 0.2 && comparison.significant) {
    return {
      reasons: [
        `écart de ${(delta * 100).toFixed(1)} points, IC excluant zéro`,
      ],
      verdict: "validated",
    };
  }
  if (delta <= 0 && comparison.significant) {
    return {
      reasons: [
        `écart de ${(delta * 100).toFixed(1)} points, IC excluant zéro en faveur de la référence`,
      ],
      verdict: "regression",
    };
  }
  return {
    reasons: [
      `écart de ${(delta * 100).toFixed(1)} points, IC incluant zéro ou sous le seuil de +20`,
    ],
    verdict: "not-demonstrated",
  };
}
