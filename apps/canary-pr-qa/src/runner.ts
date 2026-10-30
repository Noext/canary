import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createLogger } from "@usecanary/logger";
import { z } from "zod";
import {
  Canary,
  discoverPreview,
  type Observation,
  type ProbedView,
  probeAndReplan,
} from "./canary.js";
import { type Config, validateConfiguration } from "./config.js";
import { type Diagnostic, diagnose, QaError } from "./diagnostics.js";
import { executeScenario } from "./executor.js";
import {
  fixtureCatalog,
  NO_DECLARED_PRECONDITIONS,
  preconditionPlanRefusal,
  type TrustedCatalog,
  trustedCatalog,
} from "./fixtures.js";
import { GitHub, type PrContext, truncatedContextWarning } from "./github.js";
import { type ConstrainedCorrection, Model, PLANNER_PROMPT } from "./model.js";
import { runModelConfig } from "./model-catalog.js";
import {
  attributeValueRefusals,
  baselineRefusals,
  changedFileTexts,
  type DiscoveryEvidence,
  enforceObjectiveProof,
  evidenceRefusalsByScenario,
  type InvariantObservation,
  ifPresentRefusals,
  invariantObservations,
  missingExpectationRefusals,
  type PlanEvidenceRefusal,
  type PlanEvidenceReport,
  type PlanFileText,
  planEvidenceDiagnostic,
  planPayload,
  preExecutionRefusalTable,
  provenanceRefusals,
  replannedScenarios,
  replanPayload,
  stateTargetReadRefusals,
  type TargetObservation,
  targetObservations,
  unstableSelectorRefusals,
  validatePlanEvidence,
} from "./plan-evidence.js";
import {
  type AmputationScans,
  absentRequirementRemedy,
  amputationScans,
  contractBudgetRefusals,
  criticalSkipRefused,
  hasWeakWitness,
  type Policy,
  planFindings,
  quoteExcerpt,
  quoteResolutionCandidates,
  type Requirement,
  repairRequirementAttribution,
  requirementSourceRefusal,
  sourceLineMaterial,
  trustedPolicy,
  UNGROUNDED_ABSENT_REMEDY,
  UNGROUNDED_WEAK_REMEDY,
  undeclaredSourcePlanRefusals,
  undeclaredSources,
  ungroundedPlanRefusals,
  ungroundedRequirements,
  unwitnessedPlanRefusals,
  unwitnessedSources,
  validateCoverage,
  validateProvider,
  weakWitnessSuggestion,
  witnessPairKey,
  writeEvidenceRefusals,
} from "./policy.js";
import { resolvePreview, verifyPreviewUrl } from "./preview.js";
import { Progress } from "./progress.js";
import {
  attachReplayRuntimeResults,
  reportMarkdown,
  savePlannerInputs,
  saveReplayBundle,
  saveReport,
} from "./report.js";
import { checkBudget, type RunScope, runScope } from "./run-scope.js";
import {
  type Outcome,
  type Plan,
  type Preview,
  type Publication,
  plannerPlanSchema,
  type RunResult,
  type Scenario,
  type ScenarioResult,
  type SourceLineMaterial,
} from "./schema.js";
import { traced } from "./telemetry.js";

const logger = createLogger({ name: "canary-pr-qa" });
export interface RunOptions {
  expectedSha?: string;
  id?: string;
  model?: string;
  previewUrl?: string;
  prUrl: string;
  publish?: boolean;
}

function completeSource(context: PrContext, path: string, ref: string) {
  return context.context.some(
    (item) =>
      item.path === path &&
      item.ref === ref &&
      !context.contextWarnings.includes(
        truncatedContextWarning(item.path, item.ref)
      )
  );
}
function validateSourceEvidence(
  context: PrContext,
  scenarioId: string,
  path: string
) {
  if (sourceEvidenceAvailable(context, path)) {
    return;
  }
  throw new QaError(
    "CONTEXT_INCOMPLETE",
    `Scenario ${scenarioId} cites ${path} without a textual diff or complete head/base source`,
    CONTEXT_INCOMPLETE_HINT
  );
}
/**
 * Conseil du refus `CONTEXT_INCOMPLETE`, partagé par le refus nommé du contrôle
 * final et par la classe fatale du canal de correction : un scénario qui cite
 * un chemin sans diff textuel ni source complète aux deux révisions ne peut pas
 * prouver le changement testé depuis la source. Le refus est nommé, et non une
 * erreur nue : il remonte au planificateur avec le préambule fatal, et le
 * contrôle final lève le premier — sans masquer les refus de couverture que le
 * canal réparable apprend à corriger.
 */
const CONTEXT_INCOMPLETE_HINT =
  "Check GitHub Contents permissions and context budget. Unsupported/binary changes must be explicitly skipped; never infer a tested change from the page alone.";
function sourceEvidenceAvailable(context: PrContext, path: string): boolean {
  const file = context.files.find((item) => item.filename === path);
  if (file?.patch) {
    return true;
  }
  const headAvailable =
    file?.status === "removed" || completeSource(context, path, context.sha);
  const baseAvailable =
    file?.status === "added" ||
    completeSource(context, file?.previous_filename ?? path, context.baseSha);
  return headAvailable && baseAvailable;
}
/**
 * Cas du refus `CONTEXT_INCOMPLETE` : une classe fatale du canal de correction,
 * comme les classes de couverture. Les scénarios qui citent un chemin sans
 * évidence bloquent le run au contrôle final, donc ils ne peuvent pas attendre
 * après la tentative de correction du planificateur.
 */
function contextFatalClasses(plan: Plan, context: PrContext): FatalClass[] {
  const missing = plan.scenarios.flatMap((scenario) =>
    scenario.sourceFiles
      .filter((path) => !sourceEvidenceAvailable(context, path))
      .map((path) => `${scenario.id}:${path}`)
  );
  return missing.length === 0
    ? []
    : [
        {
          code: "CONTEXT_INCOMPLETE",
          entries: missing,
          hint: CONTEXT_INCOMPLETE_HINT,
          label: "scenarios citing a path without source evidence",
        },
      ];
}
/**
 * Une classe de refus fatal au plan : le code, ce qu'elle constate, les valeurs
 * fautives et le remède. Le canal de correction en agrège une ligne bornée par
 * classe, et le contrôle final lève le message complet.
 */
export interface FatalClass {
  code: string;
  entries: string[];
  /**
   * Citations fautives de la classe, dans l'ordre du plan, chacune appariée au
   * remède qui la concerne. Leur extrait entier passe en tête de la ligne :
   * c'est le détail que le planificateur doit lire pour corriger la bonne
   * exigence, et l'appariement lui interdit d'appliquer à une citation le remède
   * d'une autre. Le préambule les mesure : un segment qui ne tient pas est omis
   * entier et annoncé par son nombre, jamais coupé au milieu.
   */
  faults?: FatalFault[];
  hint: string;
  label: string;
}
/**
 * Une citation fautive et le remède qui la concerne : le préambule fatal ne
 * montre jamais l'un sans l'autre, dans cet ordre.
 */
export interface FatalFault {
  quote: string;
  remedy: string;
}
/**
 * Valeurs fautives d'une ligne agrégée, bornées en nombre et en longueur.
 */
const FATAL_ENTRIES_LISTED = 6;
const FATAL_ENTRY_CHARS = 80;
function boundedEntries(entries: string[]): string {
  const shown = entries
    .slice(0, FATAL_ENTRIES_LISTED)
    .map((entry) =>
      entry.length > FATAL_ENTRY_CHARS
        ? `${entry.slice(0, FATAL_ENTRY_CHARS - 1)}…`
        : entry
    );
  const hidden = entries.length - shown.length;
  return `${shown.join(", ")}${hidden > 0 ? ` (+${hidden} more)` : ""}`;
}
/**
 * Citations fautives montrées en entier sur la tête minimale d'une ligne
 * fatale. L'extrait d'une citation (voir `quoteExcerpt`) est l'information que
 * le planificateur doit lire et n'est jamais raccourci : une seule est montrée,
 * les suivantes sont annoncées par leur nombre — jamais perdues en silence
 * derrière la première.
 */
const FATAL_QUOTES_SHOWN = 1;
function rejectedQuotes(quotes: string[]): string {
  const shown = quotes
    .slice(0, FATAL_QUOTES_SHOWN)
    .map((quote) => JSON.stringify(quoteExcerpt(quote)));
  const hidden = quotes.length - shown.length;
  const plural = quotes.length > 1 ? "s" : "";
  const more = hidden > 0 ? ` (+${hidden} more)` : "";
  return `Rejected quote${plural}: ${shown.join(", ")}${more}`;
}
/** Nombre de citations fautives que le préambule n'a pas montrées. */
function hiddenFaultCounter(hidden: number): string {
  return hidden > 0
    ? ` (+${hidden} more faulty quote${hidden > 1 ? "s" : ""})`
    : "";
}
/**
 * Un segment du préambule : l'extrait de la citation fautive puis le remède qui
 * la concerne. La citation et son remède ne sont jamais séparés, donc aucun
 * remède affiché ne peut être appliqué à une autre citation, et l'ordre du plan
 * est conservé.
 */
function faultSegment(fault: FatalFault): string {
  return `${JSON.stringify(quoteExcerpt(fault.quote))} → ${fault.remedy}`;
}
/**
 * Citations fautives appariées à leur remède, sous la borne `limit`. Un segment
 * qui ne tient pas est omis entier — citation comme remède — et compté ; vide
 * quand même le premier ne tient pas, pour que l'appelant retombe sur la tête
 * minimale de la classe, qui nomme sa première citation et porte son conseil.
 */
function coupledFaults(faults: FatalFault[], limit: number): string {
  const shown: string[] = [];
  let used = 0;
  for (const [index, fault] of faults.entries()) {
    const segment = faultSegment(fault);
    const cost = (shown.length > 0 ? "; ".length : 0) + segment.length;
    const counter = hiddenFaultCounter(faults.length - index - 1).length;
    if (used + cost + counter > limit) {
      break;
    }
    shown.push(segment);
    used += cost;
  }
  return shown.length > 0
    ? `${shown.join("; ")}${hiddenFaultCounter(faults.length - shown.length)}`
    : "";
}
/**
 * Tête minimale d'une ligne fatale : le code, les citations fautives nommées et
 * le conseil de la classe. Aucun remède n'y figure, donc rien ne peut la rogner :
 * c'est cette place que le préambule compte dans son plafond avant de distribuer
 * sa réserve aux remèdes.
 */
function minimalFatalHead(refusal: FatalClass): string {
  return refusal.faults?.length
    ? `${refusal.code}: ${rejectedQuotes(refusal.faults.map((fault) => fault.quote))} ${refusal.hint}`
    : `${refusal.code}: ${refusal.hint}`;
}
/**
 * Tête d'une ligne fatale : le code, les citations fautives, le remède de
 * chacune. `budget` est la place que le préambule laisse au-dessus de la tête
 * minimale ; dès que le premier segment y tient, chaque citation affichée l'est
 * avec son propre remède et le conseil de la classe s'efface : il ne décrit
 * alors plus rien que les segments ne disent mieux. Sinon la tête minimale est
 * rendue telle quelle, et son conseil générique est le repli — même un remède
 * trop long pour la réserve n'est jamais poussé. Le remède suit les citations,
 * jamais les valeurs fautives : il ne doit pas disparaître derrière une entrée
 * rognée.
 */
function fatalHead(refusal: FatalClass, budget = 0): string {
  const minimal = minimalFatalHead(refusal);
  if (!refusal.faults?.length) {
    return minimal;
  }
  const coupled = coupledFaults(
    refusal.faults,
    budget + minimal.length - `${refusal.code}: `.length
  );
  return coupled ? `${refusal.code}: ${coupled}` : minimal;
}
/**
 * Ligne d'une classe fatale : sa tête intouchée, puis les valeurs fautives dans
 * la place qui reste. Le préambule borne la tête de chaque classe, pas sa queue.
 */
function fatalLine(
  refusal: FatalClass,
  head: string,
  valuesLimit: number
): string {
  const values = ` Faulty values: ${boundedEntries(refusal.entries)}`;
  return `${head}${boundedText(values, valuesLimit)}`;
}
function fatalError(refusal: FatalClass): QaError {
  return new QaError(
    refusal.code,
    `${refusal.label}: ${refusal.entries.join(", ")}`,
    refusal.hint
  );
}
/**
 * Plafond du préambule fatal complet, en caractères : la correction est
 * tronquée à 2000 par `model.ts`. Les bornes par classe ne suffisaient pas —
 * des classes saturées (6 entrées × 80 caractères chacune) dépassaient la
 * troncature, et les dernières, dont `PLAN_SCENARIO_ID_RESERVED`,
 * disparaissaient du message : le planificateur perdait sa seule tentative de
 * correction. L'en-tête nomme donc tous les codes fatals avant toute entrée, et
 * la tête de chaque classe — code, citation fautive, remède — passe avant ses
 * valeurs fautives, qui se partagent la place restante. Les têtes minimales
 * (code, citations nommées, conseil de la classe) sont comptées dans ce plafond
 * avant tout remède, et c'est la réserve qui reste au-dessus d'elles qui porte
 * les remèdes appariés ; une classe dont le premier remède ne tient pas dans la
 * réserve garde sa tête minimale et son conseil de repli, donc le préambule ne
 * dépasse jamais ce plafond, quelle que soit la taille des remèdes.
 */
export const FATAL_PRELUDE_CHARS = 1860;
/**
 * En deçà, une queue de valeurs ne dit rien : mieux vaut l'omettre que la
 * réduire à une ellipse.
 */
const FATAL_VALUES_MIN_CHARS = 24;
function boundedText(text: string, limit: number): string {
  if (limit <= 0) {
    return "";
  }
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
function fatalPrelude(classes: FatalClass[]): string[] {
  const [first] = classes;
  if (!first) {
    return [];
  }
  const header = `Fatal refusals (each one blocks the whole run): ${classes
    .map((refusal) => refusal.code)
    .join(", ")}.`;
  // La réserve est mesurée sur les têtes minimales — code, citations nommées,
  // conseil de la classe — que rien ne peut rogner : chaque classe y ajoute les
  // remèdes appariés à ses citations tant que la place le porte, et la réserve
  // se réduit de ce que la classe a consommé en plus de sa tête minimale. Une
  // classe dont le premier remède ne tient pas reste donc sur sa tête minimale,
  // qui porte son conseil de repli. La somme des têtes ne dépasse jamais
  // `FATAL_PRELUDE_CHARS`, quelle que soit la taille des remèdes.
  const minimalHeads = classes.map((refusal) => minimalFatalHead(refusal));
  const baseEssential =
    header.length +
    minimalHeads.reduce((total, head) => total + head.length + 1, 0);
  let budget = Math.max(0, FATAL_PRELUDE_CHARS - baseEssential);
  const heads = classes.map((refusal, index) => {
    const head = fatalHead(refusal, budget);
    const minimal = minimalHeads[index] ?? head;
    budget = Math.max(0, budget - (head.length - minimal.length));
    return head;
  });
  const essential =
    header.length + heads.reduce((total, head) => total + head.length + 1, 0);
  const room = Math.floor((FATAL_PRELUDE_CHARS - essential) / classes.length);
  const valuesLimit = room >= FATAL_VALUES_MIN_CHARS ? room : 0;
  return [
    header,
    ...classes.map((refusal, index) =>
      fatalLine(refusal, heads[index] ?? "", valuesLimit)
    ),
  ];
}
/**
 * Une classe fatale tenue par des refus nommés — contexte incomplet, budget de
 * scénario : le code du premier nomme la classe, son conseil vaut pour toutes
 * ses entrées.
 */
function namedFatalClass(refusals: QaError[], label: string): FatalClass[] {
  const [first] = refusals;
  return first
    ? [
        {
          code: first.code,
          entries: refusals.map((refusal) => refusal.message),
          hint: first.hint,
          label,
        },
      ]
    : [];
}
/**
 * Remède d'un fichier déclaré sans témoin dont la citation existe pourtant
 * exactement : la classe fatale `COVERAGE_WITNESS_MISSING` agrège les deux
 * défauts, et celui-ci ne se répare pas en ajoutant une citation déjà présente.
 */
const WEAK_UNWITNESSED_REMEDY =
  "A requirement already cites a listed file, but its exact quote carries no visible code content to witness that file: quote a substantial fragment, or get its skip approved in .canary/qa.json on the trusted base branch.";
/**
 * Remède d'une classe fatale de témoin : elle agrège les citations absentes et
 * les citations exactes mais trop pauvres, dont les remèdes n'ont rien à voir.
 * `FATAL_PRELUDE_CHARS` ne garde que la tête de cette ligne quand les autres
 * classes saturent, donc elle doit dire la vérité seule — un message qui demande
 * de citer le texte réel à une citation déjà présente fait renvoyer la même
 * citation au planificateur.
 */
function witnessRemedy(
  absent: string,
  weak: string,
  hasWeak: boolean,
  hasAbsent: boolean
): string {
  if (hasWeak && hasAbsent) {
    return `${absent} ${weak}`;
  }
  return hasWeak ? weak : absent;
}
/**
 * Remède d'une citation fautive que la ligne fatale apparie à sa citation : le
 * conseil de son propre défaut quand aucun remède précis n'existe, jamais une
 * chaîne vide — un segment du préambule affiche toujours une citation avec le
 * remède qui la concerne.
 */
function ungroundedRemedy(
  requirement: Requirement,
  context: PrContext,
  scans: AmputationScans
): string {
  if (hasWeakWitness(requirement, context)) {
    // Le préambule fatal survit à la troncature et le détail par exigence non :
    // la ligne réelle qui porte l'identifiant voyage donc avec le remède de la
    // classe, sinon le planificateur ne reçoit, à l'endroit qui survit, qu'un
    // conseil qui ne nomme aucune ligne.
    return `${UNGROUNDED_WEAK_REMEDY}${weakWitnessSuggestion(requirement, context)}`;
  }
  return (
    absentRequirementRemedy(requirement, context, scans).trim() ||
    UNGROUNDED_ABSENT_REMEDY
  );
}
/**
 * Classes fatales de couverture, agrégées en tête du canal de correction.
 * Toutes bloquent le run via `validateCoverage`, donc toutes passent avant les
 * refus par scénario qui suivent la même liste.
 *
 * Le budget d'amputation de la validation est reçu, jamais créé ici : cette
 * moitié du gate et `ungroundedPlanRefusals` qui la suit nomment les mêmes
 * citations fautives, donc lui donner un budget neuf ferait repayer à chacune un
 * balayage du fichier cité. Exportée pour que le test mesure ce plafond sur ce
 * chemin.
 *
 * `resolved` porte les paires (scénario, fichier) que la correction contrainte
 * répare elle-même : la ligne écrite dans le plan témoigne du fichier, donc ce
 * refus de couverture n'est plus un défaut que le plan garde (voir
 * `quotePickCorrection`).
 */
export function coverageFatalClasses(
  candidate: Plan,
  context: PrContext,
  policy: Policy,
  scans: AmputationScans,
  resolved: ReadonlySet<string> = new Set()
): FatalClass[] {
  const classes: FatalClass[] = [];
  const unwitnessed = unwitnessedSources(candidate, context).filter(
    (item) => !resolved.has(witnessPairKey(item.scenarioId, item.file))
  );
  if (unwitnessed.length > 0) {
    classes.push({
      code: "COVERAGE_WITNESS_MISSING",
      entries: unwitnessed.map((item) => `${item.scenarioId}:${item.file}`),
      hint: witnessRemedy(
        "Add a requirement whose quote exists verbatim in each listed file.",
        WEAK_UNWITNESSED_REMEDY,
        unwitnessed.some((item) => item.weak),
        unwitnessed.some((item) => !item.weak)
      ),
      label: "declared sources with no requirement witness",
    });
  }
  const undeclared = undeclaredSources(candidate);
  if (undeclared.length > 0) {
    classes.push({
      code: "COVERAGE_REQUIREMENT_SOURCE_MISSING",
      entries: undeclared.map((item) => `${item.scenarioId}:${item.file}`),
      hint: "Attribute each requirement to a file the scenario declares, or declare the cited file when the PR changes it.",
      label: "requirements attributed to a file the scenario does not declare",
    });
  }
  const ungrounded = ungroundedRequirements(candidate, context);
  if (ungrounded.length > 0) {
    const weak = ungrounded.filter((item) =>
      hasWeakWitness(item.requirement, context)
    );
    const hasWeak = weak.length > 0;
    const hasAbsent = weak.length < ungrounded.length;
    // Une faute par citation fautive, dans l'ordre du plan, chacune appariée au
    // remède qui la concerne : la réattribution quand la citation existe mot
    // pour mot dans un autre fichier du contexte, sinon les lignes réelles du
    // fichier cité, sinon le conseil de son propre défaut — témoin trop pauvre
    // ou citation absente. Une même citation attribuée à deux fichiers garde les
    // deux remèdes, chacun sur son segment ; deux fautes identiques ne sont
    // montrées qu'une fois. Le conseil de la classe reste le repli quand la
    // place ne porte pas les remèdes appariés.
    const faults: FatalFault[] = [];
    const seen = new Set<string>();
    for (const item of ungrounded) {
      const remedy = ungroundedRemedy(item.requirement, context, scans);
      const key = JSON.stringify([item.requirement.quote, remedy]);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      faults.push({ quote: item.requirement.quote, remedy });
    }
    classes.push({
      code: "REQUIREMENT_UNGROUNDED",
      entries: ungrounded.map(
        (item) => `${item.scenarioId}:${item.requirement.sourceFile}`
      ),
      faults,
      hint: witnessRemedy(
        UNGROUNDED_ABSENT_REMEDY,
        UNGROUNDED_WEAK_REMEDY,
        hasWeak,
        hasAbsent
      ),
      label: "requirements whose quote has no source witness",
    });
  }
  // Un skip de chemin critique sans approbation bloque le run : le
  // planificateur doit en disposer comme des autres classes fatales, et non
  // d'un refus qui n'arrive qu'après sa tentative de correction.
  const denied = candidate.skipped
    .filter((skip) => criticalSkipRefused(policy, skip.sourceFile))
    .map((skip) => skip.sourceFile);
  if (denied.length > 0) {
    classes.push({
      code: "CRITICAL_COVERAGE_MISSING",
      entries: denied,
      hint: "Add scenarios, or approve the exact skip with a reason in .canary/qa.json on the trusted base branch. A PR cannot approve its own skip.",
      label: "critical changes skipped without an approved skip",
    });
  }
  return classes;
}
/**
 * Formes de plan qui rendent le plan inexécutable : budget de scénarios,
 * identifiant réservé, fichier cité ou ignoré hors du diff, fichier changé non
 * couvert. Chaque refus nomme ses valeurs fautives : le planificateur les reçoit
 * dans sa tentative de correction, et le contrôle final lève un `QaError` nommé
 * au lieu d'une `Error` nue qui ne dit rien à personne.
 */
export function planShapeRefusals(
  plan: Plan,
  context: PrContext,
  config: Config
): FatalClass[] {
  const refusals: FatalClass[] = [];
  if (plan.scenarios.length > config.QA_MAX_SCENARIOS) {
    refusals.push({
      code: "PLAN_TOO_MANY_SCENARIOS",
      entries: [
        `${plan.scenarios.length} scenarios for a limit of ${config.QA_MAX_SCENARIOS}`,
      ],
      hint: `Return at most ${config.QA_MAX_SCENARIOS} scenarios, and keep every changed file covered.`,
      label: "the plan declares more scenarios than the run allows",
    });
  }
  const reserved = plan.scenarios
    .filter((scenario) => scenario.id === "_discovery")
    .map((scenario) => scenario.id);
  if (reserved.length > 0) {
    refusals.push({
      code: "PLAN_SCENARIO_ID_RESERVED",
      entries: reserved,
      hint: "Rename these scenarios; _discovery is reserved for the discovery navigation.",
      label: "the plan reuses the reserved scenario id",
    });
  }
  const changed = new Set(context.files.map((file) => file.filename));
  const cited = plan.scenarios.flatMap((scenario) =>
    scenario.sourceFiles
      .filter((file) => !changed.has(file))
      .map((file) => `${scenario.id}:${file}`)
  );
  if (cited.length > 0) {
    refusals.push({
      code: "PLAN_SOURCE_OUTSIDE_DIFF",
      entries: cited,
      hint: "Use only filenames from pr.files in sourceFiles; pr.context is evidence, never the list of changed files.",
      label: "scenarios cite files this PR does not change",
    });
  }
  const skipped = plan.skipped
    .filter((item) => !changed.has(item.sourceFile))
    .map((item) => item.sourceFile);
  if (skipped.length > 0) {
    refusals.push({
      code: "PLAN_SKIP_OUTSIDE_DIFF",
      entries: skipped,
      hint: "Use only filenames from pr.files in skipped, and never add an unchanged context file.",
      label: "skipped files this PR does not change",
    });
  }
  const uncovered = [...changed].filter(
    (file) =>
      !(
        plan.scenarios.some((scenario) =>
          scenario.sourceFiles.includes(file)
        ) || plan.skipped.some((item) => item.sourceFile === file)
      )
  );
  if (uncovered.length > 0) {
    refusals.push({
      code: "PLAN_CHANGED_FILE_UNCOVERED",
      entries: uncovered,
      hint: "Cover each listed changed file with a scenario; ignoring one is only allowed where the policy approves the skip.",
      label:
        "changed files neither covered by a scenario nor listed in skipped",
    });
  }
  return refusals;
}
function validatePlan(plan: Plan, context: PrContext, config: Config) {
  const [refusal] = planShapeRefusals(plan, context, config);
  if (refusal) {
    throw fatalError(refusal);
  }
  for (const scenario of plan.scenarios) {
    for (const path of scenario.sourceFiles) {
      validateSourceEvidence(context, scenario.id, path);
    }
  }
}
function aggregate(scenarios: ScenarioResult[]): Outcome {
  if (scenarios.length === 0) {
    return "skipped";
  }
  if (scenarios.some((s) => s.outcome === "failed")) {
    return "failed";
  }
  if (scenarios.some((s) => s.outcome !== "passed")) {
    return "blocked";
  }
  return "passed";
}
/**
 * A scenario refused before execution is reported blocked and skipped, with the
 * existing diagnostic; the remaining scenarios still run.
 */
async function refuseScenario(
  result: RunResult,
  scenario: Scenario,
  diagnostic: Diagnostic,
  progress: Progress,
  root: string,
  config: Config
) {
  result.scenarios.push({
    scenario,
    outcome: "blocked",
    steps: [],
    assertions: [],
    artifacts: [],
    diagnostic,
    error: diagnostic.message,
  });
  await progress.record({
    phase: "planning",
    scenarioId: scenario.id,
    outcome: "blocked",
    diagnostic,
  });
  await saveReport(root, result, config);
}
/**
 * Diagnostic d'un refus prononcé avant toute exécution : cible absente de la page
 * de découverte, sélecteur construit sur une classe ou une couleur, ou
 * interaction sans preuve du changement. `undefined` quand le scénario peut
 * s'exécuter. Un scénario refusé n'est jamais exécuté — aperçu de tête comme
 * préversion de base — et son refus est journalisé une seule fois, ici.
 */
function refusalDiagnostic(
  result: RunResult,
  scenario: Scenario,
  refusals: Map<string, PlanEvidenceRefusal[]>,
  inconclusive: PlanEvidenceReport["inconclusive"],
  preExecutionRefusals: Map<string, QaError>,
  config: Config
): Diagnostic | undefined {
  const scenarioRefusals = refusals.get(scenario.id);
  if (scenarioRefusals) {
    const { message, hint } = planEvidenceDiagnostic(
      scenario,
      scenarioRefusals,
      inconclusive.filter((item) => item.scenarioId === scenario.id).length
    );
    logger.warn(
      {
        runId: result.id,
        scenario: scenario.id,
        targets: scenarioRefusals.map((item) => item.target),
      },
      "Scénario refusé avant exécution : cible absente de la page de découverte"
    );
    return diagnose(new QaError("PLAN_TARGET_MISSING", message, hint), config);
  }
  const refusal = preExecutionRefusals.get(scenario.id);
  if (!refusal) {
    return;
  }
  const diagnostic = diagnose(refusal, config);
  logger.warn(
    { runId: result.id, scenario: scenario.id, diagnostic },
    "Scénario refusé avant exécution"
  );
  return diagnostic;
}
/**
 * Une assertion d'absence ne lit pas un élément : elle en constate l'absence,
 * donc une cible qui ne résout rien y est normale. Les autres sont comptées sur
 * la page de découverte avant toute exécution.
 */
/**
 * Les refus rendus au planificateur pour un plan candidat. Les classes fatales
 * — celles qui bloquent tout le run — passent en tête, agrégées dans un
 * préambule borné : la correction est tronquée à 2000 caractères par `model.ts`,
 * et aucune classe fatale ne doit disparaître parce qu'une autre a rempli le
 * message. Le détail par entrée et les refus par scénario suivent, ceux-là
 * bloquant leur scénario seul.
 */
export function planRefusals(
  candidate: Plan,
  policy: Policy,
  context: PrContext,
  config: Config,
  catalog: TrustedCatalog,
  scans: AmputationScans = amputationScans(),
  evidence?: DiscoveryEvidence
): string[] {
  const parts = planRefusalParts(
    candidate,
    policy,
    context,
    config,
    catalog,
    scans,
    evidence
  );
  return [
    ...parts.reserved,
    ...fatalPrelude(parts.fatal),
    ...parts.before,
    ...parts.ungrounded,
    ...parts.after,
  ];
}
/**
 * Les refus d'un plan candidat, séparés par ce que la correction contrainte a le
 * droit de traiter : les refus de précondition qui passent en tête, les classes
 * fatales, les refus qui précèdent la citation dans le message d'aujourd'hui,
 * les refus de citation eux-mêmes, puis les refus de lecture. `planRefusals` les
 * recompose dans cet ordre, donc le message rendu au planificateur est inchangé ;
 * `quotePickCorrection` lit la même décomposition pour savoir si la citation est
 * le SEUL défaut du plan — la condition de la correction par indice.
 */
function planRefusalParts(
  candidate: Plan,
  policy: Policy,
  context: PrContext,
  config: Config,
  catalog: TrustedCatalog,
  scans: AmputationScans,
  evidence?: DiscoveryEvidence,
  resolved: ReadonlySet<string> = new Set()
): {
  /**
   * Refus rendus en tête de la correction, avant tout diagnostic qui peut
   * saturer la fenêtre de 2 000 : une précondition hors catalogue y reste
   * lisible même quand le préambule fatal et les citations non fondées pèsent
   * déjà leur maximum.
   */
  reserved: string[];
  fatal: FatalClass[];
  before: string[];
  ungrounded: string[];
  after: string[];
} {
  const shape = planShapeRefusals(candidate, context, config);
  // Une précondition hors catalogue bloque CHAQUE scénario qui la porte, sans
  // qu'aucune étape navigateur ne soit dépensée : rendue ici, elle laisse au
  // planificateur sa tentative de correction, et un plan non corrigé est arrêté
  // par `preconditionRefusals` avant la première étape.
  const precondition = preconditionPlanRefusal(
    candidate,
    catalog,
    context.ref.repo
  );
  return {
    // Une précondition hors catalogue bloque CHAQUE scénario qui la porte, sans
    // qu'aucune étape navigateur ne soit dépensée : rendue ici, elle laisse au
    // planificateur sa tentative de correction, et un plan non corrigé est
    // arrêté par `preconditionRefusals` avant la première étape. Elle passe
    // avant le préambule fatal : placée après lui, elle disparaîtrait de la
    // fenêtre de 2 000 dès que les classes fatales saturent leurs 1 860
    // caractères, c'est-à-dire dans le plan qui a le plus besoin de la lire.
    reserved: precondition ? [precondition] : [],
    fatal: [
      ...coverageFatalClasses(candidate, context, policy, scans, resolved),
      ...contextFatalClasses(candidate, context),
      ...namedFatalClass(
        contractBudgetRefusals(candidate, config),
        "scenarios that cannot complete within QA_MAX_STEPS"
      ),
      ...shape,
    ],
    before: [
      ...unwitnessedPlanRefusals(candidate, context, policy, resolved),
      ...undeclaredSourcePlanRefusals(candidate, context),
      ...shape.map(
        (refusal) => `${fatalError(refusal).message}. ${refusal.hint}`
      ),
    ],
    ungrounded: ungroundedPlanRefusals(candidate, context, policy, scans),
    after: [
      ...writeEvidenceRefusals(candidate, policy).map(
        (item) => `${item.error.message}. ${item.error.hint}`
      ),
      ...unstableSelectorRefusals(candidate).map(
        (item) => `${item.error.message}. ${item.error.hint}`
      ),
      ...attributeValueRefusals(candidate).map(
        (item) => `${item.error.message}. ${item.error.hint}`
      ),
      ...stateTargetReadRefusals(candidate, evidence).map(
        (item) => `${item.error.message}. ${item.error.hint}`
      ),
      // Un plan passé par `PlanSchema` ne peut plus porter ces formes : ce refus
      // est donc surtout celui du chemin de lecture. Il est rendu ici aussi pour
      // qu'un plan rejoué ou bâti à la main reçoive le même message nommé que le
      // planificateur, jamais un diagnostic d'exécution plus tardif.
      ...missingExpectationRefusals(candidate).map(
        (item) => `${item.error.message}. ${item.error.hint}`
      ),
      // Même raison que ci-dessus : `PlanSchema` refuse déjà un `click(ifPresent)`
      // hors du préfixe d'établissement ou sans assertion rattachée, et le rejeu
      // donne au plan lu le même message nommé.
      ...ifPresentRefusals(candidate).map(
        (item) => `${item.error.message}. ${item.error.hint}`
      ),
      // Prévention : le défaut d'ordre de marqueur est dicible au planificateur
      // pendant qu'il écrit le plan, au lieu de coûter le scénario à l'exécution.
      // Le refus de lecture reste posé plus loin, pour un plan qui n'aurait pas
      // été corrigé malgré le message.
    ],
  };
}
/**
 * Réponse attendue d'une correction contrainte : un indice de candidat par
 * citation fautive, désigné par le couple (scénario, rang de l'exigence). Aucun
 * texte, donc aucune recopie — c'est ce qui rend la correction incapable de
 * reproduire l'altération qu'elle corrige.
 */
const QUOTE_PICK_ANSWER = z.object({
  picks: z
    .array(
      z.object({
        scenario: z.string().min(1),
        requirement: z.number().int().positive(),
        candidate: z.number().int().positive(),
      })
    )
    .min(1),
});
/**
 * Budget du message contraint, en caractères. `model.ts` tronque une correction
 * à 2000 : ce budget reste sous cette borne pour qu'aucun candidat annoncé ne
 * soit coupé, et une liste qui n'y tient pas abandonne la correction contrainte
 * au lieu de poser une question incomplète.
 */
const QUOTE_PICK_MESSAGE_CHARS = 1900;
const QUOTE_PICK_HEADER =
  'The plan has no other defect, so do not return the plan. Answer ONLY this JSON: {"picks":[{"scenario":"<scenario id>","requirement":<rank>,"candidate":<index>}]}, with exactly one pick for each requirement listed below. Each candidate is an exact portion of the cited file: the gate writes its text as that requirement\'s quote, so pick the fragment that proves the behavior you described. A quote must never be retyped.';
interface QuoteOffer {
  candidates: { line: number; text: string }[];
  rank: number;
  requirement: Requirement;
  scenarioId: string;
}
function quoteOfferHeader(offer: QuoteOffer): string {
  return `\n- ${offer.scenarioId}: ${offer.requirement.sourceFile} requirement ${offer.rank}`;
}
/**
 * Le message contraint : les citations fautives, leurs candidats réels et
 * l'indice de chacun. Construit sous `QUOTE_PICK_MESSAGE_CHARS` ; une citation
 * qui n'obtient aucun candidat dans le budget rend une chaîne vide, que
 * l'appelant traduit en refus d'aujourd'hui — jamais une question partielle à
 * laquelle le planificateur ne pourrait pas répondre.
 */
function quotePickMessage(offers: QuoteOffer[]): string {
  const headers = offers.map(quoteOfferHeader);
  let budget =
    QUOTE_PICK_MESSAGE_CHARS -
    QUOTE_PICK_HEADER.length -
    headers.join("").length;
  if (budget <= 0) {
    return "";
  }
  const blocks: string[] = [];
  for (const [index, offer] of offers.entries()) {
    // La place restante garde la tête des citations qui suivent : aucune ne
    // doit arriver sans un seul candidat.
    const available = budget - headers.slice(index + 1).join("").length;
    if (available <= 0) {
      return "";
    }
    const shown: string[] = [];
    let used = 0;
    for (const candidate of offer.candidates) {
      const line = `\n  ${shown.length + 1}: ${JSON.stringify(candidate.text)}`;
      if (used + line.length > available) {
        break;
      }
      used += line.length;
      shown.push(line);
    }
    if (shown.length === 0) {
      return "";
    }
    budget -= used;
    blocks.push((headers[index] as string) + shown.join(""));
  }
  return QUOTE_PICK_HEADER + blocks.join("");
}
/**
 * Longueur du préfixe sha256 qui identifie une citation résolue dans le
 * journal. Assez long pour recouper la même citation entre deux runs, jamais
 * assez pour en retrouver le texte.
 */
const QUOTE_FINGERPRINT_CHARS = 16;
/**
 * Métadonnées journalisables d'une citation résolue. La citation elle-même
 * n'est JAMAIS journalisée : elle est recopiée du dépôt testé, donc elle peut
 * porter un secret que ce dépôt y a laissé et que `redact` ne connaît pas —
 * seules sa taille, son nombre de lignes et son empreinte vont au journal.
 */
function quoteLogFields(text: string) {
  return {
    quoteChars: text.length,
    quoteFingerprint: createHash("sha256")
      .update(text)
      .digest("hex")
      .slice(0, QUOTE_FINGERPRINT_CHARS),
    quoteLines: text.split("\n").length,
  };
}
/**
 * Écrit les citations choisies dans une copie du plan refusé : la valeur rendue
 * porte des textes réels du fichier cité, jamais un indice, et le plan d'origine
 * n'est pas modifié — une correction qui ne converge pas laisse donc au
 * appelant le plan exact qu'il avait refusé, et donc son message.
 */
function applyQuotePicks(
  candidate: Plan,
  offers: QuoteOffer[],
  answer: z.infer<typeof QUOTE_PICK_ANSWER>,
  runId?: string
): Plan | undefined {
  const resolved = structuredClone(candidate);
  for (const offer of offers) {
    const pick = answer.picks.find(
      (item) =>
        item.scenario === offer.scenarioId && item.requirement === offer.rank
    );
    const chosen = pick ? offer.candidates[pick.candidate - 1] : undefined;
    const target = resolved.scenarios.find(
      (scenario) => scenario.id === offer.scenarioId
    )?.requirements[offer.rank - 1];
    if (!(pick && chosen && target)) {
      return;
    }
    target.quote = chosen.text;
    logger.info(
      {
        line: chosen.line,
        ...quoteLogFields(chosen.text),
        requirement: offer.rank,
        runId,
        scenario: offer.scenarioId,
        sourceFile: offer.requirement.sourceFile,
      },
      "Requirement quote resolved by pick"
    );
  }
  return resolved;
}
/**
 * Paires (scénario, fichier) qu'une citation faible couvre dès que sa
 * substitution est écrite dans le plan : le refus de couverture dérivé de la
 * même citation tombe avec elle quand l'indice choisi nomme la ligne réelle
 * (voir `quotePickCorrection`). Une citation absente n'y entre pas : sa ligne
 * réelle n'est pas son seul remède, et la substitution n'a pas à choisir.
 */
function weakWitnessPairs(
  faults: { requirement: Requirement; scenarioId: string }[],
  context: PrContext
): Set<string> {
  return new Set(
    faults
      .filter((fault) => hasWeakWitness(fault.requirement, context))
      .map((fault) =>
        witnessPairKey(fault.scenarioId, fault.requirement.sourceFile)
      )
  );
}
/**
 * Correction contrainte d'une citation refusée. Le défaut mesuré du run
 * 9add286d n'est pas un faux refus : la copie reproduit 56 caractères de la
 * ligne 368, puis insère `:""` avant l'accolade qui ferme l'interpolation et
 * s'arrête là. Le run a payé son appel de correction (`usage.calls` 2,
 * `retries` 0) et s'achève sur cette copie altérée, alors que la ligne exacte
 * était dans le matériel et que le refus la nommait. La boucle ne converge donc
 * pas en demandant au modèle de RECOPIER ; elle converge si le gate écrit le
 * texte lui-même et ne demande plus qu'un indice.
 *
 * La correction contrainte n'est posée que si elle est sûre : la citation est
 * le SEUL défaut du plan (aucune classe fatale d'une autre famille, aucun refus
 * de scénario ni de lecture), chaque citation fautive a au moins un candidat
 * réel et vérifié comme témoin, et la liste tient dans le message. Sinon
 * `undefined` : l'appelant rend le refus d'aujourd'hui, mot pour mot.
 *
 * Le refus de couverture dérivé de la même citation ne fait pas exception :
 * quand le scénario n'a que cette exigence pour son fichier déclaré, écrire un
 * candidat dans le plan témoigne du fichier, donc les deux refus tombent
 * ensemble (run 58e47755). Ce qui reste un défaut — un autre fichier déclaré
 * sans témoin, une citation hors du fichier — garde son refus et écarte la
 * correction.
 */
export function quotePickCorrection(
  candidate: Plan,
  policy: Policy,
  context: PrContext,
  config: Config,
  runId?: string,
  scans: AmputationScans = amputationScans(),
  // Défaut vide : un appelant sans catalogue ne peut attester aucune
  // précondition, donc la correction par indice s'écarte au lieu de réparer les
  // citations d'un plan dont les préconditions resteraient inexécutables.
  catalog: TrustedCatalog = NO_DECLARED_PRECONDITIONS
): ConstrainedCorrection<Plan> | undefined {
  const faults = ungroundedRequirements(candidate, context);
  // Chaque candidat offert est vérifié comme témoin de son fichier (voir
  // `quoteResolutionCandidates`) : la paire (scénario, fichier) d'une citation
  // FAIBLE est donc couverte dès que son indice est écrit dans le plan, et le
  // refus de couverture dérivé de la même citation tombe avec elle. Une citation
  // absente garde son remède détaillé et son refus : sa ligne réelle n'est pas
  // le seul remède, et la correction n'y a pas à choisir à sa place.
  const parts = planRefusalParts(
    candidate,
    policy,
    context,
    config,
    catalog,
    scans,
    undefined,
    weakWitnessPairs(faults, context)
  );
  const offers: QuoteOffer[] = faults.map((fault) => ({
    candidates: quoteResolutionCandidates(fault.requirement, context, scans),
    rank: fault.rank,
    requirement: fault.requirement,
    scenarioId: fault.scenarioId,
  }));
  /**
   * Pourquoi la correction par indice s'écarte : mesuré, pas supposé. Les runs
   * 8d80b3d4 et a2bf907f ont payé leur appel de correction et sont revenus avec
   * la même citation, alors que les refus nommaient la ligne ; sans ce relevé,
   * la seule façon de savoir laquelle des gardes a écarté l'indice était de
   * relire le code en espérant tomber juste.
   */
  const skip = (
    reason: string,
    extra: Record<string, unknown> = {}
  ): undefined => {
    logger.info(
      {
        after: parts.after.length,
        before: parts.before.length,
        candidates: offers.map((offer) => offer.candidates.length),
        fatal: parts.fatal.map((item) => item.code),
        offers: offers.length,
        reason,
        reserved: parts.reserved.length,
        runId,
        ...extra,
      },
      "Quote pick correction skipped"
    );
    return;
  };
  if (parts.reserved.length > 0) {
    return skip("reserved");
  }
  if (parts.before.length > 0) {
    return skip("before");
  }
  /**
   * `after` ne porte pas le défaut de citation, mais il n'est pas réparable par
   * un indice non plus. La seule partie qu'une citation répare est celle qui
   * DÉRIVE d'elle — la couverture du fichier déclaré, que la paire résolue fait
   * tomber. On rejoue donc les refus avec TOUTES les paires offertes résolues :
   * si `after` se vide, tout ce qu'il portait venait des citations et l'indice
   * suffit ; s'il reste quelque chose — un sélecteur instable, une attente
   * d'attribut invalide, une preuve d'écriture manquante —, le plan a un autre
   * défaut qu'un choix de ligne ne corrige pas, et la réécriture complète garde
   * sa place (revue du 23 oct. 2026).
   */
  const allOffered = new Set(
    offers.map((offer) =>
      witnessPairKey(offer.scenarioId, offer.requirement.sourceFile)
    )
  );
  const resolvedParts = planRefusalParts(
    candidate,
    policy,
    context,
    config,
    catalog,
    scans,
    undefined,
    allOffered
  );
  if (resolvedParts.after.length > 0) {
    return skip("after", { afterResolved: resolvedParts.after.length });
  }
  if (
    parts.fatal.length === 0 ||
    parts.fatal.some((item) => item.code !== "REQUIREMENT_UNGROUNDED")
  ) {
    return skip("fatal");
  }
  if (
    offers.length === 0 ||
    offers.some((offer) => offer.candidates.length === 0)
  ) {
    return skip("candidates");
  }
  const message = quotePickMessage(offers);
  if (message === "") {
    return;
  }
  return {
    answer: QUOTE_PICK_ANSWER,
    message,
    resolve: (answer) => {
      const parsed = QUOTE_PICK_ANSWER.safeParse(answer);
      return parsed.success
        ? applyQuotePicks(candidate, offers, parsed.data, runId)
        : undefined;
    },
  };
}
/**
 * Après la planification : une citation réelle attribuée au mauvais fichier est
 * réparée — la preuve ne change pas, seule la mention du fichier était fausse —
 * le contrat est validé, et un plan qui lit une cible absente de la page de
 * découverte est refusé avant d'exécuter quoi que ce soit. Le refus d'attribution
 * nommé passe avant les refus de forme : un fichier hors diff ne doit jamais
 * masquer le refus que le planificateur est en train d'apprendre à corriger.
 */

/** La seconde écriture : même payload, plus les vues réellement observées. */
/**
 * Publie les préconditions qu'aucune preuve ne tranche.
 *
 * La porte ne les refuse pas — un état déjà établi par l'application rendrait ce
 * refus faux — et ne les passe pas sous silence : sans cette publication, un run
 * dont les assertions reposent sur un état supposé (montant attendu hérité,
 * session déjà ouverte) se lit comme entièrement vérifié.
 */
function publishUnverifiedPreconditions(
  result: RunResult,
  context: PrContext
): void {
  if (!result.plan) {
    return;
  }
  const { unverified } = planFindings(result.plan, sourceLineMaterial(context));
  if (unverified.length === 0) {
    return;
  }
  result.unverifiedPreconditions = unverified;
  logger.info(
    { runId: result.id, unverified: unverified.length },
    "Preconditions the gate could not verify"
  );
}

function planWithObservedViews(input: {
  catalog: TrustedCatalog;
  config: Config;
  context: PrContext;
  evidence: string;
  files: PlanFileText[];
  initialPage: Observation;
  model: Model;
  policy: Policy;
  preview: Preview;
  views: ProbedView[];
}): Promise<Plan | undefined> {
  return input.model.json(
    PLANNER_PROMPT,
    planPayload(
      input.context,
      input.preview,
      input.initialPage,
      input.catalog,
      input.config,
      input.files,
      input.views
    ),
    plannerPlanSchema(sourceLineMaterial(input.context)),
    input.config.QA_PLAN_MAX_TOKENS,
    (candidate) => {
      const refusals = planRefusals(
        candidate,
        input.policy,
        input.context,
        input.config,
        input.catalog,
        amputationScans(),
        { aria: input.evidence, url: input.initialPage.url }
      );
      return refusals.length === 0
        ? undefined
        : `Plan rejected: ${refusals.join(" ")} Return the complete corrected plan.`;
    }
  );
}

function settlePlan(
  plan: Plan,
  context: PrContext,
  config: Config,
  runId: string
) {
  for (const repair of repairRequirementAttribution(plan, context)) {
    logger.info(
      {
        from: repair.from,
        runId,
        scenario: repair.scenarioId,
        to: repair.to,
      },
      "Requirement attribution repaired"
    );
  }
  const source = requirementSourceRefusal(plan, context);
  if (source) {
    throw source;
  }
  validatePlan(plan, context, config);
}

/**
 * Réécrit une fois le plan quand l'exécution a mesuré qu'une vérification ne
 * pouvait rien prouver, puis réexécute les scénarios concernés.
 *
 * Ce n'est pas une requalification : le plan révisé passe le même schéma, les
 * mêmes refus et la même couverture, et son résultat vient d'une exécution
 * réelle. Ce qui change est la demande — `transition` là où la valeur ne bouge
 * pas devenait une preuve impossible — et c'est le planificateur qui la change.
 */
interface ReplanInput {
  canary: Canary;
  catalog: TrustedCatalog;
  config: Config;
  context: PrContext;
  evidence: string;
  files: PlanFileText[];
  initialPage: Observation;
  material: SourceLineMaterial[];
  model: Model;
  policy: Policy;
  preview: Preview;
  progress: Progress;
  result: RunResult;
  root: string;
}

/**
 * Rend les scénarios du plan réécrit que la table avant exécution refuse, ou
 * `undefined` quand aucune réécriture n'a été adoptée (le plan exécuté reste
 * celui dont les refus sont déjà connus).
 */
async function replanObservedInvariants(
  input: ReplanInput
): Promise<ReadonlySet<string> | undefined> {
  if (!(input.config.QA_REPLAN_ON_INVARIANT && input.result.plan)) {
    return;
  }
  const observations = invariantObservations(input.result.scenarios);
  const targets = targetObservations(input.result.scenarios);
  if (observations.length === 0 && targets.length === 0) {
    return;
  }
  // La réécriture est un supplément, jamais une condition de survie : si
  // l'enveloppe de tokens ne la couvre pas, on garde le verdict d'origine au
  // lieu de perdre le run entier (mesuré au lot FF : deux runs bloqués en
  // RUN_BUDGET_EXCEEDED pour une passe de confort).
  try {
    return await replanWithObservations(
      input,
      input.result.plan,
      observations,
      targets
    );
  } catch (error) {
    logger.warn(
      { runId: input.result.id, error: String(error) },
      "Replan skipped, keeping the executed verdicts"
    );
  }
}

async function replanWithObservations(
  input: ReplanInput,
  plan: Plan,
  observations: InvariantObservation[],
  targets: TargetObservation[]
): Promise<ReadonlySet<string> | undefined> {
  checkBudget();
  const revised = await input.model.json(
    PLANNER_PROMPT,
    {
      ...planPayload(
        input.context,
        input.preview,
        input.initialPage,
        input.catalog,
        input.config,
        input.files
      ),
      ...replanPayload({ observations, plan, targets }),
    },
    plannerPlanSchema(input.material),
    input.config.QA_PLAN_MAX_TOKENS,
    (candidate) => {
      const refusals = planRefusals(
        candidate,
        input.policy,
        input.context,
        input.config,
        input.catalog,
        amputationScans(),
        { aria: input.evidence, url: input.initialPage.url }
      );
      return refusals.length === 0
        ? undefined
        : `Plan rejected: ${refusals.join(" ")} Return the complete corrected plan.`;
    }
  );
  settlePlan(revised, input.context, input.config, input.result.id);
  // Le plan révisé passe le même contrôle de provenance que le plan initial :
  // une réécriture ne peut pas introduire une assertion sans preuve, ni un
  // objectif introuvable, et être adoptée malgré tout.
  const revisionRefusals = provenanceRefusals(revised);
  if (revisionRefusals.length > 0) {
    logger.info(
      {
        runId: input.result.id,
        refusals: revisionRefusals.map((item) => item.error.message),
      },
      "Rewritten plan refused: keeping the executed plan"
    );
    return;
  }
  input.result.plan = revised;
  // Le plan révisé repasse la MÊME table avant exécution que le premier plan :
  // quand les corrections sont épuisées, le modèle rend le candidat encore
  // refusé, et ce candidat ne doit dépenser aucune étape navigateur. Le
  // scénario concerné garde son verdict d'origine (exécuté ou refusé) : la
  // réécriture n'a rien corrigé, elle ne requalifie rien.
  const discovery = { url: input.initialPage.url, aria: input.evidence };
  const revisedEvidence = validatePlanEvidence(revised, discovery);
  const evidenceRefusals = evidenceRefusalsByScenario(revisedEvidence);
  const revisedRefusals = preExecutionRefusalTable(revised, {
    catalog: input.catalog,
    config: input.config,
    context: input.context,
    evidence: discovery,
    policy: input.policy,
  });
  const stillRefused = new Set([
    ...evidenceRefusals.keys(),
    ...revisedRefusals.keys(),
  ]);
  const replanned = replannedScenarios(revised, [
    ...observations,
    ...targets,
  ]).filter((scenario) => {
    const refusal = refusalDiagnostic(
      input.result,
      scenario,
      evidenceRefusals,
      revisedEvidence.inconclusive,
      revisedRefusals,
      input.config
    );
    if (refusal) {
      logger.info(
        { runId: input.result.id, scenario: scenario.id, code: refusal.code },
        "Rewritten scenario still refused: keeping its verdict, not executing it"
      );
    }
    return refusal === undefined;
  });
  input.result.replannedScenarioIds = replanned.map((scenario) => scenario.id);
  for (const scenario of replanned) {
    logger.info(
      { runId: input.result.id, scenario: scenario.id },
      "Re-executing a scenario whose verification was rewritten"
    );
    checkBudget();
    const executed = await executeScenario(
      scenario,
      input.preview.url,
      input.root,
      input.config,
      input.canary,
      (event) => input.progress.record(event),
      input.context.ref.repo,
      input.material,
      input.model
    );
    // Un scénario réexécuté passe la preuve d'objectif comme les autres : la
    // réécriture ne doit pas être un chemin par lequel un vert sans preuve
    // rentre dans le rapport.
    const proven = enforceObjectiveProof(executed, input.config);
    const index = input.result.scenarios.findIndex(
      (item) => item.scenario.id === scenario.id
    );
    if (index >= 0) {
      input.result.scenarios[index] = proven;
    } else {
      input.result.scenarios.push(proven);
    }
  }
  input.result.outcome = aggregate(input.result.scenarios);
  await saveReport(input.root, input.result, input.config);
  return stillRefused;
}

async function executePlan(
  result: RunResult,
  context: PrContext,
  preview: Preview,
  root: string,
  config: Config,
  canary: Canary,
  model: Model,
  progress: Progress,
  github: GitHub
) {
  await progress.record({ phase: "discovery" });
  const { evidence, initialPage } = await discoverPreview(
    context,
    preview,
    root,
    canary
  );
  const catalog = await fixtureCatalog(config, context.ref.repo).then(
    trustedCatalog
  );
  const planFiles = await changedFileTexts(
    context.files,
    (path) => github.optionalFile(context.ref.repo, path, context.sha),
    config.QA_PLAN_FILE_CHARS
  );
  const payload = planPayload(
    context,
    preview,
    initialPage,
    catalog,
    config,
    planFiles
  );
  const policy = await trustedPolicy(github, context);
  validateProvider(policy, config);
  const discovery = { url: initialPage.url, aria: evidence };
  await savePlannerInputs({
    catalog,
    config,
    context,
    evidence: discovery,
    payload,
    policy,
    root,
  });
  await progress.record({ phase: "planning" });
  result.plan = await model.json(
    PLANNER_PROMPT,
    payload,
    // La résolution lit le matériel numéroté de TOUT le diff : une référence
    // `line` est résolue contre les hunks du patch — ceux que le message porte
    // dans `pr.files` — et non contre la seule part que `sourceLines` affiche.
    // Les deux vues sortent des mêmes hunks et de la même base de numérotation
    // (voir `sourceLineMaterial`), donc une ligne coupée par le budget reste
    // désignable et aucun numéro ne désigne deux lignes différentes.
    plannerPlanSchema(sourceLineMaterial(context)),
    config.QA_PLAN_MAX_TOKENS,
    (candidate) => {
      // Le planificateur reçoit les refus et dispose d'une tentative de
      // correction, au lieu de faire échouer le run sur une citation recopiée
      // de mémoire ou attribuée au mauvais fichier.
      const scans = amputationScans();
      const messages = planRefusals(
        candidate,
        policy,
        context,
        config,
        catalog,
        scans,
        discovery
      );
      if (messages.length === 0) {
        return;
      }
      // Quand la citation est le seul défaut du plan, la correction contrainte
      // remplace la réécriture complète : le modèle choisit un indice, le gate
      // écrit le texte. Sans candidat sûr, le refus d'aujourd'hui, mot pour mot.
      return (
        quotePickCorrection(
          candidate,
          policy,
          context,
          config,
          result.id,
          scans,
          catalog
        ) ??
        `Plan rejected: ${messages.join(" ")} Return the complete corrected plan.`
      );
    }
  );
  // Preserve the raw planner output separately from the settled production plan.
  const generatedPlan = structuredClone(result.plan);
  // Une citation réelle attribuée au mauvais fichier se répare : la preuve ne
  // change pas, seule la mention du fichier était fausse.
  settlePlan(result.plan, context, config, result.id);
  if (config.QA_REPLAY_BUNDLE) {
    await saveReplayBundle({
      root,
      config,
      context,
      policy,
      catalog,
      payload,
      generatedPlan,
      plan: result.plan,
      evidence: discovery,
    });
  }
  publishUnverifiedPreconditions(result, context);
  const refined = config.QA_VIEW_PROBE
    ? await probeAndReplan({
        askPlanner: (views) =>
          planWithObservedViews({
            catalog,
            config,
            context,
            evidence,
            files: planFiles,
            initialPage,
            model,
            policy,
            preview,
            views,
          }),
        canary,
        label: `PR ${context.ref.number} probe`,
        plan: result.plan,
        preview,
        root,
        settle: (plan) => settlePlan(plan, context, config, result.id),
      })
    : undefined;
  if (refined) {
    result.plan = refined;
  }
  const planEvidence = validatePlanEvidence(result.plan, {
    url: initialPage.url,
    aria: evidence,
  });
  const refusals = evidenceRefusalsByScenario(planEvidence);
  // Les cibles non tranchées restent visibles : le contrôle ne prétend jamais
  // avoir vérifié ce que l'instantané de découverte ne couvre pas.
  const gaps = planEvidence.incomplete
    ? [planEvidence.incomplete]
    : [...new Set(planEvidence.inconclusive.map((item) => item.reason))];
  if (gaps.length > 0) {
    const diagnostic = {
      code: "PLAN_EVIDENCE_INCOMPLETE",
      message: "Contrôle d'évidence du plan non concluant",
      hint: `${gaps.join(" ; ")}. Vérifié : cibles role+nom nécessaires sur la page de découverte ; non couverts : types css/text/label/placeholder/testId et nœuds au-delà de 12 niveaux.`,
    };
    logger.warn(
      { runId: result.id, gaps, targets: planEvidence.inconclusive.length },
      "Contrôle d'évidence du plan non concluant"
    );
    await progress.record({ phase: "planning", diagnostic });
  }
  // Le matériel du diff sert UNE fois : au filtre des noms observés qu'un
  // message d'exécution a le droit de publier. Il ne refuse plus rien — un nom
  // absent du diff n'est pas un nom inventé, la PR 20 de
  // `pharmania/arpilabe-pilotage` l'a mesuré (voir `plan-evidence.ts`).
  const material = sourceLineMaterial(context);
  result.coverage = validateCoverage(result.plan, context, policy, config);
  // Refus rendus au planificateur pendant la planification, rejoués ici : un
  // plan que le modèle n'a pas corrigé est bloqué, jamais exécuté. Cette table
  // est le point de contrôle UNIQUE du chemin de lecture : l'aperçu de tête et
  // la préversion de base la lisent tous les deux, donc une assertion sans
  // valeur attendue ne dépense aucune étape navigateur, dans l'un comme dans
  // l'autre.
  const preExecutionRefusals = preExecutionRefusalTable(result.plan, {
    catalog,
    config,
    context,
    evidence: { url: initialPage.url, aria: evidence },
    policy,
  });
  await saveReport(root, result, config);
  for (const scenario of result.plan.scenarios) {
    const refusal = refusalDiagnostic(
      result,
      scenario,
      refusals,
      planEvidence.inconclusive,
      preExecutionRefusals,
      config
    );
    if (refusal) {
      await refuseScenario(result, scenario, refusal, progress, root, config);
      continue;
    }
    logger.info(
      { runId: result.id, scenario: scenario.id },
      "Executing scenario"
    );
    checkBudget();
    result.scenarios.push(
      enforceObjectiveProof(
        await executeScenario(
          scenario,
          preview.url,
          root,
          config,
          canary,
          (event) => progress.record(event),
          context.ref.repo,
          material,
          model
        ),
        config
      )
    );
    await saveReport(root, result, config);
  }
  result.outcome = aggregate(result.scenarios);
  // Une vérification qui ne peut rien prouver est une faute de plan que
  // l'exécution vient de mesurer : le plan est réécrit une fois, revalidé
  // entièrement, puis seuls les scénarios concernés sont réexécutés. Aucun
  // verdict n'est requalifié — le contrat révisé repasse le même gate.
  const revisedRefusals = await replanObservedInvariants({
    canary,
    catalog,
    config,
    context,
    evidence,
    files: planFiles,
    initialPage,
    material,
    model,
    policy,
    preview,
    progress,
    result,
    root,
  });
  await runBaseline(result, context, {
    canary,
    config,
    material,
    model,
    progress,
    refused: baselineRefusals(
      [...refusals.keys(), ...preExecutionRefusals.keys()],
      result.replannedScenarioIds ?? [],
      revisedRefusals
    ),
    root,
  });
  if (config.QA_REPLAY_BUNDLE) {
    await attachReplayRuntimeResults(root, result);
  }
}
async function runBaseline(
  result: RunResult,
  context: PrContext,
  options: {
    canary: Canary;
    config: Config;
    material: SourceLineMaterial[];
    model: Model;
    progress: Progress;
    refused: ReadonlySet<string>;
    root: string;
  }
) {
  const template = options.config.QA_BASELINE_URL_TEMPLATE;
  const plan = result.plan;
  if (!(template && plan)) {
    return;
  }
  const url = template
    .replaceAll("{sha}", context.baseSha)
    .replaceAll("{pr}", String(context.ref.number));
  const basePreview = await verifyPreviewUrl(
    url,
    context.baseSha,
    options.config
  );
  const scope = runScope.getStore();
  if (scope) {
    scope.previewSha = context.baseSha;
  }
  result.baseline = {
    sha: context.baseSha,
    url: basePreview.url,
    scenarios: [],
  };
  for (const scenario of plan.scenarios) {
    if (options.refused.has(scenario.id)) {
      // Un scénario refusé ne dépense aucune étape navigateur, base comprise.
      continue;
    }
    result.baseline.scenarios.push(
      await executeScenario(
        scenario,
        basePreview.url,
        join(options.root, "_baseline"),
        options.config,
        options.canary,
        (event) => options.progress.record(event),
        context.ref.repo,
        options.material,
        options.model
      )
    );
  }
  const activeScope = runScope.getStore();
  if (activeScope) {
    activeScope.previewSha = context.sha;
  }
}
async function recheck(
  result: RunResult,
  context: PrContext,
  preview: Preview,
  options: RunOptions,
  github: GitHub,
  config: Config
) {
  const latest = await github.pr(options.prUrl);
  if (
    latest.data.head.sha !== context.sha ||
    latest.data.base.sha !== context.baseSha ||
    latest.data.state !== "open"
  ) {
    result.outcome = "stale";
    result.error =
      "PR head/base or state changed during QA. Results apply only to the recorded SHA; run again.";
    return;
  }
  const currentPreview = await resolvePreview(
    context,
    github,
    config,
    options.previewUrl
  );
  if (
    currentPreview.url !== preview.url ||
    currentPreview.sha !== preview.sha
  ) {
    result.outcome = "stale";
    result.error = "Preview deployment changed during QA; run again.";
  }
}
function statusFor(outcome: Outcome): "success" | "failure" | "error" {
  if (outcome === "passed") {
    return "success";
  }
  if (outcome === "failed") {
    return "failure";
  }
  return "error";
}
async function publish(
  result: RunResult,
  context: PrContext,
  github: GitHub,
  config: Config,
  reportUrl?: string
) {
  // Le run a tenté de publier : le champ existe dès cet instant, et ne dit que
  // l'issue de la publication du rapport. L'échec du verdict de commit status
  // est un autre fait, consigné dans `commitStatus`, jamais recopié dans
  // `status`.
  const publication: Publication = { status: "failed" };
  result.publication = publication;
  let commentAttempted = false;
  try {
    await runScope.getStore()?.verifyOwnership?.();
    const verdict = statusFor(result.outcome);
    await github.status(
      context,
      verdict,
      `QA ${result.outcome}: ${result.scenarios.filter((s) => s.outcome === "passed").length}/${result.scenarios.length} scenarios`,
      reportUrl
    );
    publication.commitStatus = verdict;
    await runScope.getStore()?.verifyOwnership?.();
    commentAttempted = true;
    const commentUrl = await github.comment(
      context,
      reportMarkdown(result, reportUrl)
    );
    publication.commentUrl = commentUrl;
    publication.status = "published";
  } catch (error) {
    result.diagnostic = diagnose(error, config);
    result.outcome = "blocked";
    result.error =
      `${result.error ?? ""} GitHub publication failed: ${result.diagnostic.message}`.trim();
    // Le verdict bloqué et le commentaire réparé sont deux écritures
    // indépendantes : le rapport est publié dès que son commentaire aboutit,
    // même si l'écriture du verdict a échoué.
    await runScope
      .exit(() =>
        github.status(
          context,
          "error",
          "QA completed but publication failed",
          reportUrl
        )
      )
      .then(() => {
        publication.commitStatus = "error";
      })
      .catch((statusError) => {
        result.error += ` Blocked status update failed: ${diagnose(statusError, config).message}`;
      });
    // A failed response can follow a successful write: repair the upserted comment too.
    if (commentAttempted) {
      await runScope
        .exit(async () => {
          const commentUrl = await github.comment(
            context,
            reportMarkdown(result, reportUrl)
          );
          publication.commentUrl = commentUrl;
          publication.status = "published";
        })
        .catch((repairError) => {
          result.error += ` Blocked comment update failed: ${diagnose(repairError, config).message}`;
        });
    }
  }
}
/**
 * Le repli de transport publie sa reprise avant chaque attente : le tableau de
 * bord ne doit pas paraître figé pendant le backoff, et l'instabilité de l'amont
 * reste mesurable dans l'historique du run.
 */
export function relayModelRetries(
  scope: RunScope | undefined,
  progress: Progress
) {
  if (scope) {
    scope.onRetry = (retry) => {
      // L'écriture de la progression ne doit jamais faire tomber le worker : un
      // rejet détaché suffirait à terminer le processus et à laisser la ligne
      // SQL courir jusqu'à l'expiration de son lease au lieu de finir bloquée.
      progress.record({ phase: "planning", retry }).catch((error: unknown) => {
        logger.warn({ error, retry }, "Retry progress event not persisted");
      });
    };
  }
}
async function runUnscoped(
  options: RunOptions,
  config: Config
): Promise<RunResult> {
  const id = options.id ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
    throw new Error("Invalid run id");
  }
  const root = join(config.QA_DATA_DIR, id);
  const result: RunResult = {
    id,
    prUrl: options.prUrl,
    model: config.OPENAI_MODEL,
    startedAt: new Date().toISOString(),
    outcome: "blocked",
    scenarios: [],
  };
  const github = new GitHub(config);
  const canary = new Canary(config);
  const model = new Model(config);
  const progress = new Progress(root, id);
  relayModelRetries(runScope.getStore(), progress);
  progress.recordModelResponses(runScope.getStore());
  let context: PrContext | undefined;
  const reportUrl = config.ARTIFACT_BASE_URL
    ? `${config.ARTIFACT_BASE_URL.replace(/\/$/, "")}/artifacts/${id}/report.html`
    : undefined;
  try {
    await progress.record({ phase: "context" });
    validateConfiguration(config);
    if (
      options.publish !== false &&
      !config.GITHUB_TOKEN &&
      !config.GITHUB_APP_ID
    ) {
      throw new Error(
        "GITHUB_TOKEN is required to publish. Use --no-publish for local verification."
      );
    }
    const loaded = await github.context(options.prUrl);
    if (options.expectedSha && loaded.sha !== options.expectedSha) {
      throw new QaError(
        "STALE_HEAD",
        "Queued commit is no longer the PR head",
        "Submit a new run for the current commit."
      );
    }
    context = loaded;
    result.sha = context.sha;
    const scope = runScope.getStore();
    if (scope) {
      scope.previewSha = context.sha;
    }
    logger.info(
      { runId: id, sha: context.sha, pr: context.ref.url },
      "PR context pinned"
    );
    if (options.publish !== false) {
      await github.status(
        context,
        "pending",
        "Planning and executing browser scenarios",
        reportUrl
      );
    }
    await progress.record({ phase: "preview" });
    result.preview = await resolvePreview(
      context,
      github,
      config,
      options.previewUrl
    );
    await executePlan(
      result,
      context,
      result.preview,
      root,
      config,
      canary,
      model,
      progress,
      github
    );
    await progress.record({ phase: "verification" });
    await recheck(result, context, result.preview, options, github, config);
  } catch (error) {
    result.diagnostic = diagnose(error, config);
    result.error = result.diagnostic.message;
    result.outcome =
      result.diagnostic.code === "STALE_HEAD" ? "stale" : "blocked";
    logger.warn({ runId: id, error: result.error }, "QA blocked");
  }
  const usage = runScope.getStore();
  if (usage) {
    result.usage = {
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      reservedTokens: usage.reservedTokens,
      reservedCostUsd: usage.reservedCostUsd,
      calls: usage.calls,
      retries: usage.retries ?? 0,
      model: config.OPENAI_MODEL,
      estimated: usage.estimated ?? false,
      pricingConfigured:
        config.QA_INPUT_COST_PER_MILLION > 0 ||
        config.QA_OUTPUT_COST_PER_MILLION > 0,
    };
  }
  result.endedAt = new Date().toISOString();
  await saveReport(root, result, config);
  if (
    context &&
    options.publish !== false &&
    !runScope.getStore()?.signal.aborted
  ) {
    await progress.record({ phase: "publication" });
    await publish(result, context, github, config, reportUrl);
    await saveReport(root, result, config);
  } else if (
    context &&
    options.publish !== false &&
    runScope.getStore()?.signal.aborted
  ) {
    const pinnedContext = context;
    // Only close the check for the pinned historical SHA. Aborted runs can never publish success.
    await runScope
      .exit(() =>
        github.status(
          pinnedContext,
          "error",
          "QA interrupted or cancelled; no successful verdict",
          reportUrl
        )
      )
      .catch((error) => {
        logger.warn(
          { runId: id, diagnostic: diagnose(error, config) },
          "Could not close interrupted GitHub check"
        );
      });
  }
  await progress.record({
    phase: "done",
    outcome: result.outcome,
    diagnostic: result.diagnostic,
  });
  return result;
}

export async function runQa(
  options: RunOptions,
  configured: Config
): Promise<RunResult> {
  const config = runModelConfig(configured, options.model);
  if (runScope.getStore()) {
    return traced(
      "qa.run",
      { runId: options.id ?? "direct", pr: options.prUrl },
      () => runUnscoped(options, config)
    );
  }
  const id = options.id ?? randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new QaError(
          "RUN_DEADLINE",
          "Run deadline exceeded",
          "Inspect the last progress phase before increasing QA_RUN_TIMEOUT_SECONDS."
        )
      ),
    config.QA_RUN_TIMEOUT_SECONDS * 1000
  );
  try {
    return await runScope.run(
      {
        id,
        signal: controller.signal,
        tokens: 0,
        costUsd: 0,
        reservedTokens: 0,
        reservedCostUsd: 0,
        calls: 0,
        retries: 0,
        maxTokens: config.QA_RUN_MAX_TOKENS,
        maxCostUsd: config.QA_RUN_MAX_COST_USD,
      },
      () =>
        traced("qa.run", { runId: id, pr: options.prUrl }, () =>
          runUnscoped({ ...options, id }, config)
        )
    );
  } finally {
    clearTimeout(timer);
  }
}
