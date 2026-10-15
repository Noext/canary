import { z } from "zod";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import type { GitHub, PrContext } from "./github.js";
import type { Plan, Scenario } from "./schema.js";

type Requirement = Scenario["requirements"][number];

export const PolicySchema = z
  .object({
    version: z.literal(1),
    criticalPaths: z
      .array(z.string().min(1))
      .default(["src/", "app/", "apps/", "pages/", "routes/", "packages/"]),
    approvedSkips: z
      .array(
        z
          .object({ path: z.string().min(1), reason: z.string().min(8) })
          .strict()
      )
      .default([]),
    providerHosts: z.array(z.string()).default([]),
    requireWriteEvidence: z.boolean().default(true),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;
export async function trustedPolicy(
  github: GitHub,
  context: PrContext
): Promise<Policy> {
  const value = await github.optionalFile(
    context.ref.repo,
    ".canary/qa.json",
    context.baseSha
  );
  return value === undefined
    ? PolicySchema.parse({ version: 1 })
    : PolicySchema.parse(JSON.parse(value));
}
const DOCUMENTATION_DIRECTORY = /(^|\/)(docs|openspec)\//;
const MARKDOWN_FILE = /\.mdx?$/i;
const LICENSE_FILE = /(^|\/)LICEN[CS]E(\.[^/]*)?$/i;
/**
 * Documentation is never gated by `criticalPaths`: markdown prose, `docs/` and
 * `openspec/` trees and licence texts change no runtime behavior, including
 * when an application keeps them under a critical prefix such as `apps/`.
 * `.github/` is deliberately not listed here - workflows are executable
 * configuration, so a repository that wants them gated adds the prefix itself.
 */
export function isDocumentationPath(file: string): boolean {
  return (
    DOCUMENTATION_DIRECTORY.test(file) ||
    MARKDOWN_FILE.test(file) ||
    LICENSE_FILE.test(file)
  );
}
function segmentMatches(pattern: string, segment: string): boolean {
  if (!pattern.includes("*")) {
    return pattern === segment;
  }
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`).test(segment);
}
function segmentsMatch(pattern: string[], file: string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) {
    return file.length === 0;
  }
  if (head === "**") {
    // `**` spans zero or more segments, including every one of them.
    return Array.from({ length: file.length + 1 }, (_, index) => index).some(
      (index) => segmentsMatch(rest, file.slice(index))
    );
  }
  return (
    file.length > 0 &&
    segmentMatches(head, file[0] as string) &&
    segmentsMatch(rest, file.slice(1))
  );
}
/**
 * `approvedSkips[].path` accepts an exact path or a pattern: `*` matches
 * inside one segment and `**` spans segments, so a wildcard app directory
 * followed by a file name is honoured. A pattern made only of wildcard
 * segments, or ending with a slash, would approve every skip and disable this
 * gate, so it approves nothing and the run is refused exactly like an
 * unapproved skip.
 */
export function approvedSkipCovers(pattern: string, file: string): boolean {
  const segments = pattern.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    pattern.endsWith("/") ||
    segments.every((segment) => segment === "*" || segment === "**")
  ) {
    return false;
  }
  return segmentsMatch(segments, file.split("/").filter(Boolean));
}
/**
 * Un skip que le gate de couverture refuserait : chemin critique non
 * documenté, sans approbation sur la branche de base. Le remède « retirez le
 * fichier des sources et listez-le dans skipped » ne vaut donc que si ce
 * prédicat est faux, et le gate comme les remèdes rendus au planificateur
 * lisent la même règle.
 */
export function criticalSkipRefused(policy: Policy, file: string): boolean {
  return (
    !isDocumentationPath(file) &&
    policy.criticalPaths.some((prefix) => file.startsWith(prefix)) &&
    !policy.approvedSkips.some((skip) => approvedSkipCovers(skip.path, file))
  );
}
export interface ScenarioRefusal {
  error: QaError;
  scenario: Scenario;
}
/**
 * A scenario that interacts with the UI must prove the change the interaction
 * produces. These refusals are per scenario: the runner blocks the offender
 * alone, never executes it, and keeps the rest of the plan running.
 */
export function writeEvidenceRefusals(
  plan: Plan,
  policy: Policy
): ScenarioRefusal[] {
  if (!policy.requireWriteEvidence) {
    return [];
  }
  const refusals: ScenarioRefusal[] = [];
  for (const scenario of plan.scenarios) {
    const interacts = scenario.steps.some((step) =>
      ["click", "fill", "press", "select", "check"].includes(step.action.type)
    );
    const provesChange = scenario.assertions.some((assertion) =>
      ["transition", "persisted"].includes(assertion.verification)
    );
    if (interacts && !provesChange) {
      refusals.push({
        scenario,
        error: new QaError(
          "WRITE_EVIDENCE_MISSING",
          `Scenario ${scenario.id} interacts with UI without changed/persisted state evidence`,
          "Use a transition or persisted assertion on the actual changed output. Static visibility or matching decoy text cannot prove a write."
        ),
      });
    }
  }
  return refusals;
}
/**
 * Segments témoins d'une exigence : le patch du fichier dans la PR, puis chaque
 * contenu contextuel récupéré pour ce chemin. Chaque élément est un témoin à
 * part entière, comparé seul : une citation qui n'existe qu'en recousant la fin
 * d'un segment au début du suivant — jonction patch→contenu, ou contenu de tête
 * → contenu de base — n'a pas de témoin.
 */
export function requirementEvidence(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): string[] {
  const patch = context.files.find(
    (file) => file.filename === requirement.sourceFile
  )?.patch;
  return [
    ...(patch ? [patch] : []),
    ...context.context
      .filter((item) => item.path === requirement.sourceFile)
      .map((item) => item.content),
  ];
}

/**
 * Les blancs ne départagent pas une citation de sa source : le planificateur
 * recopie sur une ligne le bloc que le fichier indente sur quatre, et un refus
 * d'espacement ne lui apprend rien. La règle est celle de `normalizeText`
 * (plan-evidence.ts) : caractères invisibles retirés, toute suite de blancs
 * ramenée à une espace. Le repli typographique reste réservé aux cibles de
 * locator, jamais aux citations : un seul caractère non blanc différent doit
 * continuer de refuser.
 */
function normalizeQuoteText(value: string): string {
  return value
    .replace(/[\u200b\u00ad]/g, "")
    .replace(/[\r\n\s\t]+/g, " ")
    .trim();
}

/**
 * Vrai si la citation apparaît dans ce segment témoin, à l'espacement près.
 * Une citation qui se normalise en chaîne vide n'a jamais de témoin :
 * `includes("")` est toujours vrai, et l'accepter ferait passer pour une preuve
 * une citation qui n'existe nulle part.
 */
export function quoteHasWitness(evidence: string, quote: string): boolean {
  const normalized = normalizeQuoteText(quote);
  if (normalized.length === 0) {
    return false;
  }
  return normalizeQuoteText(evidence).includes(normalized);
}

/**
 * Vrai si la citation est contenue dans l'un des segments témoins du fichier
 * cité, jamais dans leur recousage.
 */
export function requirementHasWitness(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): boolean {
  return requirementEvidence(requirement, context).some((segment) =>
    quoteHasWitness(segment, requirement.quote)
  );
}

/**
 * Une exigence dont la citation n'apparaît nulle part, même à l'espacement
 * près, n'a pas de témoin : le plan est refusé plutôt que testé sur une preuve
 * inventée.
 */
export function ungroundedRequirement(
  scenarioId: string,
  requirement: Requirement
): QaError {
  return new QaError(
    "REQUIREMENT_UNGROUNDED",
    `No source witness for ${scenarioId}: ${requirement.sourceFile}`,
    "Quote exact source or diff text; page content alone is not a requirement."
  );
}

/**
 * Fichiers dont le texte témoin contient la citation mot pour mot — à
 * l'espacement près — dans l'ordre où ils apparaîent : sert à dire au
 * planificateur où la citation existe réellement quand il l'a attribuée au
 * mauvais fichier.
 */
export function witnessFiles(quote: string, context: PrContext): string[] {
  const paths = [
    ...context.files.map((file) => file.filename),
    ...context.context.map((item) => item.path),
  ];
  return [...new Set(paths)].filter((path) =>
    requirementHasWitness({ quote, sourceFile: path }, context)
  );
}

/**
 * Répare une attribution fautive quand la citation existe, à l'espacement près,
 * dans un autre fichier déclaré par le même scénario : la preuve reste réelle,
 * seule la mention du fichier était fausse. Un plan qui cite un fichier hors
 * scénario n'est pas réparé ici — le planificateur reçoit le refus et corrige
 * lui-même sa liste de sources.
 */
export function repairRequirementAttribution(
  plan: Plan,
  context: PrContext
): { from: string; quote: string; scenarioId: string; to: string }[] {
  const repairs: {
    from: string;
    quote: string;
    scenarioId: string;
    to: string;
  }[] = [];
  for (const scenario of plan.scenarios) {
    for (const requirement of scenario.requirements) {
      if (requirementHasWitness(requirement, context)) {
        continue;
      }
      const candidates = scenario.sourceFiles.filter((sourceFile) =>
        requirementHasWitness({ quote: requirement.quote, sourceFile }, context)
      );
      const [target] = candidates;
      if (candidates.length !== 1 || !target) {
        continue;
      }
      repairs.push({
        from: requirement.sourceFile,
        quote: requirement.quote,
        scenarioId: scenario.id,
        to: target,
      });
      requirement.sourceFile = target;
    }
  }
  return repairs;
}

/**
 * Où la citation se trouve réellement, en ne proposant que des fichiers que la
 * PR change : déclarer une source hors diff consommerait la tentative de
 * correction pour rien, puisque la validation la refuserait.
 */
function witnessHint(quote: string, context: PrContext): string {
  const changed = context.files.map((file) => file.filename);
  const found = witnessFiles(quote, context);
  const pr = found.filter((path) => changed.includes(path));
  if (pr.length > 0) {
    return ` The quote appears verbatim in ${pr.join(", ")}; declare that file and attribute the requirement to it.`;
  }
  const outside = found.filter((path) => !changed.includes(path));
  if (outside.length === 0) {
    return "";
  }
  return ` The quote only appears in ${outside.join(", ")}, which this PR does not change; quote the changed file instead.`;
}

/**
 * Exigences citées sans témoin textuel, même à l'espacement près, avec le
 * scénario qui les porte : la classe fatale `REQUIREMENT_UNGROUNDED` en est
 * rendue une par entrée, et le canal de correction peut aussi l'agréger en une
 * seule ligne.
 */
export function ungroundedRequirements(
  plan: Plan,
  context: PrContext
): { requirement: Requirement; scenarioId: string }[] {
  return plan.scenarios.flatMap((scenario) =>
    scenario.requirements
      .filter((requirement) => !requirementHasWitness(requirement, context))
      .map((requirement) => ({ requirement, scenarioId: scenario.id }))
  );
}

/**
 * Forme courte de la citation fautive : un refus qui ne nomme que le scénario
 * et le fichier laisse le planificateur deviner laquelle de ses exigences est
 * fausse. La ligne reste bornée — le préambule fatal et la troncature de
 * `model.ts` se partagent un budget de correction.
 */
const QUOTE_EXCERPT_CHARS = 120;
function quoteExcerpt(quote: string): string {
  const compact = normalizeQuoteText(quote);
  return compact.length <= QUOTE_EXCERPT_CHARS
    ? compact
    : `${compact.slice(0, QUOTE_EXCERPT_CHARS - 1)}…`;
}

/**
 * Exigences sans témoin textuel, sous forme de refus rendus au planificateur.
 * Le planificateur dispose d'une tentative de correction (voir `runner.ts`),
 * comme pour `writeEvidenceRefusals` ; `validateCoverage` reste le contrôle
 * final et refuse le plan si la correction n'a pas suffi.
 */
export function ungroundedPlanRefusals(
  plan: Plan,
  context: PrContext
): string[] {
  return ungroundedRequirements(plan, context).map(
    ({ requirement, scenarioId }) => {
      const error = ungroundedRequirement(scenarioId, requirement);
      const quote = JSON.stringify(quoteExcerpt(requirement.quote));
      return `${error.message}. Rejected quote: ${quote}. ${error.hint}${witnessHint(requirement.quote, context)}`;
    }
  );
}

/**
 * Marque comme couverts les fichiers témoignés par les exigences d'un scénario,
 * et seulement ceux-là : une exigence dont la citation n'existe pas mot pour
 * mot, à l'espacement près, n'ajoute rien, comme `validateCoverage` l'aurait
 * refusée juste avant. Le couvert est cumulatif sur tout le plan, dans l'ordre
 * des scénarios.
 * `unwitnessedPlanRefusals` et `validateCoverage` partagent ce pas pour que le
 * refus rendu au planificateur nomme exactement le fichier que le gate
 * refuserait ensuite, et jamais un fichier que le gate accepterait.
 */
function coverWitnessedSourceFiles(
  covered: Set<string>,
  scenario: Scenario,
  context: PrContext
): void {
  for (const requirement of scenario.requirements) {
    if (requirementHasWitness(requirement, context)) {
      covered.add(requirement.sourceFile);
    }
  }
}

/**
 * Un fichier déclaré par un scénario qu'aucune exigence témoignée ne couvre :
 * sans témoin, le plan ne peut pas prouver la couverture qu'il annonce. Le
 * remède de repli — retirer le fichier des sources — n'est proposé que si le
 * gate accepterait le remède qui le complète : un fichier que la PR ne change
 * pas ne se liste jamais dans `skipped` (`PLAN_SKIP_OUTSIDE_DIFF`), et un chemin
 * critique du diff demande un skip approuvé (`CRITICAL_COVERAGE_MISSING`).
 * Proposer un skip que le gate refuse ferait tourner la tentative de correction
 * du planificateur pour rien.
 */
export function unwitnessedRequirement(
  scenarioId: string,
  file: string,
  policy: Policy,
  inDiff: boolean
): QaError {
  let hint = `Add a requirement whose quote exists verbatim in ${file}, or drop it from sourceFiles and list it in skipped.`;
  if (!inDiff) {
    hint = `This PR does not change ${file}, so it cannot be listed in skipped: drop it from sourceFiles and quote a changed file instead.`;
  } else if (criticalSkipRefused(policy, file)) {
    hint = `Add a requirement whose quote exists verbatim in ${file}; this critical file cannot be dropped from sourceFiles without an approved skip in .canary/qa.json on the trusted base branch.`;
  }
  return new QaError(
    "COVERAGE_WITNESS_MISSING",
    `Scenario ${scenarioId} declares ${file} without a source requirement witness`,
    hint
  );
}

/**
 * Paires (scénario, fichier) des sources déclarées sans témoin, dans l'ordre du
 * plan : le couvert est cumulatif, exactement comme `validateCoverage`.
 */
export function unwitnessedSources(
  plan: Plan,
  context: PrContext
): { file: string; scenarioId: string }[] {
  const covered = new Set<string>();
  const entries: { file: string; scenarioId: string }[] = [];
  for (const scenario of plan.scenarios) {
    coverWitnessedSourceFiles(covered, scenario, context);
    for (const file of scenario.sourceFiles) {
      if (!covered.has(file)) {
        entries.push({ file, scenarioId: scenario.id });
      }
    }
  }
  return entries;
}

/**
 * Fichiers cités sans témoin, sous forme de refus rendus au planificateur : il
 * apprend la règle ici, dispose d'une tentative de correction, et
 * `validateCoverage` reste le contrôle final qui refuse un plan non corrigé.
 */
export function unwitnessedPlanRefusals(
  plan: Plan,
  context: PrContext,
  policy: Policy
): string[] {
  const changed = new Set(context.files.map((file) => file.filename));
  return unwitnessedSources(plan, context).map(({ file, scenarioId }) => {
    const error = unwitnessedRequirement(
      scenarioId,
      file,
      policy,
      changed.has(file)
    );
    return `${error.message}. ${error.hint}`;
  });
}

/**
 * Une exigence attribuée à un fichier que le scénario ne déclare pas : la
 * preuve citée n'appartient pas au scénario, donc elle ne couvre rien. Le refus
 * nomme le scénario et le fichier fautif, et ne propose de déclarer ce fichier
 * que si la PR le change : hors du diff, la validation de forme refuserait la
 * déclaration et la tentative de correction serait consommée pour rien.
 */
export function undeclaredRequirementSource(
  scenarioId: string,
  file: string,
  declared: string[],
  inDiff: boolean
): QaError {
  const candidates = declared.length
    ? `one of the files the scenario declares (${declared.join(", ")})`
    : "a file the scenario declares";
  return new QaError(
    "COVERAGE_REQUIREMENT_SOURCE_MISSING",
    `Scenario ${scenarioId} attributes a requirement to ${file}, which it does not declare in sourceFiles`,
    inDiff
      ? `Declare ${file} in this scenario's sourceFiles, or attribute the requirement to ${candidates}.`
      : `This PR does not change ${file}, so it cannot be declared: attribute the requirement to ${candidates}.`
  );
}

/** Fichiers cités par les exigences d'un scénario qu'il ne déclare pas. */
function undeclaredFiles(scenario: Scenario): string[] {
  return scenario.requirements
    .map((requirement) => requirement.sourceFile)
    .filter((file) => !scenario.sourceFiles.includes(file));
}

/**
 * Paires (scénario, fichier) des exigences attribuées hors des sources
 * déclarées, dans l'ordre du plan.
 */
export function undeclaredSources(
  plan: Plan
): { file: string; scenarioId: string }[] {
  return plan.scenarios.flatMap((scenario) =>
    undeclaredFiles(scenario).map((file) => ({ file, scenarioId: scenario.id }))
  );
}

/**
 * Exigences attribuées à un fichier hors de `sourceFiles`, sous forme de refus
 * rendus au planificateur. Fatal comme `COVERAGE_WITNESS_MISSING` : il bloque
 * tout le run via `validateCoverage`, donc il passe avant les refus par
 * scénario, qui restent rapportés et bloqués individuellement.
 */
export function undeclaredSourcePlanRefusals(
  plan: Plan,
  context: PrContext
): string[] {
  const changed = new Set(context.files.map((file) => file.filename));
  const declared = new Map(
    plan.scenarios.map((scenario) => [scenario.id, scenario.sourceFiles])
  );
  return undeclaredSources(plan).map(({ file, scenarioId }) => {
    const error = undeclaredRequirementSource(
      scenarioId,
      file,
      declared.get(scenarioId) ?? [],
      changed.has(file)
    );
    return `${error.message}. ${error.hint}`;
  });
}

/**
 * Premier refus d'attribution d'exigence, sans aucune dépendance à l'évidence.
 * Le contrôle final (`validateCoverage`) et le règlement du plan le partagent,
 * et il passe avant les refus de forme : un fichier hors diff, qui rend le plan
 * inexécutable, ne doit jamais masquer ce refus nommé et réparable.
 */
export function requirementSourceRefusal(
  plan: Plan,
  context: PrContext
): QaError | undefined {
  const changed = new Set(context.files.map((file) => file.filename));
  for (const scenario of plan.scenarios) {
    const [file] = undeclaredFiles(scenario);
    if (file !== undefined) {
      return undeclaredRequirementSource(
        scenario.id,
        file,
        scenario.sourceFiles,
        changed.has(file)
      );
    }
  }
}

/**
 * Un scénario dont les étapes ne tiennent pas dans le budget d'actions : son
 * contrat ne peut pas être exécuté. Le refus est nommé, remonte au
 * planificateur comme le refus d'attribution, et le contrôle final lève le
 * premier de la liste.
 */
export function contractBudgetRefusal(
  scenario: Scenario,
  config: Config
): QaError | undefined {
  return scenario.steps.length + 1 > config.QA_MAX_STEPS
    ? new QaError(
        "CONTRACT_BUDGET",
        `Scenario ${scenario.id} cannot complete within QA_MAX_STEPS`,
        "Increase the budget or split the scenario before execution."
      )
    : undefined;
}

/** Budgets de scénario refusés, dans l'ordre du plan. */
export function contractBudgetRefusals(plan: Plan, config: Config): QaError[] {
  return plan.scenarios
    .map((scenario) => contractBudgetRefusal(scenario, config))
    .filter((refusal): refusal is QaError => refusal !== undefined);
}

export function validateCoverage(
  plan: Plan,
  context: PrContext,
  policy: Policy,
  config: Config
) {
  const covered = new Set<string>();
  const changed = new Set(context.files.map((file) => file.filename));
  validateProvider(policy, config);
  const source = requirementSourceRefusal(plan, context);
  if (source) {
    throw source;
  }
  for (const scenario of plan.scenarios) {
    const budget = contractBudgetRefusal(scenario, config);
    if (budget) {
      throw budget;
    }
    for (const requirement of scenario.requirements) {
      if (!requirementHasWitness(requirement, context)) {
        throw ungroundedRequirement(scenario.id, requirement);
      }
    }
    coverWitnessedSourceFiles(covered, scenario, context);
    const unwitnessed = scenario.sourceFiles.find((file) => !covered.has(file));
    if (unwitnessed !== undefined) {
      throw unwitnessedRequirement(
        scenario.id,
        unwitnessed,
        policy,
        changed.has(unwitnessed)
      );
    }
  }
  const denied = plan.skipped.filter((skip) =>
    criticalSkipRefused(policy, skip.sourceFile)
  );
  if (denied.length) {
    throw new QaError(
      "CRITICAL_COVERAGE_MISSING",
      `Critical changes skipped: ${denied.map((f) => f.sourceFile).join(", ")}`,
      "Add scenarios, or approve the exact skip with a reason in .canary/qa.json on the trusted base branch. A PR cannot approve its own skip."
    );
  }
  return {
    covered: [...covered],
    skipped: plan.skipped,
    policyRef: context.baseSha,
    gate: plan.scenarios.length ? "complete" : "no-browser-tests",
  };
}

export function validateProvider(policy: Policy, config: Config) {
  if (
    policy.providerHosts.length &&
    !policy.providerHosts.includes(new URL(config.OPENAI_BASE_URL).host)
  ) {
    throw new Error("Provider denied by trusted repository data policy");
  }
}
