import { z } from "zod";
import type { Config } from "./config.js";
import {
  type ConsumerMaterial,
  findConsumers,
  isConsumerCandidate,
  isTestPath,
} from "./consumer-context.js";
import { workspaceResolution } from "./consumer-resolution.js";
import { redact } from "./diagnostics.js";

/**
 * La recherche des consommateurs dans le dépôt : un arbre (une requête), puis
 * les manifestes et les fichiers source lus à la révision de tête, et la
 * recherche structurelle de consumer-context.ts sur ce qui a été lu.
 *
 * Chaque lecture coûte une requête à l'API du dépôt. Tout ce qui borne ou
 * dégrade la recherche est NOMMÉ dans les avertissements, jamais tu : un plafond
 * atteint, une lecture qui échoue pour une autre raison qu'une absence (quota,
 * erreur serveur, délai), un fichier modifié qui n'a pas pu être analysé. Sans
 * cela, un dépôt dont les lectures ont échoué ressemblerait à un dépôt sans
 * consommateur.
 */

const treeSchema = z.object({
  tree: z.array(
    z.object({
      path: z.string(),
      size: z.number().optional(),
      type: z.string(),
    })
  ),
  truncated: z.boolean().optional(),
});
const MANIFEST = /(^|\/)(package|tsconfig)\.json$/;
const MAX_SCANNED_BYTES = 200_000;
/** Les manifestes lus au plus, les moins profonds d'abord : la racine et les paquets. */
const MAX_MANIFESTS = 100;
/** Sous ce budget, aucune excerpt utile ne tient : rien n'est lu. */
const MIN_USEFUL_BUDGET = 1000;
/** Lectures simultanées au plus : assez pour raccourcir la collecte, pas pour saturer l'API. */
const READ_CONCURRENCY = 6;

type FileRead = (path: string) => Promise<string | undefined>;

/** Les lectures qui ont échoué pour une autre raison qu'une absence (404). */
interface ReadFailures {
  count: number;
  first?: string;
}

/** Lit `paths` par lots bornés ; l'ordre du résultat est celui de `paths`. */
async function readAll(
  paths: readonly string[],
  read: FileRead,
  failures: ReadFailures
): Promise<Map<string, string>> {
  const texts: (string | undefined)[] = new Array(paths.length);
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const index = next++;
      try {
        texts[index] = await read(paths[index] ?? "");
      } catch (error) {
        failures.count += 1;
        failures.first ??= redact(
          (error instanceof Error ? error.message : String(error)).slice(0, 200)
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker)
  );
  const result = new Map<string, string>();
  for (const [index, path] of paths.entries()) {
    const text = texts[index];
    if (text !== undefined) {
      result.set(path, text);
    }
  }
  return result;
}

function failureWarning(what: string, failures: ReadFailures, then = "") {
  return failures.count === 0
    ? []
    : [
        `Consumer search: ${failures.count} ${what} unreadable (first error: ${failures.first})${then}`,
      ];
}

/**
 * Le budget et les plafonds d'une recherche pour un dépôt de tête donné : pris
 * sur ce que le contexte de dépendances laisse de QA_CONTEXT_CHARS. Un dépôt de
 * tête non installé est lu anonymement (quota public horaire partagé) : la
 * recherche n'y est pas lancée.
 */
export function consumerLimits(
  config: Config,
  headRepo: string,
  dependencyContext: readonly { content: string }[]
) {
  return {
    anonymous: Boolean(
      config.githubInstallations &&
        !config.githubInstallations[headRepo.toLowerCase()]
    ),
    budget: Math.min(
      config.QA_CONSUMER_CONTEXT_CHARS,
      config.QA_CONTEXT_CHARS -
        dependencyContext.reduce((sum, item) => sum + item.content.length, 0)
    ),
    maxFiles: config.QA_CONSUMER_SCAN_FILES,
  };
}

/** Pourquoi la recherche ne lit rien, ou `undefined` quand elle peut partir. */
function skipReason(input: {
  anonymous?: boolean;
  budget: number;
}): string | undefined {
  if (input.budget < MIN_USEFUL_BUDGET) {
    return `Consumer search skipped: ${input.budget} characters left for consumer context, below the ${MIN_USEFUL_BUDGET} a useful excerpt needs`;
  }
  if (input.anonymous) {
    return "Consumer search skipped: the head repository is not installed and is read anonymously, whose hourly quota the search would exhaust";
  }
  return;
}

/** Les fichiers modifiés que la recherche ne peut pas analyser, nommés. */
function unanalysedChanged(
  files: readonly { filename: string; status?: string }[],
  sources: Map<string, string>
): string[] {
  return files
    .filter(
      (file) =>
        isConsumerCandidate(file.filename) && !sources.has(file.filename)
    )
    .map((file) =>
      file.status === "removed"
        ? `Consumer search: ${file.filename} is removed; its former importers are not searched`
        : `Consumer search: ${file.filename} not analysed (over ${MAX_SCANNED_BYTES} bytes, beyond the scan limit, or unreadable)`
    );
}

/**
 * Remonte le graphe d'imports depuis les fichiers modifiés, à la révision de
 * tête : un arbre (une requête), puis au plus `MAX_MANIFESTS` manifestes et
 * `maxFiles` fichiers source, fichiers modifiés d'abord, tests en dernier. Un
 * budget nul (recherche désactivée, ou contexte déjà plein) ne lit rien et ne
 * dit rien ; un budget trop petit pour une excerpt, ou un dépôt lu anonymement,
 * ne lit rien et le dit. Les lectures passent par `read`, qui porte l'accès au
 * dépôt : ce module ne fait aucune I/O lui-même.
 */
export async function consumerContext(input: {
  anonymous?: boolean;
  budget: number;
  files: readonly { filename: string; patch?: string; status?: string }[];
  maxFiles: number;
  read: {
    /** La réponse brute de `git/trees/{ref}?recursive=1`. */
    tree: () => Promise<unknown>;
    file: FileRead;
  };
  ref: string;
}): Promise<{ consumers: ConsumerMaterial[]; warnings: string[] }> {
  // Budget nul : la recherche est désactivée, ou le contexte de dépendances a
  // tout pris. Aucune requête n'est faite.
  if (input.budget <= 0) {
    return { consumers: [], warnings: [] };
  }
  const skipped = skipReason(input);
  if (skipped) {
    return { consumers: [], warnings: [skipped] };
  }
  const warnings: string[] = [];
  let listing: z.infer<typeof treeSchema>;
  try {
    listing = treeSchema.parse(await input.read.tree());
  } catch {
    return { consumers: [], warnings: ["Consumer search: tree unavailable"] };
  }
  if (listing.truncated) {
    warnings.push("Consumer search: repository tree listing truncated");
  }
  const blobs = listing.tree
    .filter(
      (item) => item.type === "blob" && (item.size ?? 0) <= MAX_SCANNED_BYTES
    )
    .map((item) => item.path);
  const manifestPaths = blobs
    .filter((path) => MANIFEST.test(path) && !path.includes("node_modules/"))
    .sort(
      (left, right) =>
        left.split("/").length - right.split("/").length ||
        left.localeCompare(right)
    );
  if (manifestPaths.length > MAX_MANIFESTS) {
    warnings.push(
      `Consumer manifest limit (${MAX_MANIFESTS}) reached: ${manifestPaths.length - MAX_MANIFESTS} package.json/tsconfig.json not read; workspace and path-alias resolution may miss consumers`
    );
  }
  const manifestFailures: ReadFailures = { count: 0 };
  const manifests = await readAll(
    manifestPaths.slice(0, MAX_MANIFESTS),
    input.read.file,
    manifestFailures
  );
  const changed = new Set(input.files.map((file) => file.filename));
  const candidates = blobs
    .filter(isConsumerCandidate)
    .sort(
      (left, right) =>
        Number(changed.has(right)) - Number(changed.has(left)) ||
        Number(isTestPath(left)) - Number(isTestPath(right))
    );
  if (candidates.length > input.maxFiles) {
    warnings.push(
      `Consumer scan limit (${input.maxFiles}) reached: ${candidates.length - input.maxFiles} source files not searched`
    );
  }
  const sourceFailures: ReadFailures = { count: 0 };
  const sources = await readAll(
    candidates.slice(0, input.maxFiles),
    input.read.file,
    sourceFailures
  );
  const found = findConsumers({
    budget: input.budget,
    changed: input.files.map((file) => ({
      content: sources.get(file.filename) ?? "",
      path: file.filename,
      ...(file.patch ? { patch: file.patch } : {}),
    })),
    files: sources,
    ref: input.ref,
    workspace: workspaceResolution(manifests),
  });
  return {
    consumers: found.consumers,
    warnings: [
      ...warnings,
      ...failureWarning(
        "manifest(s)",
        manifestFailures,
        "; workspace and path-alias resolution may miss consumers"
      ),
      ...failureWarning("source file(s)", sourceFailures),
      ...unanalysedChanged(input.files, sources),
      ...found.warnings,
    ],
  };
}
