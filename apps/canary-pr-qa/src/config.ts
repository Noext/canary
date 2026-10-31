import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hostAllowed } from "../../canary-daemon/src/network-policy.js";
import { QaError } from "./diagnostics.js";
import { ModelIdSchema } from "./model-catalog.js";
import { isValidPreviewHost } from "./preview-hosts.js";

/**
 * Plafond de sortie d'un seul appel modèle, en tokens : le plus grand chiffre de
 * sortie qu'un envoi peut demander. Il ne remplace pas la borne de l'appelant
 * (`QA_PLAN_MAX_TOKENS`, `QA_DOCTOR_MAX_TOKENS`) : il la ramène, et c'est ce
 * chiffre-là qui part au fournisseur, qui réserve l'enveloppe du run et qui juge
 * la réponse.
 *
 * C'est un choix de dimensionnement justifié par une mesure du lot Q, pas une
 * mesure de ce plafond : l'endpoint ne stocke pas sa `completion_tokens`, la
 * sortie d'un appel se déduit donc d'un total rapporté moins l'entrée. Les 184
 * runs du lot Q (même PR et même sha, donc la même charge utile — 238 420
 * octets, déduits du compte exact du run 1eb26f8c — remplissant son budget de
 * contexte) portent tous le même prompt ; le plus petit total à deux appels,
 * 138 937, en donne le plafond rigoureux : 69 468 tokens d'entrée, puisque les
 * sorties sont comptées au-dessus. Sur les 37 runs à un appel dont l'endpoint a
 * chiffré l'usage, la sortie par appel va de 7 741 à 57 778 tokens sous ce
 * plafond, et jusqu'à 67 641 si l'entrée n'en vaut que 59 605 (238 420 octets à
 * quatre octets par token). Dix des trente-sept dépassent déjà 32 768, l'ancienne
 * valeur.
 *
 * Un plan de 7 à 8 scénarios — les 18 runs à un appel de cette taille — pèse de
 * 24 499 à 39 761 octets de JSON et de 77 209 à 109 666 tokens comptés, soit au
 * plus 50 061 tokens de sortie : le raisonnement se paie dans le même champ de
 * limite, donc la sortie vaut plusieurs fois la taille du JSON qu'elle porte.
 * 98 304 couvre ce pire cas avec 96 % de marge et 67 641 avec 45 %, et laisse
 * quatre envois tenir dans `QA_RUN_MAX_TOKENS` = 1 000 000 (119 402 d'entrée
 * plus 98 304 par envoi).
 */
export const MAX_OUTPUT_TOKENS_PER_CALL = 98_304;

/**
 * Plancher de `QA_CALL_MAX_TOKENS` : la plus petite valeur qui porte encore le
 * JSON d'un plan réellement mesuré. Le plus gros plan du lot Q (8 scénarios)
 * vaut 39 761 octets, soit environ 12 000 tokens à 3,5 octets par token.
 *
 * Il ne porte que ce JSON, jamais le raisonnement qui le précède : la sortie
 * mesurée d'un plan de 7 à 8 scénarios monte jusqu'à 50 061 tokens, et un
 * opérateur réglé au plancher tronque ces plans-là. C'est une borne basse
 * assumée, pas un réglage recommandé ; le défaut la dépasse de six fois.
 */
export const MIN_OUTPUT_TOKENS_PER_CALL = 16_384;

const envSchema = z.object({
  QA_ALLOW_PRIVATE_PREVIEWS: z.enum(["true", "false"]).default("false"),
  QA_WEBHOOK_MAX_RUNS_PER_HOUR: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(60),
  QA_WEBHOOK_REPO_MAX_RUNS_PER_HOUR: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(20),
  QA_PREVIEW_WAIT_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(7200)
    .default(900),
  QA_AUTO_RUNS: z.enum(["true", "false"]).default("true"),
  QA_AUTO_PREVIEW_WAIT_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(1800),
  QA_BASELINE_URL_TEMPLATE: z.string().default(""),
  DATABASE_URL: z.string().default(""),
  QA_RUN_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(7200)
    // Mesuré sur la PR #20 (reasoning high) : une génération de plan prend
    // 190 à 275 s, et un run complet en enchaîne jusqu'à trois (génération,
    // correction, réécriture sur invariant) avant l'exécution Chromium.
    .default(2400),
  // Une seule planification réserve son entrée bornée (~158 000 tokens sur la
  // PR #20) plus sa sortie (98 304) : l'ancien défaut de 100 000 refusait tout
  // run avant le premier appel. Cette enveloppe est la SEULE borne par run tant
  // que QA_INPUT/OUTPUT_COST_PER_MILLION valent 0 (leur défaut) : le coût
  // calculé reste alors nul et QA_RUN_MAX_COST_USD ne se déclenche jamais. Un
  // modèle du catalogue autre qu'OPENAI_MODEL est aussi tarifé à 0
  // (`runModelConfig`). Les campagnes, elles, exigent un tarif (PRICING_MISSING).
  QA_RUN_MAX_TOKENS: z.coerce.number().int().min(1000).default(1_000_000),
  QA_RUN_MAX_COST_USD: z.coerce.number().positive().default(10),
  QA_INPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(0),
  QA_OUTPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(0),
  QA_USERS_FILE: z.string().default(""),
  QA_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),
  QA_STORAGE_MAX_GB: z.coerce.number().positive().default(20),
  QA_BROWSER_SERVICE_URL: z.string().default(""),
  QA_BROWSER_SERVICE_TOKEN: z.string().default(""),
  QA_BROWSER_HOST: z.string().default("127.0.0.1"),
  QA_BROWSER_PORT: z.coerce.number().int().default(8790),
  QA_FIXTURES_FILE: z.string().default(""),
  GITHUB_APP_ID: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY_FILE: z.string().default(""),
  GITHUB_INSTALLATION_ID: z.string().default(""),
  GITHUB_WEBHOOK_SECRET: z.string().default(""),
  QA_OIDC_ISSUER: z.string().default(""),
  QA_OIDC_AUDIENCE: z.string().default(""),
  QA_OIDC_JWKS_URL: z.string().default(""),
  QA_ALLOWED_PROVIDER_HOSTS: z.string().default(""),
  QA_RAW_EVIDENCE: z.enum(["true", "false"]).default("false"),
  // Local replay bundles include source and page text; disabled unless explicitly enabled.
  QA_REPLAY_BUNDLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  GITHUB_TOKEN: z.string().default(""),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  GITHUB_ALLOWED_REPOS: z.string().default(""),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: ModelIdSchema.default("opencode-go/deepseek-v4.1-flash"),
  QA_ALLOWED_MODELS: z.string().default(""),
  OPENAI_JSON_MODE: z.enum(["true", "false"]).default("true"),
  OPENAI_TOKEN_PARAMETER: z
    .enum(["max_tokens", "max_completion_tokens"])
    .default("max_tokens"),
  OPENAI_TEMPERATURE: z
    .union([z.literal(""), z.coerce.number().min(0).max(2)])
    .default(""),
  // Streamé par défaut : un proxy devant l'endpoint coupe une réponse non streamée (~100 s)
  // avant la fin d'une longue génération. `false` revient au corps complet, pour un endpoint
  // qui ne sait pas streamer.
  OPENAI_STREAM: z.enum(["true", "false"]).default("true"),
  // Vide : le paramètre n'est pas envoyé (compatible avec les modèles qui le rejettent).
  OPENAI_REASONING_EFFORT: z
    .enum(["", "minimal", "low", "medium", "high"])
    .default(""),
  QA_DATA_DIR: z.string().default("./qa-data"),
  QA_POLICY_DIR: z.string().default(""),
  QA_API_TOKEN: z.string().default(""),
  QA_HOST: z.string().default("127.0.0.1"),
  QA_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  QA_MAX_STEPS: z.coerce.number().int().min(1).max(100).default(25),
  QA_MAX_SCENARIOS: z.coerce.number().int().min(1).max(20).default(8),
  // Plafond haut volontaire : un endpoint streamé peut générer longtemps, et un modèle de
  // raisonnement peut légitimement consommer plus que l'ancien plafond avant d'émettre son JSON.
  QA_PLAN_MAX_TOKENS: z.coerce
    .number()
    .int()
    .min(128)
    .max(1_000_000)
    // Le modèle par défaut raisonne (DeepSeek V4.1 Flash, effort high par
    // défaut côté fournisseur) et paie son raisonnement dans max_tokens : à
    // 8 000 puis 32 000, deux runs réels ont rendu 0 caractère
    // (finish_reason=length) ; les plans complets mesurés consomment 36 655 à
    // 42 524 tokens de sortie. Aligné sur le plafond d'un appel.
    .default(MAX_OUTPUT_TOKENS_PER_CALL),
  QA_DOCTOR_MAX_TOKENS: z.coerce
    .number()
    .int()
    .min(128)
    .max(1_000_000)
    .default(1024),
  /**
   * Plafond de sortie d'un appel, appliqué à chaque envoi par `Model.json`.
   * Une valeur plus basse resserre la dépense d'un appel ; la relever est un
   * choix explicite, et le plafond du plan ne peut plus la contourner.
   *
   * Le plancher (`MIN_OUTPUT_TOKENS_PER_CALL`) est la taille sous laquelle le
   * JSON d'un plan réellement mesuré ne tient plus ; 0 est refusé, jamais lu
   * comme « illimité » : c'est l'absence de borne sur un envoi qui a brûlé
   * l'enveloppe du run 1eb26f8c, et un plafond désactivé ne se verrait qu'au
   * moment où le run bloque sur son budget total.
   */
  QA_CALL_MAX_TOKENS: z.coerce
    .number()
    .int()
    .min(MIN_OUTPUT_TOKENS_PER_CALL)
    .max(1_000_000)
    .default(MAX_OUTPUT_TOKENS_PER_CALL),
  QA_STEP_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  QA_MODEL_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(900)
    // Mesuré : un plan en reasoning high arrive en 190 à 275 s ; 120 s coupait
    // une génération déjà payée (run 51751951, TIMEOUT à 166 s).
    .default(600),
  /**
   * Reprises d'un appel modèle qui n'a rien produit : transport interrompu
   * (reset, timeout, connexion coupée), ou statut transitoire de l'endpoint
   * (503, 429). 0 désactive le repli ; les délais 1/4/10 s restent dans le client
   * modèle — un `Retry-After` reçu sur le 503 ou le 429 est suivi quand il reste
   * sous son plafond —, et un plafond absolu d'appels par run borne la dépense.
   */
  QA_MODEL_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  /**
   * Ce que les fichiers modifiés, EN ENTIER, peuvent peser dans le message du
   * planificateur.
   *
   * Zéro par défaut, et ce n'est pas un renoncement : le lot HH (10 runs, même
   * build, même PR, même modèle) est passé à 10/10 avec 86 scénarios et 2,44 M de
   * tokens là où le même build avec 120 000 caractères de fichiers entiers
   * donnait 5/10 et 3,83 M. Le message plus court est lu plus fidèlement ; les
   * fichiers entiers restent disponibles pour un dépôt où la jointure manque
   * vraiment, mais ils ne sont plus payés par défaut.
   */
  /**
   * Rejouer le préfixe de navigation du plan pour observer la vue réellement
   * testée, puis faire réécrire le plan une fois. Coût : une session navigateur
   * et un appel de planification supplémentaires ; bénéfice mesurable, donc
   * désactivable pour comparer.
   */
  /**
   * Réécrire le plan, une fois, quand l'exécution mesure qu'une vérification ne
   * peut rien prouver (transition sur une valeur qui ne bouge pas). Le contrat
   * révisé repasse tous les refus puis est réexécuté : rien n'est requalifié à la
   * volée. Le drapeau existe pour mesurer ce que coûte la passe supplémentaire.
   */
  QA_REPLAN_ON_INVARIANT: z
    .union([z.boolean(), z.enum(["true", "false"])])
    // Activé : sur le premier plan réel de la PR #20, la réécriture d'une
    // transition impossible mesurée par Chromium a fait passer le run de 6/7 à
    // 7/7 (run f2defd79), le plan révisé repassant toutes les portes.
    .default(true)
    .transform((value) => value === true || value === "true"),
  /**
   * Un défaut de contrat qui ne concerne qu'un scénario (exigence non témoignée,
   * source non déclarée, contrat hors budget) coûte-t-il le run entier, ou
   * seulement le scénario ? Mesuré : la moitié des runs bloqués du corpus
   * produisent ZÉRO scénario pour l'un de ces trois défauts. Le drapeau existe
   * pour comparer les deux politiques sur des lots réels avant de trancher.
   */
  QA_PER_SCENARIO_COVERAGE: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .default(false)
    .transform((value) => value === true || value === "true"),
  /**
   * Le chemin observe→act : l'objectif et les preuves viennent du diff, les
   * actions sont résolues à l'exécution depuis l'instantané observé. Désactivé
   * par défaut : le plan figé reste le bras de comparaison jusqu'à ce que la
   * campagne ait tranché (voir docs/pr-qa-architecture-target.md).
   */
  QA_OBSERVE_ACT: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .default(false)
    .transform((value) => value === true || value === "true"),
  QA_VIEW_PROBE: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .default(false)
    .transform((value) => value === true || value === "true"),
  QA_PLAN_FILE_CHARS: z.coerce.number().int().min(0).max(1_000_000).default(0),
  /**
   * Fenêtre de contexte du modèle configuré, en TOKENS. Le fournisseur ne
   * l'expose pas (`/v1/models` ne rend que id/object/owned_by), donc elle est
   * déclarée ici : c'est elle qui borne l'entrée du planificateur, et non la
   * taille du payload (une borne qui s'étire avec ce qu'elle mesure ne garantit
   * rien). La valeur par défaut est la fenêtre du modèle par défaut
   * (OPENAI_MODEL), pas une borne prudente : elle vaut pour TOUT modèle, y
   * compris un modèle choisi par run dans QA_ALLOWED_MODELS (`runModelConfig`
   * ne change que l'identifiant et le tarif). Configurer un modèle de fenêtre
   * plus petite sans abaisser cette valeur désarme le refus local « PR context
   * exceeds model budget » : le payload trop gros part, et c'est le fournisseur
   * qui le refuse.
   */
  QA_MODEL_CONTEXT_TOKENS: z.coerce
    .number()
    .int()
    .min(8192)
    .max(4_000_000)
    // Fenêtre du modèle par défaut (opencode-go/deepseek-v4.1-flash), confirmée
    // par l'opérateur. Avec 131 072, le budget du planificateur — fenêtre moins
    // deux sorties de plan — était négatif : tout run était refusé. Un autre
    // modèle exige de déclarer sa propre fenêtre (voir la JSDoc ci-dessus).
    .default(1_000_000),
  QA_CONTEXT_CHARS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(1_000_000)
    .default(120_000),
  /**
   * Excerpts de consommateurs (fichiers non modifiés qui utilisent un symbole
   * touché, voir consumer-context.ts), pris sur ce que `QA_CONTEXT_CHARS` laisse
   * après le contexte de dépendances ; 0 désactive la recherche.
   */
  QA_CONSUMER_CONTEXT_CHARS: z.coerce
    .number()
    .int()
    .min(0)
    .max(200_000)
    .default(24_000),
  /** Plafond de fichiers source lus pour chercher les consommateurs. */
  QA_CONSUMER_SCAN_FILES: z.coerce.number().int().min(1).max(5000).default(400),
  PREVIEW_ALLOWED_HOSTS: z.string().default(""),
  PREVIEW_URL_TEMPLATE: z.string().default(""),
  PREVIEW_SHA_PATH: z.string().default(""),
  PREVIEW_SHA_HEADER: z.string().default("x-commit-sha"),
  PREVIEW_ENVIRONMENT: z.string().default("preview"),
  ARTIFACT_BASE_URL: z.string().default(""),
  ARTIFACT_PUBLIC: z.enum(["true", "false"]).default("false"),
  CANARY_CLI_PATH: z
    .string()
    .default(
      fileURLToPath(new URL("../../canary/dist/cli.js", import.meta.url))
    ),
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  // The environment list is the one allowlist that does not pass
  // `normalizePreviewHosts`, so it is split into what this process may enforce
  // and what it must not. Every process gets its configuration here - including
  // `browser` and `egress`, which never run the boot check and, without
  // `QA_POLICY_DIR`, never apply a published policy either - so an entry the
  // dashboard would refuse can never reach a network boundary. `invalid` is
  // reported by `validateConfiguration` instead of being dropped in silence.
  const environmentHosts = parsed.PREVIEW_ALLOWED_HOSTS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allowedHosts = environmentHosts.filter(isValidPreviewHost);
  return {
    ...parsed,
    PREVIEW_ALLOWED_HOSTS: allowedHosts.join(","),
    QA_DATA_DIR: resolve(parsed.QA_DATA_DIR),
    QA_POLICY_DIR: parsed.QA_POLICY_DIR ? resolve(parsed.QA_POLICY_DIR) : "",
    allowedRepos: parsed.GITHUB_ALLOWED_REPOS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    autoRuns: parsed.QA_AUTO_RUNS === "true",
    allowedHosts,
    invalidAllowedHosts: environmentHosts.filter(
      (host) => !isValidPreviewHost(host)
    ),
  };
}
export type Config = ReturnType<typeof loadConfig> & {
  githubPrivateKey?: string;
  githubInstallations?: Record<string, string>;
  /**
   * Repositories (lowercase `owner/repository`) whose pull requests may start a
   * run without an operator. Present only when the dashboard-managed GitHub App
   * is connected; `undefined` means every entry of `allowedRepos` is automatic,
   * which keeps the legacy `GITHUB_TOKEN` + `GITHUB_ALLOWED_REPOS` setup working.
   */
  automaticRepos?: string[];
};

function validEndpoint(input: string, origin = false): boolean {
  try {
    const url = new URL(input);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!origin || url.pathname === "/")
    );
  } catch {
    return false;
  }
}
function serviceProblems(config: Config) {
  const problems: string[] = [];
  if (
    config.QA_API_TOKEN.length < 24 ||
    /replace-with|changeme/i.test(config.QA_API_TOKEN)
  ) {
    problems.push(
      "Set QA_API_TOKEN to at least 24 random characters; replace the example placeholder"
    );
  }
  if (legacyGitHubMissing(config)) {
    problems.push(
      "Configure a GitHub credential and GITHUB_ALLOWED_REPOS for the legacy file service; use PostgreSQL for UI onboarding"
    );
  }
  if (
    config.GITHUB_APP_ID &&
    !(
      config.githubPrivateKey ||
      (config.GITHUB_INSTALLATION_ID && config.GITHUB_APP_PRIVATE_KEY_FILE)
    )
  ) {
    problems.push(
      "Set GITHUB_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY_FILE together with GITHUB_APP_ID"
    );
  }
  if (
    config.GITHUB_WEBHOOK_SECRET &&
    config.GITHUB_WEBHOOK_SECRET.length < 32
  ) {
    problems.push(
      "GITHUB_WEBHOOK_SECRET must contain at least 32 random characters"
    );
  }
  if (
    config.QA_BROWSER_SERVICE_URL &&
    config.QA_BROWSER_SERVICE_TOKEN.length < 32
  ) {
    problems.push(
      "QA_BROWSER_SERVICE_TOKEN must contain at least 32 random characters"
    );
  }
  if (
    config.QA_OIDC_ISSUER &&
    !(config.QA_OIDC_AUDIENCE && config.QA_OIDC_JWKS_URL)
  ) {
    problems.push(
      "Set QA_OIDC_AUDIENCE and QA_OIDC_JWKS_URL with QA_OIDC_ISSUER"
    );
  }
  return problems;
}
export function validateConfiguration(config: Config, service = false) {
  const problems: string[] = [];
  for (const key of ["OPENAI_BASE_URL", "GITHUB_API_URL"] as const) {
    if (!validEndpoint(config[key])) {
      problems.push(
        `${key} must be an HTTP(S) endpoint without embedded credentials, query or fragment`
      );
    }
  }
  if (["configured-model", "your-model-name"].includes(config.OPENAI_MODEL)) {
    problems.push("Set OPENAI_MODEL to the actual endpoint's model identifier");
  }
  if (
    !config.allowedHosts.length ||
    config.allowedHosts.includes("preview.example.com")
  ) {
    problems.push(
      "Set PREVIEW_ALLOWED_HOSTS to the exact reachable preview hosts (including ports)"
    );
  }
  // The `.env` list is already sanitized by `loadConfig`; report what it had to
  // drop, which is otherwise an allowlist that silently shrank.
  if (config.invalidAllowedHosts.length) {
    problems.push(
      `PREVIEW_ALLOWED_HOSTS entries must be host, host:port, *.domain or *.domain:port over a domain you control: ${config.invalidAllowedHosts.join(", ")}`
    );
  }
  if (config.allowedRepos.some((repo) => !/^[\w.-]+\/[\w.-]+$/.test(repo))) {
    problems.push("GITHUB_ALLOWED_REPOS entries must use owner/repository");
  }
  if (
    config.ARTIFACT_BASE_URL &&
    !validEndpoint(config.ARTIFACT_BASE_URL, true)
  ) {
    problems.push(
      "ARTIFACT_BASE_URL must be an HTTP(S) origin without a path or credentials"
    );
  }
  if (service) {
    problems.push(...serviceProblems(config));
  }
  if (problems.length) {
    throw new QaError(
      "CONFIG_INVALID",
      problems.join("; "),
      "Edit .env using .env.example, then run doctor again. No secrets are printed by doctor."
    );
  }
}

export function validatePreviewUrl(input: string, config: Config): URL {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Invalid preview URL");
  }
  if (!hostAllowed(url, config.allowedHosts)) {
    throw new QaError(
      "PREVIEW_HOST_NOT_ALLOWED",
      `Preview host ${url.host} is not in PREVIEW_ALLOWED_HOSTS`,
      "Add the hostname and port to PREVIEW_ALLOWED_HOSTS - exact, or as *.domain to cover its subdomains - after verifying it is the intended test environment."
    );
  }
  return url;
}

function legacyGitHubMissing(config: Config) {
  return !(
    config.DATABASE_URL ||
    (config.allowedRepos.length &&
      (config.GITHUB_TOKEN || config.GITHUB_APP_ID))
  );
}
