import type { Locator } from "./schema.js";

/**
 * Ce qu'un sélecteur CSS doit à une classe ou à une couleur : la classe et la
 * couleur changent sans que le comportement change, et la source n'en fait pas
 * une preuve. Le contrôle est déterministe — il ne dépend ni du modèle ni de
 * l'instantané de découverte — pour qu'un plan fautif soit refusé avant
 * exécution, et réparé par le planificateur.
 *
 * La couleur n'est lue que là où elle est déclarée : une propriété de couleur
 * suivie de `:` puis d'une valeur, ou un attribut de présentation
 * (`fill="#b42318"`). Ailleurs un `#abc` est un identifiant — `#saved`,
 * `[id="#abc"]`, `[value="#ffffff"]` — et une valeur `url()` n'est jamais une
 * couleur : `url(#abc)` référence un dégradé, ce n'est pas un code hexadécimal.
 */

/** Moteur de locator Playwright, `<moteur>=valeur` : seul `css=` annonce un sélecteur CSS. */
const ENGINE = /^([a-z][\w-]*)\s*=/i;

/** Classe CSS : un point hors chaîne littérale et hors crochets, jamais un chiffre de `0.5`. */
const CLASS_NAME = /\.(?!\d)[a-z_\u00a0-\uffff-][\w\u00a0-\uffff-]*/i;

/** Attribut class : `[class]` seul ne nomme aucune classe, il n'est pas visé. */
const CLASS_ATTRIBUTE = /^\[\s*class\s*[*^$~|]?\s*=/i;

/** Attributs SVG dont la valeur est la couleur elle-même. */
const PRESENTATION_ATTRIBUTE = /^(?:fill|stroke|color|bg)$/i;

/**
 * Propriétés dont la valeur peut porter une `<color>` : `color`, toute propriété
 * `…-color`, les familles qui mêlent la couleur à d'autres composants
 * (`background`, `border`, `outline`, `text-decoration`, `text-shadow`,
 * `box-shadow`) et celles qui la portent seules (`fill`, `stroke`). La liste est
 * fermée : c'est elle qui distingue une déclaration de style d'une donnée de la
 * page, donc `[data-state=red]` et `[value=red]` ne sont pas des couleurs.
 */
const COLOR_PROPERTY =
  /^(?:color|background|border|outline|text-decoration|text-shadow|box-shadow|fill|stroke)(?:-|$)|-color$/;

/** Déclaration : `propriété: valeur` dans un style, `attribut=valeur` dans un crochet. */
const DECLARATION = /(?<![\w-])([a-z][\w-]*)\s*(?:([*^$~|]?=)|:)\s*/i;

/** Un `url()` est une référence, jamais une couleur — même s'il n'est pas refermé. */
const URL_REFERENCE = /url\([^)]*\)?/gi;

/** Hexadécimal à 8, 4, 6 puis 3 chiffres, jamais suivi d'un identifiant. */
const HEX_COLOR =
  /#(?:[0-9a-f]{8}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{3})(?![\w-])/i;

/** Fonction de couleur, nom seul : `(?<![\w-])` empêche de lire `lab(` dans `oklab(`. */
const COLOR_FUNCTION =
  /(?<![\w-])(?:color-mix|color|rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/i;

/** Couleur nommée : un identifiant entier, jamais le suffixe d'un autre mot. */
const COLOR_NAME = /(?<![\w-])[a-z]+(?![\w-])/gi;

/** Les couleurs nommées de CSS Color 4, plus `transparent` et `currentcolor`. */
const NAMED_COLORS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black
blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse
chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
darkslateblue darkslategray darkslategrey darkturquoise darkviolet
deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green
greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender
lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
lightgoldenrodyellow lightgray lightgreen lightgrey lightpink
lightsalmon lightseagreen lightskyblue lightslategray lightslategrey
lightsteelblue lightyellow lime limegreen linen magenta maroon
mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
mediumslateblue mediumspringgreen mediumturquoise mediumvioletred
midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive
olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise
palevioletred papayawhip peachpuff peru pink plum powderblue purple
rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
seagreen seashell sienna silver skyblue slateblue slategray slategrey
snow springgreen steelblue tan teal thistle tomato turquoise violet
wheat white whitesmoke yellow yellowgreen transparent currentcolor`.split(/\s+/)
);

/**
 * Le sélecteur privé de ses chaînes littérales, à longueur constante : un point
 * ou une classe dans une chaîne est une valeur d'attribut, jamais un sélecteur,
 * et une longueur conservée laisse citer le fragment fautif.
 */
function selectorCode(selector: string): string {
  let code = "";
  let quote: string | undefined;
  let index = 0;
  while (index < selector.length) {
    const char = selector[index] as string;
    // Un caractère échappé appartient à un identifiant, jamais à un sélecteur.
    if (char === "\\") {
      const escaped = selector[index + 1];
      code += escaped === undefined ? " " : "  ";
      index += escaped === undefined ? 1 : 2;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      code += " ";
    } else if (char === '"' || char === "'") {
      quote = char;
      code += " ";
    } else {
      code += char;
    }
    index += 1;
  }
  return code;
}

/**
 * Le sélecteur privé du contenu de ses crochets, à longueur constante : un point
 * dans une valeur d'attribut n'est jamais une classe. Le sélecteur reçu n'a plus
 * ses chaînes littérales, donc un crochet entre guillemets n'en ouvre aucun.
 */
function outsideBrackets(code: string): string {
  return code.replace(/\[[^\]]*\]?/g, (block) => " ".repeat(block.length));
}

/**
 * Blocs entre crochets, chaînes littérales comprises : c'est là qu'un attribut
 * et une couleur se lisent, y compris dans la forme observée
 * `p[class*="text-[#b42318]"]`.
 */
function bracketBlocks(selector: string): string[] {
  const blocks: string[] = [];
  let quote: string | undefined;
  let start = -1;
  let index = 0;
  while (index < selector.length) {
    const char = selector[index] as string;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[") {
      start = index;
    } else if (char === "]" && start >= 0) {
      blocks.push(selector.slice(start, index + 1));
      start = -1;
    }
    index += 1;
  }
  if (start >= 0) {
    blocks.push(selector.slice(start));
  }
  return blocks;
}

/**
 * Segments d'une chaîne Playwright : `>>` sépare des sélecteurs indépendants,
 * chacun avec son moteur, et un `>>` entre guillemets appartient à sa valeur.
 */
function selectorChain(selector: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index] as string;
    if (char === "\\") {
      current += selector.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">" && selector[index + 1] === ">") {
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Valeur d'une déclaration, guillemets retirés, et position de fin. */
function readValue(
  text: string,
  start: number
): { end: number; value: string } {
  let index = start;
  while (index < text.length && /\s/.test(text[index] as string)) {
    index += 1;
  }
  const quote = text[index];
  if (quote === '"' || quote === "'") {
    for (let cursor = index + 1; cursor < text.length; cursor += 1) {
      if (text[cursor] === "\\") {
        cursor += 1;
      } else if (text[cursor] === quote) {
        return { end: cursor + 1, value: text.slice(index + 1, cursor) };
      }
    }
    return { end: text.length, value: text.slice(index + 1) };
  }
  let end = index;
  while (end < text.length && !";]\"'".includes(text[end] as string)) {
    end += 1;
  }
  return { end, value: text.slice(index, end) };
}

/** Une valeur porte-t-elle une couleur ? Les `url()` sont retirés avant lecture. */
function hasColor(value: string): boolean {
  const readable = value.replace(URL_REFERENCE, " ");
  if (HEX_COLOR.test(readable) || COLOR_FUNCTION.test(readable)) {
    return true;
  }
  for (const match of readable.matchAll(COLOR_NAME)) {
    if (NAMED_COLORS.has((match[0] ?? "").toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Ce qu'un texte de déclarations doit à une couleur, ou `undefined`. Un
 * `style=` est relu comme une déclaration ; les autres attributs ne le sont que
 * s'ils portent une couleur de présentation, donc `[data-color=red]` reste une
 * donnée de la page. La valeur lue n'est jamais relue comme une déclaration :
 * `[data-x="fill:red"]` ne nomme pas de style.
 */
function declarationColor(text: string): string | undefined {
  // Une relecture de `style` est récursive : chaque appel a son propre index de
  // dernier match.
  const pattern = new RegExp(DECLARATION.source, "gi");
  let match = pattern.exec(text);
  while (match) {
    const name = (match[1] ?? "").toLowerCase();
    const attribute = match[2] !== undefined;
    const { end, value } = readValue(text, match.index + match[0].length);
    if (attribute && name === "style") {
      const declaration = declarationColor(value);
      if (declaration) {
        return declaration;
      }
    } else if (attribute) {
      if (PRESENTATION_ATTRIBUTE.test(name) && hasColor(value)) {
        return `${name}=${value.trim()}`;
      }
    } else if (COLOR_PROPERTY.test(name) && hasColor(value)) {
      return `${name}:${value.trim()}`;
    }
    pattern.lastIndex = end;
    match = pattern.exec(text);
  }
  return;
}

/**
 * Ce qu'un locator CSS doit à une classe ou à une couleur, `undefined` quand il
 * n'en dépend pas. Chaque segment de la chaîne est analysé : `role=button >> .foo`
 * porte un sélecteur CSS dans son second segment. `role=`, `text=` et les autres
 * moteurs Playwright ne sont pas des sélecteurs CSS — un point y est du texte —,
 * seul `css=` en annonce.
 */
export function unstableSelectorReason(locator: Locator): string | undefined {
  if (locator.by !== "css") {
    return;
  }
  for (const segment of selectorChain(locator.value)) {
    const engine = ENGINE.exec(segment);
    if (engine && (engine[1] ?? "").toLowerCase() !== "css") {
      continue;
    }
    const css = engine ? segment.slice(engine[0].length) : segment;
    // Un point n'est une classe que hors chaînes littérales et hors crochets —
    // sinon `[data-file=report.png]` serait une classe.
    const className = CLASS_NAME.exec(outsideBrackets(selectorCode(css)))?.[0];
    if (className) {
      return `a class name (${className})`;
    }
    for (const block of bracketBlocks(css)) {
      if (CLASS_ATTRIBUTE.test(block)) {
        return `a class attribute selector (${block})`;
      }
      const color = declarationColor(block);
      if (color) {
        return `a color value (${color})`;
      }
    }
  }
  return;
}
