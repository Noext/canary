import { describe, expect, it } from "vitest";
import { reportMarkdown } from "../src/report.js";
import type { RunResult, ScenarioResult } from "../src/schema.js";

function result(assertions: ScenarioResult["assertions"]): RunResult {
  return {
    endedAt: "2026-10-26T00:00:00.000Z",
    id: "run",
    outcome: "passed",
    prUrl: "https://github.com/o/r/pull/1",
    scenarios: [
      {
        artifacts: [],
        assertions,
        outcome: "passed",
        scenario: {
          assertions,
          id: "s1",
          kind: "regression",
          title: "un scénario",
        } as unknown as ScenarioResult["scenario"],
        steps: [],
      },
    ],
    startedAt: "2026-10-26T00:00:00.000Z",
  } as RunResult;
}

describe("le rapport dit ce qu'une assertion ne prouve pas", () => {
  it("compte les assertions déjà satisfaites avant leur étape", () => {
    // Sans cette ligne, un lecteur du commentaire de PR croit que chaque
    // assertion prouve l'effet de sa propre étape. L'héritage d'état reste
    // possible : il est publié, jamais requalifié.
    const markdown = reportMarkdown(
      result([
        { actual: true, id: "a1", passed: true, preMatched: true },
        { actual: true, id: "a2", passed: true },
      ])
    );
    expect(markdown).toContain(
      "1 assertion(s) already satisfied before their step"
    );
    expect(markdown).toContain("not that the step produced it");
  });

  it("ne dit rien quand aucune assertion n'était déjà satisfaite", () => {
    const markdown = reportMarkdown(
      result([{ actual: true, id: "a1", passed: true }])
    );
    expect(markdown).not.toContain("already satisfied before their step");
  });
});
