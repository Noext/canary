import type { PrContext } from "./github.js";
import type { Plan, RunResult } from "./schema.js";

/**
 * Les approbations de skip de la politique de base (`.canary/qa.json`) : leur
 * motif de chemin, et le verdict d'un diff qu'elles couvrent entièrement. Le
 * type est structurel pour que `policy.ts`, qui lit ici `approvedSkipCovers`,
 * ne soit pas importé en retour.
 */
interface ApprovedSkips {
  approvedSkips: readonly { path: string; reason: string }[];
}
function segmentMatches(pattern: string, segment: string): boolean {
  if (!pattern.includes("*")) {
    return pattern === segment;
  }
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`).test(segment);
}
function segmentsMatch(pattern: string[], file: string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) {
    return file.length === 0;
  }
  if (head === "**") {
    // `**` spans zero or more segments, including every one of them.
    return Array.from({ length: file.length + 1 }, (_, index) => index).some(
      (index) => segmentsMatch(rest, file.slice(index))
    );
  }
  return (
    file.length > 0 &&
    segmentMatches(head, file[0] as string) &&
    segmentsMatch(rest, file.slice(1))
  );
}
/**
 * `approvedSkips[].path` accepts an exact path or a pattern: `*` matches
 * inside one segment and `**` spans segments, so a wildcard app directory
 * followed by a file name is honoured. A pattern made only of wildcard
 * segments, or ending with a slash, would approve every skip and disable this
 * gate, so it approves nothing and the run is refused exactly like an
 * unapproved skip.
 */
export function approvedSkipCovers(pattern: string, file: string): boolean {
  const segments = pattern.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    pattern.endsWith("/") ||
    segments.every((segment) => segment === "*" || segment === "**")
  ) {
    return false;
  }
  return segmentsMatch(segments, file.split("/").filter(Boolean));
}
/** La porte de couverture d'un run dont tout le diff est approuvé ignoré. */
export const APPROVED_SKIPS_GATE = "approved-skips-only";
/**
 * Conclut le run d'une PR dont CHAQUE fichier changé est couvert par un
 * `approvedSkips` de la base : rien n'y est testable au navigateur, et les
 * raisons sont celles que la base a approuvées. Le run est `skipped` sans
 * découverte, appel au planificateur ni scénario : une PR de documentation
 * réservait un appel de plan payant et finissait bloquée par son plafond de
 * coût. Un fichier renommé exige aussi l'approbation de son ancien chemin,
 * puisque le retirer de là est un changement. Dès qu'un fichier n'est pas
 * couvert, ou que le diff est vide, le run reste intact et la fonction rend
 * faux : le chemin de planification est celui d'avant.
 */
export function settleApprovedSkips(
  result: RunResult,
  policy: ApprovedSkips,
  context: PrContext
): boolean {
  const approval = (file: string) =>
    policy.approvedSkips.find((skip) => approvedSkipCovers(skip.path, file));
  const skipped: Plan["skipped"] = [];
  for (const file of context.files) {
    const skip = approval(file.filename);
    if (
      !skip ||
      (file.previous_filename && !approval(file.previous_filename))
    ) {
      return false;
    }
    skipped.push({ sourceFile: file.filename, reason: skip.reason });
  }
  if (skipped.length === 0) {
    return false;
  }
  result.outcome = "skipped";
  result.plan = {
    summary:
      "No browser-testable change: every changed file is an approved skip in .canary/qa.json on the base branch, so no model was called and no browser scenario ran.",
    scenarios: [],
    skipped,
  };
  result.coverage = {
    covered: [],
    skipped,
    policyRef: context.baseSha,
    gate: APPROVED_SKIPS_GATE,
  };
  return true;
}
