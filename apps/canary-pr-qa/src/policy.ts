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
  requirement: Requirement,
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
        return `${error.message}. ${error.hint}`;
      })
  );
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
        throw new Error("Requirement must cite a scenario source file");
      }
      if (
        !requirementEvidence(requirement, context).includes(requirement.quote)
      ) {
        throw ungroundedRequirement(scenario.id, requirement);
      }
      covered.add(requirement.sourceFile);
    }
    if (scenario.sourceFiles.some((f) => !covered.has(f))) {
      throw new Error(
        "Every cited changed file needs a source requirement witness"
      );
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
