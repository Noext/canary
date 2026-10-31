import { assertionMatches } from "./canary.js";
import type { Config } from "./config.js";
import { diagnose, QaError } from "./diagnostics.js";
import type {
  BaselineAssertionDiff,
  BaselineComparison,
  ScenarioResult,
} from "./results.js";

/**
 * Une `persisted` jugée à la RÉENTRÉE (`reentry.ts`) ne prouve pas la survie
 * au rechargement : une PR peut casser une persistance existante dont l'appel
 * de stockage est hors du diff (`setItems(loadCart())` devenu `setItems([])`),
 * et l'aller-retour, servi par l'état en mémoire, passe quand même. Les deux
 * côtés relisent donc la cible après rechargement, et la base tranche :
 *
 * - tête rechargée verte : rien à dire ;
 * - tête rechargée rouge, base rechargée verte : la PR casse la persistance,
 *   `BASELINE_REGRESSION` ;
 * - tête et base rechargées rouges : l'application ne persistait pas, la
 *   réentrée tient et le rapport garde « reload persistence not claimed » ;
 * - relevé manquant ou non concluant d'un côté : le scénario est bloqué,
 *   jamais vert.
 *
 * Une cible absente sur la base (interface que la PR ajoute) est un relevé de
 * base en échec : la base n'avait rien à persister.
 */

type RecordedAssertion = ScenarioResult["assertions"][number];
type Planned = ScenarioResult["scenario"]["assertions"][number];
interface Reading {
  actual?: unknown;
  passed: boolean;
}

const short = (sha: string) => sha.slice(0, 7);

/** Le relevé après rechargement de la base, `undefined` s'il ne tranche pas. */
function baseReload(
  planned: Planned,
  head: ScenarioResult,
  base: ScenarioResult | undefined
): Reading | undefined {
  if (base === undefined || base.contract?.hash !== head.contract?.hash) {
    return;
  }
  const b = base.assertions.find((item) => item.id === planned.id);
  if (b?.reloadPassed !== undefined) {
    return { passed: b.reloadPassed, actual: b.reloadReading };
  }
  // Jugée à la réentrée sur la base, sans relevé après rechargement.
  if (b?.reloadPersistence !== undefined) {
    return;
  }
  // Rechargement ordinaire sur la base : la valeur relue après lui.
  if (b?.persisted !== undefined) {
    return {
      passed: assertionMatches(planned, b.persisted),
      actual: b.persisted,
    };
  }
  // Cible absente sur la base, avant la lecture ou après le rechargement.
  return base.diagnostic?.code === "TARGET_NOT_FOUND"
    ? { passed: false }
    : undefined;
}

function entryOf(
  head: ScenarioResult,
  planned: Planned,
  h: RecordedAssertion,
  base: Reading | undefined,
  reason: string
): BaselineAssertionDiff {
  return {
    scenarioId: head.scenario.id,
    assertionId: planned.id,
    objective: head.scenario.objective === planned.id,
    ...("expected" in planned && planned.expected !== undefined
      ? { expected: planned.expected }
      : {}),
    head: {
      passed: h.reloadPassed === true,
      ...(h.reloadReading === undefined ? {} : { actual: h.reloadReading }),
    },
    ...(base ? { base } : {}),
    reason,
  };
}

function mark(
  head: ScenarioResult,
  error: QaError,
  outcome: "blocked" | "failed",
  config: Config
) {
  const previous = head.error;
  head.outcome = outcome;
  head.classification = outcome === "failed" ? "failed" : "indeterminate";
  head.diagnostic = diagnose(error, config);
  head.error =
    previous && outcome === "failed"
      ? `${head.diagnostic.message} — head: ${previous}`
      : head.diagnostic.message;
}

/**
 * Juge contre la base chaque assertion de `head` jugée à la réentrée dont la
 * relecture après rechargement n'a pas passé. Vrai quand le verdict du
 * scénario a changé. `base` absente (comparaison indisponible, scénario non
 * rejoué) : aucune preuve, le scénario vert est bloqué.
 */
export function judgeReloadPersistence(
  head: ScenarioResult,
  base: ScenarioResult | undefined,
  comparison: BaselineComparison | undefined,
  config: Config
): boolean {
  for (const h of head.assertions) {
    const planned = head.scenario.assertions.find((item) => item.id === h.id);
    if (
      h.reloadPersistence !== "not-claimed" ||
      h.reloadPassed === true ||
      planned === undefined
    ) {
      continue;
    }
    const b =
      h.reloadPassed === false ? baseReload(planned, head, base) : undefined;
    if (b?.passed === false) {
      continue;
    }
    const sha = short(comparison?.sha ?? "");
    if (b?.passed) {
      comparison?.regressions.push(
        entryOf(
          head,
          planned,
          h,
          b,
          "the value survives a reload on the base and not on the head"
        )
      );
      mark(
        head,
        new QaError(
          "BASELINE_REGRESSION",
          `Assertion ${h.id} survives a reload on the base commit ${sha} and not on the PR head: the PR breaks persistence that works on the base`,
          "Both reloaded values are in the base comparison of the private report and result.json (baselineComparison.regressions), never in this message. Restore the persistence; if dropping it is intended, the plan must not expect the value to be kept."
        ),
        "failed",
        config
      );
      return true;
    }
    if (head.outcome !== "passed") {
      continue;
    }
    comparison?.inconclusive.push(
      entryOf(
        head,
        planned,
        h,
        undefined,
        "judged on re-entry, but the reload reading is missing on the head or on the base"
      )
    );
    mark(
      head,
      new QaError(
        "RELOAD_PERSISTENCE_UNPROVEN",
        `Assertion ${h.id} was judged on re-entry, but the reload readings of the PR head and of the base do not establish that the PR keeps the persistence the base has`,
        "Re-entry may stand only when the base also loses the value after a reload. Make the base preview replay this scenario, or plan a reload the head is expected to survive."
      ),
      "blocked",
      config
    );
    return true;
  }
  return false;
}
