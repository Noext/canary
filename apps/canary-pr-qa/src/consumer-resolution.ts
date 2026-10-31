import { posix } from "node:path";

/**
 * La résolution des imports d'un dépôt lu à distance, pour la recherche des
 * consommateurs (voir consumer-context.ts) : imports et réexports d'un source,
 * chemins relatifs, nom de paquet du workspace (`exports["."]`, `module`,
 * `main`) et alias `paths` de tsconfig. Règles structurelles seulement : aucun
 * nom d'application n'y entre.
 */

const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

export interface ModuleReference {
  /** Pour un réexport nommé, les noms réexportés ; absent pour `export *`. */
  names?: string[];
  /** Vrai pour `export … from`, qui fait du fichier un module de réexport. */
  reexport: boolean;
  specifier: string;
}

export function moduleReferences(source: string): ModuleReference[] {
  const references: ModuleReference[] = [];
  for (const match of source.matchAll(
    /(^|[\n;])\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/g
  )) {
    const keyword = match[2];
    const clause = match[4] ?? "";
    const specifier = match[5] ?? "";
    if (keyword === "export") {
      const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
      references.push({
        reexport: true,
        specifier,
        ...(braces
          ? {
              names: (braces[1] ?? "")
                .split(",")
                .map(
                  (part) =>
                    part
                      .trim()
                      .split(/\s+as\s+/)[0]
                      ?.trim() ?? ""
                )
                .filter(Boolean),
            }
          : {}),
      });
    } else {
      references.push({ reexport: false, specifier });
    }
  }
  for (const match of source.matchAll(
    /(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g
  )) {
    references.push({ reexport: false, specifier: match[1] ?? "" });
  }
  return references;
}

export interface WorkspaceResolution {
  /** Alias `paths` d'un tsconfig : préfixe → cibles, valables sous `directory`. */
  aliases: { directory: string; prefix: string; targets: string[] }[];
  /** Nom de paquet du workspace → fichier d'entrée (exports["."], module, main). */
  packages: Map<string, { directory: string; entry?: string }>;
}

function packageEntry(manifest: Record<string, unknown>): string | undefined {
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") {
      return value;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["import", "types", "default", "require", "node"]) {
        const found = pick(record[key]);
        if (found) {
          return found;
        }
      }
    }
    return;
  };
  const exports = manifest.exports;
  if (exports && typeof exports === "object" && "." in exports) {
    return pick((exports as Record<string, unknown>)["."]);
  }
  return pick(exports) ?? pick(manifest.module) ?? pick(manifest.main);
}

function lenientJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(
        text
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:"])\/\/.*$/gm, "$1")
          .replace(/,\s*([}\]])/g, "$1")
      ) as Record<string, unknown>;
    } catch {
      return;
    }
  }
}

function directoryOf(path: string): string {
  return posix.dirname(path) === "." ? "" : posix.dirname(path);
}

function tsconfigAliases(
  directory: string,
  json: Record<string, unknown>
): WorkspaceResolution["aliases"] {
  const options = json.compilerOptions as
    | { baseUrl?: string; paths?: Record<string, unknown> }
    | undefined;
  const base = posix.join(directory, options?.baseUrl ?? ".");
  return Object.entries(options?.paths ?? {})
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([pattern, targets]) => ({
      directory,
      prefix: pattern.replace(/\*$/, ""),
      targets: targets.map((target) =>
        posix.join(base, String(target).replace(/\*$/, ""))
      ),
    }));
}

/** Les manifestes et tsconfig lus : ce qu'il faut pour résoudre un import non relatif. */
export function workspaceResolution(
  manifests: Map<string, string>
): WorkspaceResolution {
  const resolution: WorkspaceResolution = {
    aliases: [],
    packages: new Map(),
  };
  for (const [path, text] of manifests) {
    const json = lenientJson(text);
    const directory = directoryOf(path);
    if (!json) {
      continue;
    }
    if (posix.basename(path) !== "package.json") {
      resolution.aliases.push(...tsconfigAliases(directory, json));
      continue;
    }
    if (typeof json.name === "string") {
      const entry = packageEntry(json);
      resolution.packages.set(json.name, {
        directory,
        ...(entry ? { entry: posix.join(directory, entry) } : {}),
      });
    }
  }
  return resolution;
}

export function resolveSpecifier(
  from: string,
  specifier: string,
  exists: (path: string) => boolean,
  workspace: WorkspaceResolution
): string | undefined {
  const tryBase = (base: string): string | undefined => {
    const normalized = posix.normalize(base).replace(/^\.\//, "");
    if (normalized.startsWith("..")) {
      return;
    }
    const stripped = normalized.replace(/\.(?:m|c)?js$/, "");
    for (const candidate of [normalized, stripped]) {
      for (const suffix of RESOLVE_SUFFIXES) {
        if (exists(candidate + suffix)) {
          return candidate + suffix;
        }
      }
    }
    return;
  };
  if (specifier.startsWith(".")) {
    return tryBase(posix.join(posix.dirname(from), specifier));
  }
  for (const alias of workspace.aliases) {
    if (
      alias.prefix &&
      specifier.startsWith(alias.prefix) &&
      (alias.directory === "" || from.startsWith(`${alias.directory}/`))
    ) {
      for (const target of alias.targets) {
        const found = tryBase(target + specifier.slice(alias.prefix.length));
        if (found) {
          return found;
        }
      }
    }
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0];
  const workspacePackage = name ? workspace.packages.get(name) : undefined;
  if (!workspacePackage) {
    return;
  }
  const subpath = specifier.slice((name ?? "").length).replace(/^\//, "");
  if (subpath) {
    return (
      tryBase(posix.join(workspacePackage.directory, subpath)) ??
      tryBase(posix.join(workspacePackage.directory, "src", subpath))
    );
  }
  return workspacePackage.entry
    ? tryBase(workspacePackage.entry)
    : tryBase(posix.join(workspacePackage.directory, "src/index"));
}
