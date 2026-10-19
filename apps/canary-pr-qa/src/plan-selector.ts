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
export function bracketBlocks(selector: string): string[] {
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
 * Les sélecteurs CSS d'un locator, moteur retiré : `css=aside > div` et
 * `role=button >> aside > div` rendent `aside > div`. `role=`, `text=` et les
 * autres moteurs Playwright ne sont pas des sélecteurs CSS — un point y est du
 * texte —, seul `css=` en annonce. Un segment `css=` est rendu sans son moteur,
 * pour qu'un contrôle puisse lire le sélecteur lui-même.
 */
export function cssSelectors(value: string): string[] {
  return selectorChain(value).flatMap((segment) => {
    const engine = ENGINE.exec(segment);
    if (engine && (engine[1] ?? "").toLowerCase() !== "css") {
      return [];
    }
    return [engine ? segment.slice(engine[0].length) : segment];
  });
}

/**
 * Ce qu'un locator CSS doit à une classe ou à une couleur, `undefined` quand il
 * n'en dépend pas. Chaque segment de la chaîne est analysé : `role=button >> .foo`
 * porte un sélecteur CSS dans son second segment (voir `cssSelectors`).
 */
export function unstableSelectorReason(locator: Locator): string | undefined {
  if (locator.by !== "css") {
    return;
  }
  for (const css of cssSelectors(locator.value)) {
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

/**
 * Ce qu'un sélecteur CSS doit à une POSITION plutôt qu'à un nom. Un combinateur
 * (`>`, `+`, `~`, l'espace descendant) relie des composés sans nommer l'élément
 * visé, et une pseudo-classe positionnelle (`:nth-of-type(2)`, `:first-child`)
 * désigne le même endroit d'une liste : le sélecteur décrit OÙ l'élément se
 * trouve, pas l'élément. Playwright le refuse alors en strict mode dès que deux
 * éléments occupent cet endroit, ce qui arrive par construction et non par
 * accident.
 *
 * Mesuré sur les artefacts de production conservés (189 runs au plan conservé,
 * 1 050 scénarios, 3 027 cibles CSS) : 101 cibles de cette forme sont refusées,
 * dont 90 appartenaient à des scénarios qui passaient, 2 à des scénarios en
 * échec et 9 à des scénarios bloqués. `aside > div` en résolvait 4 et a bloqué
 * les 4 scénarios qui l'utilisaient (run 93cd4991, « strict mode violation :
 * resolved to 4 elements »).
 *
 * Une cible qui NOMME l'élément qu'elle SÉLECTIONNE — un `#id`, un attribut qui
 * porte une valeur, écrits sur le dernier composé — n'est pas refusée : le
 * chemin qui la rejoint n'est qu'un contexte. Nommer un ancêtre ne suffit pas,
 * parce qu'un conteneur stable ne rend pas ses descendants uniques. Une liste de
 * sélecteurs (`a, b`) est lue alternative par alternative : une alternative
 * positionnelle rend la liste ambiguë même si une autre nomme son élément.
 * La lecture descend dans les arguments des pseudo-classes fonctionnelles qui
 * prennent un sélecteur (`:not`, `:is`, `:where`, `:has`, `:nth-child(An+B of
 * S)`, `:nth-of-type`) : un chemin écrit là désigne la même position que dans
 * le composé qui le porte, donc `:is(aside > div)` est refusé comme
 * `aside > div`. Un argument sans chemin (`:not([disabled])`, `:has(label)`)
 * ne change rien.
 *
 * La règle est indépendante du modèle et de l'instantané de découverte, comme
 * celle des classes et des couleurs, pour que le plan soit refusé AVANT la
 * première étape navigateur.
 */

/** Où en est la lecture d'un composé : profondeur de bloc, chaîne ouverte, échappement. */
interface OutlineState {
  depth: number;
  escaped: boolean;
  quote?: string;
}

/**
 * Un caractère du composé, remplacé par `x` quand il appartient à une chaîne
 * littérale, à un bloc `[...]` ou à un groupe `(...)`, et rendu tel quel
 * sinon. Le remplacement n'est jamais un espace, sinon
 * `input[inputmode="numeric"]` deviendrait un descendant de `input`. Le
 * crochet et la parenthèse ouvrants restent lisibles pour que le nom d'une
 * pseudo-classe reste adjacent à sa parenthèse : `div:nth-of-type(2)` se lit
 * `div:nth-of-type(xx)`, qui porte bien `:nth-of-type`.
 */
function outlineStep(state: OutlineState, char: string): string {
  if (state.quote) {
    if (state.escaped) {
      state.escaped = false;
    } else if (char === "\\") {
      state.escaped = true;
    } else if (char === state.quote) {
      state.quote = undefined;
    }
    return "x";
  }
  if (char === '"' || char === "'") {
    state.quote = char;
    return "x";
  }
  if (char === "[" || char === "(") {
    state.depth += 1;
    return char;
  }
  if (char === "]" || char === ")") {
    state.depth = Math.max(0, state.depth - 1);
    return char;
  }
  return state.depth > 0 ? "x" : char;
}

/** Le composé ramené à sa structure : voir `outlineStep`. */
function positionalOutline(segment: string): string {
  const state: OutlineState = { depth: 0, escaped: false };
  let outline = "";
  for (const char of segment) {
    outline += outlineStep(state, char);
  }
  return outline;
}

/**
 * Les pseudo-classes qui sélectionnent une POSITION dans une liste : elles
 * nomment un rang, jamais l'élément, donc plusieurs éléments peuvent le porter
 * (`div:nth-of-type(2)` en désigne un par conteneur). `:has(...)` et les
 * pseudo-classes d'état (`:disabled`, `:checked`) n'en font pas partie.
 */
const POSITIONAL_PSEUDO_CLASS =
  /:(?:nth-of-type|nth-last-of-type|nth-child|nth-last-child|first-child|last-child|first-of-type|last-of-type|only-child|only-of-type)\b/i;

/**
 * La position que le composé exprime, nommée pour le message, ou `undefined`.
 * La pseudo-classe est citée en premier parce qu'elle est la cause la plus
 * précise ; le combinateur la suit.
 */
function positionalReason(outline: string): string | undefined {
  const pseudo = POSITIONAL_PSEUDO_CLASS.exec(outline)?.[0];
  if (pseudo) {
    return `positional pseudo-class ${pseudo}`;
  }
  const symbol = /[>+~]/.exec(outline)?.[0];
  if (symbol === ">") {
    return "child combinator >";
  }
  if (symbol === "+") {
    return "adjacent-sibling combinator +";
  }
  if (symbol === "~") {
    return "general-sibling combinator ~";
  }
  return /\S\s+\S/.test(outline)
    ? "descendant combinator (a space)"
    : undefined;
}

/**
 * Les alternatives d'une liste de sélecteurs CSS (`a, b`), séparées par une
 * virgule de premier niveau : une virgule dans `[data-x="a,b"]` ou dans
 * `:not(a, b)` appartient à sa valeur ou à son groupe. Chaque alternative est
 * sélectionnée indépendamment, sinon une alternative qui nomme son élément
 * blanchirait une alternative positionnelle de la même liste.
 */
function commaAlternatives(css: string): string[] {
  const alternatives: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index] as string;
    if (char === "\\") {
      current += css.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[" || char === "(") {
      depth += 1;
    } else if (char === "]" || char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  alternatives.push(current);
  return alternatives
    .map((alternative) => alternative.trim())
    .filter((alternative) => alternative.length > 0);
}

/**
 * Les pseudo-classes fonctionnelles dont l'argument EST un sélecteur : ce que
 * l'argument sélectionne fait partie du même chemin que le composé qui le
 * porte. `:has(label)` et `:not([disabled])` en font partie sans écrire aucun
 * chemin, et n'opposent donc aucun refus.
 */
const SELECTOR_ARGUMENT_PSEUDO_CLASS =
  /:(not|is|where|matches|has|nth-child|nth-last-child|nth-of-type|nth-last-of-type)\(/gi;

/** Les `:nth-*`, dont l'argument est `An+B [of S]` : seul `S` est un sélecteur. */
const NTH_ARGUMENT_PSEUDO_CLASS = /^nth-/i;

/** L'index de la parenthèse qui ferme celle ouverte à `open`, ou `-1`. */
function closingParenthesis(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** Le sélecteur `S` d'un argument `An+B of S`, ou `undefined` sans clause `of`. */
function nthOfSelector(argument: string): string | undefined {
  const match = /(?:^|\s)of\s+/i.exec(selectorCode(argument));
  return match ? argument.slice(match.index + match[0].length) : undefined;
}

/**
 * Les sélecteurs passés en argument à une pseudo-classe fonctionnelle, dans
 * l'ordre du texte. Le sélecteur est lu sur son `selectorCode`, donc une
 * parenthèse entre guillemets n'en ouvre aucune, et un argument imbriqué est
 * laissé à l'appel récursif plutôt que relu ici.
 */
function selectorArguments(selector: string): string[] {
  const code = selectorCode(selector);
  const pattern = new RegExp(SELECTOR_ARGUMENT_PSEUDO_CLASS.source, "gi");
  const arguments_: string[] = [];
  let match = pattern.exec(code);
  while (match) {
    const open = match.index + match[0].length - 1;
    const close = closingParenthesis(code, open);
    if (close < 0) {
      break;
    }
    const argument = selector.slice(open + 1, close);
    if (NTH_ARGUMENT_PSEUDO_CLASS.test(match[1] ?? "")) {
      const ofSelector = nthOfSelector(argument);
      if (ofSelector !== undefined) {
        arguments_.push(ofSelector);
      }
    } else {
      arguments_.push(argument);
    }
    pattern.lastIndex = close + 1;
    match = pattern.exec(code);
  }
  return arguments_;
}

/** Attribut qui porte une valeur : `[data-testid="total"]`. Il nomme un élément. */
const ATTRIBUTE_WITH_VALUE =
  /^\[\s*[a-zA-Z_][-\w]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\]\s]+)\s*\]$/;

/** Attribut de seule présence : `[data-cash-state]`. Il prouve une présence, il ne nomme rien. */
const ATTRIBUTE_PRESENCE = /^\[\s*[a-zA-Z_][-\w]*\s*\]$/;

/**
 * Les attributs de seule PRÉSENCE d'une alternative : `[data-cash-state]`
 * prouve une présence, il ne nomme aucun élément. Ils servent au message, qui
 * propose le conteneur que le plan nomme déjà, jamais à l'exemption.
 */
function presenceAttributes(alternative: string): string[] {
  return bracketBlocks(alternative).filter((block) =>
    ATTRIBUTE_PRESENCE.test(block)
  );
}

/**
 * Le composé que l'alternative SÉLECTIONNE : le dernier, une fois les
 * combinateurs de premier niveau retirés (`#saved > span` sélectionne `span`).
 * `positionalOutline` fournit le masque — chaînes littérales, crochets et
 * groupes parenthésés rendus opaques — et sa longueur est celle de
 * l'alternative, donc les deux index coïncident. Un `>`, un `+`, un `~` ou un
 * blanc de premier niveau ouvre le composé suivant ; un caractère échappé
 * appartient à son identifiant (`p.class\ name` ne contient pas de descendant).
 */
function selectedCompound(alternative: string): string {
  const outline = positionalOutline(alternative);
  let start = 0;
  for (let index = 0; index < outline.length; index += 1) {
    // Un antislash lisible dans le contour est de premier niveau : le caractère
    // qu'il échappe appartient à son identifiant, jamais à un combinateur.
    if (outline[index] === "\\") {
      index += 1;
      continue;
    }
    if (/[>+~\s]/.test(outline[index] as string)) {
      start = index + 1;
    }
  }
  return alternative.slice(start);
}

/**
 * Les blocs `[...]` écrits SUR le composé, hors crochets imbriqués et hors
 * groupes parenthésés : un attribut dans `:has([data-testid="x"])` décrit un
 * descendant, donc il ne nomme pas l'élément sélectionné. Le composé est lu sur
 * son `positionalOutline`, où chaînes et contenu sont masqués à longueur
 * constante : il ne reste que la structure, et un bloc de premier niveau se
 * reconnaît à son crochet ouvert à profondeur zéro.
 */
function ownAttributeBlocks(compound: string): string[] {
  const outline = positionalOutline(compound);
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < outline.length; index += 1) {
    const char = outline[index];
    if (char === "[") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === "(") {
      depth += 1;
    } else if (char === "]" || char === ")") {
      depth = Math.max(0, depth - 1);
      if (char === "]" && depth === 0 && start >= 0) {
        blocks.push(compound.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return blocks;
}

/**
 * Le composé nomme-t-il l'ÉLÉMENT QU'IL SÉLECTIONNE ? Un `#id` et un attribut
 * qui porte une valeur le nomment, à condition d'être écrits sur ce composé :
 * un `#id` dans `[href="#abc"]`, dans `:has(#saved)` ou dans `:not(#x)` désigne
 * autre chose que l'élément visé, et un attribut écrit dans `:has(...)` décrit
 * un descendant.
 *
 * Un ancêtre nommé ne suffit pas : `#saved > span` sélectionne TOUS les `span`
 * de `#saved`, `[data-testid="total"] > span` tous ceux de `[data-testid="total"]`,
 * et Playwright les refuse en strict mode dès que deux existent. C'est la même
 * ambiguïté que `aside > div`, avec un conteneur stable devant.
 */
function namesItsElement(compound: string): boolean {
  // Un `#` n'est un id que hors chaînes littérales, hors crochets et hors
  // groupes parenthésés : `#abc` dans `[href="#abc"]` est une valeur,
  // `url(#abc)` une référence, `:has(#abc)` un descendant.
  if (/#[A-Za-z_][\w-]*/.test(positionalOutline(compound))) {
    return true;
  }
  return ownAttributeBlocks(compound).some((block) =>
    ATTRIBUTE_WITH_VALUE.test(block)
  );
}

/** Un chemin positionnel refusé : la position qu'il exprime, et le sélecteur qui l'écrit. */
interface PositionalPath {
  path: string;
  position: string;
}

/**
 * Le premier chemin positionnel de l'alternative, à quelque profondeur qu'il
 * soit écrit, ou `undefined` quand elle se contente de nommer son élément. Un
 * argument de pseudo-classe fonctionnelle est lu comme une alternative à part
 * entière, parce qu'il fait partie du même chemin : `:is(aside > div)` ne
 * sélectionne pas un élément plus unique que `aside > div`.
 */
function positionalPath(alternative: string): PositionalPath | undefined {
  const position = positionalReason(positionalOutline(alternative));
  if (position && !namesItsElement(selectedCompound(alternative))) {
    return { path: alternative, position };
  }
  for (const argument of selectorArguments(alternative)) {
    for (const nested of commaAlternatives(argument)) {
      const path = positionalPath(nested);
      if (path) {
        return path;
      }
    }
  }
  return;
}

/**
 * Ce qu'un locator CSS doit à une position, `undefined` quand il nomme son
 * élément. `aside > div`, `div:nth-of-type(2)`, `#saved > span` et
 * `[data-testid="total"] > span` sont refusés ; `div > #saved`,
 * `li:first-child[id="saved"]`, `[role="status"]` et
 * `[data-cash-state="cloture"]` ne le sont pas : l'ancre doit désigner
 * l'élément que le sélecteur SÉLECTIONNE, pas l'un de ses ancêtres. Le chemin
 * est cherché à toute profondeur, donc `:is(aside > div)` et
 * `div:has(li:nth-child(2))` sont refusés pour la même raison.
 *
 * La raison cite le chemin fautif et, quand le plan y nomme déjà un conteneur
 * (`[data-cash-state]`), la cible stable qu'il peut viser à la place.
 */
export function structuralSelectorReason(locator: Locator): string | undefined {
  if (locator.by !== "css") {
    return;
  }
  for (const css of cssSelectors(locator.value)) {
    for (const alternative of commaAlternatives(css)) {
      const found = positionalPath(alternative);
      if (!found) {
        continue;
      }
      const container = presenceAttributes(found.path)[0];
      return `a structural path (${found.path}, ${found.position}: it names a position instead of an element, so it matches several elements by construction${container ? `; the plan already names ${container} in it, target that container instead` : ""})`;
    }
  }
  return;
}
