import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import {
  isDocumentationPath,
  PolicySchema,
  quoteHasWitness,
  repairRequirementAttribution,
  undeclaredSourcePlanRefusals,
  ungroundedPlanRefusals,
  ungroundedRequirements,
  unwitnessedPlanRefusals,
  validateCoverage,
  witnessFiles,
} from "../src/policy.js";
import { planShapeRefusals } from "../src/runner.js";
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

/**
 * Cas réel du run 94e86f2b : le planificateur a recopié sur une ligne le bloc
 * que le fichier indente sur quatre. Un `PrContext` réel porte les deux — le
 * patch du fichier changé et son contenu à la révision de tête — et c'est le
 * contenu qui témoigne : les marqueurs `+` du patch sont des caractères non
 * blancs, que la comparaison ne tolère pas.
 */
const CASH_FILE = [
  "function report(denomination, quantities) {",
  "  return {",
  "    ok: false,",
  '    code: "QUANTITE_INVALIDE",',
  "  };",
  "}",
].join("\n");
const REFLOWED_QUOTE = 'return { ok: false, code: "QUANTITE_INVALIDE", };';
const cashPatch = "+ return {\n+   ok: false,\n+ };";
const reflowedCashContext: PrContext = {
  ...contextWith([{ filename: "src/cash.ts", patch: cashPatch }]),
  context: [{ content: CASH_FILE, path: "src/cash.ts", ref: context.sha }],
};
function cashPlan(quote: string): Plan {
  return planWithWitnesses([
    {
      id: "cash",
      sourceFiles: ["src/cash.ts"],
      requirements: [{ sourceFile: "src/cash.ts", quote }],
    },
  ]);
}

it("compares a quote to its file up to whitespace", () => {
  expect(quoteHasWitness(CASH_FILE, REFLOWED_QUOTE)).toBe(true);
  expect(
    quoteHasWitness(CASH_FILE, REFLOWED_QUOTE.replace("false", "true"))
  ).toBe(false);
});

it("accepts a quote whose only difference from the file is whitespace", () => {
  const plan = cashPlan(REFLOWED_QUOTE);
  expect(ungroundedRequirements(plan, reflowedCashContext)).toEqual([]);
  expect(
    unwitnessedPlanRefusals(plan, reflowedCashContext, policyFor())
  ).toEqual([]);
  expect(
    validateCoverage(plan, reflowedCashContext, policyFor(), config).gate
  ).toBe("complete");
});

it("still refuses a quote with one different character", () => {
  const plan = cashPlan(REFLOWED_QUOTE.replace("false", "true"));
  expect(ungroundedRequirements(plan, reflowedCashContext)).toHaveLength(1);
  expect(refusalOfPlan(plan, reflowedCashContext, policyFor()).code).toBe(
    "REQUIREMENT_UNGROUNDED"
  );
});

it("does not read the patch marker as whitespace", () => {
  const patchOnly: PrContext = contextWith([
    { filename: "src/cash.ts", patch: cashPatch },
  ]);
  const plan = cashPlan(REFLOWED_QUOTE);
  // Sans le contenu du fichier, les `+` du patch séparent les lignes que la
  // citation a recollées : seuls les blancs sont tolérés, jamais un caractère
  // non blanc — et le contenu accompagne toujours le patch dans un vrai
  // contexte, donc ce refus ne se produit pas en run.
  expect(ungroundedRequirements(plan, patchOnly)).toHaveLength(1);
});

it("refuses a quote that normalizes to nothing", () => {
  // Huit espaces se normalisent en chaîne vide, et `includes("")` est toujours
  // vrai : sans ce refus, le gate accepterait comme témoin une citation qui
  // n'existe nulle part.
  expect(quoteHasWitness(CASH_FILE, "")).toBe(false);
  expect(quoteHasWitness(CASH_FILE, "   \n\t ")).toBe(false);
  expect(quoteHasWitness(CASH_FILE, "        ")).toBe(false);
  // Une citation de huit espaces passe le `min(8)` du schéma puis disparaît à la
  // normalisation : le faux témoin est atteignable depuis un plan réel.
  const blank = cashPlan("        ");
  expect(ungroundedRequirements(blank, reflowedCashContext)).toHaveLength(1);
  expect(refusalOfPlan(blank, reflowedCashContext, policyFor()).code).toBe(
    "REQUIREMENT_UNGROUNDED"
  );
  // Idem pour huit caractères invisibles, que `min(8)` compte comme des
  // caractères.
  expect(
    ungroundedRequirements(cashPlan("\u200b".repeat(8)), reflowedCashContext)
  ).toHaveLength(1);
});

it("names the rejected quote in the refusal, bounded to its short form", () => {
  const plan = cashPlan(REFLOWED_QUOTE.replace("false", "true"));
  const [refusal] = ungroundedPlanRefusals(plan, reflowedCashContext);
  expect(refusal).toContain("No source witness for cash: src/cash.ts");
  expect(refusal).toContain(
    `Rejected quote: ${JSON.stringify(REFLOWED_QUOTE.replace("false", "true"))}`
  );
  const long = `return { ok: false, code: ${"x".repeat(200)} };`;
  const [longRefusal = ""] = ungroundedPlanRefusals(
    cashPlan(long),
    reflowedCashContext
  );
  expect(longRefusal).toContain('Rejected quote: "return { ok: false, code: ');
  expect(longRefusal).not.toContain("x".repeat(200));
  expect(longRefusal).toContain("…");
  expect(longRefusal.length).toBeLessThan(400);
});

/**
 * Cas réel du run 71cb3369 : la citation invente des caractères — `"":"` — que
 * le fichier ne porte pas. La tolérance porte sur les blancs, jamais sur un
 * caractère de plus : ce refus reste dû.
 */
const pagePatch =
  '@@ -1,3 +1,4 @@\n const suffix = count === 1\n   ? "s" : "";\n+ const doubled = suffix + suffix;';
const pageContext: PrContext = contextWith([
  { filename: "src/page.tsx", patch: pagePatch },
]);
function pagePlan(quote: string): Plan {
  return planWithWitnesses([
    {
      id: "page",
      sourceFiles: ["src/page.tsx"],
      requirements: [{ sourceFile: "src/page.tsx", quote }],
    },
  ]);
}

it("still refuses the real quote that invents characters", () => {
  const plan = pagePlan('const suffix = count === 1 ? "s":"":"";');
  expect(ungroundedRequirements(plan, pageContext)).toHaveLength(1);
  expect(refusalOfPlan(plan, pageContext, policyFor()).code).toBe(
    "REQUIREMENT_UNGROUNDED"
  );
  const [refusal] = ungroundedPlanRefusals(plan, pageContext);
  expect(refusal).toContain(
    `Rejected quote: ${JSON.stringify('const suffix = count === 1 ? "s":"":"";')}`
  );
  // La même ligne, recopiée sans rien inventer, passe : c'est l'invention qui
  // est refusée, pas le retour à la ligne du fichier.
  expect(
    ungroundedRequirements(
      pagePlan('const suffix = count === 1 ? "s" : "";'),
      pageContext
    )
  ).toEqual([]);
});

it("names the file whose content carries the reflowed quote", () => {
  const misattributed: PrContext = {
    ...reflowedCashContext,
    files: [
      ...reflowedCashContext.files,
      {
        filename: "src/form.ts",
        patch: "+ const nothing = 0;",
        status: "modified",
      },
    ],
  };
  const plan = planWithWitnesses([
    {
      id: "flow",
      sourceFiles: ["src/form.ts"],
      requirements: [{ sourceFile: "src/form.ts", quote: REFLOWED_QUOTE }],
    },
  ]);
  expect(witnessFiles(REFLOWED_QUOTE, misattributed)).toEqual(["src/cash.ts"]);
  const [refusal] = ungroundedPlanRefusals(plan, misattributed);
  expect(refusal).toContain("The quote appears verbatim in src/cash.ts");
});

it("repairs an attribution only when another declared file witnesses the quote", () => {
  const misattributed: PrContext = {
    ...reflowedCashContext,
    files: [
      ...reflowedCashContext.files,
      {
        filename: "src/empty.ts",
        patch: "+ const nothing = 0;",
        status: "modified",
      },
    ],
  };
  const attributed = planWithWitnesses([
    {
      id: "cash",
      sourceFiles: ["src/empty.ts", "src/cash.ts"],
      requirements: [{ sourceFile: "src/empty.ts", quote: REFLOWED_QUOTE }],
    },
  ]);
  expect(repairRequirementAttribution(attributed, misattributed)).toEqual([
    {
      from: "src/empty.ts",
      quote: REFLOWED_QUOTE,
      scenarioId: "cash",
      to: "src/cash.ts",
    },
  ]);
  // Témoin dans le fichier attribué : rien à réparer, la comparaison tolérant
  // les blancs reconnaît déjà la citation.
  expect(
    repairRequirementAttribution(cashPlan(REFLOWED_QUOTE), reflowedCashContext)
  ).toEqual([]);
});

it("never proposes a skip the coverage gate would refuse", () => {
  // src/a.ts is changed and witnessed; src/b.ts is a critical path of the diff:
  // dropping it from sourceFiles would be refused by the gate, so the refusal
  // must not propose it.
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
  // lib/helper.ts is changed and not critical: both gates accept the skip, so
  // the refusal may propose it — and the shape gate is consulted here, which the
  // earlier version of this test never did while it validated the promise.
  const skippableContext = contextWith([
    { filename: "src/a.ts", patch: "+ const alpha = 'Alpha witness text';" },
    { filename: "lib/helper.ts", patch: "+ export const helper = true;" },
  ]);
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
    skippableContext,
    policyFor()
  );
  expect(skippable).toHaveLength(1);
  expect(skippable[0]).toContain(
    "drop it from sourceFiles and list it in skipped"
  );
  // Suivre ce remède passe les deux gates : le scénario couvre le fichier
  // témoigné du diff, le second est ignoré. C'est la promesse que le refus
  // affirme, et elle est vérifiée sur la forme du plan comme sur la couverture.
  const corrected: Plan = {
    ...planWithWitnesses([
      {
        id: "flow",
        sourceFiles: ["src/a.ts"],
        requirements: [{ sourceFile: "src/a.ts", quote: "Alpha witness text" }],
      },
    ]),
    skipped: [
      {
        reason: "Not reachable from a browser scenario",
        sourceFile: "lib/helper.ts",
      },
    ],
  };
  expect(planShapeRefusals(corrected, skippableContext, config)).toEqual([]);
  expect(
    validateCoverage(corrected, skippableContext, policyFor(), config).gate
  ).toBe("complete");
});

it("proposes only the removal for a declared file outside the diff", () => {
  const single = contextWith([
    { filename: "src/a.ts", patch: "+ const alpha = 'Alpha witness text';" },
  ]);
  const declared = (file: string) =>
    planWithWitnesses([
      {
        id: "flow",
        sourceFiles: ["src/a.ts", file],
        requirements: [{ sourceFile: "src/a.ts", quote: "Alpha witness text" }],
      },
    ]);
  const [outside] = unwitnessedPlanRefusals(
    declared("lib/extra.ts"),
    single,
    policyFor()
  );
  expect(outside).toContain("This PR does not change lib/extra.ts");
  expect(outside).toContain("drop it from sourceFiles");
  expect(outside).not.toContain("list it in skipped");
  // Le diff l'emporte sur la criticalité : un chemin critique que la PR ne
  // change pas se retire seul, sans skip approuvé. L'ancienne promesse
  // ("cannot be dropped from sourceFiles") était fausse ici.
  const [outsideCritical] = unwitnessedPlanRefusals(
    declared("src/extra.ts"),
    single,
    policyFor()
  );
  expect(outsideCritical).toContain("This PR does not change src/extra.ts");
  expect(outsideCritical).not.toContain("cannot be dropped from sourceFiles");
  // Les deux gates refusent le remède skip que le refus ne propose plus, et le
  // retrait seul que le refus propose passe : le test ne peut plus valider une
  // promesse que le gate refuse.
  for (const file of ["lib/extra.ts", "src/extra.ts"]) {
    expect(
      planShapeRefusals(planSkipping(file), single, config).map(
        (refusal) => refusal.code
      )
    ).toContain("PLAN_SKIP_OUTSIDE_DIFF");
  }
  const removed = planWithWitnesses([
    {
      id: "flow",
      sourceFiles: ["src/a.ts"],
      requirements: [{ sourceFile: "src/a.ts", quote: "Alpha witness text" }],
    },
  ]);
  expect(planShapeRefusals(removed, single, config)).toEqual([]);
  expect(validateCoverage(removed, single, policyFor(), config).gate).toBe(
    "complete"
  );
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
