import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "@usecanary/logger";
import type { CampaignArm, CampaignPlan } from "./campaign.js";
import type {
  RecordedAssertion,
  RecordedRun,
  RecordedScenario,
} from "./campaign-metrics.js";
import type { Config } from "./config.js";

const logger = createLogger({ name: "pr-qa-campaign-run" });
const run = promisify(execFile);

/**
 * Projette une assertion d'artefact sur ce que la mesure consomme : le type de
 * vérification, la pré-satisfaction, la preuve d'exécution et le résultat. Les
 * valeurs de page ne sont jamais recopiées — elles peuvent porter des données de
 * test, et l'artefact de campagne n'en a pas besoin.
 */
export function recordAssertion(assertion: {
  passed: boolean;
  preMatched?: boolean;
  changed?: boolean;
  verification?: string;
}): RecordedAssertion {
  return {
    passed: assertion.passed,
    ...(assertion.preMatched === undefined
      ? {}
      : { preMatched: assertion.preMatched }),
    ...(assertion.changed === undefined ? {} : { changed: assertion.changed }),
    ...(assertion.verification === "state" ||
    assertion.verification === "transition" ||
    assertion.verification === "persisted"
      ? { verification: assertion.verification }
      : {}),
  };
}

/** Un scénario est refusé avant exécution quand il n'a joué aucune étape. */
export function recordScenario(scenario: {
  outcome: string;
  diagnostic?: { code: string };
  steps: readonly unknown[];
}): RecordedScenario {
  return {
    outcome: scenario.outcome,
    ...(scenario.diagnostic === undefined
      ? {}
      : { code: scenario.diagnostic.code }),
    refused: scenario.steps.length === 0,
  };
}

export interface CampaignRunInput {
  arm: CampaignArm;
  block: number;
  index: number;
  runId: string;
}

/** Ce que le driver appelle pour produire un run. Injecté, donc testable. */
export type CampaignExecutor = (
  input: CampaignRunInput
) => Promise<RecordedRun>;

/**
 * Le protocole, dans l'ordre du document : pour chaque bloc, un run par bras et
 * par position, en alternant référence puis candidat.
 */
export async function runArm(input: {
  campaign: CampaignPlan;
  config: Config;
  input: CampaignRunInput;
}): Promise<RecordedRun> {
  const { arm, block, index } = input.input;
  const runDir = join(
    input.campaign.dataDir,
    arm.name,
    String(block),
    String(index)
  );
  await mkdir(runDir, { recursive: true });
  const cli = join(arm.worktree, "apps/canary-pr-qa/dist/cli.js");
  const startedAt = Date.now();
  try {
    await run(
      process.execPath,
      [
        cli,
        "run",
        input.campaign.prUrl,
        "--preview",
        input.campaign.previewUrl,
        "--no-publish",
      ],
      {
        env: {
          ...process.env,
          ...arm.env,
          QA_DATA_DIR: runDir,
          QA_REPLAY_BUNDLE: "false",
        },
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
      }
    );
  } catch (error) {
    // Aucun résultat n'est inventé : un run qui n'a pas abouti est enregistré
    // comme incomplet, et il ne compte ni comme vert ni comme évaluable.
    logger.warn(
      {
        arm: arm.name,
        block,
        index,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      },
      "Campaign run did not complete"
    );
    return incompleteRun(arm, block, index, startedAt);
  }
  return readRecordedRun({ arm, block, index, runDir, startedAt });
}

function incompleteRun(
  arm: CampaignArm,
  block: number,
  index: number,
  startedAt: number
): RecordedRun {
  return {
    arm: arm.name,
    assertions: [],
    block,
    incomplete: true,
    index,
    outcome: "incomplete",
    runId: `${arm.name}-b${block}-r${index}`,
    scenarios: [],
    sha: arm.commit,
    startedAt,
  };
}

async function readRecordedRun(input: {
  arm: CampaignArm;
  block: number;
  index: number;
  runDir: string;
  startedAt: number;
}): Promise<RecordedRun> {
  const entries = await readdir(input.runDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(input.runDir, entry.name, "result.json");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const result = JSON.parse(raw) as {
      outcome: string;
      sha?: string;
      tokens?: number;
      scenarios: {
        outcome: string;
        diagnostic?: { code: string };
        steps: unknown[];
        assertions: {
          passed: boolean;
          preMatched?: boolean;
          changed?: boolean;
          verification?: string;
        }[];
      }[];
    };
    return {
      arm: input.arm.name,
      assertions: result.scenarios.flatMap((scenario) =>
        scenario.assertions.map((assertion) => recordAssertion(assertion))
      ),
      block: input.block,
      index: input.index,
      outcome: result.outcome,
      runId: entry.name,
      scenarios: result.scenarios.map((scenario) => recordScenario(scenario)),
      sha: result.sha ?? input.arm.commit,
      ...(result.tokens === undefined ? {} : { tokens: result.tokens }),
    };
  }
  return incompleteRun(input.arm, input.block, input.index, input.startedAt);
}

/** Écrit l'artefact de campagne, en ajoutant les runs au fur et à mesure. */
export async function appendRunRecord(
  dataDir: string,
  record: RecordedRun
): Promise<void> {
  const path = join(dataDir, "campaign-runs.jsonl");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(record)}\n`, { flag: "a" });
}

/** Les runs déjà enregistrés, relus pour recalculer sans relancer. */
export async function readRunRecords(dataDir: string): Promise<RecordedRun[]> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, "campaign-runs.jsonl"), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedRun);
}
