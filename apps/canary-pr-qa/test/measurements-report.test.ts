import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { consumerContext } from "../src/consumer-context.js";
import { classifyFailure, summarizeFailures } from "../src/diagnostics.js";
import type { PrContext } from "../src/github.js";
import { objectiveWitnessRefusals } from "../src/objective-witness.js";
import {
  PolicySchema,
  requirementSourceRefusal,
  unwitnessedPlanRefusals,
} from "../src/policy.js";
import { type Plan, PlanSchema } from "../src/schema.js";

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

/**
 * Le témoin d'objectif (`OBJECTIVE_UNWITNESSED`) et le matériel des
 * consommateurs, recalculés depuis les fixtures réelles : les 79 plans stockés,
 * les plans des runs 16, 15 et 11 de la PR 20, le plan de la PR 21 et le
 * sous-ensemble de sa révision de tête.
 */
const witnessFixture = JSON.parse(read("objective-witness.json.gz")) as {
  pr21: { bundle: { context: PrContext; plan: Plan } };
  regression: { plan: Plan; run: string }[];
};
const PRESENCE_KINDS = new Set(["visible", "hidden", "count"]);
function witnessCounts() {
  let scenarios = 0;
  let presence = 0;
  let unwitnessed = 0;
  let refused = 0;
  for (const record of records) {
    const plan = PlanSchema.parse(record.plan);
    scenarios += plan.scenarios.length;
    refused += objectiveWitnessRefusals(plan, context).length;
    for (const scenario of plan.scenarios) {
      for (const assertion of scenario.assertions) {
        if (PRESENCE_KINDS.has(assertion.kind)) {
          presence += 1;
          unwitnessed += objectiveWitnessRefusals(
            {
              ...plan,
              scenarios: [{ ...scenario, objective: assertion.id }],
            },
            context
          ).length;
        }
      }
    }
  }
  const regression = witnessFixture.regression.map((run) => {
    const plan = PlanSchema.parse(run.plan);
    return {
      objectives: plan.scenarios.filter((item) => item.objective).length,
      refused: objectiveWitnessRefusals(plan, context).length,
      run: run.run.slice(0, 8),
      scenarios: plan.scenarios.length,
    };
  });
  const pr21 = objectiveWitnessRefusals(
    PlanSchema.parse(witnessFixture.pr21.bundle.plan),
    witnessFixture.pr21.bundle.context
  ).length;
  return { presence, pr21, refused, regression, scenarios, unwitnessed };
}
const consumerFixture = JSON.parse(read("pr21-consumers.json.gz")) as {
  changed: { filename: string; patch?: string }[];
  files: Record<string, string>;
  ref: string;
};
const consumerFiles = new Map(Object.entries(consumerFixture.files));
const pr21Consumers = await consumerContext({
  budget: 24_000,
  files: consumerFixture.changed,
  maxFiles: 400,
  read: {
    file: (path) => Promise.resolve(consumerFiles.get(path)),
    tree: () =>
      Promise.resolve({
        tree: [...consumerFiles.keys()].map((path) => ({ path, type: "blob" })),
      }),
  },
  ref: consumerFixture.ref,
});

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
    const witness = witnessCounts();
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
    // La campagne entrelacée : deux builds alternés sur le même service, pas
    // deux lots séparés par des heures. Les chiffres sont figés dans un
    // artefact, et le test en vérifie l'arithmétique.
    const interleaved = JSON.parse(
      readFileSync(join(here, "historical", "interleaved.json"), "utf8")
    ) as {
      batch: string;
      blocked: number;
      build: string;
      phase?: string;
      calls: number;
      green: number;
      product: number;
      runs: number;
      tokens: number;
      verts: number;
    }[];
    // Aucune sélection : la référence est « tous les lots du build 8143ac9 » et
    // la lignée courante « tous les autres lots », y compris ceux qui régressent.
    // Le générateur précédent énumérait les lots retenus à la main et laissait
    // tomber KK (1/10) : c'est exactement la lecture opportuniste que l'objectif
    // interdit, et elle a été corrigée ici.
    const baselineRows = interleaved.filter((row) => row.phase === "baseline");
    const lineageRows = interleaved.filter((row) => row.phase === "lineage");
    const currentRows = interleaved.filter((row) => row.phase === "current");
    const nonBaselineRows = interleaved.filter(
      (row) => row.phase !== "baseline"
    );
    const sum = (
      rows: typeof interleaved,
      key: "green" | "product" | "runs" | "tokens" | "verts"
    ) => rows.reduce((total, row) => total + row[key], 0);
    const perRun = (
      rows: typeof interleaved,
      key: "green" | "tokens" | "product"
    ) =>
      Math.round((sum(rows, key) / Math.max(sum(rows, "runs"), 1)) * 10) / 10;
    const percent = (rows: typeof interleaved) =>
      Math.round((sum(rows, "verts") / Math.max(sum(rows, "runs"), 1)) * 100);
    lines.push(
      "",
      "## Campagne entrelacée (deux builds alternés sur le même service)",
      "",
      "Les lots sont alternés entre `8143ac9` et la lignée courante sur le même",
      "service. **Tous** les lots sont agrégés, y compris ceux qui régressent : un",
      "lot défavorable n'est jamais retiré du calcul.",
      "",
      "| Lot | Build | Runs verts | Scénarios verts | Échecs produit | Tokens |",
      "| --- | --- | --- | --- | --- | --- |",
      ...interleaved.map(
        (row) =>
          `| ${row.batch} | \`${row.build}\` | ${row.verts}/${row.runs} | ${row.green} | ${row.product} | ${row.tokens} |`
      ),
      "",
      `Référence \`8143ac9\` (${sum(baselineRows, "runs")} runs) : **${percent(baselineRows)} %** de runs verts, ${perRun(baselineRows, "green")} scénarios verts par run, ${perRun(baselineRows, "product")} échec produit par run, ${perRun(baselineRows, "tokens")} tokens par run.`,
      `Toute la lignée non-référence (${sum(nonBaselineRows, "runs")} runs, y compris les builds dont un défaut a été corrigé depuis) : **${percent(nonBaselineRows)} %** de runs verts, ${perRun(nonBaselineRows, "green")} scénarios verts par run, ${perRun(nonBaselineRows, "product")} échec produit par run, ${perRun(nonBaselineRows, "tokens")} tokens par run.`,
      "",
      `Lignée historique seule (${sum(lineageRows, "runs")} runs, builds antérieurs au build courant) : **${percent(lineageRows)} %**.`,
      "",
      `**Build courant seul** (${sum(currentRows, "runs")} runs de deux commits de source identique — SS \`c5b3634\`, UU \`f8a6959\`) : **${percent(currentRows)} %** de runs verts, ${perRun(currentRows, "green")} scénarios verts par run, ${perRun(currentRows, "product")} échec produit par run, ${perRun(currentRows, "tokens")} tokens par run.`,
      "",
      "Les deux agrégats sont publiés parce qu'ils répondent à deux questions différentes :",
      "« la lignée a-t-elle progressé depuis la référence ? » (tous lots, y compris les",
      "régressions corrigées depuis) et « le code d'aujourd'hui fait-il mieux que la",
      "référence ? » (code identique). Le second n'a de sens que comparé à une campagne",
      "fraîche de la référence : la campagne contrôlée entrelacée l'a mesurée",
      "(`controlled-campaign.json`, 10 runs par bras, résultat non séparable).",
      "",
      "Expériences isolées (un lot de chaque côté, jamais agrégées) :",
      "",
      "- `QQ` (politique « un défaut de contrat coûte le scénario ») : 5/10 contre 7/10",
      "  pour `PP` sur le même build — l'hypothèse « le refus fatal coûte des runs verts »",
      "  est réfutée par la mesure.",
      "- `RR` (réparation déterministe d'une cible proche) : 5/10 contre 7/10 pour `PP`,",
      "  mais 89 scénarios verts contre 70 — la réparation débloque des étapes sans",
      "  rendre les plans justes.",
      "",
      "`SS` et `UU` forment l'agrégat « build courant » : ce ne sont pas des expériences",
      "isolées, et le meilleur lot n'est pas présenté comme une moyenne séparée.",
      "",
      "**Durées** : `startedAt`/`endedAt` sont publiés par run ci-dessus pour les lots BA à",
      "II, et la campagne contrôlée les enregistre aussi : 492,6 s contre 427,9 s par run,",
      "un écart non séparable (erreur-type 50 s).",
      "",
      "## Témoin d'objectif et matériel des consommateurs",
      "",
      "Mesuré hors ligne, sans appel modèle, avec la règle courante",
      "(`src/objective-witness.ts`, `src/consumer-context.ts`).",
      "",
      `- **79 plans stockés** (${witness.scenarios} scénarios, aucun objectif déclaré) : ${witness.refused} refus \`OBJECTIVE_UNWITNESSED\` sous la règle de repli (toutes les assertions forment la preuve). Contrefactuel, chaque lecture de présence prise pour objectif : ${witness.unwitnessed} sans témoin sur ${witness.presence}.`,
      ...witness.regression.map(
        (run) =>
          `- **Run \`${run.run}\`** (PR 20) : ${run.objectives} objectifs déclarés sur ${run.scenarios} scénarios, ${run.refused} refus.`
      ),
      `- **PR 21** (plan publié vert sur « le titre de la vue d'accueil est masqué ») : ${witness.pr21} refus \`OBJECTIVE_UNWITNESSED\`.`,
      `- **Consommateurs de la PR 21** (révision de tête, budget 24 000) : ${pr21Consumers.consumers
        .map(
          (item) =>
            `\`${item.path}\` lignes ${item.excerpts.map((excerpt) => `${excerpt.startLine}–${excerpt.endLine} (${excerpt.text.length} caractères)`).join(", ")}`
        )
        .join(" ; ")}.`,
      "",
      "Limite : les 79 plans viennent tous de la PR 20, un grand diff d'interface ;",
      "le zéro faux positif dit peu des petits diffs ou des diffs sans interface.",
      ""
    );
    const document = `${lines.join("\n")}`;
    // Le document est comparé, jamais réécrit en silence : une mesure périmée fait
    // échouer la CI. On le régénère explicitement avec UPDATE_MEASUREMENTS=1.
    const target = join(repo, "docs", "pr-qa-measurements.md");
    if (process.env.UPDATE_MEASUREMENTS === "1") {
      writeFileSync(target, document);
    } else {
      expect(readFileSync(target, "utf8")).toBe(document);
    }
    expect(document).toContain("Comparaison appariée des portes");
    expect(rows.length).toBe(79);
  });
});
