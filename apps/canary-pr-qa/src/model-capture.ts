import { createLogger } from "@usecanary/logger";
import type { Config } from "./config.js";
import { diagnose, redact } from "./diagnostics.js";
import type { InvalidContent } from "./model-content.js";
import { runScope } from "./run-scope.js";

/**
 * Capture des réponses payées du modèle.
 *
 * Mesure d'origine (runs 5, 7 et 8) : 92 181 tokens d'entrée, ~40 000 tokens de
 * sortie complets et non tronqués, jugés invalides — puis un
 * `RUN_BUDGET_EXCEEDED` nu au tour suivant. Le contenu payé, son
 * `finish_reason` et la liste des violations n'étaient conservés nulle part : ni
 * `result.json`, ni le bundle de rejeu, ni les événements. Chaque réponse est
 * désormais remise à un crochet du run (`RunScope.onModelResponse`) dès que son
 * usage est compté — AVANT tout contrôle de budget qui pourrait lever —, puis une
 * seconde fois avec le verdict qui l'a jugée.
 */

const logger = createLogger({ name: "pr-qa-model-capture" });

/** Contenu conservé par réponse : généreux (1 Mo), mais borné. */
const RECORDED_CONTENT_CHARS = 1_000_000;

/** Ce que la boucle de plan a décidé d'une réponse. */
export type ResponseVerdict =
  | { kind: "accepted" }
  | { kind: "unusable"; reason: string }
  | { kind: "unreadable"; detail: string; parseError?: string }
  | { kind: "schema"; detail: string; issues: string[] }
  | { kind: "gate"; refusal: string }
  | { kind: "discarded" };

/**
 * Une réponse payée, telle que le run la conserve. Jamais de raisonnement, de
 * clé ni d'en-tête : le contenu est passé par `redact`, et `reasoningChars` ne
 * compte que des caractères.
 */
export interface ModelResponseRecord {
  /** Rang de la réponse dans le run (`RunScope.calls` après comptage). */
  call: number;
  /** Vrai quand la réponse répond à une correction contrainte, pas au schéma. */
  constrained: boolean;
  content: string;
  /** Longueur du contenu après `redact`, avant toute borne. */
  contentChars: number;
  contentTruncated: boolean;
  durationMs: number;
  finishReason?: string;
  /**
   * Présent quand le transport a rejeté la tentative APRÈS en avoir livré une
   * part — événement illisible, erreur annoncée en fin de flux, coupure, délai,
   * corps non JSON — : son rang parmi les tentatives de cet appel.
   */
  lost?: { attempt: number };
  /** Borne de sortie transmise au fournisseur pour cet appel. */
  maxTokens: number;
  /** Première ligne du prompt système : le rôle de l'appel (plan, cible, doctor). */
  purpose: string;
  reasoningChars?: number;
  usage?: unknown;
  verdict?: ResponseVerdict;
}

export type ModelResponseHook = (record: ModelResponseRecord) => void;

/** Ce que le transport avait assemblé d'une tentative quand elle a été rejetée. */
export interface DeliveredContent {
  content: string;
  finishReason?: string;
  reasoningChars: number;
  usage?: unknown;
}

export type LostAttemptHook = (
  delivered: DeliveredContent | undefined,
  error: unknown,
  attempt: number
) => void;

/** Le rôle d'un appel, lu sur la première ligne de son prompt système. */
export function purposeOf(system: string): string {
  return (system.split("\n")[0] ?? "").slice(0, 160);
}

/** Le verdict d'un contenu refusé, avec la liste complète de ses violations. */
export function invalidVerdict(invalid: InvalidContent): ResponseVerdict {
  return invalid.kind === "schema"
    ? { kind: "schema", detail: invalid.detail, issues: invalid.issues }
    : {
        kind: "unreadable",
        detail: invalid.detail,
        ...(invalid.parseError ? { parseError: invalid.parseError } : {}),
      };
}

/** Le verdict d'une valeur que la porte de l'appelant a jugée. */
export function gateVerdict(
  rejection: string | { message: string } | undefined,
  config: Config
): ResponseVerdict {
  if (rejection === undefined) {
    return { kind: "accepted" };
  }
  const refusal = typeof rejection === "string" ? rejection : rejection.message;
  return { kind: "gate", refusal: redact(refusal, config) };
}

/**
 * Le journal des réponses d'un appel `Model.json`. Sans crochet — doctor, appel
 * hors run —, il ne fait rien. Une écriture qui échoue n'atteint jamais le run :
 * l'enregistrement est une preuve, pas une condition.
 */
export class ResponseLog {
  private current: ModelResponseRecord | undefined;
  private readonly config: Config;
  private readonly hook: ModelResponseHook | undefined;
  private readonly purpose: string;
  constructor(
    hook: ModelResponseHook | undefined,
    config: Config,
    system: string
  ) {
    this.hook = hook;
    this.config = config;
    this.purpose = purposeOf(system);
  }

  /** Enregistre une réponse comptée, avant tout contrôle de budget. */
  response(input: {
    call: number;
    constrained: boolean;
    content: string | undefined;
    durationMs: number;
    finishReason: string | undefined;
    maxTokens: number;
    reasoningChars: number | undefined;
    usage: unknown;
  }): void {
    if (!this.hook) {
      return;
    }
    this.current = this.capture(input);
    this.emit(this.current);
  }

  /**
   * Le crochet des tentatives qu'un appel perd en transport après une livraison
   * — `MODEL_STREAM_INVALID`, `MODEL_STREAM_ERROR`, `MODEL_STREAM_TRUNCATED`,
   * délai en plein flux, corps non JSON —. Elles ne sont jamais comptées comme
   * réponses, donc jamais jugées : sans ce crochet, ce qu'elles ont livré — et
   * facturé — n'était conservé nulle part. Chacune est enregistrée AVANT la
   * réservation de sa reprise, qui peut lever, sous le rang de l'appel qu'elle
   * tentait (`RunScope.calls + 1`). `started` date le premier envoi de l'appel ;
   * `pending`, la correction contrainte à laquelle il répond, s'il y en a une.
   */
  lost(started: number, pending: unknown, maxTokens: number): LostAttemptHook {
    return (delivered, error, attempt) => {
      // Rien de livré, rien de payé à conserver : un refus avant tout octet.
      if (!(this.hook && (delivered?.content || delivered?.usage))) {
        return;
      }
      const diagnostic = diagnose(error, this.config);
      this.emit({
        ...this.capture({
          call: (runScope.getStore()?.calls ?? 0) + 1,
          constrained: pending !== undefined,
          content: delivered.content,
          durationMs: Date.now() - started,
          finishReason: delivered.finishReason,
          maxTokens,
          reasoningChars: delivered.reasoningChars,
          usage: delivered.usage,
        }),
        lost: { attempt },
        verdict: {
          kind: "unusable",
          reason: `${diagnostic.code}: ${diagnostic.message}`,
        },
      });
    };
  }

  /** Complète la dernière réponse avec le verdict qui l'a jugée. */
  verdict(verdict: ResponseVerdict): void {
    if (!this.current) {
      return;
    }
    this.current = { ...this.current, verdict };
    this.emit(this.current);
  }

  /**
   * Rend le plan DÉJÀ REFUSÉ quand l'appel de correction échoue, au lieu de
   * l'échec : le plan payé repart vers l'appelant, qui rejoue ses portes. Il
   * n'est jamais déclaré valide. Un run annulé, lui, s'arrête tel quel.
   */
  keepRefused<T>(
    refused: T | undefined,
    error: unknown,
    signal: AbortSignal | undefined
  ): T {
    if (refused === undefined || signal?.aborted) {
      throw error;
    }
    const diagnostic = diagnose(error, this.config);
    logger.warn(
      { code: diagnostic.code, message: diagnostic.message },
      "Correction call failed: the refused plan is returned to its gates"
    );
    return refused;
  }

  private capture(input: Parameters<ResponseLog["response"]>[0]) {
    const safe = redact(input.content ?? "", this.config);
    return {
      call: input.call,
      constrained: input.constrained,
      content: safe.slice(0, RECORDED_CONTENT_CHARS),
      contentChars: safe.length,
      contentTruncated: safe.length > RECORDED_CONTENT_CHARS,
      durationMs: input.durationMs,
      finishReason: input.finishReason,
      maxTokens: input.maxTokens,
      purpose: this.purpose,
      reasoningChars: input.reasoningChars,
      usage: input.usage,
    };
  }

  private emit(record: ModelResponseRecord): void {
    if (!this.hook) {
      return;
    }
    try {
      this.hook(record);
    } catch (error) {
      logger.warn(
        { message: diagnose(error, this.config).message },
        "Model response not recorded"
      );
    }
  }
}
