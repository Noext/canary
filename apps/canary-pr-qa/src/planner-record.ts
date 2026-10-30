import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@usecanary/logger";
import type { Config } from "./config.js";
import { diagnose } from "./diagnostics.js";
import type { ModelResponseRecord } from "./model-capture.js";
import type { RunScope } from "./run-scope.js";

/**
 * Ce que le run conserve du planificateur, sous `<run>/_planner/` : les entrées
 * exactes de l'appel (`inputs.json`) et chaque réponse payée
 * (`response-<n>.json`). Rien de cela ne dépend de l'issue du run — ni d'un plan
 * accepté, ni de `QA_REPLAY_BUNDLE` — : c'est la matière du rejugement hors
 * ligne (`rejudge.ts`), gratuit, sans modèle, sans navigateur, sans réseau.
 *
 * Les fichiers sont privés (0600, dossier 0700) et passés par `redact`. Une
 * écriture qui échoue est journalisée et n'échoue jamais le run.
 */
export const PLANNER_DIR = "_planner";

const logger = createLogger({ name: "pr-qa-planner-record" });

/** Le nom du fichier d'une réponse. */
export function responseFile(call: number): string {
  return `response-${call}.json`;
}

/**
 * Branche l'enregistrement des réponses du modèle sur le run. L'écriture est
 * synchrone : le crochet est appelé juste avant un contrôle de budget qui peut
 * lever, et la réponse doit être sur disque quand il lève.
 */
export function recordModelResponses(
  scope: RunScope | undefined,
  root: string,
  phase: () => string
): void {
  if (!scope) {
    return;
  }
  scope.onModelResponse = (record) => writeResponse(root, record, phase());
}

function writeResponse(
  root: string,
  record: ModelResponseRecord,
  phase: string
): void {
  try {
    const dir = join(root, PLANNER_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Une tentative perdue garde son propre fichier : la reprise qui la suit
    // porte le même rang d'appel et ne doit pas l'écraser.
    const file = record.lost
      ? `response-${record.call}-lost-${record.lost.attempt}.json`
      : responseFile(record.call);
    writeFileSync(join(dir, file), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // L'événement nomme la réponse et son verdict, jamais son contenu.
    appendFileSync(
      join(root, "events.jsonl"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        phase,
        modelResponse: {
          call: record.call,
          contentChars: record.contentChars,
          file: `${PLANNER_DIR}/${file}`,
          finishReason: record.finishReason ?? null,
          ...(record.lost ? { lostAttempt: record.lost.attempt } : {}),
          purpose: record.purpose,
          verdict: record.verdict?.kind ?? "pending",
        },
      })}\n`,
      { mode: 0o600 }
    );
  } catch (error) {
    logger.warn(
      { call: record.call, message: diagnose(error).message },
      "Planner response not persisted"
    );
  }
}

/**
 * La configuration modèle effective, sans aucun secret : de quoi savoir, en
 * relisant un run, quel modèle a répondu, avec quelle borne, quel effort de
 * raisonnement et quel mode JSON — jamais la clé, ni l'URL complète.
 */
export function effectiveModelConfig(config: Config) {
  return {
    OPENAI_MODEL: config.OPENAI_MODEL,
    baseUrlHost: URL.canParse(config.OPENAI_BASE_URL)
      ? new URL(config.OPENAI_BASE_URL).host
      : "",
    OPENAI_JSON_MODE: config.OPENAI_JSON_MODE,
    OPENAI_REASONING_EFFORT: config.OPENAI_REASONING_EFFORT,
    OPENAI_STREAM: config.OPENAI_STREAM,
    OPENAI_TEMPERATURE: config.OPENAI_TEMPERATURE,
    OPENAI_TOKEN_PARAMETER: config.OPENAI_TOKEN_PARAMETER,
    QA_CALL_MAX_TOKENS: config.QA_CALL_MAX_TOKENS,
    QA_MODEL_RETRIES: config.QA_MODEL_RETRIES,
    QA_MODEL_TIMEOUT_SECONDS: config.QA_MODEL_TIMEOUT_SECONDS,
    QA_PLAN_FILE_CHARS: config.QA_PLAN_FILE_CHARS,
    QA_PLAN_MAX_TOKENS: config.QA_PLAN_MAX_TOKENS,
    QA_RUN_MAX_COST_USD: config.QA_RUN_MAX_COST_USD,
    QA_RUN_MAX_TOKENS: config.QA_RUN_MAX_TOKENS,
  };
}
