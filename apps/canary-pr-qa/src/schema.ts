import { z } from "zod";
import type { Diagnostic } from "./diagnostics.js";

/**
 * Normalisation d'une citation avant comparaison au texte témoin. Deux
 * opérations, chacune portée par un fait réel :
 *
 * - une suite de blancs qui contient un saut de ligne est un repli de mise en
 *   forme — le planificateur recopie sur une ligne le bloc que le fichier
 *   indente sur quatre. Une suite de blancs SANS saut de ligne garde son nombre
 *   exact : deux espaces dans un littéral de chaîne sont significatifs, et les
 *   replier ferait passer pour témoin un texte qui diffère d'une manière qui a
 *   un sens ;
 * - les caractères invisibles (U+200B, U+00AD) ne sont rognés qu'aux bornes de
 *   la chaîne comparée. À l'intérieur, ils restent : un invisible présent dans
 *   la source ne disparaît jamais en silence, donc une citation qui l'omet là
 *   où il compte n'a pas de témoin, et une citation qui le porte en a un. En
 *   bordure, il est du bruit de copie et se retire comme le blanc.
 */
export function normalizeQuoteText(value: string): string {
  return value
    .replace(/\s+/g, (run) => (/[\r\n]/.test(run) ? " " : run))
    .replace(/^[\s\u200b\u00ad]+/, "")
    .replace(/[\s\u200b\u00ad]+$/, "");
}
/**
 * Contenu réel minimal d'une citation crédible. Une citation rembourrée — sept
 * espaces suivis d'une accolade, ou des caractères invisibles en bordure — se
 * normalise en un fragment que tout fichier contient : elle couvrirait un
 * fichier entier sans rien prouver. Après normalisation, la citation doit donc
 * garder `QUOTE_MIN_TEXT_CHARS` caractères ET au moins `QUOTE_MIN_WORD_CHARS`
 * lettre ou chiffre VISIBLE : jamais de la ponctuation seule, jamais du blanc,
 * jamais des invisibles.
 *
 * La règle est la même partout, y compris sur un fichier critique, et elle est
 * portée par le contenu — jamais par la présence d'un blanc. L'ancien plancher
 * universel de deux jetons comptait les BLANCS, pas le contenu : il refusait des
 * copies EXACTES de code que rien ne sépare par un espace, mesurées dans les
 * lots G à O — `aria-invalid={invalid||undefined}` (37 caractères),
 * `disabled={closed||!counted.ok}`,
 * `data-cash-state={closed?"cloture":"ouvert"}` (40 caractères),
 * `formatAmountFr(centsToEuros(counted.totalCents))` (runs 9ee36233, 94e86f2b,
 * 71cb3369). Ces quatre copies sont exactes et substantielles : les refuser est
 * un faux refus qui tue le run, donc le proxy disparaît du contrat. Ce qu'il
 * ajoutait de juste sur un chemin critique — au moins une lettre ou un chiffre
 * visible — vaut maintenant partout, ce qui refuse la ponctuation seule sur
 * tous les chemins par la règle de contenu.
 *
 * Une lettre peut elle-même être invisible : les quatre remplisseurs Hangul
 * (U+115F, U+1160, U+3164, U+FFA0) appartiennent à
 * `Default_Ignorable_Code_Point`, donc le compteur les retire avant de compter.
 * Sans ce retrait, un diff hostile fournit un « contenu visible » que la pile
 * de rendu ne dessine pas — huit remplisseurs et un blanc satisfont une lettre.
 *
 * La longueur et la lettre ne suffisent pas : un identifiant NU les franchit —
 * `function` (8 caractères), `undefined` (9), `countedValue` (12) portent tous
 * des lettres —, et un fichier qui contient un mot courant couvrirait alors
 * n'importe quelle exigence, y compris sur un chemin critique. Un témoin doit
 * donc porter une STRUCTURE de code : au moins `QUOTE_MIN_STRUCTURE_CHARS`
 * caractère VISIBLE d'une liste EXPLICITE — accolades, parenthèses, crochets,
 * opérateurs, signes égal, point-virgule, chevrons, guillemets internes, ou le
 * blanc qui sépare deux mots. C'est ce qui distingue une EXPRESSION d'un
 * identifiant nu : `total=17`, `value 12` et `if (x) {` passent, `function` non.
 *
 * La liste est explicite, jamais « tout ce qui n'est ni lettre ni chiffre » :
 * ce complémentaire comptait les caractères de LIAISON D'IDENTIFIANT — tiret
 * bas, tiret, point, deux-points, barre oblique —, donc `snake_case_name`,
 * `kebab-case-name`, `a.b.c`, `a:b` et `a/b` passaient pour des témoins alors
 * qu'ils ne portent aucune structure de code. Ces cinq caractères sont exclus
 * du décompte, comme `$` et `#` qui forment eux aussi des identifiants
 * JavaScript (`$foo`, `#field`).
 *
 * L'apostrophe est exclue pour la même raison, par l'autre bout : elle ne
 * sépare rien, elle PRÉCÈDE un identifiant (le lifetime Rust `'dangerous`,
 * `'static`, le caractère `'a'`) ou elle délimite un contenu dont les lettres
 * et le blanc rendent déjà compte. Compter le sigil laissait donc un
 * identifiant nu redevenir témoin sous une autre écriture : `'dangerous`
 * (10 caractères, des lettres, une apostrophe) couvrait un fichier `.rs` d'un
 * dépôt où une PR non fiable pilote le planificateur. Les cas légitimes ne sont
 * pas refusés pour autant, parce qu'ils passent par les autres caractères :
 * `let c = 'a';` porte `=` et `;` plus le blanc entre deux mots, `'bonjour le
 * monde'` porte ce même blanc, et `data-cash-state={closed?"cloture":"ouvert"}`
 * porte accolades, `=` et `?`. Le guillemet interne, lui, reste compté : c'est
 * une des formes du contrat.
 *
 * Le seuil de structure vaut UN et non deux : des contrats déjà tenus par la
 * suite acceptent une citation dont c'est le seul caractère de structure —
 * `total=17` porte un seul `=`, `value 12` un seul blanc —, donc exiger deux
 * caractères rouvrirait le faux refus que ces cas mesurent. Le compteur, comme
 * celui des lettres, ne retient pas un caractère invisible : sans ce retrait,
 * huit zéro-largeurs et un `x` offriraient une structure que rien ne dessine.
 *
 * Le seuil de contenu visible est le plus bas qui satisfasse les deux revues :
 * `if (x) {` porte trois lettres et `{"x": 1}` deux, donc exiger plus qu'une
 * lettre rouvrirait le plan juste bloqué, et le plancher de longueur seul
 * laisserait passer un séparateur de ponctuation (`// ------`).
 *
 * Le seuil est appliqué par le gate de témoin (voir `requirementHasWitness`,
 * policy.ts), jamais par le schéma Zod : celui-ci valide une citation sans
 * savoir de quel fichier elle vient, donc il ne garde que le plancher de
 * longueur, et le gate rend le refus de contenu — un refus qui nomme le fichier
 * cité, le rang de l'exigence et la règle, là où un refus de schéma ne nomme
 * qu'un champ. Le gate reste le seul juge d'acceptation, comme le documente
 * `quoteHasWitness`.
 */
export const QUOTE_MIN_TEXT_CHARS = 8;
/** Lettres ou chiffres visibles exigés d'une citation, quel que soit son fichier. */
export const QUOTE_MIN_WORD_CHARS = 1;
/**
 * Caractères de structure de code exigés d'une citation : au moins un symbole
 * de la liste explicite `STRUCTURE_CHARS`, ou un blanc entre deux mots. Ni
 * lettre, ni chiffre, ni caractère de liaison d'identifiant.
 */
export const QUOTE_MIN_STRUCTURE_CHARS = 1;
const WORD_CHARS = /[\p{L}\p{N}]/gu;
/**
 * Symboles qui expriment une STRUCTURE de code : accolades, parenthèses,
 * crochets, opérateurs, signes égal, point-virgule, chevrons et guillemets
 * internes. Le tiret bas, le tiret, le point, les deux-points et la barre
 * oblique en sont exclus : ce sont des caractères de LIAISON d'identifiant
 * (`snake_case`, `kebab-case`, `a.b.c`, `a:b`, `a/b`), donc les compter
 * accepterait un identifiant nu comme témoin. `$` et `#` le sont aussi parce
 * qu'ils forment des identifiants JavaScript (`$foo`, `#field`). L'apostrophe
 * l'est enfin : c'est un sigil qui précède un identifiant — le lifetime Rust
 * `'dangerous` — ou un délimiteur dont le contenu compte par ses lettres et
 * ses blancs, donc un identifiant nu préfixé passait pour une expression.
 */
const STRUCTURE_CHARS = /[{}()[\]=!<>,;"`|&?+*%^~]/gu;
/**
 * Le blanc qui sépare deux mots : une suite de blancs bordée d'un mot de part
 * et d'autre. Un blanc voisin d'une ponctuation ne compte pas — c'est la
 * structure voisine qui porte le témoin —, et les bords sont déjà rognés par
 * `normalizeQuoteText`. Le mot de gauche est consommé, celui de droite est vu
 * par une anticipation, donc deux blancs partageant un mot (`a b c`) comptent
 * chacun.
 */
const WORD_SEPARATING_SPACE = /[\p{L}\p{N}]\s+(?=[\p{L}\p{N}])/gu;
/**
 * Caractères que la pile de rendu ne dessine pas, quelle que soit leur
 * catégorie Unicode : U+00AD, U+200B..U+200F, U+2060..U+206F, U+FE00..U+FE0F,
 * U+FFF0..U+FFF8, U+E0000..U+E0FFF, et les quatre remplisseurs Hangul cités
 * plus haut. `\p{L}` les couvre sans les distinguer — les remplisseurs Hangul
 * sont des lettres — donc compter les lettres ne suffit pas : il faut qu'elles
 * s'affichent.
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
/**
 * Lettres et chiffres d'une chaîne qui s'affichent réellement : le compteur de
 * contenu visible, qui ne retient pas un caractère default-ignorable.
 */
function visibleWordChars(value: string): number {
  return (value.match(WORD_CHARS) ?? []).filter(
    (char) => !DEFAULT_IGNORABLE.test(char)
  ).length;
}
/**
 * Caractères de structure d'une chaîne qui s'affichent réellement : les
 * symboles de `STRUCTURE_CHARS`, plus un pour chaque blanc qui sépare deux
 * mots. Un zéro-largeur ne compte pas comme une ponctuation.
 */
function visibleStructureChars(value: string): number {
  const symbols = (value.match(STRUCTURE_CHARS) ?? []).filter(
    (char) => !DEFAULT_IGNORABLE.test(char)
  ).length;
  const separators = (value.match(WORD_SEPARATING_SPACE) ?? []).length;
  return symbols + separators;
}
/**
 * Plafond de longueur d'une citation, en caractères. Le schéma le pose et le
 * gate le relit : un candidat de correction plus long serait un inconnu pour le
 * schéma, donc aucun remède ni aucune correction contrainte ne le propose.
 */
export const QUOTE_MAX_CHARS = 1000;
export function quoteCarriesContent(value: string): boolean {
  const normalized = normalizeQuoteText(value);
  return (
    normalized.length >= QUOTE_MIN_TEXT_CHARS &&
    visibleWordChars(normalized) >= QUOTE_MIN_WORD_CHARS &&
    visibleStructureChars(normalized) >= QUOTE_MIN_STRUCTURE_CHARS
  );
}

const text = z.string().trim().min(1).max(2000);
const quote = z
  .string()
  // Le schéma ne connaît pas le fichier cité : il ne garde que le plancher de
  // longueur. Le gate de témoin applique la règle de contenu — au moins
  // `QUOTE_MIN_WORD_CHARS` lettre ou chiffre visible et une structure de code
  // (`QUOTE_MIN_STRUCTURE_CHARS`) — et c'est lui le seul juge d'acceptation
  // (voir `quoteCarriesContent`).
  .min(QUOTE_MIN_TEXT_CHARS)
  .max(QUOTE_MAX_CHARS);
const locator = z.discriminatedUnion("by", [
  z.object({ by: z.literal("css"), value: text }).strict(),
  z
    .object({ by: z.literal("role"), value: text, name: z.string().max(2000) })
    .strict(),
  z.object({ by: z.literal("text"), value: text }).strict(),
  z.object({ by: z.literal("label"), value: text }).strict(),
  z.object({ by: z.literal("placeholder"), value: text }).strict(),
  z.object({ by: z.literal("testId"), value: text }).strict(),
]);
const assertionBase = {
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  description: text,
  target: locator.optional(),
  afterStep: text.optional(),
  verification: z.enum(["state", "transition", "persisted"]).default("state"),
};
/**
 * L'attendu d'un kind qui compare à une valeur. Même acceptation que `text`, mais
 * le refus porte une phrase que le planificateur peut suivre : un `expected`
 * vide rend l'assertion insatisfiable (ou, pour `text`, satisfaite par
 * n'importe quelle page puisque `includes("")`), et le message Zod est ce qu'il
 * reçoit dans sa tentative de correction (`model.ts` renvoie les issues du
 * schéma). La règle est rejouée à l'exécution par `missingExpectationRefusals`
 * (plan-evidence.ts), qui porte l'aide complète.
 */
const expectedText = z
  .string()
  .trim()
  .min(
    1,
    "expected is required and cannot be blank: this kind compares the observed value to it, so an empty expected can never be satisfied (text would match any page)."
  )
  .max(2000);
export const AssertionSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...assertionBase, kind: z.literal("visual"), expected: text })
    .strict(),
  z
    .object({
      ...assertionBase,
      kind: z.literal("download"),
      expected: expectedText,
    })
    .strict(),
  z
    .object({ ...assertionBase, kind: z.literal("popup"), expected: text })
    .strict(),
  z
    .object({
      ...assertionBase,
      kind: z.literal("text"),
      expected: expectedText,
    })
    .strict(),
  z
    .object({
      ...assertionBase,
      kind: z.literal("value"),
      // Pas de `.min(1)` ici, contrairement aux autres kinds à valeur : `""`
      // est la forme mesurée de « le champ est vide ». 27 assertions de ce kind
      // sur 26 runs du corpus portent un attendu vide, 25 passent, et toutes
      // décrivent un champ vierge (comptage d'une pharmacie non hérité d'une
      // autre). `actual === ""` compare à quelque chose de précis, donc la
      // présence de `expected` suffit ; la règle de lecture vit dans
      // `missingExpectationRefusals` (plan-evidence.ts).
      expected: z.string().max(2000),
    })
    .strict(),
  z
    .object({
      ...assertionBase,
      kind: z.literal("url"),
      expected: expectedText,
    })
    .strict(),
  z
    .object({
      ...assertionBase,
      kind: z.literal("count"),
      expected: z.number().int().min(0).max(10_000),
    })
    .strict(),
  z.object({ ...assertionBase, kind: z.literal("visible") }).strict(),
  z.object({ ...assertionBase, kind: z.literal("hidden") }).strict(),
]);
export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("observe") }).strict(),
  z
    .object({ type: z.literal("download"), locator, assertionId: text })
    .strict(),
  z.object({ type: z.literal("popup"), locator, assertionId: text }).strict(),
  z.object({ type: z.literal("goto"), path: text }).strict(),
  z
    .object({
      type: z.literal("click"),
      locator,
      /**
       * Clic d'ÉTABLISSEMENT d'un état : si la cible est absente, l'étape est
       * sautée au lieu d'échouer, parce que cette absence prouve que l'état
       * visé est déjà en place (le bouton « Réouvrir le comptage » n'existe que
       * caisse fermée). Un clic métier n'utilise jamais cette option : là, une
       * cible absente est un défaut et doit rester un échec. Les autres actions
       * n'acceptent pas la clé, leurs objets étant `strict`.
       */
      ifPresent: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("fill"), locator, value: z.string().max(2000) })
    .strict(),
  z.object({ type: z.literal("press"), locator, key: text }).strict(),
  z.object({ type: z.literal("select"), locator, value: text }).strict(),
  z
    .object({ type: z.literal("check"), locator, checked: z.boolean() })
    .strict(),
  z
    .object({
      type: z.literal("assert"),
      assertionId: text,
      locator: locator.optional(),
    })
    .strict(),
  z.object({ type: z.literal("finish") }).strict(),
  z.object({ type: z.literal("blocked"), explanation: text }).strict(),
]);
/**
 * Le matériel numéroté que le planificateur reçoit (`sourceLines` du message,
 * voir `planPayload` dans runner.ts) : les lignes réelles de chaque fichier
 * modifié, avec leur numéro dans le nouveau fichier. C'est la SEULE source d'une
 * référence `line` : le gate y lit le texte qu'il écrit dans `quote`, donc rien
 * de ce que le planificateur devait recopier n'est plus recopié.
 */
export interface SourceLineMaterial {
  lines: { line: number; text: string }[];
  path: string;
}
/**
 * Nombre de numéros cités de part et d'autre d'une ligne demandée quand elle
 * n'est pas dans le matériel : assez pour situer la ligne dans la portion que le
 * planificateur voit, jamais assez pour noyer le refus.
 */
const REFERENCE_NEIGHBOUR_LINES = 3;
/** Numéros proposés quand la ligne demandée ne porte pas de contenu citable. */
const REFERENCE_CARRIER_LINES = 2;
/** Fichiers nommés quand une référence vise un fichier que le matériel ignore. */
const REFERENCE_NAMED_FILES = 5;
function namedList(items: string[]): string {
  const shown = items.slice(0, REFERENCE_NAMED_FILES).join(", ");
  const rest = items.length - REFERENCE_NAMED_FILES;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}
/**
 * Les numéros que le matériel porte autour de celui qui a été demandé, avant et
 * après : le refus nomme la ligne voulue ET ce que le planificateur pouvait
 * désigner, sans jamais lui rendre un texte à recopier.
 */
function neighbouringLines(lines: { line: number }[], line: number): string {
  const numbers = lines.map((item) => item.line);
  const before = numbers
    .filter((number) => number < line)
    .slice(-REFERENCE_NEIGHBOUR_LINES);
  const after = numbers
    .filter((number) => number > line)
    .slice(0, REFERENCE_NEIGHBOUR_LINES);
  const parts = [
    ...(before.length > 0 ? [`${before.join(", ")} before it`] : []),
    ...(after.length > 0 ? [`${after.join(", ")} after it`] : []),
  ];
  return parts.length === 0 ? "no other line" : parts.join(" and ");
}
/**
 * Les lignes les plus proches de la ligne demandée qui portent, elles, du
 * contenu citable : la ligne demandée existe mais ne peut rien témoigner, donc
 * le refus désigne les voisines qui le peuvent au lieu de renvoyer le
 * planificateur vers la même ligne.
 */
function carryingLines(
  lines: { line: number; text: string }[],
  line: number
): number[] {
  return lines
    .filter(
      (item) =>
        item.line !== line &&
        item.text.length <= QUOTE_MAX_CHARS &&
        quoteCarriesContent(item.text)
    )
    .sort(
      (left, right) =>
        Math.abs(left.line - line) - Math.abs(right.line - line) ||
        left.line - right.line
    )
    .slice(0, REFERENCE_CARRIER_LINES)
    .map((item) => item.line);
}
/**
 * Ce que donne une référence `line` : le texte réel de la ligne dans le
 * matériel, ou le refus qui dit pourquoi elle ne désigne rien d'exploitable.
 */
export type LineReferenceResolution = { refusal: string } | { text: string };
/**
 * Résolution d'une référence `sourceFile` + `line` dans le matériel numéroté.
 *
 * Le texte écrit dans `quote` est celui du matériel, octet pour octet : une
 * référence ne peut donc pas porter une copie altérée, ce qui est la cause
 * mesurée de la famille de refus (ligne 368 retapée avec `:""` inséré, alors
 * qu'elle était dans `sourceLines`). Aucune tolérance n'est ajoutée pour
 * autant : la ligne est LUE, jamais recréée ni rognée, et une ligne absente du
 * matériel, ambiguë, vide de code ou au-delà du plafond de citation est refusée
 * avec le numéro demandé et les numéros que le matériel porte autour — sans
 * jamais citer de texte de page.
 */
export function resolveLineReference(
  sourceFile: string,
  line: number,
  material: SourceLineMaterial[]
): LineReferenceResolution {
  const file = material.find((item) => item.path === sourceFile);
  if (file && file.lines.length === 0) {
    return {
      refusal: `No numbered line for ${sourceFile}: sourceLines lists that file but no line of it, because its diff carries no added or context line. Quote exact text from it instead.`,
    };
  }
  if (!file) {
    const listed = material.map((item) => item.path);
    return {
      refusal: `No numbered line for ${sourceFile}: sourceLines lists no such file${listed.length === 0 ? " (it lists no file)" : ` (it lists ${namedList(listed)})`}. Designate a line of a file it lists, or quote exact text from ${sourceFile} with quote.`,
    };
  }
  const matches = file.lines.filter((item) => item.line === line);
  if (matches.length > 1) {
    return {
      refusal: `Line ${line} of ${sourceFile} is ambiguous: sourceLines lists it ${matches.length} times, so it designates no single fragment. Quote the exact text instead, since preference cannot be measured.`,
    };
  }
  const found = matches[0];
  if (!found) {
    return {
      refusal: `Line ${line} of ${sourceFile} is not in the numbered material: sourceLines lists ${neighbouringLines(file.lines, line)} (it carries the lines of the patch hunks, not every line of the file, and the context budget can cut that list short). Designate one of the listed numbers, or quote exact text from that file.`,
    };
  }
  if (found.text.length > QUOTE_MAX_CHARS) {
    return {
      refusal: `Line ${line} of ${sourceFile} holds ${found.text.length} characters, beyond the ${QUOTE_MAX_CHARS}-character quote cap, so it cannot be written as a whole: quote an exact fragment of it with quote instead.`,
    };
  }
  if (!quoteCarriesContent(found.text)) {
    const carriers = carryingLines(file.lines, line);
    return {
      refusal: `Line ${line} of ${sourceFile} carries no usable code content: it is blank, or holds nothing but punctuation or invisible characters, so it cannot witness a behavior. ${carriers.length === 0 ? "" : `Lines that do carry code content: ${carriers.join(", ")}. `}Designate one of them, or quote an exact fragment of that file.`,
    };
  }
  return { text: found.text };
}
/**
 * L'exigence du plan PERSISTÉ : une citation texte, toujours. Toute la lecture
 * en aval — couverture, témoin, rapport, UI — ne connaît que cette forme.
 */
const persistedRequirement = z
  .object({
    sourceFile: text,
    quote,
    behavior: text,
  })
  .strict();
/**
 * L'exigence telle que le planificateur la PRODUIT : soit une citation texte
 * (forme persistée, rétro-compatible), soit une RÉFÉRENCE `line` que le gate
 * résout dans le matériel avant toute validation. Les deux formes sont
 * exclusives : les accepter ensemble laisserait une copie altérée accompagner
 * une ligne juste et passer pour un témoin, ce qui serait une tolérance
 * nouvelle. La résolution écrit le texte réel de la ligne dans `quote` — la
 * valeur rendue est donc identique à celle d'une citation, jamais un indice.
 */
function submittedRequirement(material: SourceLineMaterial[]) {
  return z
    .object({
      sourceFile: text,
      quote: quote.optional(),
      line: z.number().int().min(1).optional(),
      behavior: text,
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.quote === undefined && value.line === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["quote"],
          message: `A requirement needs a source reference: "line", the number of a line sourceLines lists for ${value.sourceFile}, or "quote", the exact text itself.`,
        });
        return;
      }
      if (value.quote !== undefined && value.line !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["quote"],
          message: `"quote" and "line" are alternatives, never both: a line reference is resolved by the gate, so a quote sent beside it would prove nothing. Send line alone for ${value.sourceFile}.`,
        });
        return;
      }
      if (value.line === undefined) {
        return;
      }
      const resolution = resolveLineReference(
        value.sourceFile,
        value.line,
        material
      );
      if ("refusal" in resolution) {
        ctx.addIssue({
          code: "custom",
          path: ["line"],
          message: resolution.refusal,
        });
        return;
      }
      value.quote = resolution.text;
    })
    .transform((value) => ({
      sourceFile: value.sourceFile,
      quote: value.quote ?? "",
      behavior: value.behavior,
    }));
}
/**
 * Les clés d'un scénario, indépendantes de la forme d'une exigence : le
 * planificateur en produit une (citation ou référence), le plan persisté n'en
 * garde qu'une citation texte.
 */
function scenarioSchema<T extends z.ZodTypeAny>(requirement: T) {
  return z
    .object({
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
      title: text,
      rationale: text,
      kind: z.enum(["happy_path", "edge_case", "regression"]),
      sourceFiles: z.array(text).min(1).max(30),
      preconditions: z.array(text).max(10),
      steps: z
        .array(
          z
            .object({
              id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
              description: text,
              action: ActionSchema,
            })
            .strict()
        )
        .min(1)
        .max(40),
      requirements: z.array(requirement).min(1).max(20),
      assertions: z.array(AssertionSchema).min(1).max(10),
    })
    .strict();
}
export const ScenarioSchema = scenarioSchema(persistedRequirement);
/**
 * Actions MÉTIER : elles déplacent la donnée que le scénario prétend prouver.
 * Un clic tolérant placé après elles n'établit plus un état de départ, il
 * remplace une action obligatoire — et sa cible absente passerait alors pour un
 * saut légitime.
 */
const BUSINESS_ACTION_TYPES = new Set<string>([
  "check",
  "fill",
  "press",
  "select",
]);
/**
 * Un clic `ifPresent` hors de son contrat : l'étape fautive et la raison, que le
 * schéma et le rejeu du runner nomment tous deux de la même façon.
 */
export interface EstablishingClickFault {
  reason: string;
  stepId: string;
}
/**
 * Contrat EXÉCUTABLE de `click.ifPresent` : le drapeau n'est permis que sur une
 * étape d'ÉTABLISSEMENT, et cette qualité se vérifie sur la structure du
 * scénario, pas sur les mots de sa description.
 *
 * 1. Le clic précède la PREMIÈRE action métier du scénario (fill, select, check,
 *    press). Après elle, une cible absente est un défaut : elle est tolérée par
 *    erreur sur un clic obligatoire, et l'étape est sautée sans que rien ne le
 *    montre.
 * 2. Une assertion se rattache à ce clic (`afterStep` = son identifiant) : elle
 *    vérifie l'état obtenu, donc une étape sautée ne peut pas passer inaperçue.
 *    Le contrat ordonne déjà cette assertion APRÈS le clic (`afterStep` doit
 *    viser une étape antérieure), et le mode correct est `verification: state` :
 *    une étape sautée ne déplace aucune valeur, donc une transition y échoue
 *    par construction.
 *
 * Le refus est déterministe : il ne dépend ni de la page, ni de l'état laissé
 * par un run antérieur, et il est prononcé avant toute étape navigateur.
 */
export function establishingClickFault(
  scenario: z.infer<typeof ScenarioSchema>,
  index: number
): EstablishingClickFault | undefined {
  const step = scenario.steps[index];
  if (step?.action.type !== "click" || step.action.ifPresent !== true) {
    return;
  }
  const firstBusiness = scenario.steps.findIndex((item) =>
    BUSINESS_ACTION_TYPES.has(item.action.type)
  );
  const business = scenario.steps[firstBusiness];
  if (business && index > firstBusiness) {
    return {
      stepId: step.id,
      reason: `ifPresent is only for an establishing step placed before the first business action, but this click comes after ${business.id} (${business.action.type})`,
    };
  }
  if (
    !scenario.assertions.some((assertion) => assertion.afterStep === step.id)
  ) {
    return {
      stepId: step.id,
      reason: `ifPresent skips the step when its target is absent, so an assertion must verify the state it establishes: no assertion has afterStep ${step.id} (attach one to this click, verification "state")`,
    };
  }
  return;
}
/**
 * Le contrat d'un plan, indépendant de la forme d'une exigence — voir
 * `scenarioSchema`. Le planificateur est validé par la forme qui accepte une
 * référence `line` ; tout le reste — couverture, rapport, rejeu — lit le plan
 * persisté, qui ne porte que des citations texte.
 */
function planSchema<T extends z.ZodTypeAny>(requirement: T) {
  return z
    .object({
      summary: text,
      scenarios: z.array(scenarioSchema(requirement)).max(20),
      skipped: z
        .array(z.object({ sourceFile: text, reason: text }).strict())
        .max(100),
    })
    .strict()
    .superRefine((plan, ctx) => {
      const ids = plan.scenarios.map((scenario) => scenario.id);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: "custom", message: "Duplicate scenario ids" });
      }
      for (const scenario of plan.scenarios) {
        validateScenarioContract(scenario, ctx);
      }
    });
}
export const PlanSchema = planSchema(persistedRequirement);
/**
 * Le schéma de la RÉPONSE du planificateur : la forme persistée, plus la
 * référence `line` qu'un gate résout dans le matériel reçu (`sourceLines`).
 * C'est le point d'entrée unique de la résolution : elle a donc lieu avant
 * toute validation de couverture, et un plan accepté ne peut pas porter une
 * citation recopiée que le modèle aurait altérée.
 */
export function plannerPlanSchema(material: SourceLineMaterial[]) {
  return planSchema(submittedRequirement(material));
}
function validateContractAssertion(
  scenario: z.infer<typeof ScenarioSchema>,
  index: number,
  ctx: z.RefinementCtx
): string | undefined {
  const step = scenario.steps[index];
  if (
    !(
      step?.action.type === "assert" ||
      step?.action.type === "download" ||
      step?.action.type === "popup"
    )
  ) {
    return;
  }
  const { assertionId } = step.action;
  const assertion = scenario.assertions.find((item) => item.id === assertionId);
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (!assertion) {
    issue("Unknown contract assertion");
    return;
  }
  if (
    !(["url", "download", "popup"].includes(assertion.kind) || assertion.target)
  ) {
    issue("Assertion requires a frozen target");
  }
  if (step.action.type === "assert" && step.action.locator) {
    issue(
      "Assertion targets belong to the original contract, never executor actions"
    );
  }
  if (
    ["visual", "popup", "download"].includes(assertion.kind) &&
    assertion.verification !== "state"
  ) {
    issue("Visual, popup and download assertions require state verification");
  }
  if (
    (step.action.type === "download" || step.action.type === "popup") &&
    assertion.kind !== step.action.type
  ) {
    issue("Event action must use an assertion of the same kind");
  }
  if (
    step.action.type === "assert" &&
    ["download", "popup"].includes(assertion.kind)
  ) {
    issue("Event assertions require their corresponding event action");
  }
  const preceding = scenario.steps.slice(0, index);
  const dependency = preceding.find((item) => item.id === assertion.afterStep);
  if (!dependency) {
    issue("Assertion must reference an earlier required step");
  }
  if (
    assertion.verification !== "state" &&
    !(
      dependency &&
      ["click", "fill", "press", "select", "check"].includes(
        dependency.action.type
      )
    )
  ) {
    issue(
      "Transition/persistence verification requires a preceding interaction"
    );
  }
  return assertion.id;
}
function validateScenarioContract(
  scenario: z.infer<typeof ScenarioSchema>,
  ctx: z.RefinementCtx
) {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const stepIds = scenario.steps.map((step) => step.id);
  if (new Set(stepIds).size !== stepIds.length) {
    issue("Duplicate contract step ids");
  }
  const evaluated: string[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    if (["finish", "blocked"].includes(step.action.type)) {
      issue("Finish/blocked cannot be a contract step");
    }
    const fault = establishingClickFault(scenario, index);
    if (fault) {
      issue(`Scenario ${scenario.id} step ${fault.stepId}: ${fault.reason}`);
    }
    const id = validateContractAssertion(scenario, index, ctx);
    if (id) {
      evaluated.push(id);
    }
  }
  if (new Set(evaluated).size !== evaluated.length) {
    issue("Repeated contract assertion");
  }
  if (evaluated.length !== scenario.assertions.length) {
    issue("Every assertion requires one ordered contract step");
  }
  const ids = scenario.assertions.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    issue("Duplicate assertion ids");
  }
}
export type Plan = z.infer<typeof PlanSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Assertion = z.input<typeof AssertionSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Locator = z.infer<typeof locator>;
export type Outcome = "passed" | "failed" | "blocked" | "skipped" | "stale";
/**
 * Issue de la publication du rapport : c'est la seule chose que dit
 * `Publication.status`. L'état du commit status posté sur GitHub est un autre
 * fait, consigné à part dans `Publication.commitStatus`.
 */
export type PublicationIssue = "published" | "failed";

/**
 * Ce que porte `publication` : deux faits distincts qui ne se recopient jamais.
 * Les result.json écrits avant cette séparation portent l'état du commit status
 * dans `status` ("success"/"error"/"failure") et aucun `commitStatus` : les
 * lecteurs restent donc tolérants à l'ancien vocabulaire d'un côté comme à
 * l'absence de l'autre.
 */
export interface Publication {
  /** URL du commentaire qui porte le rapport, absent si rien n'a été écrit. */
  commentUrl?: string;
  /**
   * Dernier état de commit status réellement écrit sur le commit par ce run
   * ("success"/"failure"/"error") : c'est le verdict du dernier post réussi,
   * qui peut donc précéder la fin du run — un run bloqué dont l'écriture du
   * verdict "error" a échoué garde le verdict écrit avant lui
   * (`runner.ts:publish`). Absent quand aucune écriture de commit status n'a
   * abouti, même si le rapport est publié : les deux écritures sont indépendantes
   * et ne s'attestent pas l'une l'autre.
   */
  commitStatus?: string;
  /**
   * "published" dès que le commentaire de rapport est sur la PR, "failed"
   * sinon : l'échec du verdict de statut n'en fait jamais partie.
   */
  status: PublicationIssue | "success" | "failure" | "error";
}

export interface Preview {
  evidence: string;
  sha: string;
  url: string;
}
export interface StepResult {
  action: Action;
  index: number;
  observation: string;
  ok: boolean;
  reason: string;
  /**
   * Clic `ifPresent` dont la cible était absente : l'étape n'a rien fait parce
   * que l'état qu'elle établit était déjà là. Ce n'est ni une réussite
   * silencieuse ni un échec, et le rapport le dit.
   */
  skipped?: boolean;
  /** Étape du contrat jouée ici : l'hôte exécute le plan, il ne l'interprète pas. */
  stepId?: string;
}
export interface ScenarioResult {
  artifacts: string[];
  assertions: {
    id: string;
    passed: boolean;
    actual: unknown;
    baseline?: unknown;
    persisted?: unknown;
  }[];
  contract?: { completedSteps: string[]; totalSteps: number; hash: string };
  diagnostic?: Diagnostic;
  error?: string;
  outcome: Outcome;
  scenario: Scenario;
  sessionId?: string;
  steps: StepResult[];
}
export interface RunResult {
  baseline?: { sha: string; url: string; scenarios: ScenarioResult[] };
  coverage?: {
    covered: string[];
    skipped: Plan["skipped"];
    policyRef: string;
    gate: string;
  };
  diagnostic?: Diagnostic;
  endedAt?: string;
  error?: string;
  id: string;
  model?: string;
  outcome: Outcome;
  plan?: Plan;
  preview?: Preview;
  prUrl: string;
  publication?: Publication;
  scenarios: ScenarioResult[];
  sha?: string;
  startedAt: string;
  usage?: {
    tokens: number;
    costUsd: number;
    /**
     * Cumul des réserves des tentatives perdues, chiffré à part des tokens que
     * l'endpoint a rapportés. Chaque réserve est créditée de ce que le transport
     * a réellement livré, plafonnée par le pire cas de la tentative perdue —
     * sauf un `total_tokens` déclaré au-delà de ce pire cas, repris tel quel ;
     * elle compte dans l'admission du run, donc une exposition qui dépasse
     * l'enveloppe y refuse toute admission suivante.
     */
    reservedTokens?: number;
    reservedCostUsd?: number;
    calls: number;
    model?: string;
    estimated?: boolean;
    pricingConfigured?: boolean;
    /** Reprises de transport effectuées pendant les appels modèle du run. */
    retries?: number;
  };
}
