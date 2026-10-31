import {
  type ModuleReference,
  moduleReferences,
  resolveSpecifier,
  type WorkspaceResolution,
} from "./consumer-resolution.js";

/**
 * Le matériel des CONSOMMATEURS d'un changement : les fichiers NON modifiés qui
 * importent un symbole dont la déclaration est touchée par le diff, réduits aux
 * déclarations de premier niveau qui l'utilisent.
 *
 * Le planificateur ne recevait que les fichiers modifiés et leurs imports
 * descendants (`dependencyPaths`, github.ts) : quand un diff change une valeur
 * calculée dans un module pur, l'écran qui l'affiche — son libellé, son
 * formatage, les contrôles qui la produisent — n'était nulle part dans son
 * message, et il ne pouvait asserter que la navigation. Ce module remonte le
 * graphe dans l'autre sens, par des règles structurelles seulement (imports,
 * réexports, nom de paquet du workspace, alias `paths` de tsconfig) : aucun nom
 * d'application n'y entre.
 *
 * Ce que la règle ne voit pas : un consommateur atteint par un import dynamique
 * calculé, par un autre langage, par HTTP (une API qui sérialise la valeur pour
 * un client séparé), ou au-delà du plafond de fichiers parcourus — le plafond
 * est alors nommé dans les avertissements, jamais tu. Les lectures du dépôt et
 * leurs plafonds vivent dans consumer-search.ts ; ce module ne fait aucune I/O.
 */

interface ConsumerExcerpt {
  endLine: number;
  startLine: number;
  text: string;
}

export interface ConsumerMaterial {
  excerpts: ConsumerExcerpt[];
  /** Le fichier modifié atteint, directement ou par un réexport. */
  imports: string;
  path: string;
  ref: string;
  /** Les symboles touchés par le diff que ce fichier utilise. */
  symbols: string[];
}

interface ChangedModule {
  content: string;
  patch?: string;
  path: string;
}

const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|mts|cts|vue|svelte)$/;
const IGNORED_DIRECTORY =
  /(?:^|\/)(?:node_modules|dist|build|out|coverage|vendor|\.next|\.turbo|\.git)\//;
const TEST_FILE =
  /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** Une excerpt plus longue se replie sur une fenêtre autour de l'usage. */
const MAX_EXCERPT_CHARS = 12_000;
const WINDOW_LINES = 25;

export function isConsumerCandidate(path: string): boolean {
  return SOURCE_FILE.test(path) && !IGNORED_DIRECTORY.test(path);
}

export function isTestPath(path: string): boolean {
  return TEST_FILE.test(path);
}

/** Lignes du nouveau fichier ajoutées, ou point d'insertion d'une suppression. */
function changedLineNumbers(patch: string | undefined): number[] {
  if (!patch) {
    return [];
  }
  const lines = new Set<number>();
  let next = 0;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      next = Number(header[1]);
      continue;
    }
    if (next === 0) {
      continue;
    }
    if (line.startsWith("+")) {
      lines.add(next);
      next++;
    } else if (line.startsWith("-")) {
      lines.add(next);
    } else if (!line.startsWith("\\")) {
      next++;
    }
  }
  return [...lines].sort((left, right) => left - right);
}

/** Une ligne en colonne 0 qui ouvre une déclaration ou une instruction de premier niveau. */
function isTopLevelStart(line: string): boolean {
  return /^[A-Za-z_$@]/.test(line);
}

const EXPORT_DECLARATION =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/;

/**
 * Les symboles exportés dont la déclaration contient une ligne changée. Quand
 * aucune ne la contient (le diff touche un utilitaire non exporté), tous les
 * symboles exportés du fichier : la valeur peut sortir par n'importe lequel.
 */
function changedExports(content: string, changed: number[]): string[] {
  const lines = content.split("\n");
  const declarations: { end: number; name: string; start: number }[] = [];
  for (const [index, line] of lines.entries()) {
    const name = EXPORT_DECLARATION.exec(line)?.[1];
    if (!name) {
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !isTopLevelStart(lines[end] ?? "")) {
      end++;
    }
    while (end > index + 1 && (lines[end - 1] ?? "").trim() === "") {
      end--;
    }
    declarations.push({ end, name, start: index + 1 });
  }
  const touched = declarations.filter((declaration) =>
    changed.some((line) => line >= declaration.start && line <= declaration.end)
  );
  return [
    ...new Set(
      (touched.length > 0 ? touched : declarations).map((item) => item.name)
    ),
  ];
}

function importLines(lines: string[]): Set<number> {
  const skipped = new Set<number>();
  let open = false;
  for (const [index, line] of lines.entries()) {
    if (
      open ||
      /^\s*(?:import|export)\b[^=(]*\bfrom\b|^\s*import\s*[{*\w]/.test(line)
    ) {
      skipped.add(index);
      open = !/\bfrom\s*["']|^\s*import\s*["']|;\s*$/.test(line);
    }
  }
  return skipped;
}

/** La déclaration de premier niveau qui entoure la ligne `index`, ou une fenêtre si elle est trop longue. */
function enclosingRange(lines: string[], index: number): [number, number] {
  let start = index;
  while (start > 0 && !isTopLevelStart(lines[start] ?? "")) {
    start--;
  }
  let end = index + 1;
  while (end < lines.length && !isTopLevelStart(lines[end] ?? "")) {
    end++;
  }
  end--;
  while (end > index && (lines[end] ?? "").trim() === "") {
    end--;
  }
  const size = lines
    .slice(start, end + 1)
    .reduce((sum, text) => sum + text.length + 1, 0);
  return size > MAX_EXCERPT_CHARS
    ? [
        Math.max(start, index - WINDOW_LINES),
        Math.min(end, index + WINDOW_LINES),
      ]
    : [start, end];
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const merged: [number, number][] = [];
  for (const range of [...ranges].sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }
  return merged;
}

/** Les déclarations de premier niveau qui contiennent un usage, fusionnées. */
function consumerExcerpts(
  content: string,
  symbols: string[]
): { excerpts: ConsumerExcerpt[]; used: string[] } {
  const lines = content.split("\n");
  const skipped = importLines(lines);
  const pattern = new RegExp(
    `(?<![\\w$])(${symbols.map((symbol) => symbol.replace(/[$]/g, "\\$")).join("|")})(?![\\w$])`,
    "g"
  );
  const used = new Set<string>();
  const ranges: [number, number][] = [];
  for (const [index, line] of lines.entries()) {
    const found = skipped.has(index)
      ? []
      : [...line.matchAll(pattern)].map((match) => match[1] ?? "");
    if (found.length > 0) {
      for (const symbol of found) {
        used.add(symbol);
      }
      ranges.push(enclosingRange(lines, index));
    }
  }
  return {
    excerpts: mergeRanges(ranges).map(([start, end]) => ({
      endLine: end + 1,
      startLine: start + 1,
      text: lines.slice(start, end + 1).join("\n"),
    })),
    used: symbols.filter((symbol) => used.has(symbol)),
  };
}

type Reach = Map<string, { origin: string; symbols: Set<string> }>;
type ResolvedReference = ModuleReference & { resolved?: string };

/** Les fichiers modifiés et les symboles exportés que leur diff touche. */
function changedReach(changed: ChangedModule[]): Reach {
  const reach: Reach = new Map();
  for (const module of changed) {
    const symbols = isConsumerCandidate(module.path)
      ? changedExports(module.content, changedLineNumbers(module.patch))
      : [];
    if (symbols.length > 0) {
      reach.set(module.path, {
        origin: module.path,
        symbols: new Set(symbols),
      });
    }
  }
  return reach;
}

/** Un passage de la fermeture par réexport ; vrai si un symbole a été ajouté. */
function propagateReexports(
  reach: Reach,
  references: Map<string, ResolvedReference[]>
): boolean {
  let grew = false;
  for (const [path, list] of references) {
    for (const reference of list) {
      const target = reference.resolved && reach.get(reference.resolved);
      if (!(reference.reexport && target)) {
        continue;
      }
      const passing = [...target.symbols].filter(
        (symbol) => !reference.names || reference.names.includes(symbol)
      );
      const entry = reach.get(path) ?? {
        origin: target.origin,
        symbols: new Set<string>(),
      };
      const before = entry.symbols.size;
      for (const symbol of passing) {
        entry.symbols.add(symbol);
      }
      grew ||= entry.symbols.size > before;
      if (entry.symbols.size > 0) {
        reach.set(path, entry);
      }
    }
  }
  return grew;
}

/** Ce qu'un fichier importe (hors réexport) parmi les symboles atteignables. */
function importedSymbols(
  list: ResolvedReference[],
  reach: Reach
): { origin: string; symbols: string[] } {
  const symbols = new Set<string>();
  let origin = "";
  for (const reference of list) {
    const target = reference.resolved && reach.get(reference.resolved);
    if (target && !reference.reexport) {
      origin ||= target.origin;
      for (const symbol of target.symbols) {
        symbols.add(symbol);
      }
    }
  }
  return { origin, symbols: [...symbols] };
}

/** Garde les excerpts dans l'ordre tant que le budget les couvre ; nomme le reste. */
function withinBudget(
  found: ConsumerMaterial[],
  budget: number
): { consumers: ConsumerMaterial[]; warnings: string[] } {
  const consumers: ConsumerMaterial[] = [];
  const warnings: string[] = [];
  let remaining = budget;
  for (const consumer of found) {
    // Compté tel que le planificateur le reçoit : en JSON, champs du
    // consommateur compris (chemin, symboles, import), une fois par fichier.
    let overhead = JSON.stringify({ ...consumer, excerpts: [] }).length;
    const kept = consumer.excerpts.filter((excerpt) => {
      const cost = JSON.stringify(excerpt).length + 1 + overhead;
      if (cost > remaining) {
        return false;
      }
      remaining -= cost;
      overhead = 0;
      return true;
    });
    if (kept.length < consumer.excerpts.length) {
      warnings.push(
        `Consumer context budget exhausted: ${consumer.excerpts.length - kept.length} excerpt(s) of ${consumer.path} omitted`
      );
    }
    if (kept.length > 0) {
      consumers.push({ ...consumer, excerpts: kept });
    }
  }
  return { consumers, warnings };
}

/**
 * Les consommateurs NON modifiés des symboles touchés, dans la limite de
 * `budget` caractères (JSON) d'excerpts : code applicatif d'abord (c'est lui qui rend
 * la valeur), tests ensuite (ils fixent le contrat). Ce qui ne tient pas est
 * nommé dans `warnings`.
 */
export function findConsumers(input: {
  budget: number;
  changed: ChangedModule[];
  /** Fichiers source lus à la révision de tête, chemin → contenu. */
  files: Map<string, string>;
  ref: string;
  workspace: WorkspaceResolution;
}): { consumers: ConsumerMaterial[]; warnings: string[] } {
  // Cible → symboles atteignables par elle. Les modules de réexport héritent
  // des symboles qu'ils laissent passer.
  const reach = changedReach(input.changed);
  if (reach.size === 0) {
    return { consumers: [], warnings: [] };
  }
  const exists = (path: string) => input.files.has(path);
  const references = new Map<string, ResolvedReference[]>();
  for (const [path, content] of input.files) {
    references.set(
      path,
      moduleReferences(content).map((reference) => {
        const resolved = resolveSpecifier(
          path,
          reference.specifier,
          exists,
          input.workspace
        );
        return resolved ? { ...reference, resolved } : reference;
      })
    );
  }
  // Fermeture par réexport, bornée : un barrel de barrel reste atteint.
  let depth = 0;
  while (depth < 4 && propagateReexports(reach, references)) {
    depth++;
  }
  const changedPaths = new Set(input.changed.map((module) => module.path));
  const found: ConsumerMaterial[] = [];
  for (const [path, list] of references) {
    const { origin, symbols } = importedSymbols(list, reach);
    if (changedPaths.has(path) || symbols.length === 0) {
      continue;
    }
    const { excerpts, used } = consumerExcerpts(
      input.files.get(path) ?? "",
      symbols
    );
    if (excerpts.length > 0) {
      found.push({
        excerpts,
        imports: origin,
        path,
        ref: input.ref,
        symbols: used,
      });
    }
  }
  found.sort(
    (left, right) =>
      Number(isTestPath(left.path)) - Number(isTestPath(right.path)) ||
      left.path.localeCompare(right.path)
  );
  return withinBudget(found, input.budget);
}
