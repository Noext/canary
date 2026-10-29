import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type Config, validateConfiguration } from "./config.js";
import { QaError, redact } from "./diagnostics.js";
import { GitHub } from "./github.js";
import { ModelCatalog, runModelConfig } from "./model-catalog.js";
import { verifyPreviewUrl } from "./preview.js";

const run = promisify(execFile);

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

/** Les 100 runs du protocole figé : 2 bras × 5 blocs × 10 runs. */
export const CAMPAIGN_TOTAL_RUNS = 100;

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
/** Un message d'erreur expurgé, borné, jamais un corps de réponse complet. */
function safeMessage(error: unknown, config: Config): string {
  const text = error instanceof Error ? error.message : "échec inconnu";
  return redact(text, config).slice(0, 300);
}

/**
 * La PR doit être lisible avec les credentials **de Canary**, pas avec ceux du
 * poste : `GitHub.context` est le chemin de production, donc c'est lui qui
 * décide. Le head qu'il renvoie est la seule vérité sur le SHA à tester ; `--head`
 * ne fait que le confirmer, et un désaccord bloque avant la dépense.
 */
async function prBlocker(
  plan: CampaignPlan,
  config: Config
): Promise<{ blockers: Blocker[]; prSha?: string }> {
  try {
    const context = await new GitHub(config).context(plan.prUrl);
    if (context.sha !== plan.headSha) {
      return {
        blockers: [
          {
            code: "PR_HEAD_MISMATCH",
            detail: `La PR est sur ${context.sha}, la campagne testerait ${plan.headSha}.`,
            fix: "Passer --head au SHA du head renvoyé par la PR, et attendre que la preview le serve.",
          },
        ],
        prSha: context.sha,
      };
    }
    return { blockers: [], prSha: context.sha };
  } catch (error) {
    return {
      blockers: [
        {
          code: "PR_UNREADABLE",
          detail: safeMessage(error, config),
          fix: "Vérifier que GITHUB_TOKEN ou l'App GitHub du service lit cette PR : un accès depuis le poste ne suffit pas, et une PR privée répond 404 sans permission.",
        },
      ],
    };
  }
}

/**
 * L'endpoint du modèle doit répondre et accepter la clé, **sans appel de
 * génération** : `ModelCatalog.list()` fait un `GET /models`, le même chemin que
 * le tableau de bord. Une clé expirée ou un hôte refusé se voit donc ici, avant
 * le premier run payé.
 */
async function modelBlocker(config: Config): Promise<Blocker[]> {
  let resolved: Config;
  try {
    resolved = runModelConfig(config);
  } catch (error) {
    return [
      {
        code: "MODEL_NOT_ALLOWED",
        detail: safeMessage(error, config),
        fix: "Choisir un modèle permis par QA_ALLOWED_MODELS, ou faire mettre à jour cette politique par l'opérateur.",
      },
    ];
  }
  try {
    const ids = await new ModelCatalog(resolved).list();
    if (ids.length === 0) {
      return [
        {
          code: "MODEL_CATALOG_EMPTY",
          detail: `Le catalogue de ${resolved.OPENAI_BASE_URL} n'expose aucun modèle autorisé.`,
          fix: "Vérifier /models et QA_ALLOWED_MODELS ; le driver n'invente pas de modèle de repli.",
        },
      ];
    }
    return [];
  } catch (error) {
    const code = error instanceof QaError ? error.code : "";
    const unauthorized = code === "HTTP_401" || code === "HTTP_403";
    return [
      {
        code: unauthorized
          ? "MODEL_UNAUTHORIZED"
          : "MODEL_ENDPOINT_UNREACHABLE",
        detail: `${code || "réseau"} : ${safeMessage(error, config)}`,
        fix: unauthorized
          ? "Remplacer OPENAI_API_KEY par une clé active pour cet endpoint (une clé expirée ou d'un autre fournisseur répond 401)."
          : "Vérifier OPENAI_BASE_URL (chemin /v1), la joignabilité depuis cette machine, et QA_ALLOWED_PROVIDER_HOSTS.",
      },
    ];
  }
}

/**
 * Sans tarifs, aucun coût maximal n'est calculable : le moteur retombe sur 0 et
 * ne peut pas réserver de budget. On bloque plutôt que de laisser partir 100 runs
 * dont personne ne connaît le prix.
 */
function pricingBlockers(config: Config): Blocker[] {
  const missing: string[] = [];
  if (!(config.QA_INPUT_COST_PER_MILLION > 0)) {
    missing.push("QA_INPUT_COST_PER_MILLION");
  }
  if (!(config.QA_OUTPUT_COST_PER_MILLION > 0)) {
    missing.push("QA_OUTPUT_COST_PER_MILLION");
  }
  if (missing.length === 0) {
    return [];
  }
  return [
    {
      code: "PRICING_MISSING",
      detail: `Tarifs absents ou nuls : ${missing.join(", ")}.`,
      fix: "Renseigner les deux tarifs par million de tokens de l'endpoint ; sans eux le coût maximal de la campagne n'est pas calculable.",
    },
  ];
}

/**
 * Le coût maximal engagé par la campagne. Aucun run ne peut dépasser
 * `QA_RUN_MAX_TOKENS` (plafond du moteur), et chaque token coûte au plus le plus
 * élevé des deux tarifs : la borne est donc `runs × plafond × tarif max`.
 */
export function maxCostEstimate(
  config: Config,
  runs: number
): { costUsd: number; runs: number; tokens: number } {
  const perMillion = Math.max(
    config.QA_INPUT_COST_PER_MILLION,
    config.QA_OUTPUT_COST_PER_MILLION
  );
  const tokens = config.QA_RUN_MAX_TOKENS * runs;
  return { costUsd: (tokens * perMillion) / 1_000_000, runs, tokens };
}

export async function campaignPreflight(
  plan: CampaignPlan,
  config: Config
): Promise<{
  blockers: Blocker[];
  maxCost?: { costUsd: number; runs: number; tokens: number };
  prSha?: string;
  previewSha?: string;
}> {
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
  const pr = await prBlocker(plan, config);
  blockers.push(...pr.blockers);
  // Sans clé, interroger le catalogue serait un appel sortant inutile : le
  // blocage de credentials suffit et le dit déjà.
  if (config.OPENAI_API_KEY && config.OPENAI_MODEL) {
    blockers.push(...(await modelBlocker(config)));
  }
  blockers.push(...pricingBlockers(config));
  const preview = await previewBlocker(plan, config);
  blockers.push(...preview.blockers);
  for (const arm of plan.arms) {
    blockers.push(...(await armBlockers(arm)));
  }
  blockers.push(...(await dataDirBlockers(plan.dataDir)));
  const priced =
    config.QA_INPUT_COST_PER_MILLION > 0 &&
    config.QA_OUTPUT_COST_PER_MILLION > 0;
  return {
    blockers,
    ...(priced
      ? { maxCost: maxCostEstimate(config, CAMPAIGN_TOTAL_RUNS) }
      : {}),
    ...(pr.prSha === undefined ? {} : { prSha: pr.prSha }),
    ...(preview.previewSha === undefined
      ? {}
      : { previewSha: preview.previewSha }),
  };
}

/**
 * Les runs ne doivent jamais être versionnables. Le test porte sur le dépôt qui
 * CONTIENT le dossier, jamais sur le répertoire courant : un dossier sous
 * `/tmp` lancé depuis `/tmp` était signalé « dans le dépôt » alors qu'il n'y en
 * a aucun — mesuré en lançant le préflight. Hors de tout dépôt, ou ignoré par
 * git, le dossier convient.
 */
async function dataDirBlockers(dataDir: string): Promise<Blocker[]> {
  const resolved = resolve(dataDir);
  let toplevel: string;
  try {
    const { stdout } = await run("git", [
      "-C",
      nearestExisting(resolved),
      "rev-parse",
      "--show-toplevel",
    ]);
    toplevel = stdout.trim();
  } catch {
    return [];
  }
  const inside = relative(toplevel, resolved);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    return [];
  }
  try {
    await run("git", ["-C", toplevel, "check-ignore", "-q", resolved]);
    return [];
  } catch {
    return [
      {
        code: "DATA_DIR_INSIDE_REPO",
        detail: `${resolved} est suivi par git : les runs seraient versionnables.`,
        fix: "Donner un dossier hors du dépôt (ou ajouté au .gitignore) pour --data.",
      },
    ];
  }
}

/** Le plus proche ancêtre qui existe, pour interroger git sur un dossier à créer. */
function nearestExisting(path: string): string {
  let current = path;
  for (;;) {
    try {
      statSync(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

/** La preview doit prouver le SHA complet du head, ou le préflight le dit. */
async function previewBlocker(
  plan: CampaignPlan,
  config: Config
): Promise<{
  blockers: Blocker[];
  maxCost?: { costUsd: number; runs: number; tokens: number };
  prSha?: string;
  previewSha?: string;
}> {
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
