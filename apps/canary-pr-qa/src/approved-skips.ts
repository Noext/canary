import type { PrContext } from "./github.js";
import type { Plan, RunResult } from "./schema.js";

/**
 * Les fichiers qu'une PR peut laisser sans scénario navigateur : ceux que la
 * politique de base (`.canary/qa.json`) approuve, et ceux qui n'ont jamais
 * besoin d'approbation — documentation et tests. Le type de politique est
 * structurel pour que `policy.ts`, qui lit ici ces prédicats, ne soit pas
 * importé en retour.
 */
interface SkipPolicy {
  approvedSkips: readonly { path: string; reason: string }[];
  criticalPaths: readonly string[];
}
const DOCUMENTATION_DIRECTORY = /(^|\/)(docs|openspec)\//;
const MARKDOWN_FILE = /\.mdx?$/i;
/**
 * Un fichier de test ne porte aucun comportement visible : son comportement EST
 * celui du code qu'il éprouve, déjà couvert par le scénario qui exerce ce code.
 * L'exiger comme chemin critique demandait un scénario navigateur pour
 * `apps/web/lib/cash-session.test.ts` (run 338f18d8), c'est-à-dire une preuve en
 * double et un run bloqué pour un fichier qui n'affiche rien. Le skip reste
 * visible : il est listé, compté et publié.
 */
const TEST_FILE = /(^|\/)(__tests__|__mocks__)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const LICENSE_FILE = /(^|\/)LICEN[CS]E(\.[^/]*)?$/i;
export function isTestPath(file: string): boolean {
  return TEST_FILE.test(file);
}
/**
 * Documentation is never gated by `criticalPaths`: markdown prose, `docs/` and
 * `openspec/` trees and licence texts change no runtime behavior, including
 * when an application keeps them under a critical prefix such as `apps/`.
 * `.github/` is deliberately not listed here - workflows are executable
 * configuration, so a repository that wants them gated adds the prefix itself.
 */
export function isDocumentationPath(file: string): boolean {
  return (
    DOCUMENTATION_DIRECTORY.test(file) ||
    MARKDOWN_FILE.test(file) ||
    LICENSE_FILE.test(file)
  );
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
/** La porte de couverture d'un run dont le diff ne change aucun code exécuté. */
export const NON_RUNTIME_GATE = "documentation-and-tests-only";
const DOCUMENTATION_REASON =
  "Documentation (never critical): no runtime behavior to exercise in a browser.";
const TEST_REASON =
  "Test file: exercised by CI, no runtime behavior to exercise in a browser.";
/**
 * Un fichier dont aucun octet n'atteint le navigateur, à en juger par sa seule
 * forme : un test, de la prose Markdown, un texte de licence, ou un fichier d'un
 * arbre `docs/`/`openspec/` hors de tout préfixe critique. Plus étroit que
 * `isDocumentationPath` : un `.mdx` se compile en composant, et un dossier
 * `docs/` sous `apps/` peut être une route (`apps/web/app/docs/page.tsx`).
 */
function isNonRuntimePath(policy: SkipPolicy, file: string): boolean {
  if (TEST_FILE.test(file) || LICENSE_FILE.test(file) || /\.md$/i.test(file)) {
    return true;
  }
  return (
    DOCUMENTATION_DIRECTORY.test(file) &&
    !MARKDOWN_FILE.test(file) &&
    !policy.criticalPaths.some((prefix) => file.startsWith(prefix))
  );
}
/**
 * Conclut le run d'une PR dont CHAQUE fichier changé (et l'ancien chemin d'un
 * renommage) est documentation ou test : rien n'y est testable au navigateur.
 * Le run est `skipped` sans préversion, découverte, appel au planificateur ni
 * scénario : une PR de documentation réservait un appel de plan payant et
 * finissait bloquée par son plafond de coût. Chaque fichier porte la raison de
 * son `approvedSkips` quand la base en a une, sinon une raison fixe.
 *
 * Une approbation n'est pas un verdict : elle permet au planificateur de laisser
 * un fichier hors de ses scénarios, en supposant que d'autres existent (le barrel
 * `packages/domain/src/index.ts` d'arpilabe, « exercé par les scénarios qui
 * passent par page.tsx »). Un fichier exécuté, approuvé ou non, garde donc le
 * chemin de planification d'avant, tout comme un diff vide : la fonction rend
 * faux et le run reste intact.
 */
export function settleNonRuntimeDiff(
  result: RunResult,
  policy: SkipPolicy,
  context: PrContext
): boolean {
  const skipped: Plan["skipped"] = [];
  for (const file of context.files) {
    const paths = [file.filename, file.previous_filename ?? file.filename];
    if (!paths.every((path) => isNonRuntimePath(policy, path))) {
      return false;
    }
    const approved = policy.approvedSkips.find((skip) =>
      approvedSkipCovers(skip.path, file.filename)
    );
    const fallback = TEST_FILE.test(file.filename)
      ? TEST_REASON
      : DOCUMENTATION_REASON;
    skipped.push({
      sourceFile: file.filename,
      reason: approved?.reason ?? fallback,
    });
  }
  if (skipped.length === 0) {
    return false;
  }
  result.outcome = "skipped";
  result.plan = {
    summary:
      "No browser-testable change: every changed file is documentation or a test, so no preview was opened, no model was called and no browser scenario ran.",
    scenarios: [],
    skipped,
  };
  result.coverage = {
    covered: [],
    skipped,
    policyRef: context.baseSha,
    gate: NON_RUNTIME_GATE,
  };
  return true;
}
/**
 * Le statut de commit d'un diff de documentation et de tests seuls, tant que le
 * run reste `skipped` : la revérification qui le rend `stale`, ou une erreur qui
 * le rend `blocked`, garde le texte générique du rapport.
 */
export function nonRuntimeStatus(result: RunResult): string | undefined {
  if (
    result.outcome !== "skipped" ||
    result.coverage?.gate !== NON_RUNTIME_GATE
  ) {
    return;
  }
  const files = result.coverage.skipped.length;
  return `QA skipped: ${files}/${files} changed files are documentation or tests; no browser scenario run`;
}
