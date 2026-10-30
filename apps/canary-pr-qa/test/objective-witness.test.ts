import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { armMetrics } from "../src/campaign-metrics.js";
import { loadConfig } from "../src/config.js";
import { classifyFailure, QaError } from "../src/diagnostics.js";
import type { TrustedCatalog } from "../src/fixtures.js";
import type { PrContext } from "../src/github.js";
import { PLANNER_PROMPT } from "../src/model.js";
import { objectiveWitnessRefusals } from "../src/objective-witness.js";
import { classifyScenarioResult } from "../src/observe-act.js";
import { preExecutionRefusalTable } from "../src/plan-evidence.js";
import { PolicySchema } from "../src/policy.js";
import { rejudge } from "../src/rejudge.js";
import { runReplay } from "../src/replay.js";
import { type Plan, PlanSchema, type Scenario } from "../src/schema.js";

/**
 * Le témoin d'objectif : un scénario n'est pas prouvé par un objectif de
 * présence ou d'adresse qui ne lit rien de ce que le diff ajoute ou retire.
 *
 * Fixtures réelles (aucune règle n'y lit un nom d'application) :
 * - `pr21` : le run payé d'une PR d'une ligne qui inverse le signe d'un écart,
 *   publié vert sur l'objectif « le titre de la vue d'accueil est masqué après le
 *   clic de navigation » — le bundle de rejeu (contexte réduit au fichier
 *   modifié, à ses deux révisions), et la réponse brute du planificateur ;
 * - `regression` : les plans réels des runs 16, 15 et 11 de la PR 20, verts ;
 * - `plans.json.gz` : les 79 plans historiques de la PR 20.
 */
const historical = join(import.meta.dirname, "historical");
const read = (name: string) =>
  JSON.parse(gunzipSync(readFileSync(join(historical, name))).toString());

interface Bundle {
  catalog: TrustedCatalog;
  context: PrContext;
  evidence: { aria: string; url: string };
  plan: Plan;
  policy: unknown;
  source: Record<string, unknown>;
  validationConfig: Record<string, unknown>;
}
const fixture = read("objective-witness.json.gz") as {
  pr21: {
    bundle: Bundle;
    outcome: string;
    response: Record<string, unknown>;
    scenarios: { classification: string; id: string; outcome: string }[];
  };
  regression: {
    outcome: string;
    plan: unknown;
    run: string;
    scenarios: { id: string; outcome: string }[];
  }[];
};
const pr20 = read("pr20.json.gz") as { files: PrContext["files"] };
const historicalPlans = read("plans.json.gz") as {
  plan: { scenarios: Scenario[] };
}[];

const bundle = fixture.pr21.bundle;
const realPlan = PlanSchema.parse(bundle.plan);
const real = realPlan.scenarios[0] as Scenario;
const CHANGED_LINE =
  "  const varianceCents = input.expectedCents - input.countedCents;";
const WITNESS_PHRASE =
  "nothing the diff adds or removes in its sourceFiles nor the quote it cites";

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(
    cleanup.map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "objective-witness-"));
  cleanup.push(directory);
  return directory;
}

/** Le rejeu offline de la porte (mode `gate`) sur le bundle réel, plan remplacé. */
async function gate(scenario: Scenario = real) {
  const directory = await scratch();
  const plan = { ...realPlan, scenarios: [scenario] };
  const path = join(directory, "bundle.json");
  await writeFile(
    path,
    JSON.stringify({
      ...bundle,
      createdAt: "2026-10-01T00:00:00.000Z",
      generatedPlan: plan,
      payload: null,
      plan,
      version: 1,
    })
  );
  return await runReplay(path, "gate", loadConfig({ QA_DATA_DIR: directory }));
}

const witnessRefusals = (refusals: readonly string[]) =>
  refusals.filter((item) => item.includes(WITNESS_PHRASE));

/** Une variante du scénario réel, son unique assertion modifiée. */
function mutant(edit: (scenario: Scenario) => void): Scenario {
  const scenario = structuredClone(real);
  edit(scenario);
  return scenario;
}
const objective = (scenario: Scenario) =>
  scenario.assertions[0] as Scenario["assertions"][number];

describe("PR 21 : l'objectif de navigation ne prouve pas le changement", () => {
  it("le run réel a publié passed/proven sur ce plan", () => {
    expect(fixture.pr21.outcome).toBe("passed");
    expect(fixture.pr21.scenarios).toEqual([
      { classification: "proven", id: real.id, outcome: "passed" },
    ]);
    expect(real.objective).toBe("pilotage-heading-hidden");
  });

  it("le rejeu de la porte refuse le plan réel : un seul refus, OBJECTIVE_UNWITNESSED", async () => {
    const replay = await gate();
    expect(replay.verdict).toBe("refused");
    expect(replay.refusals).toHaveLength(1);
    const error = preExecutionRefusalTable(realPlan, {
      catalog: bundle.catalog,
      config: loadConfig({ QA_DATA_DIR: tmpdir() }),
      context: bundle.context,
      evidence: bundle.evidence,
      policy: PolicySchema.parse(bundle.policy),
    }).get(real.id);
    expect(error).toBeInstanceOf(QaError);
    expect(error?.code).toBe("OBJECTIVE_UNWITNESSED");
    // La correction du planificateur et la table d'avant exécution disent la
    // même chose, au mot près.
    expect(replay.refusals[0]).toBe(`${error?.message}. ${error?.hint}`);
    expect(replay.refusals[0]).toContain("pilotage-heading-hidden");
    expect(replay.refusals[0]).toContain('"Pilotage"');
    expect(replay.refusals[0]).toContain(WITNESS_PHRASE);
  });

  it("un scénario refusé ainsi est un défaut de plan, jamais un vert ni une régression", () => {
    const result: Parameters<typeof classifyScenarioResult>[0] = {
      diagnostic: { code: "OBJECTIVE_UNWITNESSED" },
      outcome: "blocked",
    };
    classifyScenarioResult(result);
    expect(result.classification).toBe("test-defect");
    expect(classifyFailure({ code: "OBJECTIVE_UNWITNESSED" })).toBe(
      "plan-defective"
    );
    // Et une campagne compte le run parmi les défauts de plan, pas parmi les
    // défaillances du produit.
    const metrics = armMetrics("witness", [
      {
        arm: "witness",
        assertions: [],
        block: 1,
        outcome: "blocked",
        runId: "r",
        scenarios: [
          { code: "OBJECTIVE_UNWITNESSED", outcome: "blocked", refused: true },
        ],
        sha: "s",
      },
    ]);
    expect(metrics.planDefectiveRuns).toBe(1);
  });

  it("le rejugement de la réponse brute met le même message dans la correction", async () => {
    const directory = await scratch();
    await mkdir(join(directory, "_planner"));
    await writeFile(
      join(directory, "_planner", "inputs.json"),
      JSON.stringify({
        catalog: bundle.catalog,
        context: bundle.context,
        evidence: bundle.evidence,
        model: {},
        policy: bundle.policy,
        source: bundle.source,
        validationConfig: bundle.validationConfig,
        version: 1,
      })
    );
    await writeFile(
      join(directory, "_planner", "response-1.json"),
      JSON.stringify(fixture.pr21.response)
    );
    const judged = await rejudge(
      directory,
      undefined,
      loadConfig({ QA_DATA_DIR: directory })
    );
    expect(judged.accepted).toBe(false);
    const [response] = judged.responses;
    // Le run d'origine avait accepté cette réponse ; aujourd'hui, la porte la
    // renvoie au planificateur avec le refus de témoin.
    expect(response?.recordedVerdict).toBe("accepted");
    expect(response?.verdict.kind).toBe("gate");
    const verdict = response?.verdict as { refusal?: string };
    expect(verdict.refusal).toContain(
      `Scenario ${real.id}: objective pilotage-heading-hidden (hidden role heading "Pilotage") reads ${WITNESS_PHRASE}`
    );
  });
});

describe("variantes qui doivent rester refusées", () => {
  it("(a) count du titre quitté, attendu 0 : `count` est une lecture de présence", async () => {
    const scenario = mutant((item) => {
      Object.assign(objective(item), { expected: 0, kind: "count" });
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });

  it("(b) objectif d'adresse « / » : `url` est une lecture d'adresse", async () => {
    const scenario = mutant((item) => {
      const assertion = objective(item) as Record<string, unknown>;
      assertion.target = undefined;
      Object.assign(assertion, { expected: "/", kind: "url" });
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });

  it("(c) objectif retiré : les assertions du scénario forment la preuve", async () => {
    const scenario = mutant((item) => {
      item.objective = undefined;
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });

  it("(d) `behavior` réécrit pour nommer la cible : la prose ne blanchit rien", async () => {
    const scenario = mutant((item) => {
      const requirement = item.requirements[0] as { behavior: string };
      requirement.behavior = `${requirement.behavior} Le titre Pilotage disparaît.`;
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });

  it("(e) littéral présent seulement dans une ligne de contexte du hunk", async () => {
    // `compte-juste` est écrit par une ligne que le diff ne touche pas : elle
    // existe avant comme après le changement.
    expect(bundle.context.files[0]?.patch).toContain('"compte-juste"');
    const scenario = mutant((item) => {
      Object.assign(objective(item), {
        kind: "visible",
        target: { by: "css", value: '[data-x="compte-juste"]' },
      });
    });
    expect(objective(scenario).requirement).toBe(0);
    expect(scenario.requirements[0]?.quote).toBe(CHANGED_LINE);
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });
});

describe("faux verts de la revue : refusés", () => {
  it("(f) racine de vue `[data-cash-state]` : `cash` n'est qu'un préfixe de `cashVarianceCents`", async () => {
    // L'attribut existe avant comme après le changement ; il ne partage avec la
    // ligne changée que le premier mot d'un identifiant composé.
    const scenario = mutant((item) => {
      Object.assign(objective(item), {
        kind: "visible",
        target: { by: "css", value: "[data-cash-state]" },
      });
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });

  it.each([
    { kind: "hidden", target: { by: "testId", value: "variance-cents" } },
    { kind: "hidden", target: { by: "css", value: "[data-variance-cents]" } },
    {
      kind: "hidden",
      target: { by: "text", value: "expected counted variance" },
    },
    { kind: "hidden", target: { by: "label", value: "Variance" } },
    {
      expected: 0,
      kind: "count",
      target: { by: "css", value: "[data-variance-cents]" },
    },
  ])("(g) lecture négative en state d'une cible qu'aucune ligne retirée n'écrit : %o", async (read) => {
    // Aucune de ces cibles n'existe : en `state`, l'absence passe sur la base
    // comme sur la tête, quel que soit le mot qu'elle emprunte au diff.
    const scenario = mutant((item) => {
      Object.assign(objective(item), read, { verification: "state" });
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });

  /** Une lecture de texte non citée du bouton de navigation. */
  const uncitedText = {
    afterStep: "open-caisse",
    description: "le bouton de navigation garde son libellé",
    expected: "Caisse et Coffre",
    id: "nav-label",
    kind: "text",
    target: { by: "role", name: "Caisse et Coffre", value: "button" },
    verification: "transition",
  } as Scenario["assertions"][number];
  const verifyNav = {
    action: { assertionId: uncitedText.id, type: "assert" },
    description: "verify the navigation label",
    id: "verify-nav",
  } as Scenario["steps"][number];

  it("(c2) objectif retiré, une lecture de texte non citée à côté : refusé", async () => {
    const scenario = mutant((item) => {
      item.objective = undefined;
      item.assertions.push(uncitedText);
      item.steps.push(verifyNav);
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });

  it("(c3) objectif = lecture de texte non citée : refusé", async () => {
    const scenario = mutant((item) => {
      item.assertions.push(uncitedText);
      item.steps.push(verifyNav);
      item.objective = uncitedText.id;
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });

  it("(c4) objectif = `value` vide non cité : refusé", async () => {
    const scenario = mutant((item) => {
      item.assertions = [
        { ...uncitedText, expected: "", kind: "value" },
      ] as Scenario["assertions"];
      item.steps = [
        ...item.steps.filter((step) => step.action.type !== "assert"),
        verifyNav,
      ];
      item.objective = uncitedText.id;
    });
    expect(witnessRefusals((await gate(scenario)).refusals)).toHaveLength(1);
  });
});

describe("contrôles qui doivent passer toutes les portes", () => {
  it("V2 : le message d'état lu en texte après la clôture (hors périmètre `text`)", async () => {
    const scenario = mutant((item) => {
      item.steps = [
        item.steps[0],
        item.steps[1],
        {
          action: {
            locator: { by: "label", value: "Montant d’espèces attendu" },
            type: "fill",
            value: "1 240,00",
          },
          description: "fill",
          id: "fill-expected",
        },
        {
          action: {
            locator: {
              by: "role",
              name: "Clôturer la session",
              value: "button",
            },
            type: "click",
          },
          description: "close",
          id: "close",
        },
        {
          action: { assertionId: "status-variance", type: "assert" },
          description: "verify",
          id: "verify",
        },
      ] as Scenario["steps"];
      item.assertions = [
        {
          afterStep: "close",
          description: "message d'écart signé",
          expected:
            "Écart de -1 240,00 € : une justification écrite est obligatoire avant clôture.",
          id: "status-variance",
          kind: "text",
          requirement: 0,
          target: { by: "role", name: "", value: "status" },
          verification: "transition",
        },
      ] as Scenario["assertions"];
      item.objective = "status-variance";
    });
    const replay = await gate(scenario);
    expect(replay.refusals).toEqual([]);
    expect(replay.verdict).toBe("accepted");
  });

  it("count sur un attribut dont le nom kebab redonne l'identifiant camelCase changé", async () => {
    const scenario = mutant((item) => {
      Object.assign(objective(item), {
        expected: 1,
        kind: "count",
        target: { by: "css", value: '[data-variance-cents="-4000"]' },
      });
    });
    const replay = await gate(scenario);
    expect(replay.refusals).toEqual([]);
    expect(replay.verdict).toBe("accepted");
  });

  it("présence dont la citation écrit le littéral ciblé", async () => {
    const scenario = mutant((item) => {
      (item.requirements[0] as { quote: string }).quote =
        '    return { varianceCents, status: "compte-juste", blocking: false };';
      Object.assign(objective(item), {
        kind: "visible",
        target: { by: "css", value: '[data-x="compte-juste"]' },
      });
    });
    const replay = await gate(scenario);
    expect(replay.refusals).toEqual([]);
    expect(replay.verdict).toBe("accepted");
  });
});

/** Un scénario synthétique sur un diff d'une ligne, pour le découpage en jetons. */
function tokenCase(added: string, target: Record<string, unknown>) {
  const scenario = mutant((item) => {
    item.sourceFiles = ["src/value.ts"];
    (item.requirements[0] as { quote: string; sourceFile: string }).quote = "}";
    (item.requirements[0] as { sourceFile: string }).sourceFile =
      "src/value.ts";
    Object.assign(objective(item), { kind: "visible", target });
  });
  const context = {
    files: [
      {
        filename: "src/value.ts",
        patch: `@@ -1 +1 @@\n-const previous = 1;\n+${added}`,
        status: "modified",
      },
    ],
  };
  return objectiveWitnessRefusals(
    { ...realPlan, scenarios: [scenario] },
    context
  );
}

describe("découpage en jetons", () => {
  it("« Écart » rejoint `ecart` : accents repliés", () => {
    expect(
      tokenCase('const status = "ecart";', {
        by: "role",
        name: "Écart",
        value: "heading",
      })
    ).toEqual([]);
    expect(
      tokenCase('const status = "cart";', {
        by: "role",
        name: "Écart",
        value: "heading",
      })
    ).toHaveLength(1);
  });

  it("`varianceCents` donne variance et cents", () => {
    for (const value of ["[data-variance]", "[data-cents]"]) {
      expect(
        tokenCase("const varianceCents = 1;", { by: "css", value })
      ).toEqual([]);
    }
  });

  it("`5_000` est le nombre 5000", () => {
    expect(
      tokenCase("const limit = 5_000;", { by: "text", value: "5000" })
    ).toEqual([]);
    expect(
      tokenCase("const limit = 5_001;", { by: "text", value: "5000" })
    ).toHaveLength(1);
  });
});

/** Un scénario synthétique sur un diff donné, son unique assertion remplacée. */
function synthetic(input: {
  assertion: Record<string, unknown>;
  files: { filename: string; patch: string; status?: string }[];
  quote?: string;
  sourceFiles?: string[];
}) {
  const scenario = mutant((item) => {
    item.sourceFiles = input.sourceFiles ?? [input.files[0]?.filename ?? ""];
    const requirement = item.requirements[0] as {
      quote: string;
      sourceFile: string;
    };
    requirement.quote = input.quote ?? "}";
    requirement.sourceFile = item.sourceFiles[0] ?? "";
    const assertion = objective(item) as Record<string, unknown>;
    for (const key of ["expected", "requirement", "target"]) {
      delete assertion[key];
    }
    Object.assign(
      assertion,
      input.quote === undefined ? {} : { requirement: 0 },
      input.assertion
    );
  });
  return objectiveWitnessRefusals(
    { ...realPlan, scenarios: [scenario] },
    { files: input.files.map((file) => ({ status: "modified", ...file })) }
  );
}
const oneLine = (removed: string, added: string) => [
  {
    filename: "src/view.tsx",
    patch: `@@ -1 +1 @@\n-${removed}\n+${added}`,
  },
];

describe("libellés que le diff écrit en entier", () => {
  it.each([
    "CSV",
    "PDF",
    "TVA",
    "OK",
    "Add",
    "Export",
    "Import",
    "New",
    "Default",
    "Type",
    "Style",
    "Return",
    "Class",
    "Data",
    "Number",
    "Case",
    "Break",
    "Async",
  ])("« %s » : un mot court ou structurel, écrit comme texte du bouton ajouté", (label) => {
    expect(
      synthetic({
        assertion: {
          kind: "visible",
          target: { by: "role", name: label, value: "button" },
        },
        files: oneLine("", `  <button onClick={go}>${label}</button>`),
      })
    ).toEqual([]);
  });

  it("un mot-clé du langage n'est pas un littéral", () => {
    expect(
      synthetic({
        assertion: {
          kind: "visible",
          target: { by: "role", name: "Export", value: "button" },
        },
        files: oneLine("", "export const go = 1;"),
      })
    ).toHaveLength(1);
  });

  it("un rôle anonyme est lu par le `role=` que le diff écrit, et par lui seul", () => {
    const files = oneLine("", '  {error && <p role="alert">{error}</p>}');
    const read = (value: string) =>
      synthetic({
        assertion: { kind: "visible", target: { by: "role", name: "", value } },
        files,
      });
    expect(read("alert")).toEqual([]);
    expect(read("status")).toHaveLength(1);
  });

  it("une absence est témoin d'une cible que les lignes retirées écrivent", () => {
    const hidden = (removed: string, added: string) =>
      synthetic({
        assertion: {
          kind: "hidden",
          target: { by: "text", value: "Maintenance prévue" },
          verification: "state",
        },
        files: oneLine(removed, added),
      });
    expect(hidden("  <Banner>Maintenance prévue</Banner>", "")).toEqual([]);
    // Ajoutée seulement : la cible n'existait pas, l'absence passait déjà.
    expect(hidden("", "  <Banner>Maintenance prévue</Banner>")).toHaveLength(1);
  });

  it("une absence en transition se juge comme une présence : la cible était là juste avant", () => {
    // PR #20, run d6b3656d : le bouton « Rouvrir » que le diff AJOUTE disparaît
    // après la réouverture. En transition, l'exécuteur exige le bouton présent
    // avant l'étape : une cible qui n'a jamais existé échoue à l'exécution.
    const reopen = (verification: "state" | "transition") =>
      synthetic({
        assertion: {
          expected: 0,
          kind: "count",
          target: { by: "css", value: '[data-cash-action="rouvrir"]' },
          verification,
        },
        files: oneLine(
          "",
          '  <Button onClick={reopen} data-cash-action="rouvrir">Rouvrir la session</Button>'
        ),
      });
    expect(reopen("transition")).toEqual([]);
    expect(reopen("state")).toHaveLength(1);
  });
});

describe("adresses et nombres", () => {
  const route = (status: string) =>
    synthetic({
      assertion: { expected: "/billing", kind: "url" },
      files: [
        {
          filename: "app/billing/page.tsx",
          patch: "@@ -0,0 +1 @@\n+export default function Page() {}",
          status,
        },
      ],
    });

  it("une route par fichier AJOUTÉE est lue par son chemin", () => {
    expect(route("added")).toEqual([]);
    // Un fichier modifié existait avant : son chemin ne prouve rien.
    expect(route("modified")).toHaveLength(1);
  });

  it("un `count` dont la citation écrit le nombre attendu", () => {
    const count = (quote?: string) =>
      synthetic({
        assertion: {
          expected: 20,
          kind: "count",
          target: { by: "css", value: "tbody tr" },
        },
        files: oneLine("const PAGE_SIZE = 10;", "const PAGE_SIZE = 20;"),
        ...(quote === undefined ? {} : { quote }),
      });
    expect(count("const PAGE_SIZE = 20;")).toEqual([]);
    // Non cité, le nombre n'est jamais une observation.
    expect(count()).toHaveLength(1);
  });
});

describe("refus connus et documentés : le mot observé n'est sur aucune ligne changée", () => {
  // Le remède est une lecture de valeur qui cite son exigence (hint) ; ces cas
  // restent refusés pour qu'un relâchement soit délibéré.
  it.each([
    {
      assertion: {
        kind: "visible",
        target: { by: "text", value: "En retard" },
      },
      files: oneLine("const late = days > 30;", "const late = days > 60;"),
      name: "condition changée, libellé dans un fichier inchangé",
    },
    {
      assertion: {
        kind: "visible",
        target: { by: "role", name: "Factures en retard", value: "heading" },
      },
      files: oneLine("<h2>{title}</h2>", '<h2>{t("invoices.overdue")}</h2>'),
      name: "clé de traduction",
    },
    {
      assertion: {
        kind: "visible",
        target: { by: "text", value: "Factures" },
      },
      files: oneLine("<h2>{titre}</h2>", "<h2>{facture.titre}</h2>"),
      name: "pluriel",
    },
    {
      assertion: {
        kind: "visible",
        target: { by: "role", name: "Verrouillé", value: "img" },
      },
      files: oneLine("", "{isLocked && <LockIcon />}"),
      name: "nom accessible porté par un composant inchangé",
    },
    {
      assertion: { expected: "/items/42", kind: "url" },
      files: oneLine("const id = 41;", "const id = 42;"),
      name: "nombre de moins de trois chiffres",
    },
  ])("$name", ({ assertion, files }) => {
    expect(synthetic({ assertion, files })).toHaveLength(1);
  });
});

it("seules les lignes des `sourceFiles` du scénario sont des sources", () => {
  const files = [
    {
      filename: "src/a.ts",
      patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
    },
    {
      filename: "src/b.tsx",
      patch: '@@ -1 +1 @@\n-<p>old</p>\n+<p data-ledger-total="1">x</p>',
    },
  ];
  const read = (sourceFiles: string[]) =>
    synthetic({
      assertion: {
        kind: "visible",
        target: { by: "css", value: "[data-ledger-total]" },
      },
      files,
      sourceFiles,
    });
  expect(read(["src/a.ts"])).toHaveLength(1);
  expect(read(["src/a.ts", "src/b.tsx"])).toEqual([]);
});

describe("le jeu de régression reste vert", () => {
  const pr20Context = { files: pr20.files };
  let declared = 0;
  for (const run of fixture.regression) {
    const plan = PlanSchema.parse(run.plan);
    declared += plan.scenarios.filter(
      (scenario) => scenario.objective !== undefined
    ).length;
    it(`run ${run.run.slice(0, 8)} : aucun refus de témoin, avec ou sans objectif déclaré`, () => {
      expect(run.scenarios.length).toBe(7);
      expect(objectiveWitnessRefusals(plan, pr20Context)).toEqual([]);
      const undeclared = {
        ...plan,
        scenarios: plan.scenarios.map((scenario) => ({
          ...scenario,
          objective: undefined,
        })),
      };
      expect(objectiveWitnessRefusals(undeclared, pr20Context)).toEqual([]);
    });
  }

  it("21 objectifs déclarés sur 21 scénarios, tous témoins", () => {
    expect(declared).toBe(21);
  });

  it("79 plans historiques : 93 lectures de présence sans témoin sur 2914, 0 scénario sur 681", () => {
    expect(historicalPlans).toHaveLength(79);
    let scenarios = 0;
    let presence = 0;
    let unwitnessed = 0;
    let fallback = 0;
    for (const entry of historicalPlans) {
      const plan = entry.plan as Plan;
      scenarios += plan.scenarios.length;
      fallback += objectiveWitnessRefusals(plan, pr20).length;
      for (const scenario of plan.scenarios) {
        expect(scenario.objective).toBeUndefined();
        for (const assertion of scenario.assertions) {
          if (!["visible", "hidden", "count"].includes(assertion.kind)) {
            continue;
          }
          presence += 1;
          // Contrefactuel : chaque lecture de présence prise pour objectif.
          unwitnessed += objectiveWitnessRefusals(
            {
              ...plan,
              scenarios: [{ ...scenario, objective: assertion.id }],
            },
            pr20
          ).length;
        }
      }
    }
    // Contrefactuel : 99 avant la règle de transition, 93 depuis — les 6
    // absences lues en transition se jugent comme des présences, l'exécuteur
    // exigeant la cible juste avant l'étape. Restent les lectures négatives en
    // state (sur 98 : 81 `count` à 0, 17 `hidden`) d'une
    // cible que la PR 20 AJOUTE (`[data-cash-action="rouvrir"]`, « Rouvrir la
    // session »…) : sur la base, cette cible n'existe pas, l'absence y passe
    // donc aussi — elle ne prouve pas le changement si elle est prise pour
    // objectif. Plus une présence dont les seules sources sont de la
    // documentation. Aucune n'est l'unique preuve de son scénario : la règle de
    // repli reste à 0 sur 681.
    expect({ fallback, presence, scenarios, unwitnessed }).toEqual({
      fallback: 0,
      presence: 2914,
      scenarios: 681,
      unwitnessed: 93,
    });
  });
});

it("le prompt énonce le matériel des consommateurs et le refus de témoin", () => {
  expect(PLANNER_PROMPT).toContain(
    "pr.consumers, when present, holds excerpts of UNCHANGED files"
  );
  expect(PLANNER_PROMPT).toContain(
    "is refused (OBJECTIVE_UNWITNESSED): a view title, a navigation control or a heading of the page you left exists with or without the change"
  );
  expect(PLANNER_PROMPT).toContain("never copied from an observed view");
  expect(PLANNER_PROMPT).toContain(
    "A hidden or zero-count objective read with verification state proves the change only when the lines the diff removes write its target"
  );
});
