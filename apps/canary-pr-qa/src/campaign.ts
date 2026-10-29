import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  armMetrics,
  type CampaignVerdict,
  campaignDecision,
  compareArms,
  type RecordedRun,
} from "./campaign-metrics.js";
import {
  appendRunRecord,
  type CampaignExecutor,
  runArm,
} from "./campaign-run.js";
import { type Config, validateConfiguration } from "./config.js";
import { verifyPreviewUrl } from "./preview.js";

const run = promisify(execFile);

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

export interface CampaignArm {
  /** Le commit attendu, 40 hexadécimaux : vérifié avant chaque run. */
  commit: string;
  /** Variables ajoutées pour ce bras (le drapeau qui le distingue). */
  env?: Record<string, string>;
  name: "reference" | "candidate";
  /** Dépôt de travail où ce commit est extrait et construit. */
  worktree: string;
}

export interface CampaignPlan {
  arms: readonly [CampaignArm, CampaignArm];
  /** Dossier local des runs. Jamais versionné : le driver refuse un dossier suivi. */
  dataDir: string;
  /** Commit du head de la PR : la preview doit le prouver. */
  headSha: string;
  previewUrl: string;
  prUrl: string;
}

export interface Blocker {
  code: string;
  detail: string;
  fix: string;
}

function credentialBlockers(config: Config): Blocker[] {
  const blockers: Blocker[] = [];
  if (!(config.OPENAI_API_KEY && config.OPENAI_MODEL)) {
    blockers.push({
      code: "MODEL_CREDENTIALS_MISSING",
      detail:
        "OPENAI_API_KEY ou OPENAI_MODEL absent : aucun run ne peut planifier.",
      fix: "Fournir la clé de l'endpoint IA de l'opérateur ; le driver ne consomme jamais d'API sans elle.",
    });
  }
  if (!(config.GITHUB_TOKEN || config.GITHUB_APP_ID)) {
    blockers.push({
      code: "GITHUB_CREDENTIALS_MISSING",
      detail:
        "Ni GITHUB_TOKEN ni App GitHub configurés : la PR ne peut pas être lue.",
      fix: "Configurer un jeton de lecture ou une App installée sur le dépôt de la PR.",
    });
  }
  return blockers;
}

/** Un bras est utilisable quand son commit, son HEAD réel et son CLI concordent. */
async function armBlockers(arm: CampaignArm): Promise<Blocker[]> {
  if (!/^[0-9a-f]{40}$/.test(arm.commit)) {
    return [
      {
        code: "ARM_COMMIT_INVALID",
        detail: `Le bras ${arm.name} attend un SHA complet, reçu « ${arm.commit} ».`,
        fix: "Donner les 40 caractères du commit de chaque bras.",
      },
    ];
  }
  if (!isAbsolute(arm.worktree)) {
    return [
      {
        code: "ARM_WORKTREE_INVALID",
        detail: `Le dépôt de travail du bras ${arm.name} doit être un chemin absolu.`,
        fix: "Extraire le commit du bras (git worktree add) et donner son chemin.",
      },
    ];
  }
  const blockers: Blocker[] = [];
  try {
    const { stdout } = await run("git", [
      "-C",
      arm.worktree,
      "rev-parse",
      "HEAD",
    ]);
    const head = stdout.trim();
    if (head !== arm.commit) {
      blockers.push({
        code: "ARM_SHA_MISMATCH",
        detail: `Le bras ${arm.name} est sur ${head}, attendu ${arm.commit}.`,
        fix: `git -C ${arm.worktree} checkout ${arm.commit}, puis reconstruire.`,
      });
    }
  } catch {
    blockers.push({
      code: "ARM_WORKTREE_MISSING",
      detail: `Aucun dépôt git lisible en ${arm.worktree}.`,
      fix: "Extraire le commit du bras dans ce chemin.",
    });
  }
  try {
    await readFile(join(arm.worktree, "apps/canary-pr-qa/dist/cli.js"));
  } catch {
    blockers.push({
      code: "ARM_CLI_MISSING",
      detail: `Le bras ${arm.name} n'a pas de CLI construit (${arm.worktree}).`,
      fix: "Lancer pnpm install && pnpm build dans le dépôt de travail du bras.",
    });
  }
  return blockers;
}

/**
 * Ce qui empêche la campagne de démarrer. Tous les blocages sont rendus, pas le
 * premier : un opérateur doit voir en une fois ce qui manque, et le driver ne
 * simule jamais un run pour « voir si ça marche » — un run réel est payant.
 */
export async function campaignPreflight(
  plan: CampaignPlan,
  config: Config
): Promise<{ blockers: Blocker[]; previewSha?: string }> {
  const blockers: Blocker[] = [];
  try {
    validateConfiguration(config);
  } catch (error) {
    blockers.push({
      code: "CONFIG_INVALID",
      detail: error instanceof Error ? error.message : "configuration invalide",
      fix: "Corriger .env (voir .env.example) puis relancer le préflight.",
    });
  }
  blockers.push(...credentialBlockers(config));
  const preview = await previewBlocker(plan, config);
  blockers.push(...preview.blockers);
  for (const arm of plan.arms) {
    blockers.push(...(await armBlockers(arm)));
  }
  const inside = relative(process.cwd(), resolve(plan.dataDir));
  if (!(inside.startsWith("..") || isAbsolute(inside))) {
    blockers.push({
      code: "DATA_DIR_INSIDE_REPO",
      detail: `${plan.dataDir} est dans le dépôt : les runs seraient versionnables.`,
      fix: "Donner un dossier hors du dépôt (ou ajouté au .gitignore) pour --data.",
    });
  }
  return {
    blockers,
    ...(preview.previewSha === undefined
      ? {}
      : { previewSha: preview.previewSha }),
  };
}

/** La preview doit prouver le SHA complet du head, ou le préflight le dit. */
async function previewBlocker(
  plan: CampaignPlan,
  config: Config
): Promise<{ blockers: Blocker[]; previewSha?: string }> {
  try {
    const preview = await verifyPreviewUrl(
      plan.previewUrl,
      plan.headSha,
      config
    );
    if (preview.sha === plan.headSha) {
      return { blockers: [], previewSha: preview.sha };
    }
    return {
      blockers: [
        {
          code: "PREVIEW_SHA_MISMATCH",
          detail: `La preview annonce ${preview.sha}, la campagne attend ${plan.headSha}.`,
          fix: "Attendre le déploiement du SHA complet du head, ou corriger --head.",
        },
      ],
      previewSha: preview.sha,
    };
  } catch (error) {
    return {
      blockers: [
        {
          code: "PREVIEW_UNVERIFIED",
          detail:
            error instanceof Error ? error.message : "preview non vérifiable",
          fix: "Exposer x-commit-sha (ou PREVIEW_SHA_PATH) sur la preview, et autoriser son hôte dans PREVIEW_ALLOWED_HOSTS.",
        },
      ],
    };
  }
}
