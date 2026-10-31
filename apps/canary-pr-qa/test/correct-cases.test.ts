import { afterEach, describe, expect, it, vi } from "vitest";
import { compareWithBaseline } from "../src/baseline-diff.js";
import { Canary } from "../src/canary.js";
import type { Config } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { executeScenario } from "../src/executor.js";
import type { PrContext } from "../src/github.js";
import { explainMissingTarget } from "../src/missing-target.js";
import type {
  Assertion,
  RunResult,
  Scenario,
  ScenarioResult,
} from "../src/schema.js";
import { fixture } from "./fixture.js";

/**
 * Les cas corrects du banc pharmania (f1, f3) que Canary bloquait à tort, et
 * les gardes qui empêchent leurs correctifs d'ouvrir un faux vert.
 */
const CONFIG = {} as Config;
const BASE_SHA = "7427180aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
type Recorded = ScenarioResult["assertions"][number];
type Step = ScenarioResult["steps"][number];

const objective: Assertion = {
  id: "total",
  description: "le total reste celui de la base",
  kind: "text",
  expected: "Total 1 240,00 €",
  target: { by: "css", value: '[role="status"]' },
  afterStep: "reset",
  verification: "transition",
} as Assertion;

const button = (name: string): Assertion =>
  ({
    id: "button",
    description: `le bouton ${name} est visible`,
    kind: "visible",
    target: { by: "role", value: "button", name },
  }) as Assertion;

function side(
  kind: string,
  assertions: Assertion[],
  recorded: Recorded[],
  steps: Step[] = []
): ScenarioResult {
  return {
    scenario: {
      id: "s",
      title: "s",
      kind,
      objective: "total",
      assertions,
      preconditions: [],
      steps: [],
    } as unknown as ScenarioResult["scenario"],
    outcome: recorded.every((item) => item.passed) ? "passed" : "failed",
    steps,
    assertions: recorded,
    artifacts: [],
    contract: { completedSteps: [], totalSteps: 0, hash: "contract-s" },
  };
}

function run(head: ScenarioResult, base: ScenarioResult): RunResult {
  return {
    id: "run",
    prUrl: "https://github.com/fixture/app/pull/1",
    startedAt: "2026-10-31T00:00:00.000Z",
    outcome: "passed",
    sha: "1".repeat(40),
    scenarios: [head],
    baseline: { sha: BASE_SHA, url: "https://base/", scenarios: [base] },
  };
}

const file = (filename: string, patch: string) =>
  ({ filename, status: "modified", patch }) as PrContext["files"][number];

/** Banc f1-2 : la PR ajoute le bouton « Remettre à zéro » à la vue de caisse. */
const ADDS_RESET = [
  file(
    "apps/web/app/page.tsx",
    [
      "@@ -40,3 +40,6 @@ function CashAndSafe() {",
      "   <section>",
      '+    <button type="button" onClick={reset}>',
      "+      Remettre à zéro",
      "+    </button>",
      "     <Total />",
    ].join("\n")
  ),
];

/**
 * Un scénario `regression` : l'objectif (le total) est inchangé des deux
 * côtés, l'assertion annexe lit un bouton visible sur la tête, absent sur la
 * base.
 */
function secondary(name: string, kind = "regression") {
  const assertions = [button(name), objective];
  return run(
    side(kind, assertions, [
      { id: "button", passed: true, actual: true },
      { id: "total", passed: true, actual: "Total 1 240,00 €" },
    ]),
    side(kind, assertions, [
      { id: "button", passed: false, actual: false },
      { id: "total", passed: true, actual: "Total 1 240,00 €" },
    ])
  );
}

describe("assertion annexe d'un scénario `regression` (correctif 2, variante sûre)", () => {
  it("un littéral que le diff ajoute est un changement, pas une régression", () => {
    const result = secondary("Remettre à zéro");
    compareWithBaseline(
      result,
      CONFIG,
      "feat(caisse): remise à zéro",
      ADDS_RESET
    );
    const head = result.scenarios[0]!;
    expect(head.outcome).toBe("passed");
    expect(head.diagnostic).toBeUndefined();
    expect(result.baselineComparison?.regressions).toEqual([]);
    expect(result.baselineComparison?.changes).toHaveLength(1);
    expect(result.baselineComparison?.changes[0]?.reason).toContain(
      "literal the diff adds"
    );
  });

  it("une assertion annexe sur l'interface existante escalade toujours", () => {
    // « Valider » figure sur une ligne de contexte : le diff ne le crée pas.
    const existing = [
      file(
        "apps/web/app/page.tsx",
        [
          "@@ -40,3 +40,4 @@ function CashAndSafe() {",
          "   <button>Valider</button>",
          '+  <p className="hint">Valider</p>',
          "   <Total />",
        ].join("\n")
      ),
    ];
    for (const files of [existing, undefined, []]) {
      const result = secondary("Valider");
      compareWithBaseline(result, CONFIG, "feat(caisse): aide", files);
      expect(result.scenarios[0]?.diagnostic?.code).toBe("BASELINE_REGRESSION");
    }
  });

  it("un littéral absent du diff, ou seulement cité par un test ou la doc, escalade", () => {
    const quoted = [
      file(
        "apps/web/e2e/cash.spec.ts",
        "@@ -1,1 +1,2 @@\n test\n+  click('Remettre à zéro')"
      ),
      file("docs/caisse.md", "@@ -1,1 +1,2 @@\n # Caisse\n+Remettre à zéro"),
    ];
    for (const files of [quoted, ADDS_RESET]) {
      const result = secondary(
        files === ADDS_RESET ? "Remettre à zéro du jour" : "Remettre à zéro"
      );
      compareWithBaseline(result, CONFIG, "feat(caisse): remise à zéro", files);
      expect(result.scenarios[0]?.diagnostic?.code).toBe("BASELINE_REGRESSION");
    }
  });

  it("une base qui LIT l'élément avec une autre valeur escalade, littéral ajouté ou non", () => {
    // Le libellé « Billet de 20 € » passe d'un gabarit à une table ajoutée :
    // le diff l'épelle sur une ligne ajoutée, mais la base rend déjà la ligne,
    // avec la bonne valeur (20,00 €). La tête épingle la valeur du bug.
    const row: Assertion = {
      id: "row20",
      description: "la ligne du billet de 20 €",
      kind: "text",
      expected: "25,00 €",
      target: { by: "role", value: "row", name: "Billet de 20 €" },
    } as Assertion;
    const assertions = [row, objective];
    const result = run(
      side("regression", assertions, [
        { id: "row20", passed: true, actual: "Billet de 20 € 1 25,00 €" },
        { id: "total", passed: true, actual: "Total 1 240,00 €" },
      ]),
      side("regression", assertions, [
        { id: "row20", passed: false, actual: "Billet de 20 € 1 20,00 €" },
        { id: "total", passed: true, actual: "Total 1 240,00 €" },
      ])
    );
    compareWithBaseline(
      result,
      CONFIG,
      "fix(caisse): centraliser les coupures",
      [
        file(
          "apps/web/lib/denominations.ts",
          '@@ -0,0 +1,3 @@\n+export const DENOMINATIONS = [\n+  { label: "Billet de 20 €", cents: 2500 },\n+];'
        ),
        file(
          "apps/web/app/page.tsx",
          [
            "@@ -10,1 +10,1 @@",
            // Le gabarit de la base, tel que le patch le montre.
            ["-  label={`Billet de ", "$", "{value} €`}"].join(""),
            "+  label={d.label}",
          ].join("\n")
        ),
      ]
    );
    const head = result.scenarios[0]!;
    expect(head.outcome).toBe("failed");
    expect(head.diagnostic?.code).toBe("BASELINE_REGRESSION");
    expect(result.baselineComparison?.regressions).toHaveLength(1);
  });

  it("une cible introuvable sur la base (aucune valeur lue) reste un ajout", () => {
    const result = secondary("Remettre à zéro");
    const base = result.baseline!.scenarios[0]!;
    base.assertions[0] = { id: "button", passed: false, actual: undefined };
    compareWithBaseline(result, CONFIG, "feat: remise à zéro", ADDS_RESET);
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(result.baselineComparison?.regressions).toEqual([]);
  });

  it("un fichier sans patch lisible rend l'ajout indécidable : escalade", () => {
    const result = secondary("Remettre à zéro");
    compareWithBaseline(result, CONFIG, "feat: remise à zéro", [
      ...ADDS_RESET,
      { filename: "apps/web/big.tsx", status: "modified" } as never,
    ]);
    expect(result.scenarios[0]?.diagnostic?.code).toBe("BASELINE_REGRESSION");
  });

  it("l'objectif, une PR `refactor` ou une tête rouge gardent la régression", () => {
    // L'objectif porte la déclaration d'inchangé : jamais exempté.
    const onObjective = secondary("Remettre à zéro");
    for (const item of [
      onObjective.scenarios[0]!,
      onObjective.baseline!.scenarios[0]!,
    ]) {
      (item.scenario as { objective?: string }).objective = "button";
    }
    compareWithBaseline(onObjective, CONFIG, "feat: remise", ADDS_RESET);
    expect(onObjective.scenarios[0]?.diagnostic?.code).toBe(
      "BASELINE_REGRESSION"
    );
    // Une PR `refactor` déclare tout inchangé : un ajout y est un écart.
    const refactor = secondary("Remettre à zéro");
    compareWithBaseline(refactor, CONFIG, "refactor: caisse", ADDS_RESET);
    expect(refactor.scenarios[0]?.diagnostic?.code).toBe("BASELINE_REGRESSION");
    // Base verte, tête rouge : la PR casse, ajout ou non.
    const assertions = [button("Remettre à zéro"), objective];
    const broken = run(
      side("regression", assertions, [
        { id: "button", passed: false, actual: false },
        { id: "total", passed: true, actual: "Total 1 240,00 €" },
      ]),
      side("regression", assertions, [
        { id: "button", passed: true, actual: true },
        { id: "total", passed: true, actual: "Total 1 240,00 €" },
      ])
    );
    compareWithBaseline(broken, CONFIG, "feat: remise", ADDS_RESET);
    expect(broken.scenarios[0]?.diagnostic?.code).toBe("BASELINE_REGRESSION");
  });
});

/** La page du banc f3 : chaque coupure expose « Quantité · ${d.label} ». */
const CASH_FIELDS = `- main [ref=e1]:
  - spinbutton "Quantité · Billet de 500 €" [ref=e2]
  - spinbutton "Quantité · Billet de 100 €" [ref=e3]
  - spinbutton "Quantité · Pièce de 2 €" [ref=e4]
  - button "Clôturer la session" [ref=e5]`;

const fillStep = (
  label: string,
  type: "fill" | "click" = "fill"
): Scenario["steps"][number] =>
  (type === "fill"
    ? {
        id: "fill-100",
        description: "compter un billet de 100 €",
        action: { type, locator: { by: "label", value: label }, value: "2" },
      }
    : {
        id: "fill-100",
        description: "cliquer",
        action: { type, locator: { by: "label", value: label } },
      }) as Scenario["steps"][number];

async function explain(step: Scenario["steps"][number], aria: string) {
  const canary = {
    act: async () => ({ url: "https://p/", snapshot: aria, evidence: aria }),
  } as unknown as Canary;
  const failure = new QaError("TARGET_NOT_FOUND", "absent", "Check.");
  return await explainMissingTarget(
    failure,
    "session",
    step,
    { id: "s", steps: [step], assertions: [] } as unknown as Scenario,
    "https://p/",
    canary,
    CONFIG,
    []
  );
}

describe("reprise par inclusion d'un champ (correctif 4)", () => {
  it("rejoue sur le champ unique qui contient le libellé, mêmes nombres", async () => {
    const { contained } = await explain(
      fillStep("Billet de 100 €"),
      CASH_FIELDS
    );
    expect(contained?.target).toEqual({
      role: "spinbutton",
      name: "Quantité · Billet de 100 €",
    });
    expect(contained?.step.action).toEqual({
      type: "fill",
      locator: {
        by: "role",
        value: "spinbutton",
        name: "Quantité · Billet de 100 €",
      },
      value: "2",
    });
  });

  it("ne répare ni un candidat ambigu, ni un nombre différent, ni un clic", async () => {
    const twice = `${CASH_FIELDS}\n  - spinbutton "Stock · Billet de 100 €" [ref=e6]`;
    expect((await explain(fillStep("Billet de 100 €"), twice)).contained).toBe(
      undefined
    );
    // Deux éléments du même nom : le locator rejoué serait ambigu.
    const duplicated = `${CASH_FIELDS}\n  - spinbutton "Quantité · Billet de 100 €" [ref=e7]`;
    expect(
      (await explain(fillStep("Billet de 100 €"), duplicated)).contained
    ).toBe(undefined);
    // Un nombre ajouté change ce que le test compte.
    const extra = `- main [ref=e1]:\n  - spinbutton "Quantité · Billet de 100 € × 2" [ref=e2]`;
    expect((await explain(fillStep("Billet de 100 €"), extra)).contained).toBe(
      undefined
    );
    // « 10 » n'est pas « 100 » : aucun champ ne contient le libellé.
    expect(
      (await explain(fillStep("Billet de 10 €"), CASH_FIELDS)).contained
    ).toBe(undefined);
    expect(
      (await explain(fillStep("Billet de 100 €", "click"), CASH_FIELDS))
        .contained
    ).toBe(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejoue l'étape sans modèle et consigne la cible substituée", async () => {
    const f = await fixture();
    const scenario = {
      id: "s",
      title: "billets",
      kind: "happy_path",
      rationale: "",
      sourceFiles: [],
      preconditions: [],
      requirements: [],
      steps: [
        {
          id: "open",
          description: "ouvrir",
          action: { type: "goto", path: "/" },
        },
        fillStep("Billet de 100 €"),
      ],
      assertions: [],
    } as unknown as Scenario;
    const fills: string[] = [];
    vi.spyOn(Canary.prototype, "start").mockResolvedValue("contained");
    vi.spyOn(Canary.prototype, "act").mockImplementation(
      async (_session, label, script) => {
        if (label.endsWith("-fill")) {
          fills.push(String(script));
          if (fills.length === 1) {
            throw new QaError("TARGET_NOT_FOUND", "absent", "Check.");
          }
        }
        return {
          url: "https://fixture/",
          snapshot: CASH_FIELDS,
          evidence: CASH_FIELDS,
          actual: true,
        };
      }
    );
    vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
    const result = await executeScenario(
      scenario,
      f.baseUrl,
      f.dataDir,
      f.config,
      new Canary(f.config)
    );
    await f.close();
    expect(fills).toHaveLength(2);
    const played = result.steps.find(
      (step) => step.stepId === "fill-100" && step.ok
    );
    expect(played?.repairedTarget).toBe(
      'role=spinbutton name="Quantité · Billet de 100 €"'
    );
    // Le plan exécuté garde la cible du planificateur.
    expect(scenario.steps[1]?.action).toEqual(
      fillStep("Billet de 100 €").action
    );
  });
});

describe("même substitution des deux côtés (correctif 7)", () => {
  const repaired = (target: string): Step[] => [
    {
      action: {
        type: "fill",
        locator: { by: "label", value: "Billet de 100 €" },
        value: "2",
      },
      index: 2,
      ok: true,
      reason: "",
      observation: "",
      stepId: "fill-100",
      repairedTarget: target,
    } as Step,
  ];
  const total = text("Total 200,00 €");
  function text(expected: string): Assertion {
    return { ...objective, expected } as Assertion;
  }
  const SAME = 'role=spinbutton name="Quantité · Billet de 100 €"';

  it("une cible réparée peut encore être jugée non discriminante", () => {
    const result = run(
      side(
        "happy_path",
        [total],
        [{ id: "total", passed: true, actual: "Total 200,00 €" }],
        repaired(SAME)
      ),
      side(
        "happy_path",
        [total],
        [{ id: "total", passed: true, actual: "Total 200,00 €" }],
        repaired(SAME)
      )
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.outcome).toBe("blocked");
    expect(result.scenarios[0]?.diagnostic?.code).toBe(
      "OBJECTIVE_NOT_DISCRIMINATING"
    );
  });

  it("la même substitution garde la comparaison, une autre la rend non concluante", () => {
    const pair = (baseTarget: string) =>
      run(
        side(
          "happy_path",
          [total],
          [{ id: "total", passed: true, actual: "Total 200,00 €" }],
          repaired(SAME)
        ),
        side(
          "happy_path",
          [total],
          [{ id: "total", passed: false, actual: "Total 0,00 €" }],
          repaired(baseTarget)
        )
      );
    const same = pair(SAME);
    compareWithBaseline(same, CONFIG);
    expect(same.baselineComparison?.changes).toHaveLength(1);
    expect(same.baselineComparison?.inconclusive).toEqual([]);
    const other = pair('role=spinbutton name="Stock · Billet de 100 €"');
    compareWithBaseline(other, CONFIG);
    expect(other.baselineComparison?.changes).toEqual([]);
    expect(other.baselineComparison?.inconclusive[0]?.reason).toContain(
      "substituted target at step fill-100"
    );
  });
});
