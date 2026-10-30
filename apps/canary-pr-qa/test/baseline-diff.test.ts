import { describe, expect, it } from "vitest";
import { compareWithBaseline } from "../src/baseline-diff.js";
import { assertionMatches } from "../src/canary.js";
import type { Config } from "../src/config.js";
import { reportMarkdown, statusDescription } from "../src/report.js";
import type { Assertion, RunResult, ScenarioResult } from "../src/schema.js";

/**
 * La base comme oracle indépendant, assertion par assertion. Les valeurs de la
 * PR 21 de `pharmania/arpilabe-pilotage` sont celles mesurées : la base
 * déployée (`7427180`) affiche « Écart de -40,00 € », la tête inverse le signe.
 */
const CONFIG = {} as Config;
const BASE_SHA = "7427180aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/** Une valeur lue dans la page : elle ne doit jamais atteindre une surface publiée. */
const SENTINEL = "Valeur-de-page-privée-42";

type Recorded = ScenarioResult["assertions"][number];

function text(id: string, expected: string): Assertion {
  return {
    id,
    description: id,
    kind: "text",
    expected,
    target: { by: "css", value: '[role="status"]' },
    afterStep: "close",
    verification: "transition",
  } as Assertion;
}

function scenario(
  id: string,
  assertions: Assertion[],
  recorded: Recorded[],
  options: {
    objective?: string;
    outcome?: ScenarioResult["outcome"];
    code?: string;
    error?: string;
    hash?: string;
  } = {}
): ScenarioResult {
  const outcome =
    options.outcome ??
    (recorded.every((item) => item.passed) &&
    recorded.length === assertions.length
      ? "passed"
      : "failed");
  return {
    scenario: {
      id,
      title: id,
      objective: options.objective,
      assertions,
      steps: [],
    } as unknown as ScenarioResult["scenario"],
    outcome,
    steps: [],
    assertions: recorded,
    artifacts: [],
    contract: {
      completedSteps: [],
      totalSteps: 0,
      hash: options.hash ?? `contract-${id}`,
    },
    ...(options.code
      ? {
          diagnostic: { code: options.code, message: options.code, hint: "" },
        }
      : {}),
    ...(options.error ? { error: options.error } : {}),
  };
}

function run(
  head: ScenarioResult[],
  base: ScenarioResult[] | undefined
): RunResult {
  return {
    id: "run",
    prUrl: "https://github.com/fixture/app/pull/21",
    startedAt: "2026-10-30T00:00:00.000Z",
    outcome: "passed",
    sha: "1".repeat(40),
    scenarios: head,
    ...(base
      ? { baseline: { sha: BASE_SHA, url: "https://base/", scenarios: base } }
      : {}),
  };
}

const read = (passed: boolean, actual: unknown, id = "a"): Recorded => ({
  id,
  passed,
  actual,
});

describe("la matrice base/tête, par assertion", () => {
  it("base verte, tête rouge : régression produit, valeurs dans la comparaison seulement", () => {
    const a = text("a", "Total 10");
    const result = run(
      [
        scenario("s", [a], [read(false, `${SENTINEL} head`)], {
          objective: "a",
          error: "Assertion a failed: total",
        }),
      ],
      [scenario("s", [a], [read(true, `${SENTINEL} base`)], { objective: "a" })]
    );
    compareWithBaseline(result, CONFIG);
    const head = result.scenarios[0]!;
    expect(head.outcome).toBe("failed");
    expect(head.classification).toBe("failed");
    expect(head.diagnostic?.code).toBe("BASELINE_REGRESSION");
    expect(head.error).toContain("passes on the base commit 7427180");
    // La cause d'origine reste lisible derrière la régression.
    expect(head.error).toContain("head: Assertion a failed: total");
    expect(result.baselineComparison?.regressions).toEqual([
      {
        scenarioId: "s",
        assertionId: "a",
        objective: true,
        expected: "Total 10",
        head: { passed: false, actual: `${SENTINEL} head` },
        base: { passed: true, actual: `${SENTINEL} base` },
      },
    ]);
    for (const surface of [
      head.error,
      head.diagnostic?.message,
      head.diagnostic?.hint,
      reportMarkdown(result),
      statusDescription(result),
    ]) {
      expect(surface).not.toContain(SENTINEL);
    }
    expect(reportMarkdown(result, undefined, true)).toContain(
      `« ${SENTINEL} base » (passe) → PR : « ${SENTINEL} head » (échoue)`
    );
  });

  it("tête verte, base rouge : comportement modifié, la tête reste verte", () => {
    const a = text("a", "Welcome Ada");
    const result = run(
      [scenario("s", [a], [read(true, "Welcome Ada")], { objective: "a" })],
      [scenario("s", [a], [read(false, "Hello Ada")], { objective: "a" })]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(result.scenarios[0]?.diagnostic).toBeUndefined();
    expect(result.baselineComparison?.changes).toHaveLength(1);
    expect(result.baselineComparison?.notDiscriminating).toEqual([]);
    expect(statusDescription(result)).toBe(
      "QA passed: 1/1 scenarios · 1 behavior change vs base 7427180, see report"
    );
  });

  it("une cible absente sur la base est un comportement modifié, rendu « cible absente »", () => {
    const a = text("a", "Export CSV");
    const result = run(
      [scenario("s", [a], [read(true, "Export CSV")], { objective: "a" })],
      [
        scenario("s", [a], [read(false, undefined)], {
          objective: "a",
          code: "TARGET_NOT_FOUND",
        }),
      ]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(result.baselineComparison?.changes[0]?.base).toEqual({
      passed: false,
    });
    expect(reportMarkdown(result, undefined, true)).toContain(
      "main : cible absente (échoue) → PR : « Export CSV » (passe)"
    );
  });

  it("verte des deux côtés à valeur identique : l'objectif n'est pas prouvé", () => {
    const a = text("a", "Pilotage");
    const result = run(
      [scenario("s", [a], [read(true, "Pilotage")], { objective: "a" })],
      [scenario("s", [a], [read(true, "Pilotage")], { objective: "a" })]
    );
    compareWithBaseline(result, CONFIG);
    const head = result.scenarios[0]!;
    expect(head.outcome).toBe("blocked");
    expect(head.classification).toBe("test-defect");
    expect(head.diagnostic?.code).toBe("OBJECTIVE_NOT_DISCRIMINATING");
    expect(head.error).toContain("objective assertion a also passes");
    expect(result.baselineComparison?.changes).toEqual([]);
    expect(result.baselineComparison?.notDiscriminating).toHaveLength(1);
  });

  it("des blancs différents ne sont pas une valeur différente (repli de l'exécuteur)", () => {
    const a = text("a", "Pilotage");
    const result = run(
      [scenario("s", [a], [read(true, "Pilotage\n  du jour")])],
      [scenario("s", [a], [read(true, " Pilotage du jour ")])]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.baselineComparison?.changes).toEqual([]);
    expect(result.scenarios[0]?.diagnostic?.code).toBe(
      "OBJECTIVE_NOT_DISCRIMINATING"
    );
  });

  it("une assertion non objectif qui passe aussi sur la base ne bloque pas un objectif discriminant", () => {
    const proof = text("proof", "Welcome Ada");
    const stable = text("stable", "Name");
    const result = run(
      [
        scenario(
          "s",
          [stable, proof],
          [read(true, "Name", "stable"), read(true, "Welcome Ada", "proof")],
          { objective: "proof" }
        ),
      ],
      [
        scenario(
          "s",
          [stable, proof],
          [read(true, "Name", "stable"), read(false, "Hello Ada", "proof")],
          { objective: "proof" }
        ),
      ]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(
      result.baselineComparison?.notDiscriminating.map(
        (item) => item.assertionId
      )
    ).toEqual(["stable"]);
  });

  it("un objectif qui passe aussi sur la base n'est pas sauvé par une autre assertion", () => {
    const proof = text("proof", "Pilotage");
    const other = text("other", "Welcome Ada");
    const result = run(
      [
        scenario(
          "s",
          [proof, other],
          [read(true, "Pilotage", "proof"), read(true, "Welcome Ada", "other")],
          { objective: "proof" }
        ),
      ],
      [
        scenario(
          "s",
          [proof, other],
          [read(true, "Pilotage", "proof"), read(false, "Hello Ada", "other")],
          { objective: "proof" }
        ),
      ]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.diagnostic?.code).toBe(
      "OBJECTIVE_NOT_DISCRIMINATING"
    );
  });

  it("un scénario déjà non vert garde sa cause", () => {
    const a = text("a", "Pilotage");
    const result = run(
      [
        scenario("s", [a], [read(true, "Pilotage")], {
          outcome: "blocked",
          code: "CONTRACT_INCOMPLETE",
        }),
      ],
      [scenario("s", [a], [read(true, "Pilotage")])]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.outcome).toBe("blocked");
    expect(result.scenarios[0]?.diagnostic?.code).toBe("CONTRACT_INCOMPLETE");
    expect(result.baselineComparison?.notDiscriminating).toHaveLength(1);
  });

  it("sans objectif déclaré, toutes les assertions forment la preuve", () => {
    const one = text("one", "A");
    const two = text("two", "B");
    const both = (twoOnBase: boolean) =>
      run(
        [
          scenario(
            "s",
            [one, two],
            [read(true, "A", "one"), read(true, "B", "two")]
          ),
        ],
        [
          scenario(
            "s",
            [one, two],
            [read(true, "A", "one"), read(twoOnBase, "C", "two")]
          ),
        ]
      );
    const blocked = both(true);
    compareWithBaseline(blocked, CONFIG);
    // `two` lit « C » sur la base et passe pourtant (l'attendu est inclus) :
    // valeur modifiée, assertion non discriminante — les deux sont publiés.
    expect(blocked.scenarios[0]?.diagnostic?.code).toBe(
      "OBJECTIVE_NOT_DISCRIMINATING"
    );
    expect(blocked.scenarios[0]?.error).toContain("(one, two)");
    expect(
      blocked.baselineComparison?.changes.map((item) => item.assertionId)
    ).toEqual(["two"]);
    const proven = both(false);
    compareWithBaseline(proven, CONFIG);
    expect(proven.scenarios[0]?.outcome).toBe("passed");
  });

  it("rouge des deux côtés : non concluant, le verdict de tête est intact", () => {
    const a = text("a", "Total 10");
    const result = run(
      [
        scenario("s", [a], [read(false, "Total 9")], {
          code: "QA_ASSERTION",
          error: "Assertion a failed",
        }),
      ],
      [scenario("s", [a], [read(false, "Total 8")])]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.outcome).toBe("failed");
    expect(result.scenarios[0]?.diagnostic?.code).toBe("QA_ASSERTION");
    expect(result.baselineComparison?.inconclusive[0]?.reason).toBe(
      "fails on both the head and the base"
    );
  });

  it("une base non exécutable est non concluante, jamais un vert ni un rouge", () => {
    const a = text("a", "Welcome Ada");
    const head = () => [
      scenario("s", [a], [read(true, "Welcome Ada")], { objective: "a" }),
    ];
    const cases: [ScenarioResult[], string][] = [
      [[], "scenario not executed on the base"],
      [
        [
          scenario("s", [a], [], {
            objective: "a",
            outcome: "blocked",
            code: "PREVIEW_SHA_MISMATCH",
          }),
        ],
        "not executed on the base (PREVIEW_SHA_MISMATCH)",
      ],
      [
        [
          scenario("s", [a], [read(true, "Welcome Ada")], {
            objective: "a",
            hash: "other",
          }),
        ],
        "the base played a different contract",
      ],
    ];
    for (const [base, reason] of cases) {
      const result = run(head(), base);
      compareWithBaseline(result, CONFIG);
      expect(result.scenarios[0]?.outcome, reason).toBe("passed");
      expect(result.baselineComparison?.inconclusive[0]?.reason).toBe(reason);
      expect(statusDescription(result), reason).toContain(
        "1 inconclusive comparison vs base 7427180"
      );
    }
  });

  it("une tête qui montre déjà l'attendu ne devient pas une régression", () => {
    const a = text("a", "Session clôturée");
    const result = run(
      [
        scenario("s", [a], [read(false, "Session clôturée")], {
          outcome: "blocked",
          code: "STATE_ALREADY_SATISFIED",
        }),
      ],
      [scenario("s", [a], [read(true, "Session clôturée")])]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.outcome).toBe("blocked");
    expect(result.scenarios[0]?.diagnostic?.code).toBe(
      "STATE_ALREADY_SATISFIED"
    );
    expect(result.baselineComparison?.regressions).toEqual([]);
    expect(result.baselineComparison?.inconclusive[0]?.reason).toContain(
      "STATE_ALREADY_SATISFIED"
    );
  });

  it("une base indisponible est publiée, et le verdict reste celui de la tête", () => {
    const a = text("a", "Pilotage");
    // La base a bien joué (à l'identique) : sans SHA prouvé, rien n'en est lu.
    const result = run(
      [scenario("s", [a], [read(true, "Pilotage")], { objective: "a" })],
      [scenario("s", [a], [read(true, "Pilotage")], { objective: "a" })]
    );
    result.baseline!.diagnostic = {
      code: "PREVIEW_SHA_MISMATCH",
      message: "Preview SHA mismatch or missing provenance",
      hint: "",
    };
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(result.baselineComparison).toMatchObject({
      status: "unavailable",
      diagnostic: { code: "PREVIEW_SHA_MISMATCH" },
      changes: [],
      regressions: [],
      notDiscriminating: [],
      inconclusive: [],
    });
    expect(statusDescription(result)).toBe(
      "QA passed: 1/1 scenarios · base 7427180 comparison unavailable"
    );
    expect(reportMarkdown(result)).toContain(
      "### Comparaison à main indisponible (base 7427180)"
    );
  });

  it("sans préversion de base, rien ne change", () => {
    const a = text("a", "Pilotage");
    const result = run(
      [scenario("s", [a], [read(true, "Pilotage")], { objective: "a" })],
      undefined
    );
    const before = reportMarkdown(result);
    compareWithBaseline(result, CONFIG);
    expect(result.baselineComparison).toBeUndefined();
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(reportMarkdown(result)).toBe(before);
    expect(statusDescription(result)).toBe("QA passed: 1/1 scenarios");
  });
});

describe("PR 21 : l'inversion de signe devient visible", () => {
  /** L'assertion du plan réel (run 0b9b7fa2), qui attendait la valeur du bug. */
  const planned = text("message-ecart", "Écart de 40,00");
  const HEAD = "Écart de 40,00 €";
  const BASE = "Écart de -40,00 €";

  it("l'attendu du bug passe sur la tête, échoue sur la base : listé en tête du rapport", () => {
    // Les drapeaux viennent de la sémantique réelle de l'exécuteur (inclusion).
    const headPassed = assertionMatches(planned, HEAD);
    const basePassed = assertionMatches(planned, BASE);
    expect([headPassed, basePassed]).toEqual([true, false]);
    const result = run(
      [
        scenario(
          "ecart",
          [planned],
          [read(headPassed, HEAD, "message-ecart")],
          {
            objective: "message-ecart",
          }
        ),
      ],
      [
        scenario(
          "ecart",
          [planned],
          [read(basePassed, BASE, "message-ecart")],
          {
            objective: "message-ecart",
          }
        ),
      ]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.outcome).toBe("passed");
    const privateReport = reportMarkdown(result, undefined, true);
    expect(privateReport).toContain(
      "### Comportements modifiés par rapport à main (base 7427180)"
    );
    expect(privateReport).toContain(
      "- ecart · message-ecart [objectif] (attendu « Écart de 40,00 ») : main : « Écart de -40,00 € » (échoue) → PR : « Écart de 40,00 € » (passe)"
    );
    // En tête : avant le modèle, la preview et le tableau des scénarios.
    expect(privateReport.indexOf("Comportements modifiés")).toBeLessThan(
      privateReport.indexOf("Model:")
    );
    const published = reportMarkdown(result);
    expect(published).toContain(
      "- ecart · message-ecart [objectif] (attendu « Écart de 40,00 ») : main : échoue → PR : passe"
    );
    expect(published).not.toContain(BASE);
    expect(statusDescription(result)).toContain("1 behavior change vs base");
  });

  it("un attendu qui accepte les deux signes passe des deux côtés : modifié ET non prouvé", () => {
    const loose = text("message-ecart", "40,00 €");
    const result = run(
      [
        scenario(
          "ecart",
          [loose],
          [read(assertionMatches(loose, HEAD), HEAD, "message-ecart")],
          { objective: "message-ecart" }
        ),
      ],
      [
        scenario(
          "ecart",
          [loose],
          [read(assertionMatches(loose, BASE), BASE, "message-ecart")],
          { objective: "message-ecart" }
        ),
      ]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.diagnostic?.code).toBe(
      "OBJECTIVE_NOT_DISCRIMINATING"
    );
    expect(result.baselineComparison?.changes).toHaveLength(1);
    expect(reportMarkdown(result, undefined, true)).toContain(
      "main : « Écart de -40,00 € » (passe) → PR : « Écart de 40,00 € » (passe)"
    );
  });
});
