import { z } from "zod";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import type { GitHub, PrContext } from "./github.js";
import type { Plan } from "./schema.js";

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
export function validateCoverage(
  plan: Plan,
  context: PrContext,
  policy: Policy,
  config: Config
) {
  const covered = new Set<string>();
  validateProvider(policy, config);
  for (const scenario of plan.scenarios) {
    if (
      policy.requireWriteEvidence &&
      scenario.steps.some((step) =>
        ["click", "fill", "press", "select", "check"].includes(step.action.type)
      ) &&
      !scenario.assertions.some((assertion) =>
        ["transition", "persisted"].includes(assertion.verification)
      )
    ) {
      throw new QaError(
        "WRITE_EVIDENCE_MISSING",
        `Scenario ${scenario.id} interacts with UI without changed/persisted state evidence`,
        "Use a transition or persisted assertion on the actual changed output. Static visibility or matching decoy text cannot prove a write."
      );
    }
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
      const evidence = [
        context.files.find((f) => f.filename === requirement.sourceFile)
          ?.patch ?? "",
        ...context.context
          .filter((c) => c.path === requirement.sourceFile)
          .map((c) => c.content),
      ].join("\n");
      if (!evidence.includes(requirement.quote)) {
        throw new QaError(
          "REQUIREMENT_UNGROUNDED",
          `No source witness for ${scenario.id}: ${requirement.sourceFile}`,
          "Quote exact source or diff text; page content alone is not a requirement."
        );
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
      policy.criticalPaths.some((p) => skip.sourceFile.startsWith(p)) &&
      !policy.approvedSkips.some((s) => s.path === skip.sourceFile)
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
