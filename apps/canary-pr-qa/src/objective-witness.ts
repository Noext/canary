import { foldTypography } from "./canary.js";
import { QaError } from "./diagnostics.js";
import type { PrContext } from "./github.js";
import type { Plan, Scenario } from "./schema.js";

/**
 * Le témoin de l'objectif : la preuve d'un scénario doit LIRE quelque chose que
 * le diff produit.
 *
 * Incident mesuré : un diff d'une ligne inverse le signe d'une valeur calculée
 * dans un module pur ; le plan prend pour objectif « le titre de la vue
 * d'accueil est masqué après le clic de navigation ». Cet objectif passe sur la
 * tête ET passerait identiquement sur la base, quel que soit le diff : il prouve
 * la navigation, pas le changement, et le run a été publié vert.
 *
 * La règle est STRUCTURELLE, jamais une lecture d'intention. Les sources sont
 * les lignes que le diff AJOUTE ou RETIRE dans les `sourceFiles` du scénario, et
 * la citation de l'exigence que l'assertion cite. Les lignes de contexte d'un
 * hunk existent avant comme après le changement ; la prose `behavior`, écrite
 * par le planificateur, et l'instantané de découverte ne comptent jamais : ils
 * ne peuvent pas blanchir une cible.
 *
 * - Lecture positive de présence ou d'adresse (`visible`, `count` > 0, `url`) :
 *   ce qu'elle observe (nom accessible, sélecteur, valeur de cible, adresse —
 *   jamais le nombre d'un `count`) est témoin quand une de ses suites de mots est
 *   une sous-suite CONTIGUË d'un identifiant ou d'un mot des sources
 *   (`[data-variance-cents]` lit `varianceCents` ; `[data-x-state]` ne lit pas
 *   `xVarianceCents` par son seul préfixe), ou quand le libellé entier est un
 *   littéral que les sources écrivent (chaîne, texte JSX, nom d'attribut,
 *   `role="…"`) — ce qui rend témoin un libellé fait de mots courts ou
 *   structurels (« CSV », « Export »). Une adresse lit aussi le chemin d'un
 *   fichier que le diff AJOUTE (une route par fichier n'existait pas avant). Un
 *   `count` dont le nombre attendu est écrit dans la citation qu'il cite est
 *   témoin.
 * - Lecture négative (`hidden`, `count` attendu 0) en `state` : elle passe aussi
 *   sans cible ; témoin seulement d'une cible que les lignes RETIRÉES écrivent.
 *   En `transition`/`persisted`, elle se juge comme une lecture positive.
 * - Lecture à valeur (`text`, `value`, `visual`, `popup`, `download`) : témoin
 *   quand elle cite une exigence (la provenance contrôle alors son attendu), ou
 *   quand sa cible ou son attendu partage une suite de mots ou un littéral avec
 *   les sources. Une lecture de texte non citée sur un bouton de navigation ne
 *   prouve rien.
 *
 * Un scénario sans objectif déclaré n'esquive pas la règle : toutes ses
 * assertions forment alors l'ensemble de preuve, et il suffit que l'une d'elles
 * soit témoin.
 *
 * Ce que la règle ne voit pas (assumé, mesuré dans docs/pr-qa-measurements.md) :
 * une cible d'un seul mot qui partage par hasard ce mot avec une ligne changée —
 * sur un grand diff d'interface, la majorité des noms accessibles d'une page le
 * font, et la règle y discrimine peu ; un objectif ancré par sa citation sur une
 * ligne inchangée ; un attendu textuel qui ne discrimine pas l'ancien
 * comportement du nouveau. Et elle refuse, à tort mais sans faux vert, un mot
 * observable qui n'est écrit sur aucune ligne changée (clé de traduction,
 * pluriel, libellé d'un fichier inchangé dont le diff change la condition) : le
 * remède est une lecture de valeur qui cite son exigence. Seule une exécution
 * sur la base mesure tout cela.
 */

/**
 * Le vocabulaire de structure : mots-clés de langage et de balisage que toute
 * citation et tout sélecteur partagent sans rien dire du comportement. Générique
 * à dessein — aucun nom d'application.
 */
const STRUCTURAL_WORDS = new Set([
  "aria",
  "async",
  "await",
  "boolean",
  "break",
  "case",
  "class",
  "classname",
  "const",
  "data",
  "default",
  "else",
  "export",
  "false",
  "from",
  "function",
  "href",
  "import",
  "interface",
  "let",
  "new",
  "null",
  "number",
  "readonly",
  "return",
  "role",
  "string",
  "style",
  "this",
  "true",
  "type",
  "typeof",
  "undefined",
  "void",
  "with",
]);

/** Les mots porteurs d'un fragment, dans l'ordre : identifiants découpés, accents repliés. */
function relevanceWords(text: string): string[] {
  const split = text
    // `5_000` est le nombre 5000, pas deux mots.
    .replace(/(\d)_(?=\d)/g, "$1")
    // camelCase et PascalCase : `varianceCents` → `variance Cents`.
    .replace(/(\p{Ll}|\d)(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2");
  const folded = foldTypography(split)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  return folded.split(/[^a-z0-9]+/).filter((word) => {
    const numeric = /^\d+$/.test(word);
    return !(
      (numeric ? word.length < 3 : word.length < 4) ||
      STRUCTURAL_WORDS.has(word)
    );
  });
}

/**
 * Les suites de mots d'un fragment : un identifiant (`cashVarianceCents`,
 * `data-variance-cents`, `snake_case`) est UNE suite, découpée en ses mots ; une
 * phrase donne une suite par mot.
 */
function wordRuns(text: string): string[][] {
  return text
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(relevanceWords)
    .filter((run) => run.length > 0);
}

/** Une suite plus longue (code minifié) n'indexe que ses sous-suites courtes. */
const MAX_RUN_KEY = 12;

/** Les sous-suites contiguës des suites d'un fragment, mots joints par une espace. */
function runKeys(text: string, into = new Set<string>()): Set<string> {
  for (const run of wordRuns(text)) {
    for (let start = 0; start < run.length; start++) {
      const last = Math.min(run.length, start + MAX_RUN_KEY);
      for (let end = start + 1; end <= last; end++) {
        into.add(run.slice(start, end).join(" "));
      }
    }
  }
  return into;
}

/** Un texte comparable mot pour mot : typographie et accents repliés, espaces réduits. */
function normalized(text: string): string {
  return foldTypography(text)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const QUOTED =
  /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$]*)`|>([^<>{}]+)</g;
const ATTRIBUTE_NAME = /([A-Za-z]\w*(?:-\w+)+)\s*=/g;
const ROLE_ATTRIBUTE = /\brole\s*=\s*\{?\s*["'`]([\w-]+)["'`]/g;
const CODE_SIGN = /[(){};=<>[\]`"']|^\s*(?:\/\/|\/\*|\*|#)/;

/**
 * Les littéraux qu'une ligne écrit : chaînes, texte JSX, noms d'attributs
 * composés (`data-…`, `aria-…`), rôles déclarés (`role=alert`), et la ligne
 * entière quand elle n'est que du texte (un nœud JSX sur sa propre ligne).
 */
function lineLiterals(line: string, into: string[] = []): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(QUOTED)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
  }
  for (const match of line.matchAll(ATTRIBUTE_NAME)) {
    found.push(match[1] ?? "");
  }
  for (const match of line.matchAll(ROLE_ATTRIBUTE)) {
    found.push(`role=${match[1] ?? ""}`);
  }
  if (!CODE_SIGN.test(line) && /\p{L}/u.test(line)) {
    found.push(line);
  }
  for (const literal of found) {
    const text = normalized(literal);
    if (text !== "") {
      into.push(text);
    }
  }
  return into;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Vrai quand `needle` figure dans `haystack` entre deux bornes de mot. */
function boundedIncludes(haystack: string, needle: string): boolean {
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    const before = haystack[at - 1] ?? " ";
    const after = haystack[at + needle.length] ?? " ";
    if (!(LETTER_OR_DIGIT.test(before) || LETTER_OR_DIGIT.test(after))) {
      return true;
    }
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

/** Le libellé entier est un littéral écrit (ou, dès 4 signes, un mot entier d'un littéral). */
function literalWitness(
  observed: string,
  literals: readonly string[]
): boolean {
  const needle = normalized(observed);
  return (
    needle !== "" &&
    literals.some(
      (literal) =>
        literal === needle ||
        (needle.length >= 4 && boundedIncludes(literal, needle))
    )
  );
}

interface ChangedSide {
  keys: Set<string>;
  literals: string[];
}
interface FileWitness {
  added: ChangedSide;
  removed: ChangedSide;
  /** Le chemin d'un fichier ajouté : une route par fichier n'existait pas avant. */
  route: Set<string>;
}

type ChangedFile = PrContext["files"][number];

/** Calculé une fois par fichier : un plan relit le même diff pour chaque assertion. */
const witnessByFile = new WeakMap<ChangedFile, FileWitness>();

function fileWitness(file: ChangedFile): FileWitness {
  const cached = witnessByFile.get(file);
  if (cached) {
    return cached;
  }
  const added: ChangedSide = { keys: new Set(), literals: [] };
  const removed: ChangedSide = { keys: new Set(), literals: [] };
  for (const line of (file.patch ?? "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    let side: ChangedSide | undefined;
    if (line.startsWith("+")) {
      side = added;
    } else if (line.startsWith("-")) {
      side = removed;
    }
    if (side) {
      runKeys(line.slice(1), side.keys);
      lineLiterals(line.slice(1), side.literals);
    }
  }
  const witness: FileWitness = {
    added,
    removed,
    route:
      file.status === "added"
        ? runKeys(file.filename.replace(/\.[^./]+$/, ""))
        : new Set(),
  };
  witnessByFile.set(file, witness);
  return witness;
}

/**
 * Ce qu'un sélecteur CSS observe : noms et valeurs d'attributs, id, classes et
 * chaînes entre guillemets. Les noms de balise (`section`, `h2`) ne désignent
 * aucun produit du code et sont exclus.
 */
function cssObservedParts(selector: string): string[] {
  const parts: string[] = [];
  for (const match of selector.matchAll(
    /\[\s*([^\]\s~|^$*=]+)\s*(?:[~|^$*]?=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?[^\]]*\]/g
  )) {
    parts.push(match[1] ?? "", match[2] ?? match[3] ?? match[4] ?? "");
  }
  for (const match of selector.matchAll(/[#.]([\p{L}\d_-]+)/gu)) {
    parts.push(match[1] ?? "");
  }
  for (const match of selector.matchAll(/\(\s*(?:"([^"]*)"|'([^']*)')\s*\)/g)) {
    parts.push(match[1] ?? match[2] ?? "");
  }
  return parts;
}

/** Les lectures de présence et d'adresse ; les autres kinds lisent une valeur. */
const PRESENCE_KINDS: ReadonlySet<string> = new Set([
  "visible",
  "hidden",
  "count",
  "url",
]);

type Assertion = Scenario["assertions"][number];

/** Ce qui est observé, et si ce n'est comparable qu'en littéral entier. */
interface ObservedPart {
  literalOnly: boolean;
  text: string;
}

/** Ce que l'assertion lit sur la page ; le nombre d'un `count` n'en est jamais. */
function observedParts(assertion: Assertion): ObservedPart[] {
  if (assertion.kind === "url") {
    return [{ literalOnly: false, text: assertion.expected }];
  }
  const target = assertion.target;
  const parts: ObservedPart[] = [];
  if (target?.by === "role") {
    // Un rôle anonyme n'a pas de mot : seul `role="…"` écrit par le diff le lit.
    parts.push(
      target.name.trim() === ""
        ? { literalOnly: true, text: `role=${target.value}` }
        : { literalOnly: false, text: target.name }
    );
  } else if (target?.by === "css") {
    for (const text of cssObservedParts(target.value)) {
      parts.push({ literalOnly: false, text });
    }
  } else if (target !== undefined) {
    parts.push({ literalOnly: false, text: target.value });
  }
  if (!PRESENCE_KINDS.has(assertion.kind) && "expected" in assertion) {
    parts.push({ literalOnly: false, text: String(assertion.expected) });
  }
  return parts.filter((part) => part.text.trim() !== "");
}

function readDescription(assertion: Assertion): string {
  if (assertion.kind === "url") {
    return `url ${JSON.stringify(assertion.expected)}`;
  }
  const target = assertion.target;
  const named =
    target?.by === "role"
      ? `role ${target.value} ${JSON.stringify(target.name)}`
      : `${target?.by ?? "no target"} ${JSON.stringify(target?.value ?? "")}`;
  return `${assertion.kind} ${named}`;
}

const isNegativeRead = (assertion: Assertion) =>
  assertion.kind === "hidden" ||
  (assertion.kind === "count" && assertion.expected === 0);

/** Le nombre attendu d'un `count` est écrit tel quel dans la citation qu'il cite. */
function countQuoted(assertion: Assertion, quote: string): boolean {
  const numbers: string[] =
    quote.replace(/(\d)_(?=\d)/g, "$1").match(/\d+/g) ?? [];
  return (
    assertion.kind === "count" && numbers.includes(String(assertion.expected))
  );
}

/** Vrai quand une partie observée lit les sources du scénario ou la citation. */
function readsSources(
  part: ObservedPart,
  files: readonly FileWitness[],
  quote: string,
  url: boolean
): boolean {
  if (
    literalWitness(part.text, lineLiterals(quote)) ||
    files.some(
      (file) =>
        literalWitness(part.text, file.added.literals) ||
        literalWitness(part.text, file.removed.literals)
    )
  ) {
    return true;
  }
  if (part.literalOnly) {
    return false;
  }
  const quoteKeys = runKeys(quote);
  return wordRuns(part.text).some((run) => {
    const key = run.join(" ");
    return (
      quoteKeys.has(key) ||
      files.some(
        (file) =>
          file.added.keys.has(key) ||
          file.removed.keys.has(key) ||
          (url && file.route.has(key))
      )
    );
  });
}

/** Vrai quand l'assertion lit quelque chose que le diff produit. */
function witnessed(
  scenario: Scenario,
  assertion: Assertion,
  files: readonly FileWitness[]
): boolean {
  const parts = observedParts(assertion);
  // En transition/persisted, l'exécuteur exige la cible présente juste avant
  // l'étape : l'absence se juge alors comme une présence (PR #20, d6b3656d).
  const priorPresence = ["transition", "persisted"].includes(
    assertion.verification ?? ""
  );
  if (isNegativeRead(assertion) && !priorPresence) {
    // Une absence passe aussi sur une base où la cible n'a jamais existé : elle
    // ne témoigne que d'une cible que les lignes retirées écrivent.
    return parts.some((part) =>
      files.some((file) => literalWitness(part.text, file.removed.literals))
    );
  }
  const cited = assertion.requirement !== undefined;
  if (cited && !PRESENCE_KINDS.has(assertion.kind)) {
    // L'attendu d'une lecture à valeur qui cite son exigence est contrôlé par
    // la provenance (plan-evidence.ts).
    return true;
  }
  const quote = cited
    ? (scenario.requirements[assertion.requirement ?? 0]?.quote ?? "")
    : "";
  return (
    countQuoted(assertion, quote) ||
    parts.some((part) =>
      readsSources(part, files, quote, assertion.kind === "url")
    )
  );
}

/**
 * Les assertions de preuve du scénario quand aucune n'est témoin, sinon
 * `undefined`. L'ensemble de preuve est l'objectif déclaré ; à défaut, toutes
 * les assertions du scénario.
 */
function objectiveWitnessGap(
  scenario: Scenario,
  context: Pick<PrContext, "files">
): Assertion[] | undefined {
  const objective = scenario.assertions.find(
    (item) => item.id === scenario.objective
  );
  const proof = objective ? [objective] : scenario.assertions;
  const files = context.files
    .filter((file) => scenario.sourceFiles.includes(file.filename))
    .map(fileWitness);
  return proof.length === 0 ||
    proof.some((assertion) => witnessed(scenario, assertion, files))
    ? undefined
    : proof;
}

const WITNESS_HINT =
  "Read the value the change produces where it is rendered (pr.consumers shows where), with the expected value the base behavior gives, citing the requirement it comes from. A hidden or zero-count read proves the change only when the removed lines write its target. If the material does not show where it is rendered, say so: the scenario stays blocked.";

/**
 * Refus de témoin : prononcés au plan (le planificateur les reçoit dans sa
 * correction) et rejoués avant exécution (un plan non corrigé est bloqué,
 * jamais vert).
 */
export function objectiveWitnessRefusals(
  plan: Plan,
  context: Pick<PrContext, "files">
): { error: QaError; scenario: Scenario }[] {
  const refusals: { error: QaError; scenario: Scenario }[] = [];
  for (const scenario of plan.scenarios) {
    const gap = objectiveWitnessGap(scenario, context);
    if (gap === undefined) {
      continue;
    }
    const read = gap
      .map((assertion) => `${assertion.id} (${readDescription(assertion)})`)
      .join(", ");
    let subject = `assertions ${read} read`;
    if (scenario.objective === gap[0]?.id) {
      subject = `objective ${read} reads`;
    } else if (gap.length === 1) {
      subject = `assertion ${read} reads`;
    }
    refusals.push({
      scenario,
      error: new QaError(
        "OBJECTIVE_UNWITNESSED",
        `Scenario ${scenario.id}: ${subject} nothing the diff adds or removes in its sourceFiles nor the quote it cites; it passes identically before the change`,
        WITNESS_HINT
      ),
    });
  }
  return refusals;
}
