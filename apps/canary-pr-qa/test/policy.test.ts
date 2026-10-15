import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import {
  isDocumentationPath,
  PolicySchema,
  undeclaredSourcePlanRefusals,
  unwitnessedPlanRefusals,
  validateCoverage,
} from "../src/policy.js";
import { type Plan, PlanSchema } from "../src/schema.js";

const context: PrContext = {
  baseSha: "2".repeat(40),
  body: "",
  context: [],
  contextWarnings: [],
  files: [],
  headRepo: "fixture/app",
  ref: parsePrUrl("https://github.com/fixture/app/pull/1"),
  sha: "1".repeat(40),
  title: "",
};
const config = loadConfig({});

function planSkipping(...files: string[]): Plan {
  return {
    summary: "Changed files reviewed against the browser contract",
    scenarios: [],
    skipped: files.map((sourceFile) => ({
      sourceFile,
      reason: "Not reachable from a browser scenario",
    })),
  };
}
function policyFor(approvedSkips: { path: string; reason: string }[] = []) {
  return PolicySchema.parse({ version: 1, approvedSkips });
}
function refusalOfPlan(
  plan: Plan,
  scenarioContext: PrContext,
  policy: ReturnType<typeof policyFor>
): QaError {
  try {
    validateCoverage(plan, scenarioContext, policy, config);
  } catch (error) {
    if (error instanceof QaError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the coverage gate to refuse the plan");
}
function refusalOf(
  policy: ReturnType<typeof policyFor>,
  ...files: string[]
): QaError {
  return refusalOfPlan(planSkipping(...files), context, policy);
}
/**
 * Un contexte dont les patches portent les citations témoins : le contrôle de
 * couverture ne lit un témoin que dans le diff du fichier cité.
 */
function contextWith(files: { filename: string; patch: string }[]): PrContext {
  return {
    ...context,
    files: files.map((file) => ({ status: "modified", ...file })),
  };
}
function planWithWitnesses(
  scenarios: {
    id: string;
    sourceFiles: string[];
    requirements: { sourceFile: string; quote: string }[];
  }[]
): Plan {
  return PlanSchema.parse({
    summary: "Coverage witness fixture",
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      title: "Coverage witness fixture",
      rationale: "Exercise the coverage witness gate",
      kind: "happy_path",
      sourceFiles: scenario.sourceFiles,
      preconditions: [],
      requirements: scenario.requirements.map((requirement) => ({
        ...requirement,
        behavior: "Changed behavior under review",
      })),
      steps: [
        {
          id: "observe",
          description: "Observe the page",
          action: { type: "observe" },
        },
        {
          id: "check",
          description: "Check the changed output",
          action: { type: "assert", assertionId: "seen" },
        },
      ],
      assertions: [
        {
          afterStep: "observe",
          description: "The changed output is visible",
          id: "seen",
          kind: "visible",
          target: { by: "css", value: "#seen" },
          verification: "state",
        },
      ],
    })),
    skipped: [],
  });
}
const witnessContext = contextWith([
  { filename: "src/a.ts", patch: "+ const alpha = 'Alpha witness text';" },
  { filename: "src/b.ts", patch: "+ const beta = 'Beta witness text';" },
]);

it("accepts a plan whose declared files each carry a witnessed requirement", () => {
  expect(
    unwitnessedPlanRefusals(
      planWithWitnesses([
        {
          id: "flow",
          sourceFiles: ["src/a.ts"],
          requirements: [
            { sourceFile: "src/a.ts", quote: "Alpha witness text" },
          ],
        },
      ]),
      witnessContext,
      policyFor()
    )
  ).toEqual([]);
});

it("never proposes a skip the coverage gate would refuse", () => {
  // src/b.ts is a critical path: dropping it from sourceFiles would be refused
  // by the gate, so the refusal must not propose it.
  const critical = unwitnessedPlanRefusals(
    planWithWitnesses([
      {
        id: "flow",
        sourceFiles: ["src/b.ts"],
        requirements: [{ sourceFile: "src/b.ts", quote: "Alpha witness text" }],
      },
    ]),
    witnessContext,
    policyFor()
  );
  expect(critical).toHaveLength(1);
  expect(critical[0]).not.toContain("list it in skipped");
  expect(critical[0]).toContain("cannot be dropped from sourceFiles");
  // lib/helper.ts is not critical: the same remedy is accepted by the gate, so
  // the refusal may propose it, and that promise holds.
  const skippable = unwitnessedPlanRefusals(
    planWithWitnesses([
      {
        id: "flow",
        sourceFiles: ["lib/helper.ts"],
        requirements: [
          { sourceFile: "lib/helper.ts", quote: "Alpha witness text" },
        ],
      },
    ]),
    witnessContext,
    policyFor()
  );
  expect(skippable).toHaveLength(1);
  expect(skippable[0]).toContain(
    "drop it from sourceFiles and list it in skipped"
  );
  expect(() =>
    validateCoverage(
      planSkipping("lib/helper.ts"),
      witnessContext,
      policyFor(),
      config
    )
  ).not.toThrow();
});

it("names the scenario and the file it cannot witness", () => {
  const refusals = unwitnessedPlanRefusals(
    planWithWitnesses([
      {
        id: "flow",
        sourceFiles: ["src/a.ts", "src/b.ts"],
        requirements: [{ sourceFile: "src/a.ts", quote: "Alpha witness text" }],
      },
    ]),
    witnessContext,
    policyFor()
  );
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toContain("Scenario flow");
  expect(refusals[0]).toContain("src/b.ts");
});

it("accumulates witnesses across scenarios exactly like the coverage gate", () => {
  const declaring = {
    id: "declaring",
    sourceFiles: ["src/a.ts", "src/b.ts"],
    requirements: [{ sourceFile: "src/b.ts", quote: "Beta witness text" }],
  };
  const witnessing = {
    id: "witnessing",
    sourceFiles: ["src/a.ts"],
    requirements: [{ sourceFile: "src/a.ts", quote: "Alpha witness text" }],
  };
  // Le premier scénario déclare src/a.ts, témoigné seulement par le second : le
  // couvert est cumulatif, donc le gate refuse ce fichier et le refus au
  // planificateur le nomme, comme `validateCoverage`.
  const refused = unwitnessedPlanRefusals(
    planWithWitnesses([declaring, witnessing]),
    witnessContext,
    policyFor()
  );
  expect(refused).toHaveLength(1);
  expect(refused[0]).toContain("Scenario declaring");
  expect(refused[0]).toContain("src/a.ts");
  const refusal = refusalOfPlan(
    planWithWitnesses([declaring, witnessing]),
    witnessContext,
    policyFor()
  );
  expect(refusal.code).toBe("COVERAGE_WITNESS_MISSING");
  expect(refusal.message).toBe(
    "Scenario declaring declares src/a.ts without a source requirement witness"
  );
  // Témoin déclaré avant usage : le même plan passe et le refus disparaît.
  expect(
    unwitnessedPlanRefusals(
      planWithWitnesses([witnessing, declaring]),
      witnessContext,
      policyFor()
    )
  ).toEqual([]);
  expect(
    validateCoverage(
      planWithWitnesses([witnessing, declaring]),
      witnessContext,
      policyFor(),
      config
    ).gate
  ).toBe("complete");
});

it("names the scenario and the undeclared source file of a requirement", () => {
  const plan = planWithWitnesses([
    {
      id: "flow",
      sourceFiles: ["src/a.ts"],
      requirements: [
        { sourceFile: "src/a.ts", quote: "Alpha witness text" },
        { sourceFile: "src/decoy.ts", quote: "Alpha witness text" },
      ],
    },
  ]);
  const refusals = undeclaredSourcePlanRefusals(plan, witnessContext);
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toContain(
    "Scenario flow attributes a requirement to src/decoy.ts, which it does not declare in sourceFiles"
  );
  expect(refusals[0]).toContain(
    "This PR does not change src/decoy.ts, so it cannot be declared: attribute the requirement to one of the files the scenario declares (src/a.ts)."
  );
  const refusal = refusalOfPlan(plan, witnessContext, policyFor());
  expect(refusal.code).toBe("COVERAGE_REQUIREMENT_SOURCE_MISSING");
  expect(refusal.message).toBe(
    "Scenario flow attributes a requirement to src/decoy.ts, which it does not declare in sourceFiles"
  );
  expect(refusal.hint).toBe(
    "This PR does not change src/decoy.ts, so it cannot be declared: attribute the requirement to one of the files the scenario declares (src/a.ts)."
  );
});

it("never proposes declaring a file outside the PR diff", () => {
  const outside = planWithWitnesses([
    {
      id: "flow",
      sourceFiles: ["src/a.ts"],
      requirements: [
        { sourceFile: "src/decoy.ts", quote: "Alpha witness text" },
      ],
    },
  ]);
  const [outsideRefusal] = undeclaredSourcePlanRefusals(
    outside,
    witnessContext
  );
  expect(outsideRefusal).not.toContain("Declare src/decoy.ts");
  expect(outsideRefusal).toContain("This PR does not change src/decoy.ts");
  // Une exigence attribuée à un fichier du diff peut, elle, être déclarée : le
  // remède est alors proposé et le gate l'accepte.
  const inside = planWithWitnesses([
    {
      id: "flow",
      sourceFiles: ["src/b.ts"],
      requirements: [
        { sourceFile: "src/b.ts", quote: "Beta witness text" },
        { sourceFile: "src/a.ts", quote: "Alpha witness text" },
      ],
    },
  ]);
  const [insideRefusal] = undeclaredSourcePlanRefusals(inside, witnessContext);
  expect(insideRefusal).toContain(
    "Declare src/a.ts in this scenario's sourceFiles"
  );
  const declared = planWithWitnesses([
    {
      id: "flow",
      sourceFiles: ["src/a.ts", "src/b.ts"],
      requirements: [
        { sourceFile: "src/b.ts", quote: "Beta witness text" },
        { sourceFile: "src/a.ts", quote: "Alpha witness text" },
      ],
    },
  ]);
  expect(
    validateCoverage(declared, witnessContext, policyFor(), config).gate
  ).toBe("complete");
});

it("never treats a skipped documentation file under a critical prefix as critical", () => {
  const result = validateCoverage(
    planSkipping("apps/web/AGENTS.md"),
    context,
    policyFor(),
    config
  );
  expect(result.skipped).toEqual([
    {
      sourceFile: "apps/web/AGENTS.md",
      reason: "Not reachable from a browser scenario",
    },
  ]);
  expect(result.gate).toBe("no-browser-tests");
});

it("still refuses a skipped code file under a critical prefix", () => {
  const refusal = refusalOf(policyFor(), "apps/web/src/panel.ts");
  expect(refusal.code).toBe("CRITICAL_COVERAGE_MISSING");
  expect(refusal.message).toBe(
    "Critical changes skipped: apps/web/src/panel.ts"
  );
  expect(refusal.hint).toBe(
    "Add scenarios, or approve the exact skip with a reason in .canary/qa.json on the trusted base branch. A PR cannot approve its own skip."
  );
});

it("names only the refused code files when documentation is skipped as well", () => {
  const refusal = refusalOf(
    policyFor(),
    "apps/web/AGENTS.md",
    "apps/web/src/panel.ts"
  );
  expect(refusal.message).toBe(
    "Critical changes skipped: apps/web/src/panel.ts"
  );
});

it("keeps approving a skip declared with its exact path", () => {
  expect(() =>
    validateCoverage(
      planSkipping("apps/web/generated.ts"),
      context,
      policyFor([
        {
          path: "apps/web/generated.ts",
          reason: "Generated client covered by the required type check",
        },
      ]),
      config
    )
  ).not.toThrow();
});

it("approves a skip declared with a scoped pattern", () => {
  expect(() =>
    validateCoverage(
      planSkipping("apps/web/generated.ts"),
      context,
      policyFor([
        {
          path: "apps/*/generated.ts",
          reason: "Generated clients covered by the required type check",
        },
      ]),
      config
    )
  ).not.toThrow();
});

it.each([
  "AGENTS.md",
  "apps/web/AGENTS.MD",
  "apps/web/docs/architecture.json",
  "openspec/changes/add-banner/proposal.md",
  "packages/ui/LICENSE",
  "apps/web/LICENSE.md",
])("treats %s as documentation", (file) => {
  expect(isDocumentationPath(file)).toBe(true);
});

it.each([
  "apps/web/src/panel.ts",
  "apps/web/docs-loader/index.ts",
  "apps/web/licenses.ts",
  ".github/workflows/qa.yml",
])("does not treat %s as documentation", (file) => {
  expect(isDocumentationPath(file)).toBe(false);
});

it.each([
  "*",
  "**",
  "*/*",
  "**/*",
  "apps/",
])("refuses to honour the over-broad approval pattern %s", (pattern) => {
  const refusal = refusalOf(
    policyFor([
      {
        path: pattern,
        reason: "Blanket approval that would disable the coverage gate",
      },
    ]),
    "apps/web/src/panel.ts"
  );
  expect(refusal.code).toBe("CRITICAL_COVERAGE_MISSING");
  expect(refusal.message).toBe(
    "Critical changes skipped: apps/web/src/panel.ts"
  );
});
