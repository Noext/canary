import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/diagnostics.js";
import { classifyScenarioResult } from "../src/observe-act.js";
import { preExecutionFindings } from "../src/plan-evidence.js";
import { planFindings } from "../src/policy.js";
import { type Plan, PlanSchema, plannerPlanSchema } from "../src/schema.js";

/**
 * `assertionIntent` : le plan DÉCLARE ce que l'assertion cherche à prouver, au
 * lieu de laisser le validateur deviner. Une persistance déclarée doit être lue
 * en `persisted` ; une intention absente reste inconnue — les plans antérieurs ne
 * portent pas ce champ — et n'est jamais refusée sur cette seule ambiguïté.
 */

const HISTORY = { by: "css", value: "[data-cash-history-entry]" } as const;
const STATE_MARKER = {
  by: "css",
  value: '[data-cash-state="ecart-a-justifier"]',
} as const;

const STEPS = [
  { action: { path: "/", type: "goto" }, description: "ouvrir", id: "load" },
  {
    action: {
      locator: { by: "role", name: "Clôturer", value: "button" },
      type: "click",
    },
    description: "clôturer",
    id: "close",
  },
  {
    action: { assertionId: "history", type: "assert" },
    description: "vérifier l'historique",
    id: "assert-history",
  },
  {
    action: {
      locator: { by: "role", name: "Rouvrir", value: "button" },
      type: "click",
    },
    description: "réouvrir",
    id: "reopen",
  },
  {
    action: { assertionId: "history-persist", type: "assert" },
    description: "vérifier la persistance",
    id: "assert-persist",
  },
];

/** La forme du run `afcc9846 / cash-history-and-reopen`. */
function historyScenario(
  intent?: "invariant" | "persistence",
  verification = "state"
) {
  return {
    assertions: [
      {
        afterStep: "close",
        description: "l'entrée d'historique est créée",
        expected: 1,
        id: "history",
        kind: "count",
        target: HISTORY,
        verification: "transition",
      },
      {
        afterStep: "reopen",
        description: "l'entrée d'historique persiste après réouverture",
        expected: 1,
        id: "history-persist",
        kind: "count",
        target: HISTORY,
        verification,
        ...(intent === undefined ? {} : { assertionIntent: intent }),
      },
    ],
    id: "cash-history-and-reopen",
    kind: "regression",
    preconditions: [],
    rationale: "r",
    requirements: [
      {
        behavior: "b",
        quote: "show('Welcome '+name)",
        sourceFile: "src/form.ts",
      },
    ],
    sourceFiles: ["src/form.ts"],
    steps: STEPS,
    title: "L'historique survit à la réouverture",
  };
}

/** La forme du run `0ce50724 / cash-excedent-bloque-comme-manque`. */
function invariantScenario(intent?: "invariant" | "persistence") {
  return {
    assertions: [
      {
        afterStep: "close",
        description: "l'écart reste à justifier après la clôture",
        expected: 1,
        id: "still-blocked",
        kind: "count",
        target: STATE_MARKER,
        verification: "state",
        ...(intent === undefined ? {} : { assertionIntent: intent }),
      },
    ],
    id: "cash-excedent-bloque-comme-manque",
    kind: "regression",
    preconditions: [],
    rationale: "r",
    requirements: [
      {
        behavior: "b",
        quote: "show('Welcome '+name)",
        sourceFile: "src/form.ts",
      },
    ],
    sourceFiles: ["src/form.ts"],
    steps: [
      {
        action: { path: "/", type: "goto" },
        description: "ouvrir",
        id: "load",
      },
      {
        action: {
          locator: { by: "role", name: "Clôturer", value: "button" },
          type: "click",
        },
        description: "clôturer",
        id: "close",
      },
      {
        action: { assertionId: "still-blocked", type: "assert" },
        description: "vérifier",
        id: "assert",
      },
    ],
    title: "La clôture ne purge pas un écart à justifier",
  };
}

function plan(scenario: unknown): Plan {
  return PlanSchema.parse({ scenarios: [scenario], skipped: [], summary: "s" });
}

function refusalsOf(value: Plan) {
  return planFindings(value, []).refusals;
}

describe("le schéma porte l'intention, et l'absence reste inconnue", () => {
  it("accepte les deux intentions et l'absence du champ", () => {
    for (const intent of [undefined, "invariant", "persistence"] as const) {
      const parsed = plan(historyScenario(intent));
      expect(parsed.scenarios[0]?.assertions[1]?.assertionIntent).toBe(intent);
    }
  });

  it("refuse une intention hors des deux valeurs", () => {
    const broken = historyScenario();
    (broken.assertions[1] as Record<string, unknown>).assertionIntent = "maybe";
    expect(() => plan(broken)).toThrow();
  });

  it("le schéma de la réponse du planificateur accepte le champ", () => {
    // Sans ce champ dans la forme SOUMISE, le modèle ne pourrait jamais le
    // produire : la règle serait morte. On le vérifie en parsant une réponse.
    const submitted = plannerPlanSchema([]).parse({
      scenarios: [historyScenario("persistence", "persisted")],
      skipped: [],
      summary: "s",
    });
    expect(submitted.scenarios[0]?.assertions[1]?.assertionIntent).toBe(
      "persistence"
    );
  });
});

describe("une persistance déclarée doit être lue en `persisted`", () => {
  it("refuse la forme mesurée de s9-history-persist (run afcc9846)", () => {
    const refusals = refusalsOf(plan(historyScenario("persistence", "state")));
    expect(refusals).toHaveLength(1);
    const [finding] = refusals;
    expect(finding?.error.code).toBe("PERSISTENCE_INTENT_MISMATCH");
    expect(finding?.scenarioId).toBe("cash-history-and-reopen");
    expect(finding?.error.message).toMatch(
      /history-persist declare persistence/
    );
    expect(finding?.error.message).toMatch(/verify it with "state"/);
    expect(finding?.error.message).toMatch(
      /proves nothing about what survived/
    );
    // Le remède est nommé, et rien n'est converti en silence.
    expect(finding?.error.hint).toMatch(/verification: "persisted"/);
    expect(finding?.error.hint).toMatch(/reloads the page/);
  });

  it("accepte la même assertion déclarée persistance et lue en persisted", () => {
    expect(
      refusalsOf(plan(historyScenario("persistence", "persisted")))
    ).toEqual([]);
  });

  it("accepte la persistance déclarée sans nouvelle preuve exigée ailleurs", () => {
    // `transition` ne prouve pas la survie : la déclaration reste incohérente.
    expect(
      refusalsOf(plan(historyScenario("persistence", "transition")))
    ).toHaveLength(1);
  });
});

describe("un invariant légitime reste valide", () => {
  it("accepte still-blocked déclaré invariant (run 0ce50724)", () => {
    expect(refusalsOf(plan(invariantScenario("invariant")))).toEqual([]);
  });

  it("accepte still-blocked sans intention déclarée", () => {
    expect(refusalsOf(plan(invariantScenario()))).toEqual([]);
  });

  it("refuse une persistance déclarée sur cette même assertion", () => {
    // L'intention est la seule chose qui change : c'est bien le discriminant.
    expect(refusalsOf(plan(invariantScenario("persistence")))).toHaveLength(1);
  });
});

describe("les plans antérieurs ne sont pas refusés sur l'ambiguïté", () => {
  it("aucun refus quand l'intention est absente, même si la forme est ambiguë", () => {
    // Les 131 assertions historiques sont dans ce cas : la forme est ambiguë,
    // l'intention est inconnue, et le gate ne la devine pas.
    expect(refusalsOf(plan(historyScenario()))).toEqual([]);
  });
});

describe("le refus sort par le chemin de production, avant exécution", () => {
  it("preExecutionFindings porte le refus, donc le scénario ne sera pas joué", () => {
    const findings = preExecutionFindings(
      plan(historyScenario("persistence", "state")),
      {
        baseSha: "b".repeat(40),
        body: "",
        context: [],
        contextWarnings: [],
        files: [],
        headRepo: "fixture/app",
        ref: {
          number: 1,
          repo: "fixture/app",
          url: "https://github.com/fixture/app/pull/1",
        },
        sha: "a".repeat(40),
        title: "t",
      },
      {
        allowedHosts: ["preview.fixture.test"],
        allowedRepos: [],
        criticalPaths: ["src/"],
        fixtures: {},
        requireWriteEvidence: false,
        roles: [],
        version: 1,
        visuals: [],
      } as never,
      { QA_PER_SCENARIO_COVERAGE: false } as never
    );
    expect(findings.map((item) => item.error.code)).toContain(
      "PERSISTENCE_INTENT_MISMATCH"
    );
  });
});

describe("le diagnostic est classé comme défaut de plan, dans les deux taxonomies", () => {
  it("classe PERSISTENCE_INTENT_MISMATCH en plan-defective puis test-defect", () => {
    expect(classifyFailure({ code: "PERSISTENCE_INTENT_MISMATCH" })).toBe(
      "plan-defective"
    );
    const result: {
      classification?: "proven" | "failed" | "test-defect" | "indeterminate";
      diagnostic?: { code: string };
      outcome: string;
    } = {
      diagnostic: { code: "PERSISTENCE_INTENT_MISMATCH" },
      outcome: "blocked",
    };
    classifyScenarioResult(result);
    expect(result.classification).toBe("test-defect");
  });
});

describe("l'intention survit aux corrections de plan", () => {
  it("un plan revalidé garde le champ sur l'assertion", () => {
    const parsed = plan(historyScenario("persistence", "persisted"));
    const clone = structuredClone(parsed);
    expect(clone.scenarios[0]?.assertions[1]?.assertionIntent).toBe(
      "persistence"
    );
    // Le schéma persisté le conserve tel quel, sans valeur par défaut.
    const reparsed = PlanSchema.parse(JSON.parse(JSON.stringify(clone)));
    expect(reparsed.scenarios[0]?.assertions[1]?.assertionIntent).toBe(
      "persistence"
    );
  });
});
