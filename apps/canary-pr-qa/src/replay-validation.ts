import type { Config } from "./config.js";
import type { TrustedCatalog } from "./fixtures.js";
import type { PrContext } from "./github.js";
import { provenanceRefusals, validatePlanEvidence } from "./plan-evidence.js";
import {
  amputationScans,
  type Policy,
  requirementSourceRefusal,
} from "./policy.js";
import {
  planRefusals,
  preExecutionFindings,
  quotePickCorrection,
} from "./runner.js";
import type { Plan } from "./schema.js";

interface ReplayValidationInput {
  catalog: TrustedCatalog;
  config: Config;
  context: PrContext;
  evidence: { aria: string; url: string };
  plan: Plan;
  policy: Policy;
}

/** Same repair-time gate used by the production planner callback. */
function replayPlannerRefusals(input: ReplayValidationInput): string[] {
  return planRefusals(
    input.plan,
    input.policy,
    input.context,
    input.config,
    input.catalog,
    amputationScans(),
    input.evidence
  );
}

/**
 * Uses the same correction path as the live planner, including quote-pick repair.
 */
export function replayPlannerCorrection(input: ReplayValidationInput) {
  const refusals = replayPlannerRefusals(input);
  if (refusals.length === 0) {
    return;
  }
  return (
    quotePickCorrection(
      input.plan,
      input.policy,
      input.context,
      input.config,
      undefined,
      undefined,
      input.catalog
    ) ??
    `Plan rejected: ${refusals.join(" ")} Return the complete corrected plan.`
  );
}

/**
 * Runs the full deterministic plan gate used before browser execution.
 * Scenario-level refusals are reported here too so CI can fail fast without
 * opening Chromium. Evidence gaps remain inconclusive rather than being treated
 * as proof of a defect.
 *
 * `evidenceComplete` dit si la page a pu être jugée du tout : un instantané
 * absent ou coupé au plafond ne produit aucun refus, donc l'absence de refus ne
 * suffit pas à conclure. C'est cette information, et non la longueur de
 * `inconclusive`, qui distingue « porte sans reproche » de « porte sans preuve ».
 */
export function replayPlanValidation(input: ReplayValidationInput): {
  evidenceComplete: boolean;
  refusals: string[];
  inconclusive: string[];
} {
  const { config, context, evidence, plan, policy } = input;
  const sourceRefusal = requirementSourceRefusal(plan, context);
  const refusals = [
    ...replayPlannerRefusals(input),
    ...(sourceRefusal
      ? [`${sourceRefusal.message}. ${sourceRefusal.hint}`]
      : []),
    ...preExecutionFindings(plan, context, policy, config).map(
      (item) => `${item.scenarioId}: ${item.error.message}. ${item.error.hint}`
    ),
    ...provenanceRefusals(plan).map(
      (item) => `${item.scenarioId}: ${item.error.message}. ${item.error.hint}`
    ),
  ];
  const pageEvidence = validatePlanEvidence(plan, evidence);
  return {
    evidenceComplete: pageEvidence.incomplete === undefined,
    refusals: [
      ...new Set([
        ...refusals,
        ...pageEvidence.refusals.map((item) => JSON.stringify(item)),
      ]),
    ],
    inconclusive: pageEvidence.incomplete
      ? [pageEvidence.incomplete]
      : pageEvidence.inconclusive.map(
          (item) => `${item.scenarioId}: ${item.reason}`
        ),
  };
}
