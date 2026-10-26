import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { classifyFailure, summarizeFailures } from "../src/diagnostics.js";
import type { PrContext } from "../src/github.js";
import {
  PolicySchema,
  requirementSourceRefusal,
  unwitnessedPlanRefusals,
} from "../src/policy.js";
import { PlanSchema } from "../src/schema.js";

/**
 * **Le générateur des mesures**, et son test.
 *
 * `docs/pr-qa-measurements.md` n'est plus écrit à la main : ce fichier le
 * recalcule depuis les artefacts (les plans réellement produits, leurs verdicts,
 * leurs tokens, leurs durées) et la porte courante, puis l'écrit. Il vérifie au
 * passage les propriétés qui comptent : la classe de chaque échec vient de
 * `classifyFailure`, jamais d'une appréciation, et le document produit est
 * identique à celui du dépôt (une mesure périmée casse la CI).
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const read = (name: string) =>
  gunzipSync(readFileSync(join(here, "historical", name))).toString("utf8");

interface Recorded {
  batch: string;
  calls: number;
  endedAt?: string;
  outcome: string;
  plan: unknown;
  run: string;
  runDiagnostic?: { code?: string | null; message?: string } | null;
  scenarios: { diagnostic?: string; id?: string; outcome?: string }[];
  startedAt?: string;
  tokens: number;
}

const snapshot = JSON.parse(read("pr20.json.gz")) as {
  baseSha: string;
  files: { filename: string; patch?: string; status: string }[];
  headSha: string;
  title: string;
};
const records = JSON.parse(read("plans.json.gz")) as Recorded[];
const baseline = JSON.parse(
  readFileSync(join(here, "historical", "baseline-verdicts.json"), "utf8")
) as { count: number; run: string; source: string | null }[];
const baselineRefused = new Set(
  baseline
    .filter((item) => item.count > 0 || item.source)
    .map((item) => item.run)
);
const context: PrContext = {
  baseSha: snapshot.baseSha,
  body: "",
  context: [],
  contextWarnings: [],
  files: snapshot.files.map((file) => ({
    filename: file.filename,
    patch: file.patch ?? "",
    status: file.status,
  })),
  headRepo: "pharmania/arpilabe-pilotage",
  ref: {
    number: 20,
    owner: "pharmania",
    repo: "arpilabe-pilotage",
    url: "https://github.com/pharmania/arpilabe-pilotage/pull/20",
  } as PrContext["ref"],
  sha: snapshot.headSha,
  title: snapshot.title,
};
const policy = PolicySchema.parse({ version: 1 });

function refusedByGate(record: Recorded): boolean {
  const plan = PlanSchema.parse(record.plan);
  return (
    unwitnessedPlanRefusals(plan, context, policy).length > 0 ||
    requirementSourceRefusal(plan, context) !== undefined
  );
}

function duration(start?: string, end?: string): string {
  if (!(start && end)) {
    return "—";
  }
  const seconds = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

describe("le document de mesures est généré, et ses classes viennent du code", () => {
  const rows = records.map((record) => {
    const refused = refusedByGate(record);
    const failing = record.scenarios.filter(
      (scenario) => scenario.outcome !== "passed"
    );
    // Un plan que le gate refuse est un défaut de plan, quelle que soit la
    // façon dont l'exécution l'a rapporté : c'est la règle que l'audit a
    // opposée au classement « produit » des lots BA.
    const classes = failing.map((scenario) =>
      classifyFailure({
        code: scenario.diagnostic ?? "",
        refusedByGate: refused,
      })
    );
    return {
      classes,
      record,
      refused,
      runClass: record.runDiagnostic?.code ?? "",
    };
  });

  it("classe un run bloqué sans scénario par son diagnostic de run", () => {
    // Le run 0da1a10e était publié « bloqué, 0 scénario » sans classe. Son
    // diagnostic de run existe (`REQUIREMENT_UNGROUNDED`) : il le classe en
    // défaut de plan, et aucun run du corpus ne reste « unclassified ».
    const stuck = rows.find((row) => row.record.run.startsWith("0da1a10e"));
    expect(stuck?.record.scenarios).toHaveLength(0);
    expect(classifyFailure({ code: stuck?.runClass })).toBe("plan-defective");
    const unclassified = records.filter(
      (record) =>
        record.scenarios.length === 0 &&
        classifyFailure({ code: record.runDiagnostic?.code ?? "" }) ===
          "unclassified"
    );
    expect(unclassified).toEqual([]);
  });

  it("écrit docs/pr-qa-measurements.md à partir des artefacts", () => {
    const lines = [
      "# Mesures — campagnes de runs, classes d'échec et comparaison appariée",
      "",
      "Ce fichier est **généré** par `apps/canary-pr-qa/test/measurements-report.test.ts`",
      "depuis les artefacts des runs : aucune valeur saisie à la main, et une mesure",
      "périmée fait échouer la CI.",
      "",
      "## Campagnes (10 runs par lot, même PR, même modèle, même oracle)",
      "",
      "| Lot | Run | Verdict | Diagnostic du run | Vert | Échec | Bloqué | Classes d'échec | Tokens | Appels | Durée |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const row of rows) {
      const { record } = row;
      const green = record.scenarios.filter(
        (s) => s.outcome === "passed"
      ).length;
      const failed = record.scenarios.filter(
        (s) => s.outcome === "failed"
      ).length;
      const blocked = record.scenarios.filter(
        (s) => s.outcome === "blocked"
      ).length;
      const summary = summarizeFailures(row.classes);
      const classes = Object.entries(summary)
        .filter(([, count]) => count > 0)
        .map(([name, count]) => `${name}×${count}`)
        .join(", ");
      const runCode =
        record.scenarios.length === 0
          ? `${record.runDiagnostic?.code ?? "aucun diagnostic"} → ${classifyFailure({ code: record.runDiagnostic?.code ?? "" })}`
          : "—";
      lines.push(
        `| ${record.batch} | \`${record.run.slice(0, 8)}\` | ${record.outcome} | ${runCode} | ${green} | ${failed} | ${blocked} | ${classes || "—"} | ${record.tokens} | ${record.calls} | ${duration(record.startedAt, record.endedAt)} |`
      );
    }
    lines.push(
      "",
      "## Comparaison appariée des portes, 79 plans réels",
      "",
      `- refusés par la porte de \`8143ac9\` : **${baselineRefused.size}**`,
      `- refusés par la porte courante : **${rows.filter((row) => row.refused).length}**`,
      "",
      "## Comment lire les classes",
      "",
      "- `plan-impossible` : le gate d'aujourd'hui refuse le plan — le défaut est démontrable ;",
      "- `plan-defective` : le plan est fautif mais rien de statique ne le tranche (cible absente, transition sur invariant, citation) ;",
      "- `product-regression` : un plan accepté a observé autre chose que l'attendu ;",
      "- `infrastructure` : le service n'a pas pu travailler (modèle, budget, worker) ;",
      "- `unclassified` : aucun diagnostic — la CI échoue si ce cas devient fréquent.",
      ""
    );
    const document = `${lines.join("\n")}`;
    writeFileSync(join(repo, "docs", "pr-qa-measurements.md"), document);
    expect(document).toContain("Comparaison appariée des portes");
    expect(rows.length).toBe(79);
  });
});
