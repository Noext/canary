import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  armMetrics,
  type CampaignVerdict,
  campaignDecision,
  compareArms,
  type RecordedRun,
} from "./campaign-metrics.js";
import { type CampaignPlan, campaignPreflight } from "./campaign-preflight.js";
import {
  appendRunRecord,
  type CampaignExecutor,
  runArm,
} from "./campaign-run.js";
import type { Config } from "./config.js";

/**
 * Le protocole figé par `docs/pr-qa-campaign-criteria.md` : deux bras, des lots
 * de dix runs alternés, cinq lots par bras. Les valeurs sont des constantes
 * nommées pour qu'aucun appel ne puisse « ajuster » la taille de la campagne.
 */
export const CAMPAIGN_BLOCKS = 5;
export const CAMPAIGN_RUNS_PER_BLOCK = 10;

export async function runCampaign(input: {
  config: Config;
  execute: CampaignExecutor;
  onRun?: (run: RecordedRun) => Promise<void>;
  plan: CampaignPlan;
}): Promise<{
  candidate: ReturnType<typeof armMetrics>;
  comparison: ReturnType<typeof compareArms>;
  reasons: string[];
  reference: ReturnType<typeof armMetrics>;
  runs: RecordedRun[];
  verdict: CampaignVerdict;
}> {
  const runs: RecordedRun[] = [];
  for (let block = 1; block <= CAMPAIGN_BLOCKS; block += 1) {
    for (let index = 1; index <= CAMPAIGN_RUNS_PER_BLOCK; index += 1) {
      for (const arm of input.plan.arms) {
        const recorded = await input.execute({
          arm,
          block,
          index,
          runId: `${arm.name}-b${block}-r${index}`,
        });
        runs.push(recorded);
        if (input.onRun) {
          await input.onRun(recorded);
        }
      }
    }
  }
  return summarize(runs, input.plan);
}

/** Agrège des runs déjà enregistrés, sans rien relancer. */
function summarize(runs: readonly RecordedRun[], plan: CampaignPlan) {
  const [referenceArm, candidateArm] = plan.arms;
  const reference = armMetrics(
    referenceArm.name,
    runs.filter((item) => item.arm === referenceArm.name)
  );
  const candidate = armMetrics(
    candidateArm.name,
    runs.filter((item) => item.arm === candidateArm.name)
  );
  const comparison = compareArms(reference, candidate);
  const decision = campaignDecision({ candidate, comparison, reference });
  return {
    candidate,
    comparison,
    reference,
    reasons: decision.reasons,
    runs: [...runs],
    verdict: decision.verdict,
  };
}

export interface CampaignCommandValues {
  "candidate-sha"?: string;
  "candidate-worktree"?: string;
  "confirm-paid-runs"?: boolean;
  data?: string;
  head?: string;
  pr?: string;
  preview?: string;
  "reference-sha"?: string;
  "reference-worktree"?: string;
}

/**
 * La sous-commande `campaign`. Elle est **explicitement manuelle** : sans
 * `--confirm-paid-runs`, elle ne lance aucun run — elle vérifie les dépendances et
 * rend la liste de ce qui manque. Aucun `npm run`, aucun hook, aucun démarrage de
 * service ne l'appelle : un run réel consomme l'API du modèle de l'opérateur.
 */
export async function campaignCommand(
  command: string | undefined,
  values: CampaignCommandValues,
  config: Config
): Promise<boolean> {
  if (command !== "campaign") {
    return false;
  }
  const required = {
    candidate: values["candidate-sha"],
    "candidate-worktree": values["candidate-worktree"],
    data: values.data,
    head: values.head,
    pr: values.pr,
    preview: values.preview,
    reference: values["reference-sha"],
    "reference-worktree": values["reference-worktree"],
  };
  const missing = Object.entries(required)
    .filter(([, value]) => value === undefined || value === "")
    .map(([key]) => `--${key}`);
  if (missing.length > 0) {
    throw new Error(`campaign requires ${missing.join(", ")}`);
  }
  const plan: CampaignPlan = {
    arms: [
      {
        commit: required.reference as string,
        name: "reference",
        worktree: required["reference-worktree"] as string,
      },
      {
        commit: required.candidate as string,
        name: "candidate",
        worktree: required["candidate-worktree"] as string,
      },
    ],
    dataDir: required.data as string,
    headSha: required.head as string,
    prUrl: required.pr as string,
    previewUrl: required.preview as string,
  };
  const preflight = await campaignPreflight(plan, config);
  const report = {
    blocks: CAMPAIGN_BLOCKS,
    blockers: preflight.blockers,
    plan: {
      arms: plan.arms.map((arm) => ({
        commit: arm.commit,
        name: arm.name,
        worktree: arm.worktree,
      })),
      blocks: CAMPAIGN_BLOCKS,
      headSha: plan.headSha,
      prUrl: plan.prUrl,
      previewUrl: plan.previewUrl,
      runsPerBlock: CAMPAIGN_RUNS_PER_BLOCK,
    },
    maxCost: preflight.maxCost,
    prSha: preflight.prSha,
    previewSha: preflight.previewSha,
    ready: preflight.blockers.length === 0,
  };
  if (preflight.blockers.length > 0) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
    return true;
  }
  if (values["confirm-paid-runs"] !== true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      "Preflight OK. No run was launched: re-run with --confirm-paid-runs to spend the operator's model API.\n"
    );
    return true;
  }
  await mkdir(plan.dataDir, { recursive: true });
  await writeFile(
    join(plan.dataDir, "campaign-plan.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  const outcome = await runCampaign({
    config,
    execute: (input) => runArm({ campaign: plan, config, input }),
    onRun: (recorded) => appendRunRecord(plan.dataDir, recorded),
    plan,
  });
  await writeFile(
    join(plan.dataDir, "campaign-summary.json"),
    `${JSON.stringify(outcome, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  return true;
}
