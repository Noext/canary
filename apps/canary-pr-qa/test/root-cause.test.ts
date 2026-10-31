import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La cause racine, recalculée.
 *
 * Le document affirme qu'un seul défaut d'architecture — un plan figé écrit sur un
 * seul instantané, exécuté sans consulter l'observation — explique 80 % des runs
 * non verts, et que les familles qui le composent ne méritent donc pas une règle
 * chacune. Ce test recalcule la répartition et vérifie que les ancrages de code
 * cités existent encore : si l'architecture change, le document doit changer.
 */
const app = join(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(join(app, ...parts), "utf8");

const corpus = JSON.parse(read("test", "historical", "campaign-runs.json")) as {
  run: string;
  outcome: string;
  runDiagnostic?: string | null;
  scenarioCodes?: string[];
}[];
const report = JSON.parse(
  read("test", "historical", "report-scenarios.json")
) as {
  runs: {
    nonGreenScenarios: {
      code: string;
      refusedBeforeExecution: boolean;
    }[];
  }[];
};

const PLAN_HYPOTHESIS = new Set([
  "TARGET_NOT_FOUND",
  "TRANSITION_NOT_OBSERVED",
  "MARKER_ORDER_UNREACHABLE",
  "TRANSITION_ON_INVARIANT",
  "PLAN_STATE_TARGET_READ_AS_TEXT",
  "PLAN_SELECTOR_UNSTABLE",
  "PLAN_ATTRIBUTE_VALUE_READ_AS_TEXT",
  "PLAN_CHANGED_FILE_UNCOVERED",
  "COVERAGE_REQUIREMENT_SOURCE_MISSING",
  "CRITICAL_COVERAGE_MISSING",
  "COVERAGE_WITNESS_MISSING",
  "PLAN_SCHEMA_INVALID",
  "REQUIREMENT_UNGROUNDED",
]);
const INFRA = new Set([
  "QA_ERROR",
  "HTTP_429",
  "HTTP_502",
  "RUN_BUDGET_EXCEEDED",
]);

const nonGreen = corpus.filter((run) => run.outcome !== "passed");
const classes = { plan: 0, infrastructure: 0, undiagnosed: 0 };
for (const run of nonGreen) {
  const codes = new Set([
    ...(run.scenarioCodes ?? []),
    ...(run.runDiagnostic ? [run.runDiagnostic] : []),
  ]);
  if (codes.size === 0) {
    classes.undiagnosed += 1;
  } else if ([...codes].some((code) => INFRA.has(code))) {
    classes.infrastructure += 1;
  } else if ([...codes].some((code) => PLAN_HYPOTHESIS.has(code))) {
    classes.plan += 1;
  }
}

const scenarios = report.runs.flatMap((run) => run.nonGreenScenarios);
const doc = read("..", "..", "docs", "pr-qa-root-cause.md");

describe("cause racine : un plan figé sur un instantané unique", () => {
  it("la classe dominante est l'hypothèse de plan contredite par l'observation", () => {
    expect(nonGreen).toHaveLength(80);
    expect(classes).toEqual({
      plan: 64,
      infrastructure: 12,
      undiagnosed: 4,
    });
    expect(doc).toContain("| **64** | 80 % |");
    expect(doc).toContain("| 12 | 15 % |");
    expect(doc).toContain("| 4 | 5 % |");
  });

  it("les scénarios non verts se répartissent de la même façon", () => {
    expect(scenarios).toHaveLength(60);
    const refused = scenarios.filter((s) => s.refusedBeforeExecution).length;
    const plan = scenarios.filter((s) => PLAN_HYPOTHESIS.has(s.code)).length;
    expect(refused).toBe(17);
    expect(plan).toBe(51);
    expect(doc).toContain("**17** sont refusés avant");
    expect(doc).toContain("**51** portent un code");
  });

  it("chaque ancrage fichier:ligne du document désigne la ligne réelle", () => {
    // La source de vérité est le code : on retrouve la ligne par son contenu, puis
    // on vérifie que le document cite exactement ce numéro. Si le code bouge, le
    // test échoue et nomme le couple attendu — le document ne peut pas dériver.
    const anchors: [string, string][] = [
      ["src/runner.ts", "result.plan = await model.json("],
      ["src/canary.ts", "PLAN_EVIDENCE_SNAPSHOT_CHARS ="],
      ["src/canary.ts", "export async function discoverPreview"],
      ["src/executor.ts", "Le plan est un contrat figé"],
      ["src/executor.ts", "canary.start(scenario.title"],
      ["src/executor.ts", "await captureReadings("],
      ["src/runner.ts", "async function replanObservedInvariants"],
      ["src/runner.ts", "await replanObservedInvariants({"],
    ];
    const expected: [string, number][] = anchors.map(([file, needle]) => {
      const index = read(...file.split("/"))
        .split("\n")
        .findIndex((line) => line.includes(needle));
      expect(index, `${file} ${needle}`).toBeGreaterThanOrEqual(0);
      return [file, index + 1];
    });
    for (const [file, line] of expected) {
      expect(doc, `${file}:${line}`).toContain(`${file}:${line}`);
    }
    // Et aucun autre couple fichier:ligne ne traîne dans le document.
    for (const [, file, line] of doc.matchAll(/(src\/[a-z-]+\.ts):(\d+)/g)) {
      const found = expected.some(
        ([path, number]) => path === file && String(number) === line
      );
      expect(found, `inattendu ${file}:${line}`).toBe(true);
    }
    // Une plage `a-b` va vers l'avant, et ne déborde pas du fichier : une
    // mise à jour qui déplace son début sans sa fin la rendait inversée.
    for (const [, file, start, end] of doc.matchAll(
      /(src\/[a-z-]+\.ts):(\d+)-(\d+)/g
    )) {
      const lines = read(...(file ?? "").split("/")).split("\n").length;
      expect(Number(end), `${file}:${start}-${end}`).toBeGreaterThanOrEqual(
        Number(start)
      );
      expect(Number(end), `${file}:${start}-${end}`).toBeLessThanOrEqual(lines);
    }
  });

  it("les ancrages de code cités existent encore", () => {
    const executor = read("src", "executor.ts");
    const runner = read("src", "runner.ts");
    const canary = read("src", "canary.ts");
    // Le plan est un script figé, joué sans consulter l'observation.
    expect(executor).toContain("Le plan est un contrat figé");
    expect(executor).toContain("canary.start(scenario.title");
    // Une seule production de plan, puis des corrections avant exécution.
    expect(runner).toContain("result.plan = await model.json(");
    // Une boucle d'observation existe, mais en réparation après échec.
    expect(runner).toContain("replanObservedInvariants");
    // La découverte est relevée une fois.
    expect(canary).toContain("export async function discoverPreview");
    expect(canary).toContain("PLAN_EVIDENCE_SNAPSHOT_CHARS");
  });

  it("le document déclare ses limites de mesure", () => {
    expect(doc).toContain("104 des 200 runs");
    expect(doc).toContain("70 des 200 runs portent le build `0000000`");
    expect(doc).toContain("plancher, pas un total");
  });
});
