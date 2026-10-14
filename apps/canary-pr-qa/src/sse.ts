/**
 * Flux SSE d'un endpoint `chat/completions` compatible OpenAI.
 *
 * Une réponse non-streamée reste ouverte sans envoyer un octet pendant toute la génération :
 * les proxys devant l'endpoint coupent alors la requête (Cloudflare répond 524 après ~100 s),
 * ce qui rend un plan long impossible à obtenir. En streaming, les octets circulent dès le
 * premier token et la génération peut durer aussi longtemps que le modèle en a besoin.
 *
 * Ce module ne fait que deux choses, sans I/O : recoller les événements `data:` d'un flux
 * lu par morceaux, et réduire leurs deltas en une réponse de la forme non-streamée. Le
 * raisonnement du modèle (`reasoning_content`) est compté mais jamais rendu au demandeur :
 * seul le contenu JSON de la réponse lui appartient.
 */

export interface ChatUsage {
  readonly completion_tokens?: number;
  readonly prompt_tokens?: number;
  readonly total_tokens?: number;
}

export interface ChatStreamState {
  /** Contenu assemblé, delta par delta : c'est lui que le schéma valide. */
  readonly content: string;
  /** Marqueur terminal `[DONE]` reçu. */
  readonly done: boolean;
  /** Erreur annoncée par l'endpoint au milieu du flux. */
  readonly error?: string;
  /** Événements `data:` reçus, y compris ceux sans contenu utile. */
  readonly events: number;
  readonly finishReason?: string;
  /** Charges utiles illisibles : un flux cassé ne doit pas passer pour un flux vide. */
  readonly malformed: number;
  readonly reasoningChars: number;
  readonly usage?: ChatUsage;
}

export const emptyChatStream: ChatStreamState = {
  content: "",
  done: false,
  events: 0,
  malformed: 0,
  reasoningChars: 0,
};

/** Charge utile d'un bloc d'événement : les lignes `data:` recollées, commentaires exclus. */
export function sseEventData(block: string): string | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return data.length === 0 ? undefined : data.join("\n");
}

/**
 * Événements complets présents dans le tampon. `rest` conserve le bloc encore ouvert, à
 * recoller avec la lecture suivante : un événement peut être coupé au milieu d'une ligne.
 */
export function takeSseEvents(buffer: string): {
  events: string[];
  rest: string;
} {
  const events: string[] = [];
  let rest = buffer;
  for (;;) {
    const separator = /\r?\n\r?\n/.exec(rest);
    if (!separator || separator.index === undefined) {
      return { events, rest };
    }
    const data = sseEventData(rest.slice(0, separator.index));
    if (data !== undefined) {
      events.push(data);
    }
    rest = rest.slice(separator.index + separator[0].length);
  }
}

interface ChatChunk {
  choices?: {
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }[];
  error?: { message?: string } | string;
  usage?: ChatUsage;
}

/** Réduit un événement `data:` dans l'état du flux. Aucune exception : un flux illisible se voit. */
export function reduceChatStream(
  state: ChatStreamState,
  event: string
): ChatStreamState {
  if (event === "[DONE]") {
    return { ...state, done: true };
  }
  let chunk: ChatChunk;
  try {
    chunk = JSON.parse(event) as ChatChunk;
  } catch {
    return {
      ...state,
      events: state.events + 1,
      malformed: state.malformed + 1,
    };
  }
  const delta = chunk.choices?.[0]?.delta;
  // Une erreur annoncée en cours de flux doit survivre aux événements suivants : l'endpoint en
  // envoie souvent un dernier (usage, finish) après l'échec, sinon le plan serait accepté.
  const error =
    (typeof chunk.error === "string" ? chunk.error : chunk.error?.message) ??
    state.error;
  return {
    content: state.content + (delta?.content ?? ""),
    done: state.done,
    ...(error === undefined ? {} : { error }),
    events: state.events + 1,
    finishReason: chunk.choices?.[0]?.finish_reason ?? state.finishReason,
    malformed: state.malformed,
    reasoningChars:
      state.reasoningChars + (delta?.reasoning_content?.length ?? 0),
    usage: chunk.usage ?? state.usage,
  };
}
