import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createLogger } from "@usecanary/logger";
import {
  Canary,
  compileAction,
  type Observation,
  PLAN_EVIDENCE_SNAPSHOT_CHARS,
} from "./canary.js";
import { type Config, validateConfiguration } from "./config.js";
import { type Diagnostic, diagnose, QaError } from "./diagnostics.js";
import { executeScenario } from "./executor.js";
import { fixtureCatalog } from "./fixtures.js";
import { GitHub, type PrContext } from "./github.js";
import { Model, PLANNER_PROMPT } from "./model.js";
import { runModelConfig } from "./model-catalog.js";
import {
  type PlanEvidenceRefusal,
  type PlanEvidenceReport,
  planEvidenceDiagnostic,
  unstableSelectorRefusals,
  validatePlanEvidence,
} from "./plan-evidence.js";
import {
  contractBudgetRefusals,
  criticalSkipRefused,
  hasWeakWitness,
  type Policy,
  quoteExcerpt,
  repairRequirementAttribution,
  requirementSourceRefusal,
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
  writeEvidenceRefusals,
} from "./policy.js";
import { resolvePreview, verifyPreviewUrl } from "./preview.js";
import { Progress } from "./progress.js";
import { reportMarkdown, saveReport } from "./report.js";
import { checkBudget, type RunScope, runScope } from "./run-scope.js";
import {
  type Outcome,
  type Plan,
  PlanSchema,
  type Preview,
  type Publication,
  type RunResult,
  type Scenario,
  type ScenarioResult,
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

async function discover(
  context: PrContext,
  preview: Preview,
  root: string,
  canary: Canary
): Promise<{ evidence: string; initialPage: Observation }> {
  const sessionId = await canary.start(`PR ${context.ref.number} discovery`);
  let observation: Observation;
  try {
    observation = await canary.act(
      sessionId,
      "discover-preview",
      // L'évidence de validation du plan est relevée en même temps que
      // l'instantané du modèle, sans second relevé navigateur.
      compileAction(
        { type: "goto", path: preview.url },
        preview.url,
        undefined,
        {
          evidenceSnapshotChars: PLAN_EVIDENCE_SNAPSHOT_CHARS,
        }
      )
    );
  } catch (error) {
    await canary.abort(sessionId);
    throw error;
  }
  try {
    await canary.end(sessionId, join(root, "_discovery"));
  } catch (error) {
    await canary.abort(sessionId);
    throw error;
  }
  const { evidence, ...initialPage } = observation;
  return { evidence: evidence ?? "", initialPage };
}
function completeSource(context: PrContext, path: string, ref: string) {
  return context.context.some(
    (item) =>
      item.path === path &&
      item.ref === ref &&
      !context.contextWarnings.includes(
        `Truncated context: ${item.path} at ${item.ref}`
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
  hint: string;
  label: string;
  /**
   * Citations fautives de la classe, dans l'ordre du plan. Leur extrait entier
   * passe en tête de la ligne, avant le remède et les valeurs fautives : c'est
   * le détail que le planificateur doit lire pour corriger la bonne exigence.
   */
  quotes?: string[];
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
 * Citations fautives montrées en entier sur une ligne fatale. L'extrait d'une
 * citation (voir `quoteExcerpt`) est l'information que le planificateur doit
 * lire et n'est jamais raccourci : une seule tient avec son remède quand les
 * onze classes sont saturées, donc les suivantes sont annoncées par leur nombre
 * — jamais perdues en silence derrière la première.
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
/**
 * Tête d'une ligne fatale : le code, la citation fautive entière, puis le
 * remède. Le remède suit la citation, jamais les valeurs fautives : il ne doit
 * pas disparaître derrière une entrée rognée.
 */
function fatalHead(refusal: FatalClass): string {
  const quotes = refusal.quotes?.length
    ? ` ${rejectedQuotes(refusal.quotes)}`
    : "";
  return `${refusal.code}:${quotes} ${refusal.hint}`;
}
/**
 * Ligne d'une classe fatale : sa tête intouchée, puis les valeurs fautives dans
 * la place qui reste. Le préambule borne la tête de chaque classe, pas sa queue.
 */
function fatalLine(refusal: FatalClass, valuesLimit: number): string {
  const values = ` Faulty values: ${boundedEntries(refusal.entries)}`;
  return `${fatalHead(refusal)}${boundedText(values, valuesLimit)}`;
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
 * la tête de chaque classe — code, citation fautive entière, remède — passe
 * avant ses valeurs fautives, qui se partagent la place restante. Onze classes
 * saturées laissent encore une réserve positive, mesurée par les tests : la
 * citation de 120 et son remède survivent sans être rognés.
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
  const heads = classes.map(fatalHead);
  const essential =
    header.length + heads.reduce((total, head) => total + head.length + 1, 0);
  const room = Math.floor((FATAL_PRELUDE_CHARS - essential) / classes.length);
  const valuesLimit = room >= FATAL_VALUES_MIN_CHARS ? room : 0;
  return [header, ...classes.map((refusal) => fatalLine(refusal, valuesLimit))];
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
  "A requirement already cites a listed file, but its exact quote carries no letter or digit to witness that critical file: quote a substantial fragment, or get its skip approved in .canary/qa.json on the trusted base branch.";
/**
 * Remède d'une classe fatale de témoin : elle agrège les citations absentes et
 * les citations exactes mais trop pauvres, dont les remèdes n'ont rien à voir.
 * `FATAL_PRELUDE_CHARS` ne garde que cette ligne quand les autres classes
 * saturent, donc elle doit dire la vérité seule — un message qui demande de
 * citer le texte réel à une citation déjà présente fait renvoyer la même
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
 * Classes fatales de couverture, agrégées en tête du canal de correction.
 * Toutes bloquent le run via `validateCoverage`, donc toutes passent avant les
 * refus par scénario qui suivent la même liste.
 */
function coverageFatalClasses(
  candidate: Plan,
  context: PrContext,
  policy: Policy
): FatalClass[] {
  const classes: FatalClass[] = [];
  const unwitnessed = unwitnessedSources(candidate, context, policy);
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
  const ungrounded = ungroundedRequirements(candidate, context, policy);
  if (ungrounded.length > 0) {
    const weak = ungrounded.filter((item) =>
      hasWeakWitness(item.requirement, context, policy)
    );
    classes.push({
      code: "REQUIREMENT_UNGROUNDED",
      entries: ungrounded.map(
        (item) => `${item.scenarioId}:${item.requirement.sourceFile}`
      ),
      hint: witnessRemedy(
        UNGROUNDED_ABSENT_REMEDY,
        UNGROUNDED_WEAK_REMEDY,
        weak.length > 0,
        weak.length < ungrounded.length
      ),
      label: "requirements whose quote has no source witness",
      quotes: [...new Set(ungrounded.map((item) => item.requirement.quote))],
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
function planRefusals(
  candidate: Plan,
  policy: Policy,
  context: PrContext,
  config: Config
): string[] {
  const shape = planShapeRefusals(candidate, context, config);
  return [
    ...fatalPrelude([
      ...coverageFatalClasses(candidate, context, policy),
      ...contextFatalClasses(candidate, context),
      ...namedFatalClass(
        contractBudgetRefusals(candidate, config),
        "scenarios that cannot complete within QA_MAX_STEPS"
      ),
      ...shape,
    ]),
    ...unwitnessedPlanRefusals(candidate, context, policy),
    ...undeclaredSourcePlanRefusals(candidate, context),
    ...shape.map(
      (refusal) => `${fatalError(refusal).message}. ${refusal.hint}`
    ),
    ...ungroundedPlanRefusals(candidate, context, policy),
    ...writeEvidenceRefusals(candidate, policy).map(
      (item) => `${item.error.message}. ${item.error.hint}`
    ),
    ...unstableSelectorRefusals(candidate).map(
      (item) => `${item.error.message}. ${item.error.hint}`
    ),
  ];
}
/**
 * Après la planification : une citation réelle attribuée au mauvais fichier est
 * réparée — la preuve ne change pas, seule la mention du fichier était fausse —
 * le contrat est validé, et un plan qui lit une cible absente de la page de
 * découverte est refusé avant d'exécuter quoi que ce soit. Le refus d'attribution
 * nommé passe avant les refus de forme : un fichier hors diff ne doit jamais
 * masquer le refus que le planificateur est en train d'apprendre à corriger.
 */
function settlePlan(
  plan: Plan,
  context: PrContext,
  config: Config,
  runId: string,
  policy: Policy
) {
  for (const repair of repairRequirementAttribution(plan, context, policy)) {
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
  const { evidence, initialPage } = await discover(
    context,
    preview,
    root,
    canary
  );
  const payload = {
    pr: context,
    changedFiles: context.files.map((file) => file.filename),
    preview,
    initialPage,
    maxScenarios: config.QA_MAX_SCENARIOS,
    fixtures: await fixtureCatalog(config, context.ref.repo).then((c) => ({
      roles: Object.keys(c.roles),
      visuals: Object.keys(c.visuals),
      fixtures: Object.fromEntries(
        Object.entries(c.fixtures).map(([name, f]) => [name, f.description])
      ),
    })),
  };
  if (JSON.stringify(payload).length > config.QA_CONTEXT_CHARS + 30_000) {
    throw new Error(
      "PR context exceeds model budget; refusing partial diff analysis"
    );
  }
  const policy = await trustedPolicy(github, context);
  validateProvider(policy, config);
  await progress.record({ phase: "planning" });
  result.plan = await model.json(
    PLANNER_PROMPT,
    payload,
    PlanSchema,
    config.QA_PLAN_MAX_TOKENS,
    (candidate) => {
      // Le planificateur reçoit les refus et dispose d'une tentative de
      // correction, au lieu de faire échouer le run sur une citation recopiée
      // de mémoire ou attribuée au mauvais fichier.
      const messages = planRefusals(candidate, policy, context, config);
      return messages.length
        ? `Plan rejected: ${messages.join(" ")} Return the complete corrected plan.`
        : undefined;
    }
  );
  // Une citation réelle attribuée au mauvais fichier se répare : la preuve ne
  // change pas, seule la mention du fichier était fausse.
  settlePlan(result.plan, context, config, result.id, policy);
  const planEvidence = validatePlanEvidence(result.plan, {
    url: initialPage.url,
    aria: evidence,
  });
  const refusals = new Map<string, PlanEvidenceRefusal[]>();
  for (const refusal of planEvidence.refusals) {
    const list = refusals.get(refusal.scenarioId) ?? [];
    list.push(refusal);
    refusals.set(refusal.scenarioId, list);
  }
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
  result.coverage = validateCoverage(result.plan, context, policy, config);
  // Refus rendus au planificateur pendant la planification, rejoués ici : un
  // plan que le modèle n'a pas corrigé est bloqué, jamais exécuté.
  const preExecutionRefusals = new Map(
    [
      ...writeEvidenceRefusals(result.plan, policy),
      ...unstableSelectorRefusals(result.plan),
    ].map((item) => [item.scenario.id, item.error])
  );
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
      await executeScenario(
        scenario,
        preview.url,
        root,
        config,
        canary,
        (event) => progress.record(event),
        context.ref.repo
      )
    );
    await saveReport(root, result, config);
  }
  result.outcome = aggregate(result.scenarios);
  if (config.QA_BASELINE_URL_TEMPLATE) {
    const url = config.QA_BASELINE_URL_TEMPLATE.replaceAll(
      "{sha}",
      context.baseSha
    ).replaceAll("{pr}", String(context.ref.number));
    const basePreview = await verifyPreviewUrl(url, context.baseSha, config);
    const scope = runScope.getStore();
    if (scope) {
      scope.previewSha = context.baseSha;
    }
    result.baseline = {
      sha: context.baseSha,
      url: basePreview.url,
      scenarios: [],
    };
    for (const scenario of result.plan.scenarios) {
      if (refusals.has(scenario.id) || preExecutionRefusals.has(scenario.id)) {
        // Un scénario refusé ne dépense aucune étape navigateur, base comprise.
        continue;
      }
      result.baseline.scenarios.push(
        await executeScenario(
          scenario,
          basePreview.url,
          join(root, "_baseline"),
          config,
          canary,
          (event) => progress.record(event),
          context.ref.repo
        )
      );
    }
    const activeScope = runScope.getStore();
    if (activeScope) {
      activeScope.previewSha = context.sha;
    }
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
