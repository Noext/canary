import { z } from "zod";
import type { Config } from "./config.js";
import { QaError, redact } from "./diagnostics.js";

/**
 * Le jugement d'un contenu rendu par le modèle, sorti de `model.ts` pour être
 * rejoué tel quel hors ligne (`rejudge.ts`) : une réponse enregistrée est jugée
 * par exactement les mêmes fonctions que pendant le run — utilisable ou non,
 * JSON lisible ou non, schéma respecté ou non — et jamais par une copie.
 */

/**
 * Ce qu'une correction contrainte attend en retour : la forme de la réponse à
 * indices, et sa résolution en valeur. La question elle-même
 * (`ConstrainedCorrection` dans `model.ts`) n'est pas lue ici.
 */
export interface ConstrainedAnswer<T> {
  /** Schéma de la réponse attendue ; une réponse qui ne le respecte pas ne résout rien. */
  answer: z.ZodType<unknown, unknown>;
  /** Valeur résolue, ou `undefined` quand la réponse ne permet pas de la construire. */
  resolve: (answer: unknown) => T | undefined;
}

/**
 * Ce qu'une réponse refusée dit d'elle-même, et que le diagnostic doit
 * distinguer : son JSON n'a pas pu être lu (`unreadable`), ou son JSON se lit
 * parfaitement et c'est le PLAN qui viole le contrat (`schema`). Les deux
 * causes n'ont ni le même code, ni le même remède : la première est une panne
 * de forme côté modèle, la seconde un plan fautif que le modèle peut réparer si
 * on lui dit quelle règle, quel scénario et quelle étape sont en cause. Mesure
 * du lot AK : deux runs bloqués en `MODEL_JSON_INVALID` sur 199, tous deux des
 * plans parfaitement lisibles, et l'opérateur envoyé chercher une panne de
 * transport inexistante.
 *
 * `detail` est ce que le canal de correction transmet au modèle (12 violations,
 * 2 000 caractères au plus) ; `issues` est la liste COMPLÈTE, réservée au
 * diagnostic et à l'enregistrement de la réponse, et `parseError` le message
 * exact de `JSON.parse` — sans eux, un run payé ne dit pas pourquoi il a été
 * refusé (runs 5, 7 et 8 : 40 000 tokens de sortie, motif perdu).
 */
export type InvalidContent =
  | { kind: "unreadable"; detail: string; parseError?: string }
  | { kind: "schema"; detail: string; issues: string[] };

/** Plafond de violations enregistrées pour une seule réponse : généreux, mais borné. */
const RECORDED_ISSUES = 5000;

/**
 * Un compteur d'usage n'est une mesure que s'il est strictement positif. Un zéro
 * explicite n'est pas une mesure nulle mais une absence de mesure : un endpoint
 * qui zéro-remplit son `usage` ne peut donc ni créditer une tentative perdue
 * d'une réserve nulle, ni faire déclarer zéro pour un prompt réellement envoyé.
 */
export function measuredCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Sortie que l'endpoint a lui-même chiffrée au-delà de la borne transmise : le
 * champ de limite a été ignoré, donc la réponse est exactement ce que la borne
 * refusait de payer. Elle est traitée comme inutilisable
 * (`MODEL_OUTPUT_INCOMPLETE`, reprise unique comprise) au lieu d'être acceptée.
 * Un endpoint qui n'annonce pas de `completion_tokens` échappe à cette mesure —
 * son `finish_reason: "length"` et la borne transmise restent ce qui juge la
 * réponse, jamais ce qui la comptabilise (voir `deliveredOutputTokens`).
 */
export function exceededOutputBound(
  usage: { completion_tokens?: number } | undefined,
  maxTokens: number
): number | undefined {
  const reported = measuredCount(usage?.completion_tokens);
  return reported !== undefined && reported > maxTokens ? reported : undefined;
}

/**
 * Vrai quand la réponse ne peut pas porter un plan : pas de contenu, coupée par
 * sa propre borne, ou annonçant plus de sortie que demandé.
 */
export function usableResponse(
  content: string | undefined,
  finishReason: string | undefined,
  overBound: unknown
): content is string {
  return (
    Boolean(content) && finishReason !== "length" && overBound === undefined
  );
}

/**
 * Caractères de la réponse fautive conservés dans le diagnostic. Borné, sans le
 * prompt et passé par `redact` : l'extrait sert à distinguer une troncature
 * d'une dérive, jamais à recopier une réponse entière dans un rapport.
 */
const OUTPUT_EXCERPT_CHARS = 500;

/**
 * Extrait borné de la réponse fautive, avec sa position d'arrêt : le nombre de
 * caractères reçus et le `finish_reason` de l'endpoint. Une accolade non fermée à
 * la fin de l'extrait trahit une génération coupée, un JSON complet — ou du texte
 * qui n'en est pas — porte une dérive du modèle que le schéma refuse.
 */
function responseExcerpt(
  content: string,
  finishReason: string | undefined,
  config: Config
): string {
  const safe = redact(content, config);
  const excerpt = safe.slice(0, OUTPUT_EXCERPT_CHARS);
  return ` Response excerpt (${safe.length} characters, finish_reason=${finishReason ?? "none"}): ${JSON.stringify(excerpt)}${safe.length > excerpt.length ? " [truncated]" : ""}`;
}

/**
 * Message d'une génération inutilisable : la coupure observée (`finishReason`,
 * nombre de caractères) et, quand l'endpoint a ignoré la borne, la sortie qu'il a
 * lui-même annoncée — de quoi distinguer un provider qui coupe d'un provider qui
 * ignore le champ de limite.
 */
export function unusableOutputMessage(
  content: string,
  finishReason: string | undefined,
  overBound: number | undefined,
  maxTokens: number,
  config: Config
): string {
  const ignored = ` The endpoint reported ${overBound} output tokens for a ${maxTokens}-token bound.`;
  return `AI returned an empty or truncated response.${overBound === undefined ? "" : ignored}${responseExcerpt(content, finishReason, config)}`;
}

/**
 * L'erreur que porte un contenu refusé, avec la cause en tête du message et la
 * validation dans l'indice. Une seule construction pour les deux moments où elle
 * remonte : les manches de correction épuisées, et la correction que le budget
 * ne finance plus — le second ne doit jamais devenir un `RUN_BUDGET_EXCEEDED`
 * nu qui efface le contenu payé et le motif de son refus.
 */
export function invalidContentError(
  invalid: InvalidContent,
  lead: string,
  content: string,
  finishReason: string | undefined,
  config: Config
): QaError {
  const excerpt = responseExcerpt(content, finishReason, config);
  if (invalid.kind === "schema") {
    return new QaError(
      "PLAN_SCHEMA_INVALID",
      `${lead}${excerpt}`,
      `Validation: ${invalid.detail}. The plan was refused before any scenario ran: the contract is enforced, not relaxed. Fix the named scenario, step and rule; never weaken an assertion or drop a scenario to obtain a pass.`
    );
  }
  const parse = invalid.parseError ? ` (${invalid.parseError})` : "";
  return new QaError(
    "MODEL_JSON_INVALID",
    `${lead}${excerpt}`,
    `Validation: ${invalid.detail}${parse}. Check OPENAI_JSON_MODE and the run plan; never weaken assertions to obtain a pass.`
  );
}

function issueText(issue: z.ZodError["issues"][number]): string {
  return `${issue.path.join(".") || "$"}: ${issue.message}`;
}

/**
 * La valeur que porte une réponse : le schéma de l'appelant, ou la résolution
 * de la correction contrainte quand une question à indices est en attente. Une
 * réponse contrainte qui ne respecte pas son schéma ou qui ne résout rien est
 * `discarded` — le tour de correction s'arrête sans payer d'appel —, et un
 * contenu refusé rend la validation que le canal de correction transmet.
 */
export function readModelContent<T>(
  content: string,
  schema: z.ZodType<T, unknown>,
  constrained: ConstrainedAnswer<T> | undefined,
  config: Config
): { value: T } | { discarded: true } | { invalid: InvalidContent } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    if (constrained) {
      return { discarded: true };
    }
    return {
      invalid: {
        kind: "unreadable",
        detail: "Response content is not valid JSON",
        parseError: redact(
          error instanceof Error ? error.message : String(error),
          config
        ).slice(0, 500),
      },
    };
  }
  if (constrained) {
    const answer = constrained.answer.safeParse(parsed);
    const value = answer.success ? constrained.resolve(answer.data) : undefined;
    return value === undefined ? { discarded: true } : { value };
  }
  try {
    return { value: schema.parse(parsed) };
  } catch (error) {
    if (!(error instanceof z.ZodError)) {
      return {
        invalid: {
          kind: "unreadable",
          detail: redact("Response content is not valid JSON", config),
        },
      };
    }
    const validation = error.issues.slice(0, 12).map(issueText).join("; ");
    return {
      invalid: {
        kind: "schema",
        detail: redact(validation, config).slice(0, 2000),
        issues: error.issues
          .slice(0, RECORDED_ISSUES)
          .map((issue) => redact(issueText(issue), config)),
      },
    };
  }
}
