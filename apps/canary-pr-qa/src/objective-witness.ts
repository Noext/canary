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
 * La règle est STRUCTURELLE, jamais une lecture d'intention. Pour une lecture
 * de présence ou d'adresse (`visible`, `hidden`, `count`, `url`), ce que
 * l'assertion observe (nom accessible, sélecteur, valeur de cible, adresse
 * attendue — jamais le nombre d'un `count`) doit partager au moins un jeton avec
 * les lignes que le diff AJOUTE ou RETIRE dans les `sourceFiles` du scénario, ou
 * avec la citation de l'exigence qu'elle cite. Les lignes de contexte d'un hunk
 * existent avant comme après le changement ; la prose `behavior`, écrite par le
 * planificateur, et l'instantané de découverte ne comptent jamais : ils ne
 * peuvent pas blanchir une cible.
 *
 * Un scénario sans objectif déclaré n'esquive pas la règle : toutes ses
 * assertions forment alors l'ensemble de preuve, et il suffit que l'une d'elles
 * soit témoin. Les kinds à valeur (`text`, `value`, `visual`, …) sont hors du
 * périmètre : leur attendu est contrôlé par la provenance, pas ici.
 *
 * Ce que la règle ne voit pas (assumé) : une cible qui partage par hasard un mot
 * avec une ligne changée ; un objectif ancré par sa citation sur une ligne
 * inchangée ; un attendu textuel qui ne discrimine pas l'ancien comportement du
 * nouveau. Seule une exécution sur la base mesure cela.
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

/** Les mots porteurs d'un fragment : identifiants découpés, accents repliés. */
function relevanceWords(text: string): Set<string> {
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
  const words = new Set<string>();
  for (const word of folded.split(/[^a-z0-9]+/)) {
    const numeric = /^\d+$/.test(word);
    if (numeric ? word.length < 3 : word.length < 4) {
      continue;
    }
    if (!STRUCTURAL_WORDS.has(word)) {
      words.add(word);
    }
  }
  return words;
}

/**
 * Ce qu'un sélecteur CSS observe : noms et valeurs d'attributs, id, classes et
 * chaînes entre guillemets. Les noms de balise (`section`, `h2`) ne désignent
 * aucun produit du code et sont exclus.
 */
function cssObservedText(selector: string): string {
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
  return parts.join(" ");
}

/** Les lignes que le diff ajoute ou retire, limitées aux fichiers donnés. */
function changedLineText(
  context: Pick<PrContext, "files">,
  only?: readonly string[]
): string {
  const lines: string[] = [];
  for (const file of context.files) {
    if (only !== undefined && !only.includes(file.filename)) {
      continue;
    }
    for (const line of (file.patch ?? "").split("\n")) {
      if (
        (line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") &&
        !line.startsWith("---")
      ) {
        lines.push(line.slice(1));
      }
    }
  }
  return lines.join("\n");
}

/** Les lectures qui ne comparent aucune valeur produite : présence et adresse. */
const WITNESS_KINDS: ReadonlySet<string> = new Set([
  "visible",
  "hidden",
  "count",
  "url",
]);

type Assertion = Scenario["assertions"][number];

/** Ce que l'assertion lit sur la page ; le nombre d'un `count` n'en est jamais. */
function observedText(assertion: Assertion): string {
  if (assertion.kind === "url") {
    return assertion.expected;
  }
  const target = assertion.target;
  if (target === undefined) {
    return "";
  }
  if (target.by === "role") {
    return target.name;
  }
  return target.by === "css" ? cssObservedText(target.value) : target.value;
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

/** Vrai quand l'assertion lit au moins un jeton du diff ou de sa citation. */
function witnessed(
  scenario: Scenario,
  assertion: Assertion,
  changed: string
): boolean {
  if (!WITNESS_KINDS.has(assertion.kind)) {
    return true;
  }
  const quote =
    assertion.requirement === undefined
      ? ""
      : (scenario.requirements[assertion.requirement]?.quote ?? "");
  const source = relevanceWords(`${changed}\n${quote}`);
  return [...relevanceWords(observedText(assertion))].some((word) =>
    source.has(word)
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
  const changed = changedLineText(context, scenario.sourceFiles);
  return proof.length === 0 ||
    proof.some((assertion) => witnessed(scenario, assertion, changed))
    ? undefined
    : proof;
}

const WITNESS_HINT =
  "Read the value the change produces where it is rendered (pr.consumers shows where), with the expected value the base behavior gives. If the material does not show where it is rendered, say so: the scenario stays blocked.";

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
