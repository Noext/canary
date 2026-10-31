import { describe, expect, it } from "vitest";
import { declaresNoBehaviorChange } from "../src/baseline-classify.js";
import { compareWithBaseline } from "../src/baseline-diff.js";
import { assertionMatches } from "../src/canary.js";
import { commitStatus } from "../src/commit-status.js";
import type { Config } from "../src/config.js";
import { PLANNER_PROMPT } from "../src/model.js";
import { judgeAgainstBaseline, reportMarkdown } from "../src/report.js";
import type { Assertion, RunResult, ScenarioResult } from "../src/schema.js";

const statusDescription = (result: Parameters<typeof commitStatus>[0]) =>
  commitStatus(result).description;

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
    kind?: string;
    preconditions?: string[];
    steps?: ScenarioResult["steps"];
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
      kind: options.kind ?? "happy_path",
      objective: options.objective,
      assertions,
      preconditions: options.preconditions ?? [],
      steps: [],
    } as unknown as ScenarioResult["scenario"],
    outcome,
    steps: options.steps ?? [],
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

  it.each([
    "STATE_ALREADY_SATISFIED",
    "TRANSITION_ON_INVARIANT",
  ])("une tête qui montre déjà l'attendu ne devient pas une régression (%s)", (code) => {
    const a = text("a", "Session clôturée");
    const result = run(
      [
        scenario("s", [a], [read(false, "Session clôturée")], {
          outcome: "blocked",
          code,
        }),
      ],
      [scenario("s", [a], [read(true, "Session clôturée")])]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.outcome).toBe("blocked");
    expect(result.scenarios[0]?.diagnostic?.code).toBe(code);
    expect(result.baselineComparison?.regressions).toEqual([]);
    expect(result.baselineComparison?.inconclusive[0]?.reason).toContain(code);
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

describe("ce que la base ne peut pas trancher", () => {
  const saved = text("a", "saved");

  it.each([
    "STATE_ALREADY_SATISFIED",
    "TRANSITION_ON_INVARIANT",
  ])("une base qui montrait déjà l'attendu n'est pas un comportement modifié (%s)", (code) => {
    // La base est un environnement persistant que chaque run écrit : « déjà
    // enregistré » avant le clic y est l'état normal, pas un changement de code.
    const result = run(
      [scenario("s", [saved], [read(true, "saved")], { objective: "a" })],
      [
        // Une autre valeur qui satisfait aussi l'attendu (inclusion) : seul le
        // code dit que la base l'affichait déjà avant l'étape.
        scenario("s", [saved], [read(false, "Already saved")], {
          objective: "a",
          outcome: "blocked",
          code,
        }),
      ]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.baselineComparison?.changes).toEqual([]);
    expect(result.baselineComparison?.notDiscriminating).toEqual([]);
    expect(result.baselineComparison?.inconclusive[0]?.reason).toBe(
      `the base value already satisfied the expectation; only its verification failed on the base (${code})`
    );
    // Jamais converti en vert ni en rouge : la tête garde son verdict, et le
    // statut ne parle pas d'un changement entre deux valeurs identiques.
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(statusDescription(result)).not.toContain("behavior change");
    expect(statusDescription(result)).toContain("1 inconclusive comparison");
  });

  it("une base qui échoue sur la même valeur que la tête est non concluante, pas un changement", () => {
    // Même lecture des deux côtés : seule la vérification (point de départ,
    // sonde d'avant) a échoué sur la base.
    const result = run(
      [scenario("s", [saved], [read(true, "saved")], { objective: "a" })],
      [
        scenario("s", [saved], [read(false, "saved  ")], {
          objective: "a",
          code: "TRANSITION_NOT_OBSERVED",
        }),
      ]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.baselineComparison?.changes).toEqual([]);
    expect(result.baselineComparison?.inconclusive[0]?.reason).toBe(
      "the base shows the same value as the head; only its verification failed on the base (TRANSITION_NOT_OBSERVED)"
    );
  });

  it("une persistance que la base perd reste un comportement modifié, même valeur avant rechargement", () => {
    const kept = {
      ...text("a", "saved"),
      verification: "persisted",
    } as Assertion;
    const result = run(
      [
        scenario(
          "s",
          [kept],
          [{ id: "a", passed: true, actual: "saved", persisted: "saved" }],
          { objective: "a" }
        ),
      ],
      [
        scenario(
          "s",
          [kept],
          [{ id: "a", passed: false, actual: "saved", persisted: "draft" }],
          { objective: "a" }
        ),
      ]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.baselineComparison?.changes).toHaveLength(1);
    expect(result.baselineComparison?.inconclusive).toEqual([]);
    expect(result.scenarios[0]?.outcome).toBe("passed");
  });

  it("une valeur déjà en place avant l'étape, sans code, ne tranche pas non plus", () => {
    const head = scenario(
      "s",
      [saved],
      [{ id: "a", passed: false, actual: "saved", preMatched: true }],
      { error: "Assertion a failed" }
    );
    const result = run([head], [scenario("s", [saved], [read(true, "saved")])]);
    compareWithBaseline(result, CONFIG);
    expect(result.baselineComparison?.regressions).toEqual([]);
    expect(head.diagnostic).toBeUndefined();
    expect(result.baselineComparison?.inconclusive[0]?.reason).toContain(
      "value already satisfied before the step"
    );
  });

  it("une cible substituée, d'un côté ou de l'autre, n'est pas le même contrat", () => {
    // Le hash du contrat est celui du plan d'origine : il ne voit pas une
    // reprise de cible. Une base qui a passé en cliquant autre chose ne peut
    // pas rendre la tête rouge.
    for (const repairedOn of ["base", "head"] as const) {
      const repaired = [
        {
          action: {
            type: "click",
            locator: { by: "role", value: "button", name: "Save" },
          },
          index: 2,
          ok: true,
          reason: "",
          observation: "",
          stepId: "save",
          repairedTarget: `button "${SENTINEL}"`,
        },
      ] as ScenarioResult["steps"];
      const head = scenario("s", [saved], [read(false, "Total 9")], {
        objective: "a",
        ...(repairedOn === "head" ? { steps: repaired } : {}),
      });
      const result = run(
        [head],
        [
          scenario("s", [saved], [read(true, "saved")], {
            objective: "a",
            ...(repairedOn === "base" ? { steps: repaired } : {}),
          }),
        ]
      );
      compareWithBaseline(result, CONFIG);
      expect(head.outcome, repairedOn).toBe("failed");
      expect(head.diagnostic, repairedOn).toBeUndefined();
      expect(result.baselineComparison?.regressions, repairedOn).toEqual([]);
      const reason = result.baselineComparison?.inconclusive[0]?.reason;
      expect(reason, repairedOn).toBe(
        `the ${repairedOn} played a substituted target at step save, not the planned one`
      );
      // La cible jouée vient de la page : elle ne gagne aucune surface publiée.
      expect(reportMarkdown(result), repairedOn).not.toContain(SENTINEL);
    }
  });

  it("des points de départ différents n'accusent pas la PR d'une régression", () => {
    const step = (passed: boolean, actual: string, baseline: string) => ({
      id: "a",
      passed,
      actual,
      baseline,
      changed: actual !== baseline,
      verification: "transition" as const,
    });
    // Un état laissé sur la tête par un run antérieur : la bascule part de
    // « saved » sur la tête et de « draft » sur la base.
    const drifted = run(
      [scenario("s", [saved], [step(false, "draft", "saved")])],
      [scenario("s", [saved], [step(true, "saved", "draft")])]
    );
    compareWithBaseline(drifted, CONFIG);
    expect(drifted.scenarios[0]?.diagnostic).toBeUndefined();
    expect(drifted.baselineComparison?.regressions).toEqual([]);
    expect(drifted.baselineComparison?.inconclusive[0]?.reason).toContain(
      "different starting state"
    );
    // Même point de départ : la base prouve que la PR casse la bascule.
    const same = run(
      [scenario("s", [saved], [step(false, "error", "draft")])],
      [scenario("s", [saved], [step(true, "saved", "draft")])]
    );
    compareWithBaseline(same, CONFIG);
    expect(same.scenarios[0]?.diagnostic?.code).toBe("BASELINE_REGRESSION");
  });

  it("une tête arrêtée avant l'assertion que la base a passée le dit, et garde son verdict", () => {
    const head = scenario("s", [saved], [], {
      objective: "a",
      outcome: "blocked",
      code: "TARGET_NOT_FOUND",
    });
    head.classification = "test-defect";
    const result = run(
      [head],
      [scenario("s", [saved], [read(true, "saved")], { objective: "a" })]
    );
    compareWithBaseline(result, CONFIG);
    expect(head.outcome).toBe("blocked");
    expect(head.classification).toBe("test-defect");
    expect(head.diagnostic?.code).toBe("TARGET_NOT_FOUND");
    expect(result.baselineComparison?.inconclusive).toEqual([
      {
        scenarioId: "s",
        assertionId: "a",
        objective: true,
        expected: "saved",
        base: { passed: true, actual: "saved" },
        reason:
          "the head stopped before this assertion (TARGET_NOT_FOUND) while the base played the same contract and passed it: the PR may have removed or renamed what the plan uses",
      },
    ]);
    // Une base qui a échoué ailleurs ne dit rien de plus.
    const both = run(
      [scenario("s", [saved], [], { outcome: "blocked", code: "QA_ERROR" })],
      [
        scenario(
          "s",
          [saved, text("b", "x")],
          [read(true, "saved"), read(false, "y", "b")]
        ),
      ]
    );
    (both.scenarios[0]!.scenario.assertions as Assertion[]).push(
      text("b", "x")
    );
    compareWithBaseline(both, CONFIG);
    expect(
      both.baselineComparison?.inconclusive.map((item) => item.reason)
    ).toContain("not executed on the head");
  });

  it("une régression rend rouge une tête qui était bloquée pour une autre cause", () => {
    const head = scenario("s", [saved], [read(false, "draft")], {
      outcome: "blocked",
      code: "QA_ERROR",
      error: "Evidence finalization: disk full",
    });
    head.classification = "indeterminate";
    const result = run([head], [scenario("s", [saved], [read(true, "saved")])]);
    compareWithBaseline(result, CONFIG);
    expect(head.outcome).toBe("failed");
    expect(head.classification).toBe("failed");
    expect(head.diagnostic?.code).toBe("BASELINE_REGRESSION");
    expect(head.error).toContain("head: Evidence finalization: disk full");
  });

  it("un scénario à fixtures n'est pas rejoué sur la base, et le dit", () => {
    const result = run(
      [
        scenario("s", [saved], [read(true, "saved")], {
          objective: "a",
          preconditions: ["fixture:cash-session"],
        }),
      ],
      []
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(result.baselineComparison?.inconclusive[0]?.reason).toBe(
      "scenario not replayed on the base: its fixtures are seeded for the head environment only"
    );
  });
});

describe("un scénario `regression` déclare un comportement inchangé", () => {
  // PR 21 mesurée (run réel) : le planificateur a pris le nouveau code pour la
  // vérité et attendait « Écart de 240,00 » ; la tête passe, la base affiche
  // « Écart de -240,00 € » et échoue. Le scénario se dit de non-régression.
  const view = (value: string) =>
    `Caisse et Coffre · DEMO17 ${"Coupures et pièces ".repeat(30)}Écart de ${value} : une justification écrite est obligatoire avant clôture.`;
  const a = text("a", "Écart de 240,00");
  const pr21 = (kind: string) =>
    run(
      [
        scenario("s", [a], [read(true, view("240,00 €"))], {
          kind,
          objective: "a",
        }),
      ],
      [
        scenario("s", [a], [read(false, view("-240,00 €"))], {
          kind,
          objective: "a",
        }),
      ]
    );

  it("une autre valeur que la base est une régression, quel que soit l'attendu", () => {
    const result = pr21("regression");
    compareWithBaseline(result, CONFIG);
    const head = result.scenarios[0]!;
    expect(head.outcome).toBe("failed");
    expect(head.diagnostic?.code).toBe("BASELINE_REGRESSION");
    expect(head.error).toContain("declares unchanged");
    expect(result.baselineComparison?.regressions).toHaveLength(1);
  });

  it("hors `regression`, le même écart reste un comportement modifié listé", () => {
    const result = pr21("happy_path");
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]!.outcome).toBe("passed");
    expect(result.baselineComparison?.regressions).toHaveLength(0);
    expect(result.baselineComparison?.changes).toHaveLength(1);
  });

  it("vert des deux côtés, un scénario `regression` reste vert : c'est sa preuve", () => {
    const same = text("a", "Comptage juste");
    const result = run(
      [
        scenario("s", [same], [read(true, "Comptage juste")], {
          kind: "regression",
          objective: "a",
        }),
      ],
      [
        scenario("s", [same], [read(true, "Comptage juste")], {
          kind: "regression",
          objective: "a",
        }),
      ]
    );
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]!.outcome).toBe("passed");
    expect(result.scenarios[0]!.diagnostic).toBeUndefined();
  });

  it("le rapport montre l'endroit où les deux lectures diffèrent, pas leur début", () => {
    const result = pr21("happy_path");
    compareWithBaseline(result, CONFIG);
    const report = reportMarkdown(result, undefined, true);
    expect(report).toContain("Écart de -240,00 €");
    expect(report).toContain("Écart de 240,00 €");
  });
});

it("le prompt énonce le contrat d'un scénario `regression` jugé contre la base", () => {
  expect(PLANNER_PROMPT).toContain(
    "A regression scenario checks behavior the diff must NOT change: its expected values are the base behavior"
  );
  expect(PLANNER_PROMPT).toContain(
    "a scenario that checks a value the diff intends to change is a happy_path or edge_case, never a regression"
  );
});

describe("une PR `refactor` déclare un comportement inchangé", () => {
  it("lit le titre Conventional Commits, sans la rupture `!`", () => {
    expect(
      declaresNoBehaviorChange(
        "refactor(domain): catalogue des espèces scindé en billets et pièces"
      )
    ).toBe(true);
    expect(declaresNoBehaviorChange("refactor: extraire un helper")).toBe(true);
    expect(declaresNoBehaviorChange("refactor!: nouvelle API")).toBe(false);
    expect(declaresNoBehaviorChange("refactor(api)!: nouvelle API")).toBe(
      false
    );
    expect(declaresNoBehaviorChange("feat(caisse): sous-totaux")).toBe(false);
    expect(declaresNoBehaviorChange("fix: refactor du calcul")).toBe(false);
    // Non mesurés : ni `chore`, ni `perf`, ni `style` ne déclarent l'invariance.
    expect(declaresNoBehaviorChange("chore: ranger")).toBe(false);
    expect(declaresNoBehaviorChange("perf: mémoïser")).toBe(false);
    expect(declaresNoBehaviorChange("style: formater")).toBe(false);
    expect(declaresNoBehaviorChange(undefined)).toBe(false);
  });

  // Banc du 31/10/2026, r6-2 : un scénario `edge_case` épingle « 25,00 € » pour
  // un billet de 20 €, la base affiche « 20,00 € » ; lu comme un changement
  // voulu, il passait vert.
  const a = text("a", "25,00 €");
  const twenty = () =>
    run(
      [
        scenario("s", [a], [read(true, "Billet de 20 € 25,00 €")], {
          objective: "a",
          kind: "edge_case",
        }),
      ],
      [
        scenario("s", [a], [read(false, "Billet de 20 € 20,00 €")], {
          objective: "a",
          kind: "edge_case",
        }),
      ]
    );

  it("une valeur que la base ne montre pas est une régression, quel que soit le libellé", () => {
    const result = twenty();
    judgeAgainstBaseline(
      result,
      CONFIG,
      "refactor(domain): catalogue des espèces scindé en billets et pièces"
    );
    const head = result.scenarios[0]!;
    expect(head.outcome).toBe("failed");
    expect(head.diagnostic?.code).toBe("BASELINE_REGRESSION");
    // Le rapport dit pourquoi : le titre `refactor` déclare l'invariance.
    expect(head.error).toContain("declares no behavior change");
    expect(result.baselineComparison?.regressions).toHaveLength(1);
    expect(result.baselineComparison?.regressions[0]?.reason).toContain(
      "declares no behavior change"
    );
    expect(reportMarkdown(result, undefined, true)).toContain(
      "the PR title declares a refactor, which declares no behavior change"
    );
  });

  it("sans déclaration, le même écart reste un comportement modifié", () => {
    const result = twenty();
    compareWithBaseline(result, CONFIG);
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(result.baselineComparison?.regressions).toEqual([]);
    expect(result.baselineComparison?.changes).toHaveLength(1);
  });

  it("un titre `feat` laisse une tête verte différente de la base en changement", () => {
    const result = twenty();
    judgeAgainstBaseline(result, CONFIG, "feat(caisse): billet de 20 €");
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(result.scenarios[0]?.diagnostic).toBeUndefined();
    expect(result.baselineComparison?.regressions).toEqual([]);
    expect(result.baselineComparison?.changes).toHaveLength(1);
    expect(result.baselineComparison?.changes[0]?.reason).toBeUndefined();
  });

  it("ne lève pas le blocage d'une preuve qui passe aussi sur la base", () => {
    const b = text("b", "225,00 €");
    const result = run(
      [
        scenario("s", [b], [read(true, "Total 225,00 €", "b")], {
          objective: "b",
        }),
      ],
      [
        scenario("s", [b], [read(true, "Total 225,00 €", "b")], {
          objective: "b",
        }),
      ]
    );
    judgeAgainstBaseline(result, CONFIG, "refactor: extraire un helper");
    expect(result.scenarios[0]?.outcome).toBe("blocked");
    expect(result.scenarios[0]?.diagnostic?.code).toBe(
      "OBJECTIVE_NOT_DISCRIMINATING"
    );
  });
});
