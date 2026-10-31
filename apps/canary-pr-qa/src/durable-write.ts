import type { PrContext } from "./github.js";
import type { SourceLineMaterial } from "./schema.js";

/**
 * Le diff revendique-t-il un état qui survit au rechargement ?
 *
 * Une assertion `persisted` recharge la page puis relit la valeur. Quand aucune
 * ligne du diff — ajoutée OU retirée — n'écrit un stockage (navigateur, cookie,
 * base) ni n'appelle le réseau (fetch, axios, server action, action de
 * formulaire, mutation…), l'état vit en mémoire de la vue : un rechargement
 * l'efface sur la base comme sur la tête, et la relecture mesure le
 * rechargement, pas la PR. Mesuré sur le banc pharmania (PR #20 run 1, f1
 * run 1) : faux rouge, alors que la PR documente « aucune persistance
 * serveur ».
 *
 * La règle penche toujours du côté du rechargement : un motif trop large ne
 * coûte qu'un faux rouge déjà connu, un motif trop étroit pourrait coûter un
 * faux vert. Les lignes retirées comptent autant que les ajoutées — une
 * régression qui SUPPRIME l'écriture `localStorage` doit garder sa relecture
 * après rechargement — et les lignes de contexte aussi : le diff touche alors
 * du code qui lit ou écrit un état durable. Un fichier sans patch textuel,
 * hors ressource binaire, est illisible : il compte comme une écriture.
 */
const DURABLE_WRITE_WORDS = [
  "save",
  "sync",
  "submit",
  "upload",
  "send",
  "store",
  "commit",
  "api",
  "request",
  "remote",
  "server",
  "database",
  "db",
  "sql",
  "query",
  "cache",
  "write",
  "post",
  "put",
];
const capitalized = DURABLE_WRITE_WORDS.map(
  (word) => `${word[0]?.toUpperCase()}${word.slice(1)}`
);
const DURABLE_WRITE_PATTERNS = [
  // Stockage navigateur, cookies, cache hors ligne.
  /storage|cookie|indexeddb|\bidb\b|dexie|localforage|pouchdb|caches\.|serviceworker/i,
  // Réseau et clients de données.
  /fetch|axios|xmlhttprequest|sendbeacon|websocket|eventsource|graphql|\bgql\b|trpc|apollo|urql|supabase|firebase|firestore|prisma|drizzle|mongoose|sequelize|knex|typeorm/i,
  // Server action, action de formulaire, mutation. `data-x-action=` n'est
  // qu'un attribut de repérage, pas une action de formulaire.
  /["'`]use server["'`]|server\s*action|formaction|useactionstate|useformstate|(?<![\w-])action\s*=|mutat/i,
  // Verbe HTTP ou SQL d'écriture.
  /method\s*[:=]\s*["'`](?:post|put|patch|delete)|\.(?:post|put|patch|delete)\s*[(<]|\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|upsert/i,
  /\b(?:POST|PUT|PATCH|DELETE)\b/,
  // `persist` de zustand, redux-persist… « persistance » est un mot de
  // commentaire en français, pas un appel.
  /persist(?!ance)/i,
  // L'état d'URL survit lui aussi au rechargement.
  /pushstate|replacestate|searchparams|location\.(?:hash|search|href|assign|replace)|router\.(?:push|replace)|usequerystate|nuqs|history\.state/i,
  // Une aide d'écriture dont le nom seul trahit l'intention : `saveDraft`,
  // `onSubmit`, `useStore`, `API_URL`…
  new RegExp(
    `(?:^|[^A-Za-z])(?:${[
      ...DURABLE_WRITE_WORDS,
      ...capitalized,
      ...DURABLE_WRITE_WORDS.map((word) => word.toUpperCase()),
    ].join("|")})(?![a-z])`
  ),
  new RegExp(`[a-z0-9](?:${capitalized.join("|")})(?![a-z])`),
];
/** Prose : sa ligne ne s'exécute pas, son vocabulaire ne revendique rien. */
const PROSE_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
/** Ressource binaire : sans patch, et incapable d'écrire quoi que ce soit. */
const BINARY_ASSET =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|pdf|mp3|mp4|webm)$/i;
const diffFiles = new WeakMap<SourceLineMaterial[], PrContext["files"]>();
const claims = new WeakMap<SourceLineMaterial[], boolean>();

/**
 * Attache au matériel du diff les fichiers dont il sort. Le matériel ne garde
 * que les lignes d'après changement ; la règle a besoin des lignes retirées.
 */
export function bindDiffFiles(
  material: SourceLineMaterial[],
  files: PrContext["files"]
): SourceLineMaterial[] {
  diffFiles.set(material, files);
  return material;
}

function fileClaimsDurableWrite(file: PrContext["files"][number]): boolean {
  if (PROSE_FILE.test(file.filename)) {
    return false;
  }
  if (!file.patch) {
    return !BINARY_ASSET.test(file.filename);
  }
  // Les lignes de contexte et l'en-tête `@@` comptent aussi : une régression
  // peut casser la relecture d'un stockage existant (`if (saved)` devenu
  // `if (!saved)`) sur une ligne sans mot-clé, à côté du `getItem` intact.
  return file.patch
    .split("\n")
    .some(
      (raw) =>
        !(raw.startsWith("+++ ") || raw.startsWith("--- ")) &&
        DURABLE_WRITE_PATTERNS.some((pattern) => pattern.test(raw))
    );
}

/**
 * Vrai quand le diff écrit (ou cessait d'écrire) un état durable, en touche
 * le voisinage, ou quand la question ne peut pas être tranchée : matériel sans
 * fichiers liés — test unitaire, rejeu ciblé — ou diff vide. Faux seulement
 * quand chaque ligne du patch a été lue et qu'aucune ne revendique d'écriture.
 */
export function durableWriteClaimed(material: SourceLineMaterial[]): boolean {
  const known = claims.get(material);
  if (known !== undefined) {
    return known;
  }
  const files = diffFiles.get(material);
  const claimed =
    files === undefined ||
    files.length === 0 ||
    files.some((file) => fileClaimsDurableWrite(file));
  claims.set(material, claimed);
  return claimed;
}
