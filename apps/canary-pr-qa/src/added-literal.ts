import { isDocumentationPath, isTestPath } from "./approved-skips.js";
import { foldTypography } from "./canary.js";
import type { PrContext } from "./github.js";
import type { Assertion } from "./schema.js";

/**
 * Le littéral que le diff AJOUTE, pour l'assertion annexe d'un scénario
 * `regression` (`src/baseline-diff.ts`).
 *
 * Un scénario `regression` déclare inchangé ce qu'il vérifie : une assertion
 * verte sur la tête et rouge sur la base y devient BASELINE_REGRESSION. Son
 * objectif porte cette déclaration ; une assertion ANNEXE peut pourtant lire
 * un contrôle que la PR ajoute (banc f1-2 : le bouton « Remettre à zéro »,
 * absent de la base, vérifié avant l'objectif inchangé). La base échoue alors
 * parce que l'élément n'existe pas encore, pas parce que la PR casse quelque
 * chose : c'est un changement, pas une régression.
 *
 * La règle reste étroite, parce qu'une régression qui ne se montre que sur une
 * assertion annexe doit toujours rougir :
 *
 * - le littéral (nom de la cible ou valeur attendue) figure en entier, borné
 *   par des non-lettres, sur une ligne AJOUTÉE d'un fichier de code — ni test,
 *   ni documentation, qui citent l'interface existante sans la créer ;
 * - il ne figure sur AUCUNE ligne retirée ni de contexte, d'aucun fichier :
 *   une interface que le diff touche sans la créer reste l'interface existante ;
 * - un fichier sans patch lisible rend la question indécidable : aucune
 *   exemption, la régression est prononcée.
 */
const MIN_LITERAL_CHARS = 4;
/** Arborescences de tests de bout en bout : elles nomment l'interface, sans la créer. */
const TEST_DIRECTORY = /(^|\/)(e2e|tests?|cypress|playwright)\//i;

const fold = (value: string) =>
  foldTypography(value.normalize("NFC")).replace(/\s+/g, " ").trim();

function literalsOf(assertion: Assertion): string[] {
  const literals: string[] = [];
  const target = assertion.target;
  if (target?.by === "role") {
    literals.push(target.name ?? "");
  } else if (target && target.by !== "css") {
    literals.push(target.value);
  }
  if ("expected" in assertion && typeof assertion.expected === "string") {
    literals.push(assertion.expected);
  }
  return literals
    .map(fold)
    .filter(
      (value) => value.length >= MIN_LITERAL_CHARS && /\p{L}/u.test(value)
    );
}

function contains(line: string, literal: string): boolean {
  let from = line.indexOf(literal);
  while (from >= 0) {
    const before = line[from - 1] ?? " ";
    const after = line[from + literal.length] ?? " ";
    if (!/[\p{L}\p{N}]/u.test(before + after)) {
      return true;
    }
    from = line.indexOf(literal, from + 1);
  }
  return false;
}

/** Range les lignes d'un patch : ajoutées par du code, ou déjà là avant la PR. */
function splitPatch(
  file: PrContext["files"][number],
  added: string[],
  kept: string[]
) {
  const creates = !(
    isTestPath(file.filename) ||
    isDocumentationPath(file.filename) ||
    TEST_DIRECTORY.test(file.filename)
  );
  // Le `patch` de l'API GitHub ne porte pas d'en-têtes `+++`/`---` : chaque
  // ligne est un contenu.
  for (const raw of (file.patch ?? "").split("\n")) {
    if (raw.startsWith("+")) {
      if (creates) {
        added.push(fold(raw.slice(1)));
      }
      continue;
    }
    // Ligne retirée, de contexte, ou en-tête `@@` qui cite la déclaration
    // englobante : tout ce qui existait avant la PR.
    kept.push(fold(raw.startsWith("-") ? raw.slice(1) : raw));
  }
}

/**
 * Le prédicat « cette assertion lit un littéral que le diff ajoute », ou
 * `undefined` quand le diff ne permet pas de le dire (aucun fichier, ou un
 * fichier sans patch) : l'appelant garde alors l'escalade.
 */
export function diffAddedLiteral(
  files: PrContext["files"] | undefined
): ((assertion: Assertion) => boolean) | undefined {
  if (!files || files.length === 0 || files.some((file) => !file.patch)) {
    return;
  }
  const added: string[] = [];
  const kept: string[] = [];
  for (const file of files) {
    splitPatch(file, added, kept);
  }
  return (assertion) =>
    literalsOf(assertion).some(
      (literal) =>
        added.some((line) => contains(line, literal)) &&
        // L'absence se juge sans bornes : plus large, elle garde l'escalade.
        !kept.some((line) => line.includes(literal))
    );
}
