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
 * Texte témoin d'une exigence : le patch du fichier dans la PR, complété par
 * les contenus contextuels récupérés pour ce chemin.
 */
export function requirementEvidence(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): string {
  return [
    context.files.find((file) => file.filename === requirement.sourceFile)
      ?.patch ?? "",
    ...context.context
      .filter((item) => item.path === requirement.sourceFile)
      .map((item) => item.content),
  ].join("\n");
}

/**
 * Une exigence dont la citation n'apparaît mot pour mot nulle part n'a pas de
 * témoin : le plan est refusé plutôt que testé sur une preuve inventée.
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
 * Fichiers dont le texte témoin contient la citation mot pour mot, dans l'ordre
 * où ils apparaîent : sert à dire au planificateur où la citation existe
 * réellement quand il l'a attribuée au mauvais fichier.
 */
export function witnessFiles(quote: string, context: PrContext): string[] {
  const paths = [
    ...context.files.map((file) => file.filename),
    ...context.context.map((item) => item.path),
  ];
  return [...new Set(paths)].filter((path) =>
    requirementEvidence({ quote, sourceFile: path }, context).includes(quote)
  );
}

/**
 * Répare une attribution fautive quand la citation existe mot pour mot dans un
 * autre fichier déclaré par le même scénario : la preuve reste réelle, seule la
 * mention du fichier était fausse. Un plan qui cite un fichier hors scénario
 * n'est pas réparé ici — le planificateur reçoit le refus et corrige lui-même
 * sa liste de sources.
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
      if (
        requirementEvidence(requirement, context).includes(requirement.quote)
      ) {
        continue;
      }
      const candidates = scenario.sourceFiles.filter((sourceFile) =>
        requirementEvidence(
          { quote: requirement.quote, sourceFile },
          context
        ).includes(requirement.quote)
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
 * Exigences sans témoin textuel, sous forme de refus rendus au planificateur.
 * Le planificateur dispose d'une tentative de correction (voir `runner.ts`),
 * comme pour `writeEvidenceRefusals` ; `validateCoverage` reste le contrôle
 * final et refuse le plan si la correction n'a pas suffi.
 */
export function ungroundedPlanRefusals(
  plan: Plan,
  context: PrContext
): string[] {
  return plan.scenarios.flatMap((scenario) =>
    scenario.requirements
      .filter(
        (requirement) =>
          !requirementEvidence(requirement, context).includes(requirement.quote)
      )
      .map((requirement) => {
        const error = ungroundedRequirement(scenario.id, requirement);
        return `${error.message}. ${error.hint}${witnessHint(requirement.quote, context)}`;
      })
  );
}

/**
 * Marque comme couverts les fichiers témoignés par les exigences d'un scénario,
 * et seulement ceux-là : une exigence dont la citation n'existe pas mot pour mot
 * n'ajoute rien, comme `validateCoverage` l'aurait refusée juste avant. Le
 * couvert est cumulatif sur tout le plan, dans l'ordre des scénarios.
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
    if (requirementEvidence(requirement, context).includes(requirement.quote)) {
      covered.add(requirement.sourceFile);
    }
  }
}

/**
 * Un fichier déclaré par un scénario qu'aucune exigence témoignée ne couvre :
 * sans témoin, le plan ne peut pas prouver la couverture qu'il annonce.
 */
export function unwitnessedRequirement(
  scenarioId: string,
  file: string
): QaError {
  return new QaError(
    "COVERAGE_WITNESS_MISSING",
    `Scenario ${scenarioId} declares ${file} without a source requirement witness`,
    `Add a requirement whose quote exists verbatim in ${file}, or drop it from sourceFiles and list it in skipped.`
  );
}

/**
 * Fichiers cités sans témoin, sous forme de refus rendus au planificateur : il
 * apprend la règle ici, dispose d'une tentative de correction, et
 * `validateCoverage` reste le contrôle final qui refuse un plan non corrigé.
 */
export function unwitnessedPlanRefusals(
  plan: Plan,
  context: PrContext
): string[] {
  const covered = new Set<string>();
  const refusals: string[] = [];
  for (const scenario of plan.scenarios) {
    coverWitnessedSourceFiles(covered, scenario, context);
    for (const file of scenario.sourceFiles) {
      if (!covered.has(file)) {
        const error = unwitnessedRequirement(scenario.id, file);
        refusals.push(`${error.message}. ${error.hint}`);
      }
    }
  }
  return refusals;
}

/**
 * Une exigence attribuée à un fichier que le scénario ne déclare pas : la
 * preuve citée n'appartient pas au scénario, donc elle ne couvre rien. Le refus
 * nomme le scénario et le fichier fautif, pour que le planificateur corrige sa
 * liste de sources dans sa tentative, comme `COVERAGE_WITNESS_MISSING`.
 */
export function undeclaredRequirementSource(
  scenarioId: string,
  file: string,
  declared: string[]
): QaError {
  const candidates = declared.length
    ? `one of the files the scenario declares (${declared.join(", ")})`
    : "a file the scenario declares";
  return new QaError(
    "COVERAGE_REQUIREMENT_SOURCE_MISSING",
    `Scenario ${scenarioId} attributes a requirement to ${file}, which it does not declare in sourceFiles`,
    `Declare ${file} in this scenario's sourceFiles, or attribute the requirement to ${candidates}.`
  );
}

/**
 * Exigences attribuées à un fichier hors de `sourceFiles`, sous forme de refus
 * rendus au planificateur. Fatal comme `COVERAGE_WITNESS_MISSING` : il bloque
 * tout le run via `validateCoverage`, donc il passe avant les refus par
 * scénario, qui restent rapportés et bloqués individuellement.
 */
export function undeclaredSourcePlanRefusals(plan: Plan): string[] {
  const refusals: string[] = [];
  for (const scenario of plan.scenarios) {
    for (const requirement of scenario.requirements) {
      if (!scenario.sourceFiles.includes(requirement.sourceFile)) {
        const error = undeclaredRequirementSource(
          scenario.id,
          requirement.sourceFile,
          scenario.sourceFiles
        );
        refusals.push(`${error.message}. ${error.hint}`);
      }
    }
  }
  return refusals;
}

export function validateCoverage(
  plan: Plan,
  context: PrContext,
  policy: Policy,
  config: Config
) {
  const covered = new Set<string>();
  validateProvider(policy, config);
  for (const scenario of plan.scenarios) {
    if (scenario.steps.length + 1 > config.QA_MAX_STEPS) {
      throw new QaError(
        "CONTRACT_BUDGET",
        `Scenario ${scenario.id} cannot complete within QA_MAX_STEPS`,
        "Increase the budget or split the scenario before execution."
      );
    }
    for (const requirement of scenario.requirements) {
      if (!scenario.sourceFiles.includes(requirement.sourceFile)) {
        throw undeclaredRequirementSource(
          scenario.id,
          requirement.sourceFile,
          scenario.sourceFiles
        );
      }
      if (
        !requirementEvidence(requirement, context).includes(requirement.quote)
      ) {
        throw ungroundedRequirement(scenario.id, requirement);
      }
    }
    coverWitnessedSourceFiles(covered, scenario, context);
    const unwitnessed = scenario.sourceFiles.find((file) => !covered.has(file));
    if (unwitnessed !== undefined) {
      throw unwitnessedRequirement(scenario.id, unwitnessed);
    }
  }
  const denied = plan.skipped.filter(
    (skip) =>
      !isDocumentationPath(skip.sourceFile) &&
      policy.criticalPaths.some((p) => skip.sourceFile.startsWith(p)) &&
      !policy.approvedSkips.some((s) =>
        approvedSkipCovers(s.path, skip.sourceFile)
      )
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
