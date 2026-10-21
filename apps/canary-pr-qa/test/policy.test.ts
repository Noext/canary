import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Observation } from "../src/canary.js";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import { PLANNER_PROMPT } from "../src/model.js";
import {
  absentRequirementRemedy,
  amputatedQuote,
  amputatedQuoteRemedy,
  amputationScans,
  isDocumentationPath,
  numberedSourceLines,
  PolicySchema,
  quoteDivergence,
  quoteExcerpt,
  quoteHasWitness,
  quoteResolutionCandidates,
  repairRequirementAttribution,
  requirementEvidence,
  requirementHasWitness,
  sourceLineMaterial,
  stitchedQuoteFragments,
  stitchedQuoteRemedy,
  suggestedQuoteLines,
  UNGROUNDED_ABSENT_REMEDY,
  undeclaredSourcePlanRefusals,
  ungroundedPlanRefusals,
  ungroundedRequirement,
  ungroundedRequirements,
  unwitnessedPlanRefusals,
  validateCoverage,
  weakWitnessLines,
  witnessFiles,
} from "../src/policy.js";
import {
  coverageFatalClasses,
  planPayload,
  planShapeRefusals,
  quotePickCorrection,
} from "../src/runner.js";
import {
  type Plan,
  PlanSchema,
  type Preview,
  QUOTE_MIN_STRUCTURE_CHARS,
  QUOTE_MIN_TEXT_CHARS,
  QUOTE_MIN_WORD_CHARS,
  quoteCarriesContent,
  resolveLineReference,
} from "../src/schema.js";
import {
  lineAt,
  MEASURED_COPY_REFUSALS,
  type MeasuredCopyRefusal,
} from "./fixture.js";

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
/** Le même fichier sans son contenu de tête : seul le patch témoigne. */
const cashPatchOnly: PrContext = contextWith([
  { filename: "src/cash.ts", patch: cashPatch },
]);
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
  const plan = cashPlan(REFLOWED_QUOTE);
  // Sans le contenu du fichier, les `+` du patch séparent les lignes que la
  // citation a recollées : seuls les blancs sont tolérés, jamais un caractère
  // non blanc — et le contenu accompagne toujours le patch dans un vrai
  // contexte, donc ce refus ne se produit pas en run.
  expect(ungroundedRequirements(plan, cashPatchOnly)).toHaveLength(1);
});

it("refuses a quote that carries no real content", () => {
  // Le seuil de contenu vit dans le gate de témoin, seul juge d'acceptation : un
  // plan dont la citation n'a pas de contenu réel est refusé au même endroit que
  // le run le refuse. Sept espaces suivis d'une accolade se normalisent en
  // « } », que tout fichier contient, et couvriraient un fichier entier ; huit
  // caractères invisibles se normalisent en chaîne vide, que `includes` accepte
  // toujours. Le schéma Zod ne garde que le plancher de longueur — il ne connaît
  // pas le fichier cité —, donc il n'est jamais la barrière de ce refus.
  for (const empty of ["        ", `${"\u200b".repeat(7)}}`, "        }"]) {
    const plan = cashPlan(empty);
    expect(
      ungroundedRequirements(plan, reflowedCashContext),
      empty
    ).toHaveLength(1);
    expect(
      refusalOfPlan(plan, reflowedCashContext, policyFor()).code,
      empty
    ).toBe("REQUIREMENT_UNGROUNDED");
  }
  // La comparaison reste la barrière : aucune de ces citations n'a de témoin,
  // même quand le fichier contient l'accolade qu'elles normalisent.
  expect(quoteHasWitness(CASH_FILE, "")).toBe(false);
  expect(quoteHasWitness(CASH_FILE, "   \n\t ")).toBe(false);
  expect(quoteHasWitness(CASH_FILE, "        ")).toBe(false);
  expect(quoteHasWitness(CASH_FILE, "        }")).toBe(false);
  expect(quoteHasWitness(CASH_FILE, `${"\u200b".repeat(7)}}`)).toBe(false);
});

/**
 * P1 de la revue : replier TOUS les blancs acceptait comme témoin une citation
 * dont le texte réel diffère d'une manière qui a un sens. Seul un blanc qui
 * porte un saut de ligne se replie — un objet écrit sur plusieurs lignes puis
 * recopié sur une ligne, cas réel du run 94e86f2b — tandis qu'une suite de
 * blancs sans saut de ligne garde son nombre exact. Deux espaces dans un
 * littéral de chaîne sont significatifs.
 */
const SPACED_LITERAL_FILE = [
  'const label = "a  b";',
  'const other = "a b";',
].join("\n");

it("does not accept a quote whose double space is a single space", () => {
  // Espace unique face au littéral qui en porte deux : ce n'est pas la même
  // chaîne, ce n'est pas un témoin.
  expect(quoteHasWitness(SPACED_LITERAL_FILE, 'label = "a b"')).toBe(false);
  // Les deux espaces exacts au bon endroit : témoin.
  expect(quoteHasWitness(SPACED_LITERAL_FILE, 'label = "a  b"')).toBe(true);
  // Le raisonnement vaut dans les deux sens, selon ce que porte le fichier.
  expect(quoteHasWitness(SPACED_LITERAL_FILE, 'other = "a b"')).toBe(true);
  expect(quoteHasWitness(SPACED_LITERAL_FILE, 'other = "a  b"')).toBe(false);
});

it("folds only whitespace runs that carry a line break", () => {
  expect(quoteHasWitness("alpha\n\n   beta", "alpha beta")).toBe(true);
  expect(quoteHasWitness("alpha\t\tbeta", "alpha beta")).toBe(false);
});

/**
 * P1 de la revue du tour 3 : retirer U+200B et U+00AD des deux côtés effaçait
 * une différence qui a un sens. Ils ne se rognent plus qu'aux bornes de la
 * chaîne comparée : à l'intérieur, ils restent significatifs et doivent donc
 * être présents des deux côtés. Règle appliquée : un invisible de bordure est
 * du bruit de copie, un invisible interne est un caractère comme un autre.
 */
const ZWSP = "\u200b";
const SOFT_HYPHEN = "\u00ad";
const ZWNJ = "\u200c";
const INVISIBLE_ID_FILE = [
  `const zone = 'no${ZWSP}ru';`,
  `const code = 'SU${SOFT_HYPHEN}90';`,
].join("\n");
const invisibleIdPatch = `+ const zone = 'no${ZWSP}ru';`;
const invisibleIdContext = contextWith([
  { filename: "src/i18n.ts", patch: invisibleIdPatch },
]);

it("refuses a quote that omits an invisible inside an identifier", () => {
  // Recopier l'identifiant SANS l'invisible qu'il porte change son contenu : ce
  // n'est pas le texte de la source, donc pas un témoin.
  expect(quoteHasWitness(INVISIBLE_ID_FILE, "const zone = 'noru';")).toBe(
    false
  );
  expect(quoteHasWitness(INVISIBLE_ID_FILE, "const code = 'SU90';")).toBe(
    false
  );
  expect(
    ungroundedRequirements(
      planWithWitnesses([
        {
          id: "i18n",
          sourceFiles: ["src/i18n.ts"],
          requirements: [
            { sourceFile: "src/i18n.ts", quote: "const zone = 'noru';" },
          ],
        },
      ]),
      invisibleIdContext
    )
  ).toHaveLength(1);
  // Recopié AVEC l'invisible à la bonne place : témoin.
  expect(
    quoteHasWitness(INVISIBLE_ID_FILE, `const zone = 'no${ZWSP}ru';`)
  ).toBe(true);
  expect(
    quoteHasWitness(INVISIBLE_ID_FILE, `const code = 'SU${SOFT_HYPHEN}90';`)
  ).toBe(true);
});

it("tolerates an invisible at the border of the quote", () => {
  const line = "const total = grandTotal;";
  // L'invisible en bordure est du bruit de copie, comme le blanc : il se rogne
  // des deux côtés, donc la citation reste témoin du contenu sans lui.
  expect(quoteHasWitness(line, `${ZWSP}${line}`)).toBe(true);
  expect(quoteHasWitness(line, `${line}${SOFT_HYPHEN}`)).toBe(true);
  expect(quoteHasWitness(`${ZWSP}${line}${SOFT_HYPHEN}`, line)).toBe(true);
});

/**
 * L'acceptation d'un témoin dépend de la substance de la citation ET de la
 * criticité du fichier cité. Deux revues se contredisent en apparence ; la
 * gradation les réconcilie, et les tests qui suivent prouvent chaque cas.
 *
 * - P2 de la revue du tour 3 : exiger quatre lettres ou chiffres PARTOUT
 *   refusait des citations EXACTES et légitimes là où la source en offre peu —
 *   `if (x) {` dans `src/logic.ts`, `{"x": 1}` dans `src/value.json` — et
 *   bloquait un plan juste. Un fichier ordinaire se contente donc du plancher
 *   universel — `QUOTE_MIN_TEXT_CHARS` caractères normalisés et
 *   `QUOTE_MIN_TOKENS` jetons, ce qui écarte déjà le rembourrage (sept espaces
 *   et une accolade, huit caractères invisibles) — et sur un chemin critique le
 *   seuil ne demande que du contenu visible : il ne compte pas les lettres ;
 * - P1 de la revue du tour 4 : sans contrôle de substance, une citation sans
 *   aucun contenu visible — séparateur de ponctuation, invisibles — servait de
 *   témoin à un fichier CRITIQUE, où un diff hostile peut la planter. Sur un
 *   chemin critique, la citation doit porter `CRITICAL_QUOTE_MIN_WORD_CHARS`
 *   lettre ou chiffre : un identifiant, un mot-clé, un nombre, un message,
 *   jamais de la ponctuation seule.
 *
 * Le jeton unique reste refusé partout, exact ou non : `};`, une accolade et
 * une ligne entière sans blanc apparaissent dans presque tout fichier.
 */
const PUNCTUATION_FILE = ["if (x) {", "  run();", "}"].join("\n");
/** Chemin hors `criticalPaths` : ni `src/`, ni `app/`, ni `packages/`. */
const SCRIPT_FILE = "tools/toggle.js";
/** Le cas nommé par la revue du tour 3 : deux alphanumériques, chemin critique. */
const JSON_FILE = "src/value.json";
const JSON_QUOTE = '{"x": 1}';

/** Un plan d'une exigence, attribuée au fichier qui porte la citation. */
function witnessed(quote: string, sourceFile: string, scenarioId: string) {
  return {
    plan: planWithWitnesses([
      {
        id: scenarioId,
        sourceFiles: [sourceFile],
        requirements: [{ sourceFile, quote }],
      },
    ]),
    scenarioContext: contextWith([
      { filename: sourceFile, patch: `+ ${quote}` },
    ]),
  };
}
it("accepts an exact short quote in a non-critical alphanumeric-poor file", () => {
  const shortQuote = "if (x) {";
  // Trois lettres seulement : le compteur d'alphanumériques la refusait, et le
  // plan juste était bloqué.
  expect(quoteHasWitness(PUNCTUATION_FILE, shortQuote)).toBe(true);
  expect(quoteCarriesContent(shortQuote)).toBe(true);
  const { plan, scenarioContext } = witnessed(
    shortQuote,
    SCRIPT_FILE,
    "toggle"
  );
  expect(ungroundedRequirements(plan, scenarioContext)).toEqual([]);
  expect(
    validateCoverage(plan, scenarioContext, policyFor(), config).gate
  ).toBe("complete");
});

it("accepts an exact short quote on a critical path", () => {
  // La citation que la revue du tour 4 demande de garder, dans le fichier
  // critique où le tour 4 l'avait prouvée : trois lettres restent un témoin, et
  // compter les lettres au-delà de leur présence rouvrirait le plan juste
  // bloqué que le tour 3 signalait.
  const shortQuote = "if (x) {";
  expect(quoteCarriesContent(shortQuote)).toBe(true);
  const logic = witnessed(shortQuote, "src/logic.ts", "logic");
  expect(ungroundedRequirements(logic.plan, logic.scenarioContext)).toEqual([]);
  expect(
    validateCoverage(logic.plan, logic.scenarioContext, policyFor(), config)
      .gate
  ).toBe("complete");
  // Le cas nommé par la revue du tour 3 : `src/value.json` réduit à `{"x": 1}`,
  // deux alphanumériques, chemin critique.
  expect(quoteCarriesContent(JSON_QUOTE)).toBe(true);
  const json = witnessed(JSON_QUOTE, JSON_FILE, "value");
  expect(ungroundedRequirements(json.plan, json.scenarioContext)).toEqual([]);
  expect(
    validateCoverage(json.plan, json.scenarioContext, policyFor(), config).gate
  ).toBe("complete");
});

it("refuses a quote with no visible letter or digit, on every path", () => {
  // Les fragments nommés par la revue du tour 4 : un séparateur de ponctuation
  // et huit zéro-largeurs non-joignants, plantés dans un diff hostile. Le
  // seuil de contenu visible vaut maintenant partout — c'est lui qui refusait
  // la ponctuation seule sur un chemin critique —, donc le fichier ordinaire
  // n'a plus de tolérance à lui.
  const separator = "// ------";
  const invisible = ZWNJ.repeat(8);
  expect(quoteCarriesContent(separator)).toBe(false);
  // Le plancher de longueur suffit déjà pour les invisibles : huit zéro-largeurs
  // se normalisent en une chaîne vide, refusée par le contrat de `quote` comme
  // par le gate.
  expect(quoteCarriesContent(invisible)).toBe(false);
  expect(quoteHasWitness(`${invisible}\n`, invisible)).toBe(false);
  for (const path of ["src/logic.ts", SCRIPT_FILE]) {
    const plan = planWithWitnesses([
      {
        id: "logic",
        sourceFiles: [path],
        requirements: [{ sourceFile: path, quote: separator }],
      },
    ]);
    const scenarioContext = contextWith([
      { filename: path, patch: `+ ${separator}` },
    ]);
    expect(ungroundedRequirements(plan, scenarioContext)).toHaveLength(1);
    const refusal = refusalOfPlan(plan, scenarioContext, policyFor());
    expect(refusal.code, `${path}: code`).toBe("REQUIREMENT_UNGROUNDED");
    // La citation EXISTE dans le fichier : lui répondre « no source witness »
    // ferait renvoyer la même citation exacte au planificateur. Le refus nomme
    // la règle du contenu, et ne propose un skip que là où le gate le demande.
    expect(refusal.message, `${path}: message`).toBe(
      `Weak source witness for logic: ${path} (requirement 1). Rejected quote: ${JSON.stringify(separator)}`
    );
    expect(refusal.hint, `${path}: seuil nommé`).toContain(
      `at least ${QUOTE_MIN_WORD_CHARS} letter or digit`
    );
    // Aucun fichier n'est proposé comme portant la citation : elle y est, et le
    // remède est une citation qui porte du contenu, pas une réattribution.
    expect(witnessFiles(separator, scenarioContext)).toEqual([]);
    expect(() =>
      validateCoverage(plan, scenarioContext, policyFor(), config)
    ).toThrow();
  }
  // Le chemin critique, lui, propose en plus le skip approuvé sur la branche de
  // base — jamais un retrait du fichier que le gate refuserait.
  const criticalContext = contextWith([
    { filename: "src/logic.ts", patch: `+ ${separator}` },
  ]);
  expect(
    refusalOfPlan(
      planWithWitnesses([
        {
          id: "logic",
          sourceFiles: ["src/logic.ts"],
          requirements: [{ sourceFile: "src/logic.ts", quote: separator }],
        },
      ]),
      criticalContext,
      policyFor()
    ).hint
  ).toContain(".canary/qa.json");
  const script = contextWith([
    { filename: SCRIPT_FILE, patch: `+ ${separator}` },
  ]);
  const [line] = ungroundedPlanRefusals(
    planWithWitnesses([
      {
        id: "logic",
        sourceFiles: [SCRIPT_FILE],
        requirements: [{ sourceFile: SCRIPT_FILE, quote: separator }],
      },
    ]),
    script,
    policyFor()
  );
  expect(line).toContain(JSON.stringify(separator));
  expect(line).not.toContain("appears verbatim in");
  // Le fragment invisible par le contrat ne franchit pas le gate : aucune
  // lettre visible ne subsiste après normalisation, donc aucune exigence ne le
  // porte comme témoin et le run est refusé là, pas au schéma.
  for (const quote of [invisible, "      \u200b\u200b}"]) {
    const plan = planWithWitnesses([
      {
        id: "logic",
        sourceFiles: ["src/logic.ts"],
        requirements: [{ sourceFile: "src/logic.ts", quote }],
      },
    ]);
    const scenarioContext = contextWith([
      { filename: "src/logic.ts", patch: `+ ${quote}` },
    ]);
    expect(ungroundedRequirements(plan, scenarioContext), quote).toHaveLength(
      1
    );
    expect(refusalOfPlan(plan, scenarioContext, policyFor()).code, quote).toBe(
      "REQUIREMENT_UNGROUNDED"
    );
  }
});

it("does not count a default-ignorable letter as visible content", () => {
  // U+115F HANGUL CHOSEONG FILLER, U+1160 HANGUL JUNGSEONG FILLER, U+3164
  // HANGUL FILLER et U+FFA0 HALFWIDTH HANGUL FILLER sont à la fois `\p{L}` et
  // `Default_Ignorable_Code_Point` : invisibles, ils satisfaisaient la lettre
  // exigée d'un témoin. Un diff hostile les plante et couvrait le fichier sans
  // rien montrer — le seuil de contenu visible les retire avant de compter,
  // désormais sur tout fichier et non plus sur le seul chemin critique.
  for (const filler of ["\u115f", "\u1160", "\u3164", "\uffa0"]) {
    const quote = `${filler.repeat(4)} ${filler.repeat(4)}`;
    expect(quote.length).toBeGreaterThanOrEqual(QUOTE_MIN_TEXT_CHARS);
    expect(quoteCarriesContent(quote)).toBe(false);
    expect(quoteHasWitness(`+ ${quote}`, quote)).toBe(false);
  }
  // Une vraie lettre ou un vrai chiffre reste visible, y compris quand la
  // source en offre peu — les cas que la revue du tour 3 demandait de garder.
  for (const visible of ["if (x) {", JSON_QUOTE, "value 12"]) {
    expect(quoteCarriesContent(visible)).toBe(true);
  }
});

it("refuses a quote reduced to punctuation, exact or not", () => {
  // La ponctuation seule ne désigne aucun endroit précis, et le gate la refuse
  // partout par la règle de contenu — plus par un comptage de blancs. Le
  // contrat de `quote` la refuse, par la règle de contenu.
  const punctuation = ["}}", ");", "=>", "+", "end();"];
  for (const quote of punctuation) {
    expect(quoteCarriesContent(quote), `${quote}: contenu`).toBe(false);
  }
  // Rembourrée à la longueur du plancher, elle reste de la ponctuation : la
  // longueur seule ne suffit jamais à prouver un témoin.
  const padded = "        }";
  expect(padded.length).toBeGreaterThanOrEqual(QUOTE_MIN_TEXT_CHARS);
  expect(quoteCarriesContent(padded)).toBe(false);
  const punctuationFile = ["}}", "  end();", padded].join("\n");
  expect(quoteHasWitness(punctuationFile, padded)).toBe(false);
  expect(quoteHasWitness(punctuationFile, "end();")).toBe(false);
  // Un plan qui cite de la ponctuation est refusé avant exécution, sur un chemin
  // critique comme sur un fichier ordinaire : le gate est le seul juge, et c'est
  // lui qui rend le refus — le schéma ne connaît pas le fichier cité.
  for (const path of [SCRIPT_FILE, "src/logic.ts"]) {
    const plan = planWithWitnesses([
      {
        id: "finish",
        sourceFiles: [path],
        requirements: [{ sourceFile: path, quote: padded }],
      },
    ]);
    const segment = contextWith([{ filename: path, patch: `+ ${padded}` }]);
    expect(ungroundedRequirements(plan, segment), path).toHaveLength(1);
    expect(refusalOfPlan(plan, segment, policyFor()).code, path).toBe(
      "REQUIREMENT_UNGROUNDED"
    );
  }
});

/**
 * Le proxy que ce contrat remplace comptait les blancs : une copie exacte de
 * code sans blanc — un attribut JSX, un appel d'accesseur — ne formait qu'un
 * jeton et était refusée alors qu'elle fait 27 à 43 caractères et porte des
 * lettres. Les quatre copies mesurées ci-dessous sont des lignes réelles des
 * runs 9ee36233, 94e86f2b et 71cb3369 (voir `MEASURED_COPY_REFUSALS`), et
 * chacune est acceptée comme témoin de son fichier déclaré.
 */
const WHITESPACE_FREE_QUOTES = [
  "formatAmountFr(centsToEuros(counted.totalCents))",
  "aria-invalid={invalid||undefined}",
  "disabled={closed||!counted.ok}",
  'data-cash-state={closed?"cloture":"ouvert"}',
];

it("accepts an exact whitespace-free quote of a real line", () => {
  for (const quote of WHITESPACE_FREE_QUOTES) {
    const label = `${quote.slice(0, 24)}…`;
    expect(quote, label).not.toMatch(/\s/u);
    expect(quote.length, label).toBeGreaterThanOrEqual(QUOTE_MIN_TEXT_CHARS);
    expect(quoteCarriesContent(quote), label).toBe(true);
    const { plan, scenarioContext } = witnessed(
      quote,
      "apps/web/app/page.tsx",
      "caisse-comptage-juste"
    );
    expect(
      requirementHasWitness(
        { quote, sourceFile: "apps/web/app/page.tsx" },
        scenarioContext
      ),
      label
    ).toBe(true);
    expect(ungroundedRequirements(plan, scenarioContext), label).toEqual([]);
    expect(
      validateCoverage(plan, scenarioContext, policyFor(), config).gate,
      label
    ).toBe("complete");
  }
  // Le cas nommé par l'ancien test : une expression longue et sans blanc, mais
  // pleine de contenu, est un témoin comme une autre.
  const finish = "finish(function(){return;});";
  expect(quoteCarriesContent(finish)).toBe(true);
  expect(quoteHasWitness(`+ ${finish}`, finish)).toBe(true);
});

/**
 * P2 de la revue : la longueur et la lettre seules acceptaient un identifiant
 * NU — `function` fait huit caractères et porte des lettres —, donc un fichier
 * qui contient un mot courant couvrait n'importe quelle exigence, y compris sur
 * un chemin critique. Un témoin doit porter une STRUCTURE de code : au moins
 * `QUOTE_MIN_STRUCTURE_CHARS` caractère VISIBLE qui ne soit ni lettre ni
 * chiffre — un opérateur, une ponctuation, le blanc qui sépare deux mots. C'est
 * ce qui distingue une EXPRESSION d'un identifiant nu.
 *
 * Jamais de retour au plancher de jetons par blancs :
 * `disabled={closed||!counted.ok}` (27 caractères, un seul jeton au sens des
 * blancs) est une copie exacte qui reste un témoin, et le seuil de structure
 * vaut UN, pas deux : un seul `=` (`total=17`) ou un seul blanc (`value 12`)
 * suffit, donc exiger deux caractères rouvrirait le faux refus que ces deux cas
 * mesurent.
 */
it("refuses a bare identifier as a witness, exact or not", () => {
  // `return`, `true` et `type` sont déjà sous le plancher de longueur ;
  // `function` (8) et `undefined` (9) le franchissaient : la liste nommée par
  // la revue est refusée entière.
  for (const word of ["function", "return", "true", "type", "undefined"]) {
    expect(quoteCarriesContent(word), `${word}: contenu`).toBe(false);
    // Le mot est bien dans le fichier, verbatim : c'est le CONTENU qui manque,
    // pas la présence.
    const line = `const ${word}Value = compute();`;
    expect(quoteHasWitness(line, word), `${word}: présence`).toBe(false);
    expect(
      requirementHasWitness(
        { quote: word, sourceFile: "src/logic.ts" },
        contextWith([{ filename: "src/logic.ts", patch: `+ ${line}` }])
      ),
      `${word}: témoin`
    ).toBe(false);
  }
  const file = "src/logic.ts";
  const line = "export function compute() {";
  const scenarioContext = contextWith([{ filename: file, patch: `+ ${line}` }]);
  const plan = planWithWitnesses([
    {
      id: "logic",
      sourceFiles: [file],
      requirements: [{ sourceFile: file, quote: "function" }],
    },
  ]);
  expect(ungroundedRequirements(plan, scenarioContext)).toHaveLength(1);
  const refusal = refusalOfPlan(plan, scenarioContext, policyFor());
  expect(refusal.code).toBe("REQUIREMENT_UNGROUNDED");
  // Le refus dit la vérité : la citation existe et porte des lettres ; ce qui
  // manque est la structure de code. Un message qui demande une lettre déjà
  // présente ferait renvoyer la même citation au planificateur.
  expect(refusal.message).toBe(
    `Weak source witness for logic: ${file} (requirement 1). Rejected quote: "function"`
  );
  expect(refusal.hint).toContain("code structure");
  // La ligne qui PORTE le mot reste un témoin : la règle distingue un
  // identifiant nu d'une expression, elle ne bloque pas le fichier.
  expect(
    requirementHasWitness({ quote: line, sourceFile: file }, scenarioContext)
  ).toBe(true);
  expect(QUOTE_MIN_STRUCTURE_CHARS).toBe(1);
  for (const single of ["total=17", "value 12"]) {
    expect(quoteCarriesContent(single), `${single}: un seul caractère`).toBe(
      true
    );
  }
  // Les deux ponctuations nommées par la revue restent refusées : sous le
  // plancher de longueur, elles ne portent aucun mot.
  for (const punctuation of [");", "}}"]) {
    expect(quoteCarriesContent(punctuation), punctuation).toBe(false);
  }
});

/**
 * P2 de la revue, suite : la structure comptée était le complémentaire de
 * `\p{L}\p{N}`, donc les caractères de LIAISON D'IDENTIFIANT — tiret bas,
 * tiret, point, deux-points, barre oblique — passaient pour de la structure, et
 * `snake_case_name`, `kebab-case-name`, `__name__` étaient acceptés comme
 * témoins alors qu'ils ne portent aucune structure de code. Seuls les symboles
 * qui expriment une structure comptent maintenant : accolades, parenthèses,
 * crochets, opérateurs, signes égal, point-virgule, chevrons, guillemets
 * internes, et le blanc entre deux mots. Les copies réelles de
 * `WHITESPACE_FREE_QUOTES` et `total=17` / `value 12` restent des témoins : la
 * règle resserrée ne rouvre pas le faux refus déjà fermé.
 */
it("refuses an identifier linked by underscores, hyphens, dots, colons or slashes", () => {
  const linked = [
    "user_id",
    "snake_case_name",
    "__name__",
    "kebab-case-name",
    "a.b.c",
    "config.settings.value",
    "module:service:handler",
    "src/utils/helpers/file",
  ];
  for (const word of linked) {
    expect(quoteCarriesContent(word), `${word}: contenu`).toBe(false);
    // Le mot est dans le fichier, verbatim : la présence suffit pour un témoin
    // exact, c'est la structure de code absente qui le refuse.
    const line = `const ${word}Value = compute();`;
    expect(quoteHasWitness(line, word), `${word}: présence`).toBe(false);
    const scenarioContext = contextWith([
      { filename: "src/logic.ts", patch: `+ ${line}` },
    ]);
    expect(
      requirementHasWitness(
        { quote: word, sourceFile: "src/logic.ts" },
        scenarioContext
      ),
      `${word}: témoin`
    ).toBe(false);
    // La ligne qui PORTE l'identifiant reste un témoin entier : la règle
    // distingue un identifiant nu d'une expression, elle ne bloque pas le
    // fichier.
    expect(
      requirementHasWitness(
        { quote: line, sourceFile: "src/logic.ts" },
        scenarioContext
      ),
      `${word}: la ligne reste un témoin`
    ).toBe(true);
  }
  // Le refus dit la vérité : la copie existe et porte des lettres ; ce qui
  // manque est la structure de code.
  const file = "src/logic.ts";
  const word = "snake_case_name";
  const line = `const ${word}Value = compute();`;
  const plan = planWithWitnesses([
    {
      id: "logic",
      sourceFiles: [file],
      requirements: [{ sourceFile: file, quote: word }],
    },
  ]);
  const refusal = refusalOfPlan(
    plan,
    contextWith([{ filename: file, patch: `+ ${line}` }]),
    policyFor()
  );
  expect(refusal.code).toBe("REQUIREMENT_UNGROUNDED");
  expect(refusal.message).toBe(
    `Weak source witness for logic: ${file} (requirement 1). Rejected quote: "snake_case_name"`
  );
  expect(refusal.hint).toContain("code structure");
  // Contre-épreuve : les six copies réelles et les deux plus courtes portent de
  // la vraie structure, donc restent acceptées.
  for (const quote of [...WHITESPACE_FREE_QUOTES, "total=17", "value 12"]) {
    expect(quoteCarriesContent(quote), quote).toBe(true);
  }
});

/**
 * P2 de sécurité de la revue de la PR #55 (18/10) : l'apostrophe comptait comme
 * structure de code, donc un identifiant nu PRÉFIXÉ d'un sigil redevenait témoin
 * sous une autre écriture. Un lifetime Rust — `'dangerous` : 10 caractères,
 * 9 lettres, une apostrophe — franchissait le plancher de longueur, le compteur
 * de lettres et le compteur de structure, et couvrait un fichier `.rs` d'un
 * dépôt où une PR non fiable pilote le planificateur.
 *
 * L'apostrophe ne compte plus comme symbole : seul l'apostrophe SIGIL, celui
 * qui précède un identifiant (`'dangerous`, `'static`, `'a`), disparaît du
 * décompte. Une paire qui délimite un contenu non vide reste une structure —
 * `'cloture'`, `'completed'`, qui sont des chaînes de caractères au même titre
 * que `"cloture"` —, sinon un littéral d'un seul mot serait refusé selon le
 * style de guillemet de la source et tuerait le run. Les autres cas légitimes
 * portent les caractères restants : `let marker = 'a';` (17 caractères, `=` et
 * `;`), la ligne qui porte le lifetime (parenthèses, chevrons, `&`) et
 * `'le comptage est verrouillé'` (le blanc entre deux mots). Aucune des copies
 * déjà tenues ci-dessus — `WHITESPACE_FREE_QUOTES`, `total=17`, `value 12` — ne
 * contient d'apostrophe : leur verdict ne bouge pas.
 */
const RUST_SOURCE = [
  "pub struct Request<'dangerous> {",
  "    pub path: &'dangerous str,",
  "}",
  "pub fn leak<'static>(value: &'static str) -> &'static str {",
  "    value",
  "}",
  "pub fn marker() -> char {",
  "    let marker = 'a';",
  "    marker",
  "}",
].join("\n");
const CHAR_LITERAL_LINE = "let marker = 'a';";
it("refuses a Rust lifetime as a witness and keeps the code that carries one", () => {
  // Les trois formes nommées par la revue. `'static` (7) et `'a` (2) tombent
  // sous le plancher de longueur du schéma comme du gate, avant comme après la
  // correction ; `'dangerous` (10) est la seule que l'apostrophe seule faisait
  // passer, donc c'est elle qui mesure le correctif.
  expect("'dangerous").toHaveLength(10);
  expect("'static").toHaveLength(7);
  expect("'a").toHaveLength(2);
  for (const lifetime of ["'dangerous", "'static", "'a"]) {
    expect(quoteCarriesContent(lifetime), `${lifetime}: contenu`).toBe(false);
    // Le lifetime est dans le fichier, verbatim : c'est la structure de code qui
    // manque, pas la présence.
    expect(
      quoteHasWitness(RUST_SOURCE, lifetime),
      `${lifetime}: présence`
    ).toBe(false);
  }
  // Le schéma garde le plancher de longueur : il refuse déjà les deux plus
  // courts avant même le gate, et laisse `'dangerous` au gate.
  for (const lifetime of ["'static", "'a"]) {
    expect(
      () =>
        planWithWitnesses([
          {
            id: "borrow",
            sourceFiles: ["src/request.rs"],
            requirements: [{ sourceFile: "src/request.rs", quote: lifetime }],
          },
        ]),
      `${lifetime}: schéma`
    ).toThrow();
  }
  const file = "src/request.rs";
  const scenarioContext = contextWith([
    {
      filename: file,
      patch: RUST_SOURCE.split("\n")
        .map((line) => `+${line}`)
        .join("\n"),
    },
  ]);
  // `'dangerous` passe le schéma (10 caractères) : c'est le gate de témoin qui
  // le refuse, avec le message qui nomme le fichier et la règle.
  expect(quoteHasWitness(RUST_SOURCE, "'dangerous")).toBe(false);
  const poisoned = planWithWitnesses([
    {
      id: "borrow",
      sourceFiles: [file],
      requirements: [{ sourceFile: file, quote: "'dangerous" }],
    },
  ]);
  expect(ungroundedRequirements(poisoned, scenarioContext)).toHaveLength(1);
  const refusal = refusalOfPlan(poisoned, scenarioContext, policyFor());
  expect(refusal.code).toBe("REQUIREMENT_UNGROUNDED");
  expect(refusal.message).toBe(
    `Weak source witness for borrow: ${file} (requirement 1). Rejected quote: "'dangerous"`
  );
  expect(refusal.hint).toContain("apostrophe");
  // Le fichier n'est pas bloqué pour autant : la ligne qui PORTE le lifetime et
  // le caractère Rust `'a'` restent des témoins, par leurs autres caractères.
  for (const quote of [
    "pub fn leak<'static>(value: &'static str) -> &'static str {",
    CHAR_LITERAL_LINE,
    "pub path: &'dangerous str,",
  ]) {
    expect(quoteCarriesContent(quote), `${quote}: contenu`).toBe(true);
    expect(quoteHasWitness(RUST_SOURCE, quote), `${quote}: témoin`).toBe(true);
    expect(
      requirementHasWitness({ quote, sourceFile: file }, scenarioContext),
      `${quote}: gate`
    ).toBe(true);
  }
  // Un caractère seul (`'a'`, 3 caractères) reste sous le plancher : c'est la
  // LIGNE qui le porte qui est un témoin, pas le littéral.
  expect("'a'").toHaveLength(3);
  expect(quoteCarriesContent("'a'")).toBe(false);
  // Une chaîne entre apostrophes reste un témoin : sa paire la délimite, comme
  // le ferait un guillemet double. `'completed'` et `'cloture'` sont les deux
  // littéraux nommés par la revue de code du tour 1.
  for (const literal of [
    "'completed'",
    "'cloture'",
    "'le comptage est verrouillé'",
  ]) {
    expect(quoteCarriesContent(literal), `${literal}: contenu`).toBe(true);
    expect(quoteCarriesContent(literal.replaceAll("'", '"')), literal).toBe(
      true
    );
  }
  // Le sigil ne passe pas pour un délimiteur : `'dangerous` reste refusé là où
  // `'dangerous'` cite une chaîne de caractères.
  expect(quoteCarriesContent("'dangerous")).toBe(false);
  expect(quoteCarriesContent("'dangerous'")).toBe(true);
  // Et un sigil planté DANS du code reste un témoin par ce code, pas par lui.
  expect(quoteCarriesContent("state='dangerous")).toBe(true);
  expect(quoteHasWitness("let state='dangerous", "state='dangerous")).toBe(
    true
  );
  // Contre-épreuve : la règle resserrée ne rouvre aucun faux refus déjà fermé.
  for (const quote of [
    ...WHITESPACE_FREE_QUOTES,
    "total=17",
    "value 12",
    "if (x) {",
  ]) {
    expect(quoteCarriesContent(quote), quote).toBe(true);
  }
});

/**
 * Lots U et V, première moitié : le refus « Weak source witness » ne nommait
 * aucune ligne. La correction par indice d'un identifiant nu n'obtenait aucun
 * candidat, parce que le remède de citation absente s'appuie sur le recouvrement
 * de jetons — trois jetons partagés, une ligne de moins de 120 caractères — et
 * qu'un identifiant n'en porte qu'un. `user_id` et `snake_case_name` (runs du
 * lot V) partaient donc au planificateur avec le seul conseil « cite un
 * fragment substantiel ». Le candidat est maintenant la ligne réelle qui PORTE
 * l'identifiant : elle est entière, donc elle porte la structure qui manquait.
 */
it("offers the real line carrying a bare identifier as the remedy", () => {
  const file = "src/logic.ts";
  const lines = [
    "export function compute() {",
    "const snake_case_name = readName();",
    "const user_id = session.id;",
  ];
  const scenarioContext = contextWith([
    {
      filename: file,
      patch: `@@ -1,3 +1,3 @@\n${lines.map((line) => `+${line}`).join("\n")}`,
    },
  ]);
  const cases = [
    { line: 1, quote: "function" },
    { line: 2, quote: "snake_case_name" },
    { line: 3, quote: "user_id" },
  ];
  for (const item of cases) {
    const requirement = { quote: item.quote, sourceFile: file };
    // Rien n'est accepté du premier coup : l'identifiant nu reste refusé.
    expect(
      requirementHasWitness(requirement, scenarioContext),
      item.quote
    ).toBe(false);
    const candidates = quoteResolutionCandidates(requirement, scenarioContext);
    expect(candidates, item.quote).toHaveLength(1);
    const [candidate] = candidates;
    expect(candidate?.line, item.quote).toBe(item.line);
    expect(candidate?.text, item.quote).toBe(lines[item.line - 1]);
    // Le candidat proposé est un témoin que le gate accepte : la correction par
    // indice ne peut pas renvoyer le plan vers un texte refusé au tour suivant.
    expect(
      requirementHasWitness(
        { quote: candidate?.text ?? "", sourceFile: file },
        scenarioContext
      ),
      item.quote
    ).toBe(true);
  }
  // Le conseil nomme la ligne réelle, et le message reste celui du témoin trop
  // pauvre : aucune tolérance n'a été ajoutée à la règle.
  const plan = planWithWitnesses([
    {
      id: "logic",
      sourceFiles: [file],
      requirements: [{ sourceFile: file, quote: "snake_case_name" }],
    },
  ]);
  const refusal = refusalOfPlan(plan, scenarioContext, policyFor());
  expect(refusal.message).toBe(
    `Weak source witness for logic: ${file} (requirement 1). Rejected quote: "snake_case_name"`
  );
  expect(refusal.hint).toContain(`2: ${JSON.stringify(lines[1])}`);
  expect(quoteCarriesContent("snake_case_name")).toBe(false);
});

/**
 * Finding P1 de la revue : un identifiant commun (`function`, `return`) vit sur
 * des dizaines de lignes sans rapport avec l'exigence. En offrir deux laisserait
 * la correction par indice écrire dans le plan une ligne réelle mais étrangère
 * au comportement décrit, que le gate accepterait comme preuve. Au-delà d'une
 * ligne par candidat offert, aucune piste n'est proposée : le refus d'aujourd'hui
 * est rendu, et le planificateur le corrige en réécrivant.
 */
it("offers no weak-witness candidate when the identifier is ambiguous", () => {
  const file = "src/logic.ts";
  const lines = [
    "export function alpha() {",
    "export function beta() {",
    "export function gamma() {",
  ];
  const scenarioContext = contextWith([
    {
      filename: file,
      patch: `@@ -1,3 +1,3 @@\n${lines.map((line) => `+${line}`).join("\n")}`,
    },
  ]);
  const requirement = { quote: "function", sourceFile: file };
  expect(requirementHasWitness(requirement, scenarioContext)).toBe(false);
  expect(weakWitnessLines(requirement, scenarioContext)).toEqual([]);
  // Aucun candidat ne sort non plus par une autre source : la correction par
  // indice ne peut donc pas écrire une de ces trois lignes dans le plan.
  expect(quoteResolutionCandidates(requirement, scenarioContext)).toEqual([]);
  const refusal = refusalOfPlan(
    planWithWitnesses([
      {
        id: "logic",
        sourceFiles: [file],
        requirements: [{ sourceFile: file, quote: "function" }],
      },
    ]),
    scenarioContext,
    policyFor()
  );
  expect(refusal.message).toContain('Rejected quote: "function"');
});

/**
 * Cas réel 1 de la revue : la citation exacte et substantielle d'un fichier
 * critique reste un témoin — 129 caractères, puis la citation recollée du run
 * 94e86f2b. Refuser celles-là bloquerait le plan juste, la direction nuisible.
 */
const CRITICAL_FILE_LINE =
  '    return { ok: false, code: "QUANTITE_INVALIDE", detail: "Le montant saisi depasse le total de la facture émise en euro TTC" };';

it("accepts an exact substantial quote on a critical path", () => {
  expect(CRITICAL_FILE_LINE).toHaveLength(129);
  expect(quoteCarriesContent(CRITICAL_FILE_LINE)).toBe(true);
  const criticalContext = contextWith([
    { filename: "src/cash.ts", patch: `+ ${CRITICAL_FILE_LINE}` },
  ]);
  const plan = planWithWitnesses([
    {
      id: "cash",
      sourceFiles: ["src/cash.ts"],
      requirements: [{ sourceFile: "src/cash.ts", quote: CRITICAL_FILE_LINE }],
    },
  ]);
  expect(ungroundedRequirements(plan, criticalContext)).toEqual([]);
  expect(
    validateCoverage(plan, criticalContext, policyFor(), config).gate
  ).toBe("complete");
  // Le contenu réel du run, dans le même fichier critique, reste témoin.
  expect(quoteCarriesContent(REFLOWED_QUOTE)).toBe(true);
  expect(
    requirementHasWitness(
      { quote: REFLOWED_QUOTE, sourceFile: "src/cash.ts" },
      reflowedCashContext
    )
  ).toBe(true);
});

it("still refuses padding under the content rule", () => {
  // Le plancher de longueur fait tout le travail : «        } » se normalise en
  // « } », et sept zéro-largeurs suivis d'une accolade en « } » aussi. Aucune
  // citation réduite à une accolade ne passe, quel que soit le fichier.
  expect(quoteCarriesContent("        }")).toBe(false);
  expect(quoteCarriesContent(`${ZWSP.repeat(7)}}`)).toBe(false);
  expect(quoteCarriesContent("        ")).toBe(false);
  expect(quoteHasWitness(CASH_FILE, "        }")).toBe(false);
  expect(quoteHasWitness(CASH_FILE, `${ZWSP.repeat(7)}}`)).toBe(false);
});

/**
 * Deux segments témoins ne se recousent pas : une citation n'est un témoin que
 * si un seul segment la porte entière. Replier les blancs après avoir joint les
 * segments acceptait une citation assemblée de deux morceaux différents.
 */
it("refuses a quote stitched across the patch and content junction", () => {
  const stitched = "}; function report(denomination, quantities) {";
  const segments = requirementEvidence(
    { quote: stitched, sourceFile: "src/cash.ts" },
    reflowedCashContext
  );
  expect(segments).toHaveLength(2);
  // L'ancienne comparaison joignait ces segments avant de replier les blancs :
  // la chaîne ainsi obtenue contient la citation, et aucun segment seul ne la
  // porte. C'est ce faux témoin que la comparaison par segment refuse.
  expect(quoteHasWitness(segments.join("\n"), stitched)).toBe(true);
  expect(
    requirementHasWitness(
      { quote: stitched, sourceFile: "src/cash.ts" },
      reflowedCashContext
    )
  ).toBe(false);
  expect(
    ungroundedRequirements(cashPlan(stitched), reflowedCashContext)
  ).toHaveLength(1);
  expect(
    refusalOfPlan(cashPlan(stitched), reflowedCashContext, policyFor()).code
  ).toBe("REQUIREMENT_UNGROUNDED");
});
it("refuses a quote stitched across the head and base contents", () => {
  const head = "const head = 'alpha tail witness';";
  const base = "const base = 'beta head witness';";
  const junction: PrContext = {
    ...cashPatchOnly,
    context: [
      { content: head, path: "src/cash.ts", ref: context.sha },
      { content: base, path: "src/cash.ts", ref: context.baseSha },
    ],
  };
  const stitched = "alpha tail witness'; const base = 'beta head witness";
  const segments = requirementEvidence(
    { quote: stitched, sourceFile: "src/cash.ts" },
    junction
  );
  expect(segments).toHaveLength(3);
  expect(quoteHasWitness(segments.join("\n"), stitched)).toBe(true);
  expect(
    requirementHasWitness(
      { quote: stitched, sourceFile: "src/cash.ts" },
      junction
    )
  ).toBe(false);
  expect(ungroundedRequirements(cashPlan(stitched), junction)).toHaveLength(1);
});
it("accepts a quote contained in the patch alone", () => {
  const plan = cashPlan("ok: false,");
  expect(
    requirementHasWitness(
      { quote: "ok: false,", sourceFile: "src/cash.ts" },
      cashPatchOnly
    )
  ).toBe(true);
  expect(ungroundedRequirements(plan, cashPatchOnly)).toEqual([]);
  expect(validateCoverage(plan, cashPatchOnly, policyFor(), config).gate).toBe(
    "complete"
  );
});
it("accepts a reflowed quote contained in one content segment alone", () => {
  // Le patch seul refuse cette citation recollée : c'est le contenu de tête,
  // segment à part entière, qui la porte.
  expect(
    requirementHasWitness(
      { quote: REFLOWED_QUOTE, sourceFile: "src/cash.ts" },
      cashPatchOnly
    )
  ).toBe(false);
  expect(
    requirementHasWitness(
      { quote: REFLOWED_QUOTE, sourceFile: "src/cash.ts" },
      reflowedCashContext
    )
  ).toBe(true);
});

it("names the rejected quote in the refusal, bounded to its short form", () => {
  const plan = cashPlan(REFLOWED_QUOTE.replace("false", "true"));
  const [refusal] = ungroundedPlanRefusals(
    plan,
    reflowedCashContext,
    policyFor()
  );
  expect(refusal).toContain("No source witness for cash: src/cash.ts");
  expect(refusal).toContain(
    `Rejected quote: ${JSON.stringify(REFLOWED_QUOTE.replace("false", "true"))}`
  );
  const long = `return { ok: false, code: ${"x".repeat(200)} };`;
  const [longRefusal = ""] = ungroundedPlanRefusals(
    cashPlan(long),
    reflowedCashContext,
    policyFor()
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
  const [refusal] = ungroundedPlanRefusals(plan, pageContext, policyFor());
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
  const [refusal] = ungroundedPlanRefusals(plan, misattributed, policyFor());
  expect(refusal).toContain("The quote appears verbatim in src/cash.ts");
});

/**
 * Cas réel du run 2f0511fd (lot H) : le plan déclarait `apps/web/app/page.tsx`
 * comme seule source du scénario de caisse, et citait pourtant le code du module
 * de caisse, importé par la page. La citation n'existe donc dans aucun fichier
 * déclaré, la réattribution ne peut rien réparer, et le refus ne nommait ni
 * l'exigence fautive, ni sa citation, ni le fichier qui la porte : le
 * planificateur reconstruisait la même citation et le run mourait avant toute
 * exécution.
 */
const CASH_MODULE_LINE =
  "export function countCash(quantities: CashQuantities = {}): CashCountResult {";
const CASH_MODULE_PATH = "apps/web/app/caisse.ts";
const CASH_PAGE_PATH = "apps/web/app/page.tsx";
const cashPageOnly: PrContext = contextWith([
  {
    filename: CASH_PAGE_PATH,
    patch: "+ import { countCash } from './caisse';",
  },
]);
const cashMisattribution: PrContext = contextWith([
  {
    filename: CASH_PAGE_PATH,
    patch: "+ import { countCash } from './caisse';",
  },
  { filename: CASH_MODULE_PATH, patch: `+ ${CASH_MODULE_LINE}` },
]);
function cashMisattributionPlan(): Plan {
  return planWithWitnesses([
    {
      id: "caisse-comptage-juste-et-cloture",
      sourceFiles: [CASH_PAGE_PATH],
      requirements: [{ sourceFile: CASH_PAGE_PATH, quote: CASH_MODULE_LINE }],
    },
  ]);
}

it("names the faulty requirement, its quote and the changed file that carries it", () => {
  const plan = cashMisattributionPlan();
  // Le gate ne bouge pas : la citation n'existe dans aucun fichier déclaré.
  expect(ungroundedRequirements(plan, cashMisattribution)).toHaveLength(1);
  const refusal = refusalOfPlan(plan, cashMisattribution, policyFor());
  expect(refusal.code).toBe("REQUIREMENT_UNGROUNDED");
  // L'exigence est nommée par son rang dans le scénario, le fichier déclaré et
  // la citation introuvable, jamais par le seul couple scénario/fichier.
  expect(refusal.message).toBe(
    `No source witness for caisse-comptage-juste-et-cloture: ${CASH_PAGE_PATH} (requirement 1). Rejected quote: ${JSON.stringify(CASH_MODULE_LINE)}`
  );
  const [refusalLine = ""] = ungroundedPlanRefusals(
    plan,
    cashMisattribution,
    policyFor()
  );
  // Le fichier qui porte réellement la citation est proposé parce que la PR le
  // change : le déclarer et lui attribuer l'exigence est un remède que le gate
  // accepte.
  expect(refusalLine).toContain(
    `The quote appears verbatim in ${CASH_MODULE_PATH}; declare that file and attribute the requirement to it.`
  );
  expect(refusalLine).not.toContain("this PR does not change");
});

it("says no changed file carries the quote and proposes none outside the diff", () => {
  const plan = cashMisattributionPlan();
  // Le module de caisse n'appartient pas au diff : rien à déclarer, et le
  // remède légal se limite au fichier déclaré.
  const [refusalLine = ""] = ungroundedPlanRefusals(
    plan,
    cashPageOnly,
    policyFor()
  );
  expect(refusalLine).toContain(
    `No source witness for caisse-comptage-juste-et-cloture: ${CASH_PAGE_PATH}`
  );
  expect(refusalLine).toContain(JSON.stringify(CASH_MODULE_LINE));
  expect(refusalLine).toContain(
    "The quote exists in no file this PR changes; quote a real line of the declared file instead."
  );
  // Un fichier de contexte qui porte la citation reste hors diff : il n'est
  // jamais proposé comme source à déclarer, la validation le refuserait.
  const contextOnly: PrContext = {
    ...cashPageOnly,
    context: [
      { content: CASH_MODULE_LINE, path: CASH_MODULE_PATH, ref: context.sha },
    ],
  };
  const [outsideLine = ""] = ungroundedPlanRefusals(
    plan,
    contextOnly,
    policyFor()
  );
  expect(outsideLine).toContain(
    `${CASH_MODULE_PATH}, which this PR does not change`
  );
  expect(outsideLine).not.toContain("declare that file");
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

/**
 * La citation exacte mais sans contenu visible d'un fichier critique laisse le
 * fichier sans témoin, mais le remède ne peut pas demander une citation déjà
 * présente : le planificateur renverrait la même et tournerait pour rien. Le
 * refus distingue donc la substance de l'existence, pour les deux moitiés du
 * message — le détail par fichier et la classe fatale agrégée.
 */
it("asks for substance, not presence, when an exact quote carries no visible content", () => {
  const separator = "// ------ --";
  const weak = planWithWitnesses([
    {
      id: "logic",
      sourceFiles: ["src/a.ts"],
      requirements: [{ sourceFile: "src/a.ts", quote: separator }],
    },
  ]);
  const context = contextWith([
    { filename: "src/a.ts", patch: `+ ${separator}` },
  ]);
  const [line = ""] = unwitnessedPlanRefusals(weak, context, policyFor());
  expect(line).toContain("A requirement already cites src/a.ts");
  expect(line).not.toContain("Add a requirement whose quote exists verbatim");
  // Le seul repli proposé reste le skip approuvé, que le gate accepterait.
  expect(line).toContain(".canary/qa.json");
  expect(refusalOfPlan(weak, context, policyFor()).code).toBe(
    "REQUIREMENT_UNGROUNDED"
  );
  // Une citation réellement absente garde le remède d'existence : la
  // distinction n'inverse pas le cas d'origine.
  const missing = planWithWitnesses([
    {
      id: "flow",
      sourceFiles: ["src/a.ts"],
      requirements: [{ sourceFile: "src/a.ts", quote: "Alpha absent text" }],
    },
  ]);
  const [absentLine = ""] = unwitnessedPlanRefusals(
    missing,
    context,
    policyFor()
  );
  expect(absentLine).toContain(
    "Add a requirement whose quote exists verbatim in src/a.ts"
  );
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

/**
 * Lot F, cas réel (runs c7d46e91 et 973cf40f) : le planificateur a recousu deux
 * lignes réelles de `cash.spec.ts` — sa ligne 47 et sa ligne 55 — en une
 * assertion qui n'existe dans aucune version du fichier ni dans aucun patch de
 * la PR. Le refus reste dû ; ce que la PR change, c'est la production de la
 * citation et l'aide à la réparation.
 */
const CASH_SPEC_PATH = "packages/domain/src/__tests__/cash.spec.ts";
const CASH_SPEC_LINES = [
  'import { describe, expect, it } from "vitest";', // 1
  'import { countCash } from "../src/cash";', // 2
  "", // 3
  'describe("countCash", () => {', // 4
  ...Array.from({ length: 42 }, (_, index) => `  // cas ${index + 5}`), // 5..46
  '  const result = countCash({ "500": "3,5" });', // 47
  ...Array.from({ length: 7 }, (_, index) => `  // étape ${index + 48}`), // 48..54
  "  expect(result.ok).toBe(false);", // 55
  "});", // 56
];
const CASH_SPEC_FILE = CASH_SPEC_LINES.join("\n");
/** Citation recousue du lot F, octet pour octet : 51 caractères, ASCII. */
const STITCHED_QUOTE = 'expect(countCash({ "500": "3,5" }).ok).toBe(false);';
const cashSpecContext: PrContext = {
  ...contextWith([
    {
      filename: CASH_SPEC_PATH,
      patch: [
        "@@ -46,3 +46,4 @@",
        "   // cas 46",
        '   const result = countCash({ "500": "3,5" });',
        "+  // commentaire ajouté",
        "   // étape 48",
      ].join("\n"),
    },
  ]),
  context: [
    { content: CASH_SPEC_FILE, path: CASH_SPEC_PATH, ref: context.sha },
  ],
};
function cashSpecPlan(quote: string): Plan {
  return planWithWitnesses([
    {
      id: "cash",
      sourceFiles: [CASH_SPEC_PATH],
      requirements: [{ sourceFile: CASH_SPEC_PATH, quote }],
    },
  ]);
}

it("refuses a quote stitched from two real lines and proposes real lines instead", () => {
  expect(STITCHED_QUOTE).toHaveLength(51);
  expect(CASH_SPEC_LINES[46]).toBe(
    '  const result = countCash({ "500": "3,5" });'
  );
  expect(CASH_SPEC_LINES[54]).toBe("  expect(result.ok).toBe(false);");
  expect(CASH_SPEC_FILE).not.toContain(STITCHED_QUOTE);
  const plan = cashSpecPlan(STITCHED_QUOTE);
  // Le gate n'est pas touché : la citation recousue n'a aucun témoin.
  expect(ungroundedRequirements(plan, cashSpecContext)).toHaveLength(1);
  expect(refusalOfPlan(plan, cashSpecContext, policyFor()).code).toBe(
    "REQUIREMENT_UNGROUNDED"
  );
  const [line = ""] = ungroundedPlanRefusals(
    plan,
    cashSpecContext,
    policyFor()
  );
  expect(line).toContain(`Rejected quote: ${JSON.stringify(STITCHED_QUOTE)}`);
  // Au plus deux candidats, chacun une ligne EXACTE du fichier avec son numéro.
  const suggestions = suggestedQuoteLines(
    { quote: STITCHED_QUOTE, sourceFile: CASH_SPEC_PATH },
    cashSpecContext
  );
  expect(suggestions.length).toBeGreaterThan(0);
  expect(suggestions.length).toBeLessThanOrEqual(2);
  for (const candidate of suggestions) {
    expect(CASH_SPEC_LINES[candidate.line - 1]).toBe(candidate.text);
    expect(CASH_SPEC_FILE).toContain(candidate.text);
    expect(quoteCarriesContent(candidate.text)).toBe(true);
  }
  // La ligne 47 reprend quatre des huit mots de la citation, la ligne 55 en
  // reprend quatre aussi. La 55 ne forme qu'un seul jeton de blanc — aucune
  // espace intérieure — mais elle porte des lettres : le contrat fondé sur le
  // contenu l'accepte, là où l'ancien proxy de jetons la refusait et ne
  // proposait qu'un seul candidat. Le remède ne propose jamais une ligne que le
  // plan refuserait, et il reste borné à deux.
  expect(suggestions).toEqual([
    { line: 47, text: '  const result = countCash({ "500": "3,5" });' },
    { line: 55, text: "  expect(result.ok).toBe(false);" },
  ]);
  expect(line).toContain(
    `Real lines of ${CASH_SPEC_PATH} to quote instead: 47: ${JSON.stringify(suggestions[0]!.text)}`
  );
});

it("measures the absent-quote suggestion inside the correction budget", () => {
  const plan = cashSpecPlan(STITCHED_QUOTE);
  const [line = ""] = ungroundedPlanRefusals(
    plan,
    cashSpecContext,
    policyFor()
  );
  const remedy = UNGROUNDED_ABSENT_REMEDY;
  const before = line.slice(0, line.indexOf(remedy) + remedy.length);
  // Mesure du coût réel : le rang de l'exigence ajoute 16 caractères à
  // l'identité du refus, la localisation de la citation — aucun fichier du diff
  // ne la porte ici — en ajoute 93, et la suggestion de deux lignes 172. La
  // ligne reste loin du budget restant après le préambule fatal (1860) dans la
  // correction que `model.ts` tronque à 2000 — le cas intégré est mesuré par
  // `unit.test.ts` ("returns real lines to quote instead of an absent quote").
  expect(before).toContain("No source witness for cash");
  expect(before).toHaveLength(236);
  expect(line).toHaveLength(501);
  expect(line.length - before.length).toBe(265);
});

it("proposes no line when none overlaps the quote", () => {
  const invented = "let totally unrelated invented statement here;";
  expect(
    suggestedQuoteLines(
      { quote: invented, sourceFile: CASH_SPEC_PATH },
      cashSpecContext
    )
  ).toEqual([]);
  const [line = ""] = ungroundedPlanRefusals(
    cashSpecPlan(invented),
    cashSpecContext,
    policyFor()
  );
  expect(line).not.toContain("to quote instead");
});

it("proposes no line of the cited file when the quote exists in another file", () => {
  const variant = 'const result = countCash({ "500": "3,6" });';
  const elsewhere: PrContext = {
    ...cashSpecContext,
    files: [
      ...cashSpecContext.files,
      {
        filename: "src/form.ts",
        status: "modified",
        patch: `+ ${variant}`,
      },
    ],
    context: [
      ...cashSpecContext.context,
      { content: variant, path: "src/form.ts", ref: context.sha },
    ],
  };
  // La ligne 47 du fichier cité recouvre largement la citation, donc le critère
  // la proposerait ; mais la citation existe mot pour mot ailleurs, et le remède
  // est alors l'attribution à l'autre fichier, pas une autre ligne de celui-ci.
  expect(
    suggestedQuoteLines(
      { quote: variant, sourceFile: CASH_SPEC_PATH },
      elsewhere
    ).length
  ).toBeGreaterThan(0);
  const [line = ""] = ungroundedPlanRefusals(
    cashSpecPlan(variant),
    elsewhere,
    policyFor()
  );
  expect(line).toContain("The quote appears verbatim in src/form.ts");
  expect(line).not.toContain("to quote instead");
});

/**
 * Le remède d'une citation qui existe mot pour mot dans un autre fichier est la
 * réattribution, jamais une ligne du fichier cité : la ligne 47 recouvre
 * largement la citation et le critère la proposerait, mais l'envoyer
 * consommerait la tentative de correction du planificateur pour une preuve
 * fausse.
 */
it("reassigns a quote that exists in another file instead of proposing a line", () => {
  const variant = 'const result = countCash({ "500": "3,6" });';
  const elsewhere: PrContext = {
    ...cashSpecContext,
    files: [
      ...cashSpecContext.files,
      { filename: "src/form.ts", status: "modified", patch: `+ ${variant}` },
    ],
    context: [
      ...cashSpecContext.context,
      { content: variant, path: "src/form.ts", ref: context.sha },
    ],
  };
  const requirement = { quote: variant, sourceFile: CASH_SPEC_PATH };
  expect(suggestedQuoteLines(requirement, elsewhere).length).toBeGreaterThan(0);
  expect(absentRequirementRemedy(requirement, elsewhere)).toBe(
    "The quote appears verbatim in src/form.ts; declare that file and attribute the requirement to it."
  );
});

it("proposes a real line of the cited file when the quote exists nowhere", () => {
  const remedy = absentRequirementRemedy(
    { quote: STITCHED_QUOTE, sourceFile: CASH_SPEC_PATH },
    cashSpecContext
  );
  const candidates = suggestedQuoteLines(
    { quote: STITCHED_QUOTE, sourceFile: CASH_SPEC_PATH },
    cashSpecContext
  );
  // Chaque ligne citée est celle du fichier, avec son numéro — y compris la
  // ligne 55, sans blanc intérieur, que le contrat fondé sur le contenu accepte.
  expect(candidates.length).toBeLessThanOrEqual(2);
  for (const { line, text } of candidates) {
    expect(CASH_SPEC_LINES[line - 1]).toBe(text);
  }
  expect(remedy).toBe(
    `Real lines of ${CASH_SPEC_PATH} to quote instead: 47: ${JSON.stringify('  const result = countCash({ "500": "3,5" });')}, 55: ${JSON.stringify("  expect(result.ok).toBe(false);")}.`
  );
});

/**
 * Lot G, cas réel (run 925abf20, PR pharmania/arpilabe-pilotage#17, fusion
 * 1342929) : le planificateur a recollé deux attributs d'une même expression JSX
 * en supprimant `aria-label="Montant d'espèces attendu"` et tout ce qui les
 * séparait. La citation — 61 caractères, mesurée — n'existe nulle part dans le
 * fichier ni dans le patch ; ses deux fragments, eux, existent chacun sur une
 * ligne réelle DIFFÉRENTE. Les deux lignes du cas réel dépassent la borne d'une
 * suggestion de ligne (120), donc le recouvrement de jetons ne proposait rien et
 * le planificateur ne recevait que le conseil générique, qu'il a reproduit.
 */
const PAGE_TSX_PATH = "apps/web/app/page.tsx";
/** Fragment A, recopié du fichier : l'attribut de saisie décimale. */
const STITCH_FRAGMENT_A = 'inputMode="decimal"';
/** Fragment B, recopié du fichier : l'attribut d'invalidité de l'autre champ. */
const STITCH_FRAGMENT_B = "aria-invalid={expected.ok?undefined:true}";
/** Citation recousue du lot G, octet pour octet : 61 caractères, ASCII. */
const STITCHED_JSX_QUOTE = `${STITCH_FRAGMENT_A} ${STITCH_FRAGMENT_B}`;
const PAGE_TSX_LINE_61 = `        <input value={e=>onChange({expected:e.target.value})} disabled={closed} inputMode="decimal" aria-label="Montant d'espèces attendu" />`;
const PAGE_TSX_LINE_63 = `        <input value={expected.input} inputMode="numeric" aria-label="Total attendu" aria-invalid={expected.ok?undefined:true} />`;
const PAGE_TSX_FILE = [
  ...Array.from({ length: 60 }, (_, index) => `  // ligne ${index + 1}`),
  PAGE_TSX_LINE_61,
  "  // ligne 62",
  PAGE_TSX_LINE_63,
].join("\n");
const pageTsxContext: PrContext = {
  ...contextWith([
    {
      filename: PAGE_TSX_PATH,
      patch: [
        "@@ -61,2 +61,3 @@",
        ` ${PAGE_TSX_LINE_61}`,
        "   // ligne 62",
        `+${PAGE_TSX_LINE_63}`,
      ].join("\n"),
    },
  ]),
  context: [{ content: PAGE_TSX_FILE, path: PAGE_TSX_PATH, ref: context.sha }],
};
function pageTsxPlan(quote: string): Plan {
  return planWithWitnesses([
    {
      id: "cash-input",
      sourceFiles: [PAGE_TSX_PATH],
      requirements: [{ sourceFile: PAGE_TSX_PATH, quote }],
    },
  ]);
}

it("names the two fragments of a stitched quote and their two real lines", () => {
  // Le cas mesuré : la citation n'existe nulle part, ses moitiés existent chacune
  // sur une ligne différente, et ces lignes sont trop longues pour être
  // proposées entières par le recouvrement de jetons.
  expect(STITCHED_JSX_QUOTE).toHaveLength(61);
  expect(PAGE_TSX_FILE).not.toContain(STITCHED_JSX_QUOTE);
  expect(PAGE_TSX_LINE_61.length).toBeGreaterThan(120);
  expect(PAGE_TSX_LINE_63.length).toBeGreaterThan(120);
  expect(
    suggestedQuoteLines(
      { quote: STITCHED_JSX_QUOTE, sourceFile: PAGE_TSX_PATH },
      pageTsxContext
    )
  ).toEqual([]);
  const fragments = stitchedQuoteFragments(
    { quote: STITCHED_JSX_QUOTE, sourceFile: PAGE_TSX_PATH },
    pageTsxContext
  );
  // Exactement deux fragments, chacun recopié de la citation et retrouvé tel
  // quel sur sa ligne réelle : le premier sur la ligne 61, le second sur la 63.
  expect(fragments.map((item) => item.fragment)).toEqual([
    STITCH_FRAGMENT_A,
    STITCH_FRAGMENT_B,
  ]);
  expect(fragments.map((item) => item.line)).toEqual([61, 63]);
  const lines = PAGE_TSX_FILE.split("\n");
  for (const item of fragments) {
    expect(STITCHED_JSX_QUOTE).toContain(item.fragment);
    expect(lines[item.line - 1]).toContain(item.fragment);
    // Le candidat est une portion EXACTE de la ligne réelle, jamais un texte
    // inventé ni un jeton rogné, et il passe le contrat de citation du fichier
    // critique : le gate accepterait le plan qui le cite.
    expect(PAGE_TSX_FILE).toContain(item.candidate);
    expect(lines[item.line - 1]).toContain(item.candidate);
    expect(item.candidate).toContain(item.fragment);
    expect(item.candidate.length).toBeLessThanOrEqual(120);
    expect(quoteCarriesContent(item.candidate)).toBe(true);
    expect(
      validateCoverage(
        pageTsxPlan(item.candidate),
        pageTsxContext,
        policyFor(),
        config
      ).gate
    ).toBe("complete");
  }
  expect(fragments).toEqual([
    {
      candidate:
        'disabled={closed} inputMode="decimal" aria-label="Montant d\'espèces attendu" />',
      fragment: STITCH_FRAGMENT_A,
      line: 61,
    },
    {
      candidate:
        'value={expected.input} inputMode="numeric" aria-label="Total attendu" aria-invalid={expected.ok?undefined:true} />',
      fragment: STITCH_FRAGMENT_B,
      line: 63,
    },
  ]);
  // Le gate n'est pas touché : la citation recousue n'a toujours aucun témoin.
  expect(
    ungroundedRequirements(pageTsxPlan(STITCHED_JSX_QUOTE), pageTsxContext)
  ).toHaveLength(1);
  expect(
    refusalOfPlan(pageTsxPlan(STITCHED_JSX_QUOTE), pageTsxContext, policyFor())
      .code
  ).toBe("REQUIREMENT_UNGROUNDED");
});

it("puts the stitch diagnosis before the generic advice in the refusal", () => {
  const [line = ""] = ungroundedPlanRefusals(
    pageTsxPlan(STITCHED_JSX_QUOTE),
    pageTsxContext,
    policyFor()
  );
  const remedy = stitchedQuoteRemedy(
    { quote: STITCHED_JSX_QUOTE, sourceFile: PAGE_TSX_PATH },
    pageTsxContext
  );
  expect(remedy).toBe(
    `Your quote assembles fragments from different lines: ${JSON.stringify(STITCH_FRAGMENT_A)} is line 61, ${JSON.stringify(STITCH_FRAGMENT_B)} is line 63. Quote one of these real fragments of ${PAGE_TSX_PATH} instead: 61: ${JSON.stringify('disabled={closed} inputMode="decimal" aria-label="Montant d\'espèces attendu" />')}, 63: ${JSON.stringify('value={expected.input} inputMode="numeric" aria-label="Total attendu" aria-invalid={expected.ok?undefined:true} />')}.`
  );
  // Le diagnostic de recousure passe avant le conseil générique, et il porte à
  // lui seul les lignes réelles à citer : une seule suggestion par citation.
  expect(line).toContain("No source witness for cash-input");
  expect(line).toContain(remedy);
  expect(line.indexOf(remedy)).toBeLessThan(
    line.indexOf(UNGROUNDED_ABSENT_REMEDY)
  );
  expect(line.indexOf(remedy)).toBeGreaterThan(
    line.indexOf("Rejected quote: ")
  );
  expect(line).not.toContain("Real lines of");
  // Le remède partagé avec la classe fatale agrégée est le même texte : le
  // préambule fatal protège donc ce diagnostic de la troncature.
  expect(
    absentRequirementRemedy(
      { quote: STITCHED_JSX_QUOTE, sourceFile: PAGE_TSX_PATH },
      pageTsxContext
    )
  ).toBe(remedy);
});

it("falls back when only one fragment of a stitched quote exists", () => {
  // Un seul fragment existe : le fichier ne porte nulle part le second, donc
  // annoncer une recousure nommerait une ligne fausse. Le repli reste le
  // remède d'aujourd'hui — conseil générique, sans candidat ici : les deux
  // lignes du fichier dépassent la borne de `suggestedQuoteLines`.
  const partial = `${STITCH_FRAGMENT_A} aria-invalid={absent.ok?undefined:true}`;
  expect(
    stitchedQuoteFragments(
      { quote: partial, sourceFile: PAGE_TSX_PATH },
      pageTsxContext
    )
  ).toEqual([]);
  expect(
    stitchedQuoteRemedy(
      { quote: partial, sourceFile: PAGE_TSX_PATH },
      pageTsxContext
    )
  ).toBe("");
  const [line = ""] = ungroundedPlanRefusals(
    pageTsxPlan(partial),
    pageTsxContext,
    policyFor()
  );
  expect(line).toContain("No source witness for cash-input");
  expect(line).not.toContain("assembles fragments");
  expect(line).not.toContain("to quote instead");
  expect(line).toContain(UNGROUNDED_ABSENT_REMEDY);
});

/**
 * Lot J, cas réel (run f328177b, après fusion des PR #49 et #50) : le
 * planificateur a recopié la ligne du compteur de pièces en commençant à
 * « unité » au lieu du premier caractère de la ligne, et sa copie porte en plus
 * un `:""` inventé dans la première interpolation. Le gate la refuse à juste
 * titre — aucune portion réelle du fichier ne la porte — mais le refus ne disait
 * que « No source witness for pieces-unites-sans-derive: apps/web/app/page.tsx
 * (requirement 3) », donc le planificateur recopiait la même copie et le run
 * mourait avant toute exécution (outcome blocked, 0 scénario exécuté).
 *
 * La fin de la copie, elle, est EXACTEMENT la fin de la ligne 12 : c'est cet
 * ancrage qui nomme la ligne réelle, et le refus doit dire quel début manque.
 * La ligne entière est courte — 94 caractères, gabarits compris — donc elle est
 * citable d'un seul tenant depuis son premier caractère.
 */
const COUNTED_PAGE_PATH = "apps/web/app/page.tsx";
/** Ligne 12 du fichier, octet pour octet : le gabarit du compteur de pièces. */
const COUNTED_LINE = `\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}`;
/** La même ligne telle que le patch la porte, avec son indentation. */
const COUNTED_LINE_TEXT = `  ${COUNTED_LINE}`;
/** Le début de la ligne, que la copie mesurée a laissé de côté. */
const COUNTED_LINE_HEAD = COUNTED_LINE.slice(0, COUNTED_LINE.indexOf("unité"));
const countedContext: PrContext = contextWith([
  {
    filename: COUNTED_PAGE_PATH,
    patch: [
      "@@ -11,2 +11,3 @@",
      "   // comptage des pièces",
      `+${COUNTED_LINE_TEXT}`,
    ].join("\n"),
  },
]);
function countedPlan(quote: string): Plan {
  return planWithWitnesses([
    {
      id: "pieces-unites-sans-derive",
      sourceFiles: [COUNTED_PAGE_PATH],
      requirements: [{ sourceFile: COUNTED_PAGE_PATH, quote }],
    },
  ]);
}
/** La citation mesurée : la ligne amputée de son début. */
const COUNTED_TAIL_QUOTE = `unité\${counted.totalUnits>1?"s":"":""} comptée\${counted.totalUnits>1?"s":""}`;
/** La même copie sans l'invention du milieu : le suffixe EXACT de la ligne. */
const COUNTED_CLEAN_TAIL = `unité\${counted.totalUnits>1?"s":""} comptée\${counted.totalUnits>1?"s":""}`;
/** Le cas symétrique mesuré : le début de la ligne, tronqué à la fin. */
const COUNTED_HEAD_QUOTE = `\${counted.totalUnits} unité\${counted.totalUnits>1?"s":"":""} comptée`;
/** Le début EXACT de la ligne, amputé de sa fin. */
const COUNTED_CLEAN_HEAD = `\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""} comptée`;
/** Un fragment pris à l'intérieur de la ligne : ni son début ni sa fin. */
const COUNTED_INTERIOR_QUOTE = `unité\${counted.totalUnits>1?"s":""} comptée`;

it("names the real line and the missing beginning of an amputated quote", () => {
  // La fixture n'a qu'une exigence : le rang du refus est 1 là où le run mesuré
  // portait sa troisième exigence.
  const plan = countedPlan(COUNTED_TAIL_QUOTE);
  // Le gate ne bouge pas : la copie amputée n'existe nulle part, même à
  // l'espacement près, donc elle reste refusée avant toute exécution.
  expect(ungroundedRequirements(plan, countedContext)).toHaveLength(1);
  const refusal = refusalOfPlan(plan, countedContext, policyFor());
  expect(refusal.code).toBe("REQUIREMENT_UNGROUNDED");
  expect(refusal.message).toBe(
    `No source witness for pieces-unites-sans-derive: ${COUNTED_PAGE_PATH} (requirement 1). Rejected quote: ${JSON.stringify(COUNTED_TAIL_QUOTE)}`
  );
  // Le refus nomme la ligne réelle, le début manquant et la portion exacte à
  // citer — jamais la citation fautive elle-même.
  expect(refusal.hint).toContain(`line 12 of ${COUNTED_PAGE_PATH}`);
  expect(refusal.hint).toContain("its beginning is missing");
  // Le remède ne rend plus la ligne à recopier : il donne le numéro à
  // DÉSIGNER, et le gate écrit lui-même la ligne du diff.
  expect(refusal.hint).toContain(
    `send "line": 12 for ${COUNTED_PAGE_PATH} and the gate writes that line itself`
  );
  expect(refusal.hint).not.toContain(JSON.stringify(COUNTED_LINE_TEXT));
  const [line = ""] = ungroundedPlanRefusals(plan, countedContext, policyFor());
  expect(line).toContain(`line 12 of ${COUNTED_PAGE_PATH}`);
  expect(line).toContain("its beginning is missing");
  expect(line).toContain(
    `send "line": 12 for ${COUNTED_PAGE_PATH} and the gate writes that line itself`
  );
  expect(line).not.toContain(JSON.stringify(COUNTED_LINE_TEXT));
  // Une seule suggestion par citation : la ligne réelle n'est pas répétée par le
  // recouvrement de jetons, ni par un diagnostic de recousure que la copie n'a
  // pas (ses deux moitiés vivent sur la même ligne).
  expect(line).not.toContain("Real lines of");
  expect(line).not.toContain("assembles fragments");
});

it("names the real line of a quote truncated at its end", () => {
  const plan = countedPlan(COUNTED_HEAD_QUOTE);
  expect(ungroundedRequirements(plan, countedContext)).toHaveLength(1);
  const refusal = refusalOfPlan(plan, countedContext, policyFor());
  expect(refusal.hint).toContain(`line 12 of ${COUNTED_PAGE_PATH}`);
  expect(refusal.hint).toContain("its end is missing");
  // Le remède ne rend plus la ligne à recopier : il donne le numéro à
  // DÉSIGNER, et le gate écrit lui-même la ligne du diff.
  expect(refusal.hint).toContain(
    `send "line": 12 for ${COUNTED_PAGE_PATH} and the gate writes that line itself`
  );
  expect(refusal.hint).not.toContain(JSON.stringify(COUNTED_LINE_TEXT));
  const [line = ""] = ungroundedPlanRefusals(plan, countedContext, policyFor());
  expect(line).toContain("its end is missing");
  expect(line).toContain(
    `send "line": 12 for ${COUNTED_PAGE_PATH} and the gate writes that line itself`
  );
  expect(line).not.toContain(JSON.stringify(COUNTED_LINE_TEXT));
  expect(line).not.toContain("Real lines of");
});

/**
 * Les trois formes qu'une copie amputée peut prendre, lues sur la même ligne
 * réelle : la copie est la fin de la ligne (son début manque), son début (sa fin
 * manque), ou un fragment pris à l'intérieur (les deux manquent). Le gate ne
 * refuse que des copies qui ne sont pas verbatim, donc un plan n'est jamais
 * refusé pour la troisième forme — recopiée telle quelle, elle EST un témoin —
 * mais la règle que le refus lit doit savoir la nommer, et jamais nommer un
 * texte inventé.
 */
it("reads the three shapes of an amputated copy on a real line", () => {
  const source = { sourceFile: COUNTED_PAGE_PATH };
  expect(
    amputatedQuote({ ...source, quote: COUNTED_CLEAN_TAIL }, countedContext)
  ).toEqual({
    candidate: COUNTED_LINE_TEXT,
    kind: "start",
    line: 12,
    wholeLine: true,
  });
  expect(
    amputatedQuote({ ...source, quote: COUNTED_CLEAN_HEAD }, countedContext)
  ).toEqual({
    candidate: COUNTED_LINE_TEXT,
    kind: "end",
    line: 12,
    wholeLine: true,
  });
  expect(
    amputatedQuote({ ...source, quote: COUNTED_INTERIOR_QUOTE }, countedContext)
  ).toEqual({
    candidate: COUNTED_LINE_TEXT,
    kind: "middle",
    line: 12,
    wholeLine: true,
  });
  // Aucune ligne du fichier ne porte cette copie : pas de diagnostic plutôt
  // qu'une ligne nommée au hasard.
  expect(
    amputatedQuote(
      { ...source, quote: "comptée deux fois la même pièce" },
      countedContext
    )
  ).toBeUndefined();
  // Un bord commun trop court pour désigner une ligne ne fait pas un
  // diagnostic : la copie entière n'est la fin d'aucune ligne du fichier.
  expect(
    amputatedQuote(
      { ...source, quote: "invented change return result;" },
      countedContext
    )
  ).toBeUndefined();
});
/**
 * Ligne réelle plus longue que la borne de `quoteableFragment` : aucun candidat
 * ne peut être la ligne entière, donc le refus nomme une FENÊTRE de jetons prise
 * sur cette ligne et se tait sur le premier caractère de la ligne, qu'il ne
 * demande pas de citer — la consigne et le candidat ne peuvent pas se
 * contredire.
 *
 * La ligne vit dans le contexte importé, jamais dans le diff : aucune référence
 * `line` ne peut la désigner (voir `sourceLineMaterial`), donc la forme `quote`
 * reste la seule voie et c'est elle que ce test couvre. Une ligne du même genre
 * portée par le diff reçoit, elle, le numéro à désigner.
 */
const LONG_PAGE_PATH = "apps/web/app/page.tsx";
const LONG_LINE = `  const total = reducePrices(items, (sum, item) => sum + item.price, 0); // ${"x".repeat(60)}`;
/** Une copie commencée par un texte inventé, mais dont la fin est celle de la ligne. */
const LONG_LINE_QUOTE = `  const x = reducePrices(items, (sum, item) => sum + item.price, 0); // ${"x".repeat(60)}`;
const longLineContext: PrContext = {
  ...context,
  context: [
    {
      content: [
        ...Array.from(
          { length: 20 },
          (_, index) => `  // ligne ${index + 1} du fichier`
        ),
        LONG_LINE,
      ].join("\n"),
      path: LONG_PAGE_PATH,
      ref: context.sha,
    },
  ],
};
it("names a fragment of a line too long to quote whole", () => {
  const requirement = { quote: LONG_LINE_QUOTE, sourceFile: LONG_PAGE_PATH };
  const amputated = amputatedQuote(requirement, longLineContext);
  expect(amputated).toBeDefined();
  expect(amputated?.kind).toBe("start");
  expect(amputated?.line).toBe(21);
  expect(amputated?.wholeLine).toBe(false);
  const candidate = amputated?.candidate ?? "";
  expect(candidate.length).toBeLessThan(LONG_LINE.length);
  expect(LONG_LINE).toContain(candidate);
  const remedy = amputatedQuoteRemedy(requirement, longLineContext);
  expect(remedy).toContain("too long to quote whole");
  expect(remedy).toContain(JSON.stringify(candidate));
  expect(remedy).not.toContain("whole line from its first character");
});
/**
 * Lot K, premier cas réel (run 0f8d8cd5, exigence 7 de
 * `cash-exact-count-close-reopen`, après fusion des PR #49, #50 et #51) : le
 * planificateur a recopié le gabarit du compteur en RETAPANT son interpolation
 * au lieu de la copier — la ligne écrit `${counted.totalUnits > 1 ? "s" : ""}`,
 * la copie s'arrête sur `${counted.totalUnits>` après avoir perdu l'espace qui
 * suit. Le gate refuse la copie à juste titre — elle n'existe nulle part dans le
 * fichier — mais le refus ne disait que « No source witness » suivi du conseil
 * générique : il ne nommait ni la ligne réelle ni ce que la recopie avait changé,
 * donc le planificateur reconstruisait la même copie et le run mourait avant
 * toute exécution (outcome blocked, 0 scénario exécuté, 0 reprise).
 */
const RETYPED_TEMPLATE_PATH = "apps/web/app/page.tsx";
/** La ligne 12 du fichier, telle que le patch la porte : gabarit et ternaire. */
const RETYPED_TEMPLATE_LINE = `        {counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits > 1 ? "s" : ""}\` : null}`;
/** La citation mesurée, octet pour octet : elle s'arrête sur le `>` du ternaire. */
const RETYPED_TEMPLATE_QUOTE =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: citation recopiée du fichier, pas un gabarit à interpoler.
  "{counted.ok?`${counted.totalUnits} unité${counted.totalUnits>";
/** La même recopie menée jusqu'au bout, l'interpolation sans ses espaces. */
const RETYPED_TEMPLATE_FULL = `{counted.ok?\`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""}\` : null}`;
const retypedTemplateContext: PrContext = contextWith([
  {
    filename: RETYPED_TEMPLATE_PATH,
    patch: [
      "@@ -11,2 +11,3 @@",
      "   // comptage des pièces",
      `+${RETYPED_TEMPLATE_LINE}`,
    ].join("\n"),
  },
]);
function retypedTemplatePlan(quote: string): Plan {
  return planWithWitnesses([
    {
      id: "cash-exact-count-close-reopen",
      sourceFiles: [RETYPED_TEMPLATE_PATH],
      requirements: [{ sourceFile: RETYPED_TEMPLATE_PATH, quote }],
    },
  ]);
}
it("names the real line and the retyped interpolation of a template literal", () => {
  const requirement = {
    quote: RETYPED_TEMPLATE_QUOTE,
    sourceFile: RETYPED_TEMPLATE_PATH,
  };
  // Le gate ne bouge pas : la copie retapée n'a aucun témoin.
  expect(requirementHasWitness(requirement, retypedTemplateContext)).toBe(
    false
  );
  expect(
    ungroundedRequirements(
      retypedTemplatePlan(RETYPED_TEMPLATE_QUOTE),
      retypedTemplateContext
    )
  ).toHaveLength(1);
  const divergence = quoteDivergence(requirement, retypedTemplateContext);
  // La ligne réelle est nommée, et les divergences avec elle : la copie s'arrête
  // sur `>` là où la ligne écrit l'espace puis le reste du ternaire.
  expect(divergence).toMatchObject({
    candidate: RETYPED_TEMPLATE_LINE,
    faults: [
      {
        copy: ">",
        kind: "invented",
        real: ' > 1 ? "s" : ""}` : null}',
      },
    ],
    kind: "invented",
    line: 12,
    wholeLine: true,
  });
  // Aucun texte inventé : le fragment réel le plus proche et le candidat sont
  // recopiés de la ligne, la fenêtre de la copie l'est de la copie.
  expect(RETYPED_TEMPLATE_LINE).toContain(divergence?.closest ?? "");
  expect(RETYPED_TEMPLATE_QUOTE).toContain(divergence?.faults?.[0]?.copy ?? "");
  const [line = ""] = ungroundedPlanRefusals(
    retypedTemplatePlan(RETYPED_TEMPLATE_QUOTE),
    retypedTemplateContext,
    policyFor()
  );
  expect(line).toContain("No source witness for cash-exact-count-close-reopen");
  expect(line).toContain(`copied from line 12 of ${RETYPED_TEMPLATE_PATH}`);
  expect(line).toContain(
    `the file writes ${JSON.stringify(' > 1 ? "s" : ""}` : null}')} where your copy has ${JSON.stringify(">")}`
  );
  expect(line).toContain(
    `send "line": 12 for ${RETYPED_TEMPLATE_PATH} and the gate writes that line itself`
  );
  expect(line).not.toContain(JSON.stringify(RETYPED_TEMPLATE_LINE));
  // La cause réelle est nommée AVANT l'amputation de bord : c'est la divergence
  // qui a fait refuser la copie, et c'est elle que le planificateur doit lire en
  // premier — l'inverse était le défaut mesuré du lot K.
  expect(line.indexOf("it differs from that line")).toBeLessThan(
    line.indexOf("its end is missing")
  );
  // Le diagnostic de la copie porte déjà la ligne à citer : le recouvrement de
  // jetons ne propose pas une autre ligne par-dessus.
  expect(line).not.toContain("Real lines of");
  // Le refus par exigence — celui que lève le contrôle final — porte le même
  // diagnostic, donc la correction reçoit la ligne réelle dans les deux canaux.
  const refusal = refusalOfPlan(
    retypedTemplatePlan(RETYPED_TEMPLATE_QUOTE),
    retypedTemplateContext,
    policyFor()
  );
  expect(refusal.code).toBe("REQUIREMENT_UNGROUNDED");
  expect(refusal.hint).toContain(
    `copied from line 12 of ${RETYPED_TEMPLATE_PATH}`
  );
});
it("names the whitespace a retyped interpolation changed, without a false amputation", () => {
  const requirement = {
    quote: RETYPED_TEMPLATE_FULL,
    sourceFile: RETYPED_TEMPLATE_PATH,
  };
  expect(requirementHasWitness(requirement, retypedTemplateContext)).toBe(
    false
  );
  const divergence = quoteDivergence(requirement, retypedTemplateContext);
  // La copie atteint la fin de la ligne : seuls les blancs de l'interpolation
  // diffèrent, et c'est ce que le refus doit dire — sa fin ne manque pas. Les
  // trois écarts de blancs sont nommés, pas seulement le premier.
  expect(divergence).toMatchObject({
    candidate: RETYPED_TEMPLATE_LINE,
    faults: [
      { copy: "totalUnits>1", kind: "whitespace", real: "totalUnits > 1" },
      { copy: '1?"s', kind: "whitespace", real: '1 ? "s' },
      {
        copy: 's":""}` : null',
        kind: "whitespace",
        real: 's" : ""}` : null',
      },
    ],
    kind: "whitespace",
    line: 12,
    wholeLine: true,
  });
  const [line = ""] = ungroundedPlanRefusals(
    retypedTemplatePlan(RETYPED_TEMPLATE_FULL),
    retypedTemplateContext,
    policyFor()
  );
  expect(line).toContain("copied from line 12");
  expect(line).toContain("only in whitespace");
  expect(line).toContain(
    `the file writes ${JSON.stringify("totalUnits > 1")} where your copy has ${JSON.stringify("totalUnits>1")}`
  );
  expect(line).toContain(
    `send "line": 12 for ${RETYPED_TEMPLATE_PATH} and the gate writes that line itself`
  );
  expect(line).not.toContain(JSON.stringify(RETYPED_TEMPLATE_LINE));
  // La cause d'amputation qui était nommée à tort disparaît : la copie couvre
  // toute la ligne, elle n'en est pas un bord tronqué.
  expect(line).not.toContain("its end is missing");
  expect(line).not.toContain("only the beginning of that line");
});
/**
 * Lot K, second cas réel (run 7eef87d4, exigence 1 de
 * `caisse-comptage-par-pharmacie`) : le planificateur a retapé la flèche typée
 * `const updateCash = (patch: Partial<CashSession>) => ...` en retirant les
 * espaces de son `=`, de son `:` et de son `=>`. La copie rapportée est tronquée
 * par l'ellipse du rapport ; la recopie mesurée commence par ces caractères et
 * existe nulle part dans le fichier. La copie n'a AUCUN blanc, donc aucun
 * découpage ne la rattache à une ligne : le diagnostic d'amputation ne pouvait
 * rien nommer, et seul le conseil générique était rendu.
 */
const RETYPED_ARROW_PATH = "apps/web/app/page.tsx";
/** La ligne réelle de la flèche typée, espaces compris. */
const RETYPED_ARROW_LINE =
  "  const updateCash = (patch: Partial<CashSession>) => setCash((prev) => ({ ...prev, ...patch }));";
/** La recopie mesurée : la flèche typée sans ses espaces. */
const RETYPED_ARROW_QUOTE =
  "const updateCash=(patch:Partial<CashSession>)=>setCash((prev)=>({...prev,...patch}))";
/**
 * La copie telle que le rapport du lot K la montre, coupée en plein jeton : le
 * planificateur avait recopié au moins ces caractères, un peu plus loin.
 */
const RETYPED_ARROW_CUT = "const updateCash=(patch:Partial<CashSessio";
const retypedArrowContext: PrContext = contextWith([
  {
    filename: RETYPED_ARROW_PATH,
    patch: [
      "@@ -30,2 +30,3 @@",
      "   // mise à jour de la caisse",
      `+${RETYPED_ARROW_LINE}`,
    ].join("\n"),
  },
]);
function retypedArrowPlan(quote: string): Plan {
  return planWithWitnesses([
    {
      id: "caisse-comptage-par-pharmacie",
      sourceFiles: [RETYPED_ARROW_PATH],
      requirements: [{ sourceFile: RETYPED_ARROW_PATH, quote }],
    },
  ]);
}
it("names the real line of a retyped typed arrow and quotes it whole", () => {
  const requirement = {
    quote: RETYPED_ARROW_QUOTE,
    sourceFile: RETYPED_ARROW_PATH,
  };
  expect(requirementHasWitness(requirement, retypedArrowContext)).toBe(false);
  const divergence = quoteDivergence(requirement, retypedArrowContext);
  // La copie a retiré TOUS ses blancs, et sa fin recopiée diffère aussi : le
  // refus dit les deux, chaque écart nommé dans l'ordre de la copie.
  expect(divergence).toMatchObject({
    candidate: RETYPED_ARROW_LINE,
    faults: [
      {
        copy: "updateCash=(patch",
        kind: "whitespace",
        real: "updateCash = (patch",
      },
      { copy: "patch:Partial", kind: "whitespace", real: "patch: Partial" },
      {
        copy: "CashSession>)=>setCash",
        kind: "whitespace",
        real: "CashSession>) => setCash",
      },
      {
        copy: "prev)=>({...prev",
        kind: "whitespace",
        real: "prev) => ({ ...prev",
      },
      { copy: "prev,...patch", kind: "whitespace", real: "prev, ...patch" },
      { copy: "}))", kind: "invented", real: " }));" },
    ],
    kind: "invented",
    line: 31,
    wholeLine: true,
  });
  expect(RETYPED_ARROW_LINE).toContain(divergence?.closest ?? "");
  const [line = ""] = ungroundedPlanRefusals(
    retypedArrowPlan(RETYPED_ARROW_QUOTE),
    retypedArrowContext,
    policyFor()
  );
  expect(line).toContain("No source witness for caisse-comptage-par-pharmacie");
  expect(line).toContain(`copied from line 31 of ${RETYPED_ARROW_PATH}`);
  // Le signe de la fin recopiée est nommé, et le refus ne dit plus que les
  // blancs seuls diffèrent.
  expect(line).toContain("in whitespace and in characters");
  expect(line).not.toContain("only in whitespace");
  expect(line).toContain(
    `the file writes ${JSON.stringify(" }));")} where your copy has ${JSON.stringify("}))")}`
  );
  expect(line).toContain(
    `send "line": 31 for ${RETYPED_ARROW_PATH} and the gate writes that line itself`
  );
  expect(line).not.toContain(JSON.stringify(RETYPED_ARROW_LINE));
  // Aucun diagnostic d'amputation ici — la copie n'a pas de bord à nommer — et
  // pas de suggestion par-dessus : le remède porte la ligne réelle.
  expect(line).not.toContain("its end is missing");
  expect(line).not.toContain("Real lines of");
});
it("names the real line of the arrow copy the report shows, cut mid-token", () => {
  const requirement = {
    quote: RETYPED_ARROW_CUT,
    sourceFile: RETYPED_ARROW_PATH,
  };
  expect(requirementHasWitness(requirement, retypedArrowContext)).toBe(false);
  const divergence = quoteDivergence(requirement, retypedArrowContext);
  // La coupe ne fait pas taire le diagnostic : la copie est un préfixe de la
  // ligne, donc ses seuls écarts sont ses blancs retirés, et les deux sont dits.
  expect(divergence).toMatchObject({
    candidate: RETYPED_ARROW_LINE,
    faults: [
      {
        copy: "updateCash=(patch",
        kind: "whitespace",
        real: "updateCash = (patch",
      },
      { copy: "patch:Partial", kind: "whitespace", real: "patch: Partial" },
    ],
    kind: "whitespace",
    line: 31,
    wholeLine: true,
  });
  const [line = ""] = ungroundedPlanRefusals(
    retypedArrowPlan(RETYPED_ARROW_CUT),
    retypedArrowContext,
    policyFor()
  );
  // La coupe en plein jeton ne fait pas taire le diagnostic : la ligne réelle
  // est nommée, et le refus ne revendique aucun bord manquant qu'il n'a pas lu.
  expect(line).toContain(`copied from line 31 of ${RETYPED_ARROW_PATH}`);
  expect(line).toContain("only in whitespace");
  expect(line).toContain(
    `send "line": 31 for ${RETYPED_ARROW_PATH} and the gate writes that line itself`
  );
  expect(line).not.toContain(JSON.stringify(RETYPED_ARROW_LINE));
  expect(line).not.toContain("its end is missing");
  expect(line).not.toContain("its beginning is missing");
});
/**
 * Caractères INVENTÉS au milieu d'une copie : la copie garde les espaces de la
 * ligne et change un seul chiffre, donc le premier écart est un mot, pas un
 * blanc. Le refus doit nommer le texte réel que la ligne écrit là et non
 * seulement une amputation de bord, qui n'existe pas ici.
 */
const INVENTED_CHAR_PATH = "apps/web/app/page.tsx";
const INVENTED_CHAR_LINE = `  const result = countCash({ "500": "3,5" }) + countCash({ "200": "1,2" });`;
const INVENTED_CHAR_QUOTE = `  const result = countCash({ "500": "3,5" }) + countCash({ "200": "1,3" });`;
const inventedCharContext: PrContext = contextWith([
  {
    filename: INVENTED_CHAR_PATH,
    patch: ["@@ -40,2 +40,3 @@", "   // total", `+${INVENTED_CHAR_LINE}`].join(
      "\n"
    ),
  },
]);
function inventedCharPlan(quote: string): Plan {
  return planWithWitnesses([
    {
      id: "cash-total",
      sourceFiles: [INVENTED_CHAR_PATH],
      requirements: [{ sourceFile: INVENTED_CHAR_PATH, quote }],
    },
  ]);
}
it("names the characters invented inside a copy of a real line", () => {
  const requirement = {
    quote: INVENTED_CHAR_QUOTE,
    sourceFile: INVENTED_CHAR_PATH,
  };
  expect(requirementHasWitness(requirement, inventedCharContext)).toBe(false);
  const divergence = quoteDivergence(requirement, inventedCharContext);
  expect(divergence).toMatchObject({
    candidate: INVENTED_CHAR_LINE,
    faults: [{ copy: ',3" });', kind: "invented", real: ',2" });' }],
    kind: "invented",
    line: 41,
    wholeLine: true,
  });
  // La fenêtre nommée est recopiée de la copie et de la ligne : le refus ne
  // fabrique pas le fragment qu'il demande de citer.
  expect(INVENTED_CHAR_QUOTE).toContain(divergence?.faults?.[0]?.copy ?? "");
  expect(INVENTED_CHAR_LINE).toContain(divergence?.faults?.[0]?.real ?? "");
  const [line = ""] = ungroundedPlanRefusals(
    inventedCharPlan(INVENTED_CHAR_QUOTE),
    inventedCharContext,
    policyFor()
  );
  expect(line).toContain(`copied from line 41 of ${INVENTED_CHAR_PATH}`);
  expect(line).toContain(
    `the file writes ${JSON.stringify(',2" });')} where your copy has ${JSON.stringify(',3" });')}`
  );
  expect(line).toContain(
    `send "line": 41 for ${INVENTED_CHAR_PATH} and the gate writes that line itself`
  );
  expect(line).not.toContain(JSON.stringify(INVENTED_CHAR_LINE));
});
/**
 * Une copie qui change À LA FOIS un blanc et un signe : la première divergence
 * de la copie — l'espace autour du `=` — ne diffère que par ses blancs, et le
 * signe changé vient plus loin. Le sens lu sur cette seule première divergence
 * annonçait « only in whitespace » d'une copie dont le `-` différait aussi du
 * `+` de la ligne : le planificateur ne réparait alors que l'espacement et
 * reconstruisait la même copie invalide (P2 de la revue de la PR #52).
 */
const BOTH_KINDS_PATH = "apps/web/app/page.tsx";
const BOTH_KINDS_LINE = "  const alpha = beta + gamma;";
const BOTH_KINDS_QUOTE = "  const alpha=beta - gamma;";
const bothKindsContext: PrContext = contextWith([
  {
    filename: BOTH_KINDS_PATH,
    patch: ["@@ -60,2 +60,3 @@", "   // total", `+${BOTH_KINDS_LINE}`].join(
      "\n"
    ),
  },
]);
function bothKindsPlan(quote: string): Plan {
  return planWithWitnesses([
    {
      id: "cash-both-kinds",
      sourceFiles: [BOTH_KINDS_PATH],
      requirements: [{ sourceFile: BOTH_KINDS_PATH, quote }],
    },
  ]);
}
it("reports both the whitespace and the changed character of a retyped copy", () => {
  const requirement = {
    quote: BOTH_KINDS_QUOTE,
    sourceFile: BOTH_KINDS_PATH,
  };
  expect(requirementHasWitness(requirement, bothKindsContext)).toBe(false);
  const divergence = quoteDivergence(requirement, bothKindsContext);
  // Les DEUX divergences de la copie sont lues, dans l'ordre de la copie : la
  // première ne diffère que par ses blancs, la seconde par son signe.
  expect(divergence).toMatchObject({
    candidate: BOTH_KINDS_LINE,
    faults: [
      { copy: "alpha=beta", kind: "whitespace", real: "alpha = beta" },
      { copy: "beta - gamma", kind: "invented", real: "beta + gamma" },
    ],
    kind: "invented",
    line: 61,
    wholeLine: true,
  });
  const [line = ""] = ungroundedPlanRefusals(
    bothKindsPlan(BOTH_KINDS_QUOTE),
    bothKindsContext,
    policyFor()
  );
  expect(line).toContain(`copied from line 61 of ${BOTH_KINDS_PATH}`);
  // Le refus dit les deux ensemble, et il nomme le signe changé — les deux
  // fenêtres sont recopiées, l'une de la copie, l'autre de la ligne.
  expect(line).toContain(
    "it differs from that line in whitespace and in characters"
  );
  expect(line).toContain(
    `the file writes ${JSON.stringify("alpha = beta")} where your copy has ${JSON.stringify("alpha=beta")}, and the file writes ${JSON.stringify("beta + gamma")} where your copy has ${JSON.stringify("beta - gamma")}`
  );
  expect(line).not.toContain("only in whitespace");
  expect(line).toContain(
    `send "line": 61 for ${BOTH_KINDS_PATH} and the gate writes that line itself`
  );
  expect(line).not.toContain(JSON.stringify(BOTH_KINDS_LINE));
});
/**
 * La ponctuation d'avant le premier mot commun : la suite commune commence au
 * premier mot des deux textes, donc le `(` de la copie fait face au `[` de la
 * ligne. Les deux ouvertures ne se comparaient pas dans ce cas, et le refus ne
 * parlait que du blanc de la copie — la même revendication fausse que la première
 * fenêtre seule (P2 de la revue de la PR #52, cas mesuré par la revue).
 */
const LEAD_DELIMITER_PATH = "apps/web/app/page.tsx";
const LEAD_DELIMITER_LINE = "[alpha, beta = gamma]";
const LEAD_DELIMITER_QUOTE = "(alpha, beta= gamma]";
const leadDelimiterContext: PrContext = contextWith([
  {
    filename: LEAD_DELIMITER_PATH,
    patch: ["@@ -60,2 +60,3 @@", "   // total", `+${LEAD_DELIMITER_LINE}`].join(
      "\n"
    ),
  },
]);
function leadDelimiterPlan(quote: string): Plan {
  return planWithWitnesses([
    {
      id: "cash-lead-delimiter",
      sourceFiles: [LEAD_DELIMITER_PATH],
      requirements: [{ sourceFile: LEAD_DELIMITER_PATH, quote }],
    },
  ]);
}
it("names the leading delimiter a retyped copy changed", () => {
  const requirement = {
    quote: LEAD_DELIMITER_QUOTE,
    sourceFile: LEAD_DELIMITER_PATH,
  };
  expect(requirementHasWitness(requirement, leadDelimiterContext)).toBe(false);
  const divergence = quoteDivergence(requirement, leadDelimiterContext);
  // L'ouverture est lue comme les autres fenêtres : le `(` de la copie face au
  // `[` de la ligne, puis le blanc de la copie.
  expect(divergence).toMatchObject({
    candidate: LEAD_DELIMITER_LINE,
    faults: [
      { copy: "(", kind: "invented", real: "[" },
      { copy: "beta= gamma", kind: "whitespace", real: "beta = gamma" },
    ],
    kind: "invented",
    line: 61,
    wholeLine: true,
  });
  const [line = ""] = ungroundedPlanRefusals(
    leadDelimiterPlan(LEAD_DELIMITER_QUOTE),
    leadDelimiterContext,
    policyFor()
  );
  expect(line).toContain(`copied from line 61 of ${LEAD_DELIMITER_PATH}`);
  expect(line).toContain(
    "it differs from that line in whitespace and in characters"
  );
  expect(line).toContain(
    `the file writes ${JSON.stringify("[")} where your copy has ${JSON.stringify("(")}`
  );
  expect(line).not.toContain("only in whitespace");
  expect(line).toContain(
    `send "line": 61 for ${LEAD_DELIMITER_PATH} and the gate writes that line itself`
  );
  expect(line).not.toContain(JSON.stringify(LEAD_DELIMITER_LINE));
});
/**
 * Les deux préfixes, quand la suite commune ne commence au premier mot d'aucun
 * des deux textes, et à des rangs différents : la copie réécrit `let` là où la
 * ligne écrit `const extra`. Les mots d'avant la suite commune ne s'alignaient
 * pas, donc aucun bord ne les comparaît, et le refus ne parlait que du blanc de
 * la suite — la même revendication fausse que la première fenêtre seule (P2 de
 * la revue de la PR #52, dernier tour, cas mesuré par la revue).
 */
const OFFSET_PREFIX_PATH = "apps/web/app/page.tsx";
const OFFSET_PREFIX_LINE = "const extra alpha = beta gamma";
const OFFSET_PREFIX_QUOTE = "let alpha= beta gamma";
const offsetPrefixContext: PrContext = contextWith([
  {
    filename: OFFSET_PREFIX_PATH,
    patch: ["@@ -60,2 +60,3 @@", "   // total", `+${OFFSET_PREFIX_LINE}`].join(
      "\n"
    ),
  },
]);
function offsetPrefixPlan(quote: string): Plan {
  return planWithWitnesses([
    {
      id: "cash-offset-prefix",
      sourceFiles: [OFFSET_PREFIX_PATH],
      requirements: [{ sourceFile: OFFSET_PREFIX_PATH, quote }],
    },
  ]);
}
it("names the prefix a copy rewrote at a different word offset", () => {
  const requirement = {
    quote: OFFSET_PREFIX_QUOTE,
    sourceFile: OFFSET_PREFIX_PATH,
  };
  expect(requirementHasWitness(requirement, offsetPrefixContext)).toBe(false);
  const divergence = quoteDivergence(requirement, offsetPrefixContext);
  // Le préfixe réécrit est lu comme les autres fenêtres, avant le blanc de la
  // suite commune que la copie a retiré autour de son `=`.
  expect(divergence).toMatchObject({
    candidate: OFFSET_PREFIX_LINE,
    faults: [
      { copy: "let ", kind: "invented", real: "const extra " },
      { copy: "alpha= beta", kind: "whitespace", real: "alpha = beta" },
    ],
    kind: "invented",
    line: 61,
    wholeLine: true,
  });
  const [line = ""] = ungroundedPlanRefusals(
    offsetPrefixPlan(OFFSET_PREFIX_QUOTE),
    offsetPrefixContext,
    policyFor()
  );
  expect(line).toContain(`copied from line 61 of ${OFFSET_PREFIX_PATH}`);
  expect(line).toContain(
    "it differs from that line in whitespace and in characters"
  );
  expect(line).toContain(
    `the file writes ${JSON.stringify("const extra ")} where your copy has ${JSON.stringify("let ")}`
  );
  expect(line).not.toContain("only in whitespace");
  expect(line).toContain(
    `send "line": 61 for ${OFFSET_PREFIX_PATH} and the gate writes that line itself`
  );
  expect(line).not.toContain(JSON.stringify(OFFSET_PREFIX_LINE));
});
/**
 * Ligne réelle plus longue que la borne de `quoteableFragment`, avec une copie
 * qui s'en écarte : le remède doit proposer la plus longue fenêtre de jetons
 * ENTIERS réellement présente sur cette ligne — jamais la ligne entière, jamais
 * un jeton rogné, jamais un texte inventé.
 */
const LONG_DIVERGENT_PATH = "apps/web/app/page.tsx";
const LONG_DIVERGENT_LINE = `  const total = countCash({ "500": "3,5" }) + countCash({ "200": "1,2" }) + countCash({ "100": "0,9" }) + countCash({ "050": "0,4" });`;
/** La même ligne sans ses espaces : la copie s'en écarte partout à la fois. */
const LONG_DIVERGENT_QUOTE = `const total=countCash({ "500": "3,5" })+countCash({ "200": "1,2" })+countCash({ "100": "0,9" })+countCash({ "050": "0,4" });`;
/** Ici la ligne longue est dans le contexte importé, donc indésignable : la
 * fenêtre de jetons reste le seul remède possible. */
const longDivergentContext: PrContext = {
  ...context,
  context: [
    {
      content: [
        ...Array.from(
          { length: 50 },
          (_, index) => `  // ligne ${index + 1} du fichier`
        ),
        LONG_DIVERGENT_LINE,
      ].join("\n"),
      path: LONG_DIVERGENT_PATH,
      ref: context.sha,
    },
  ],
};
it("proposes a whole-token window when the divergent line is too long to quote whole", () => {
  const requirement = {
    quote: LONG_DIVERGENT_QUOTE,
    sourceFile: LONG_DIVERGENT_PATH,
  };
  expect(LONG_DIVERGENT_LINE.length).toBeGreaterThan(120);
  expect(requirementHasWitness(requirement, longDivergentContext)).toBe(false);
  const divergence = quoteDivergence(requirement, longDivergentContext);
  expect(divergence?.wholeLine).toBe(false);
  expect(divergence?.line).toBe(51);
  expect(divergence?.kind).toBe("whitespace");
  const candidate = divergence?.candidate ?? "";
  // Le candidat est une portion EXACTE de la ligne, sous la borne de `quote`, et
  // ses deux bords sont des bords de jetons : aucun jeton n'est rogné.
  expect(candidate.length).toBeGreaterThan(0);
  expect(candidate.length).toBeLessThanOrEqual(120);
  expect(LONG_DIVERGENT_LINE).toContain(candidate);
  const at = LONG_DIVERGENT_LINE.indexOf(candidate);
  const before = at > 0 ? LONG_DIVERGENT_LINE[at - 1] : " ";
  const after = LONG_DIVERGENT_LINE[at + candidate.length] ?? " ";
  expect(before).toMatch(/\s/);
  expect(after).toMatch(/\s/);
  // Le refus nomme la ligne réelle et porte ce candidat, sans ligne entière.
  const [line = ""] = ungroundedPlanRefusals(
    planWithWitnesses([
      {
        id: "cash-total",
        sourceFiles: [LONG_DIVERGENT_PATH],
        requirements: [requirement],
      },
    ]),
    longDivergentContext,
    policyFor()
  );
  expect(line).toContain(`copied from line 51 of ${LONG_DIVERGENT_PATH}`);
  expect(line).toContain("too long to quote whole");
  expect(line).toContain(`51: ${JSON.stringify(candidate)}`);
  expect(line).not.toContain("whole line from its first character");
});

/**
 * Le diagnostic d'amputation est un balayage du fichier cité par citation
 * fautive : deux plafonds le bornent, et ces trois tests les MESURENT au lieu de
 * les affirmer — 2 000 lignes examinées par balayage (`CITED_LINES_EXAMINED`),
 * 32 citations examinées par validation (`AMPUTATION_QUOTES_EXAMINED`). Le plan
 * hostile du finding alignait 60 citations fautives sur un patch de 110 KB et
 * faisait tourner le worker 49,6 s, au-delà de son lease. Le deuxième test rejoue
 * ce fixture — 60 citations, fichier de 3 000 lignes, copies à une trentaine de
 * blancs — et compte les deux bornes : 32 citations examinées, 28 refus gardés
 * avec leur conseil générique. Le troisième porte le même compte sur le refus
 * rendu par les classes FATALES de couverture du plan maximal, la moitié qui
 * recréait son propre budget et repayait donc un balayage par citation.
 */
const CITED_LINE_CAP = 2000;
const CITED_QUOTE_CAP = 32;
const BOUNDED_PATH = "src/bounded.ts";
/** La ligne réelle dont la copie fautive a gardé la fin. */
const BOUNDED_TARGET = "  const total = somme(items);";
/** La copie mesurée : un début inventé, la fin exacte de la ligne. */
const BOUNDED_QUOTE = "const x = somme(items);";
/**
 * La ligne réelle du test de plafond et sa copie fautive, avec assez de blancs
 * pour que chaque ligne ait vraiment des découpages à examiner : c'est ce coût
 * — les découpages recalculés pour CHAQUE ligne du fichier — que la revue a
 * mesuré, et la sonde le paie une fois par citation.
 */
function boundedFlawedLine(index: number): string {
  return `  const total${index} = somme(items${index}) + reste(prix${index}) + base(unite${index}) + taxe(taux${index}) + marge(ecart${index}) + solde(reste${index}) + parts(lot${index});`;
}
function boundedFlawedQuote(index: number): string {
  return `  const x${index} = somme(items${index}) + reste(prix${index}) + base(unite${index}) + taxe(taux${index}) + marge(ecart${index}) + solde(reste${index}) + parts(lot${index});`;
}
function boundedContext(targetLine: number, lines: number): PrContext {
  const content = Array.from({ length: lines }, (_, position) =>
    position + 1 === targetLine
      ? BOUNDED_TARGET
      : `  // remplissage ${position + 1}`
  ).join("\n");
  return {
    ...context,
    context: [{ content, path: BOUNDED_PATH, ref: context.sha }],
  };
}
/**
 * Le même fixture pour la moitié fatale : les `faulty` premières lignes du
 * fichier cité sont réelles, et chacune est la source d'une copie fautive.
 */
function boundedFatalContext(faulty: number): PrContext {
  const content = Array.from({ length: 3000 }, (_, position) =>
    position < faulty
      ? boundedFlawedLine(position)
      : `  // remplissage ${position + 1}`
  ).join("\n");
  return {
    ...context,
    context: [{ content, path: BOUNDED_PATH, ref: context.sha }],
  };
}
function boundedPlan(requirements: { sourceFile: string; quote: string }[]) {
  const chunks: { sourceFile: string; quote: string }[][] = [];
  for (let at = 0; at < requirements.length; at += 20) {
    chunks.push(requirements.slice(at, at + 20));
  }
  return planWithWitnesses(
    chunks.map((chunk, index) => ({
      id: `bounded-${index + 1}`,
      sourceFiles: [BOUNDED_PATH],
      requirements: chunk,
    }))
  );
}
it("stops examining the cited file at the line cap, and still refuses exactly", () => {
  const requirement = { quote: BOUNDED_QUOTE, sourceFile: BOUNDED_PATH };
  // La 2000e ligne est examinée, la 2001e ne l'est plus : la borne est comptée,
  // pas seulement présente. Les deux contextes ne diffèrent que par la position
  // de la ligne réelle dans un fichier de même taille.
  expect(
    amputatedQuote(
      requirement,
      boundedContext(CITED_LINE_CAP, CITED_LINE_CAP + 1)
    )
  ).toEqual({
    candidate: BOUNDED_TARGET,
    kind: "start",
    line: CITED_LINE_CAP,
    wholeLine: true,
  });
  const beyond = boundedContext(CITED_LINE_CAP + 1, CITED_LINE_CAP + 1);
  expect(amputatedQuote(requirement, beyond)).toBeUndefined();
  // Le refus reste rendu, non vide et exact : la citation est refusée pour ce
  // qu'elle est — un texte qui n'existe nulle part — et le remède générique
  // nomme la seule réparation légale sans inventer de ligne.
  const plan = boundedPlan([requirement]);
  expect(ungroundedRequirements(plan, beyond)).toHaveLength(1);
  const [refusal = ""] = ungroundedPlanRefusals(plan, beyond, policyFor());
  expect(refusal).toContain(`Rejected quote: ${JSON.stringify(BOUNDED_QUOTE)}`);
  expect(refusal).toContain(UNGROUNDED_ABSENT_REMEDY);
  expect(refusal).toContain("quote a real line of the declared file instead");
  expect(refusal).not.toContain("copied from line");
  // La même citation, la ligne réelle DANS le balayage, garde son remède : la
  // borne ne supprime pas le diagnostic, elle l'arrête.
  const [detailed = ""] = ungroundedPlanRefusals(
    plan,
    boundedContext(CITED_LINE_CAP, CITED_LINE_CAP + 1),
    policyFor()
  );
  expect(detailed).toContain(
    `copied from line ${CITED_LINE_CAP} of ${BOUNDED_PATH}`
  );
});
it("caps the citations examined per validation, and still refuses each one", () => {
  const faulty = 60;
  const targets = new Map<number, string>();
  for (let index = 0; index < faulty; index += 1) {
    targets.set(100 + index * 30, boundedFlawedLine(index));
  }
  const content = Array.from(
    { length: 3000 },
    (_, position) =>
      targets.get(position + 1) ?? `  // remplissage ${position + 1}`
  ).join("\n");
  const many: PrContext = {
    ...context,
    context: [{ content, path: BOUNDED_PATH, ref: context.sha }],
  };
  const requirements = Array.from({ length: faulty }, (_, index) => ({
    quote: boundedFlawedQuote(index),
    sourceFile: BOUNDED_PATH,
  }));
  const plan = boundedPlan(requirements);
  expect(ungroundedRequirements(plan, many)).toHaveLength(faulty);
  // Le balayage des 32 premières citations est mesuré, comme le refus des 28
  // suivantes : chaque citation fautive garde son refus, et le plafond ne
  // fabrique aucune réponse vide ni inexacte.
  const started = performance.now();
  const refusals = ungroundedPlanRefusals(plan, many, policyFor());
  const elapsed = performance.now() - started;
  expect(refusals).toHaveLength(faulty);
  expect(
    refusals
      .slice(0, CITED_QUOTE_CAP)
      .every((line) => line.includes("copied from line"))
  ).toBe(true);
  const generic = refusals.slice(CITED_QUOTE_CAP);
  expect(generic).toHaveLength(faulty - CITED_QUOTE_CAP);
  for (const line of generic) {
    expect(line).toContain("Rejected quote:");
    expect(line).toContain(UNGROUNDED_ABSENT_REMEDY);
    expect(line).toContain("quote a real line of the declared file instead");
  }
  // Le travail payé reste celui des deux bornes — 32 balayages de 3 000 lignes
  // ramenées aux 2 000 lues — là où le head 3dad30d balayait les 60 citations :
  // 1 228 ms sur ce fixture, 319 ms borné, et les 28 refus non examinés gardent
  // un conseil exact. Le worker tient son lease.
  expect(elapsed).toBeLessThan(2000);
});
it("caps the fatal half of the same plan at the shared amputation budget", () => {
  const faulty = 400;
  const many = boundedFatalContext(faulty);
  const plan = boundedPlan(
    Array.from({ length: faulty }, (_, index) => ({
      quote: boundedFlawedQuote(index),
      sourceFile: BOUNDED_PATH,
    }))
  );
  expect(ungroundedRequirements(plan, many)).toHaveLength(faulty);
  // Le budget de la validation est créé au point d'entrée du gate (voir
  // `planRefusals`, runner.ts) et traverse ses deux moitiés. Le test le remet
  // lui-même à la moitié fatale : c'est ce qui compte le travail engagé par ce
  // chemin, et ce qui tombe si un budget neuf y est recréé. Mesuré sur ce
  // fixture, aux 400 citations fautives que le schéma autorise, un budget neuf
  // par citation rendait 400 remèdes détaillés en 4 059 ms, le budget partagé
  // 32 en 2 611 ms — dont 2 484 ms de témoins que les deux chemins paient hors
  // budget.
  const scans = amputationScans();
  const fatal = coverageFatalClasses(plan, many, policyFor(), scans).find(
    (refusal) => refusal.code === "REQUIREMENT_UNGROUNDED"
  );
  const faults = fatal?.faults ?? [];
  // Une faute par citation fautive, dans l'ordre du plan : le plafond ne
  // supprime aucun refus, il n'en détaille que les 32 premières.
  expect(faults).toHaveLength(faulty);
  expect(
    faults
      .slice(0, CITED_QUOTE_CAP)
      .every((fault) => fault.remedy.includes("copied from line"))
  ).toBe(true);
  const generic = faults.slice(CITED_QUOTE_CAP);
  expect(generic).toHaveLength(faulty - CITED_QUOTE_CAP);
  for (const fault of generic) {
    expect(fault.remedy).toContain(UNGROUNDED_ABSENT_REMEDY);
    expect(fault.remedy).not.toContain("copied from line");
  }
  // Le budget remis est exactement ce que ce chemin a consommé : le plafond de
  // la validation, et rien de plus.
  expect(scans.remaining).toBe(0);
  // La seconde moitié reçoit le même budget épuisé : les 32 citations déjà
  // examinées gardent leur remède détaillé, servi par le verdict mémorisé, et
  // les 368 autres un refus exact non vide. Le partage du plafond ne fait pas
  // taire le détail du gate, il l'arrête à 32 citations.
  const refusals = ungroundedPlanRefusals(plan, many, policyFor(), scans);
  expect(refusals).toHaveLength(faulty);
  expect(
    refusals
      .slice(0, CITED_QUOTE_CAP)
      .every((line) => line.includes("copied from line"))
  ).toBe(true);
  for (const line of refusals.slice(CITED_QUOTE_CAP)) {
    expect(line).toContain("Rejected quote:");
    expect(line).toContain(UNGROUNDED_ABSENT_REMEDY);
    expect(line).toContain("quote a real line of the declared file instead");
  }
}, 60_000);

/**
 * L'exactitude prime la position : le gate accepte toute sous-chaîne verbatim
 * (voir `quoteHasWitness`), donc une copie exacte commencée au milieu d'une ligne
 * EST un témoin, et le refus ne nomme le début manquant que d'une copie qui
 * n'existe nulle part. Ces deux citations exactes passent le gate sans remède.
 */
it("accepts an exact suffix or interior copy of a real line", () => {
  for (const quote of [COUNTED_CLEAN_TAIL, COUNTED_INTERIOR_QUOTE]) {
    expect(
      ungroundedRequirements(countedPlan(quote), countedContext)
    ).toHaveLength(0);
  }
});

/**
 * Déterministe : quand plusieurs découpages se vérifient, c'est le plus
 * équilibré qui est rendu — celui dont le plus court fragment est le plus long —
 * jamais le premier venu, et jamais plus de deux fragments.
 */
const SPLIT_PATH = "src/split.ts";
const SPLIT_LINES = [
  "alphaone betatwoo gammathr",
  "betatwoo gammathr deltfour",
];
const splitContext: PrContext = {
  ...contextWith([
    {
      filename: SPLIT_PATH,
      patch: [
        "@@ -1,2 +1,2 @@",
        ` ${SPLIT_LINES[0]}`,
        ` ${SPLIT_LINES[1]}`,
      ].join("\n"),
    },
  ]),
  context: [
    { content: SPLIT_LINES.join("\n"), path: SPLIT_PATH, ref: context.sha },
  ],
};
it("chooses the most balanced verified split", () => {
  const quote = "alphaone betatwoo gammathr deltfour";
  // Aucune ligne ne porte la citation entière : seuls ses découpages existent,
  // et trois d'entre eux se vérifient (un fragment seul d'un côté, la suite de
  // l'autre). Le plus équilibré gagne — deux fragments de 17 caractères — et la
  // ligne entière est proposée pour chacun, puisqu'elle tient dans la borne.
  expect(SPLIT_LINES.join("\n")).not.toContain(quote);
  expect(
    stitchedQuoteFragments({ quote, sourceFile: SPLIT_PATH }, splitContext)
  ).toEqual([
    { candidate: SPLIT_LINES[0], fragment: "alphaone betatwoo", line: 1 },
    { candidate: SPLIT_LINES[1], fragment: "gammathr deltfour", line: 2 },
  ]);
});

it("stays silent when both fragments live on one single line", () => {
  // Les deux fragments existent, mais la seule ligne qui les porte est la même
  // pour les deux : rien ne dit qu'ils viennent de deux lignes différentes, donc
  // le diagnostic se tait au lieu d'annoncer une jointure entre deux lignes.
  const single = "src/single.ts";
  const line = " epsilonon betatwoo zetaonly";
  const quote = "epsilonon zetaonly";
  const singleContext = contextWith([
    { filename: single, patch: `@@ -1,1 +1,1 @@\n+${line}` },
  ]);
  expect(line).toContain("epsilonon");
  expect(line).toContain("zetaonly");
  expect(line).not.toContain(quote);
  expect(
    stitchedQuoteFragments({ quote, sourceFile: single }, singleContext)
  ).toEqual([]);
  const [refusal = ""] = ungroundedPlanRefusals(
    planWithWitnesses([
      {
        id: "single",
        sourceFiles: [single],
        requirements: [{ sourceFile: single, quote }],
      },
    ]),
    singleContext,
    policyFor()
  );
  expect(refusal).toContain("No source witness for single");
  expect(refusal).not.toContain("assembles fragments");
});

/**
 * Le candidat d'un fragment est la fenêtre de jetons ENTIERS la plus large sous
 * la borne de suggestion : chaque extension est pesée avant d'être retenue. Un
 * jeton ajouté sans être pesé fait déborder la fenêtre, `quoteableFragment` la
 * refuse, et le diagnostic de recousure disparaît alors qu'un candidat citable
 * existait — la faute que ce cas mesure.
 */
it("keeps a fragment citable when the next token would overflow the bound", () => {
  const path = "src/window-cap.ts";
  const head = "const capacite = 42;";
  const tail = "aria-invalid={etatInvalide}";
  // La ligne du second fragment dépasse la borne : le jeton suivant porterait
  // la fenêtre à 149 caractères, donc elle doit s'arrêter avant lui. Les deux
  // fragments sont séparés par une ligne de remplissage : repliés, ils ne
  // reforment pas la citation.
  const tailLine = `${tail} ${"a".repeat(60)} ${"b".repeat(60)}`;
  const quote = `${head} ${tail}`;
  const file = ["  // remplissage 1", head, "  // remplissage 3", tailLine];
  const capContext: PrContext = {
    ...contextWith([
      {
        filename: path,
        patch: `@@ -1,4 +1,4 @@\n+${file.join("\n+")}`,
      },
    ]),
    context: [{ content: file.join("\n"), path, ref: context.sha }],
  };
  expect(file.join("\n")).not.toContain(quote);
  expect(tailLine).toHaveLength(149);
  expect(
    stitchedQuoteFragments({ quote, sourceFile: path }, capContext)
  ).toEqual([
    { candidate: head, fragment: head, line: 2 },
    { candidate: `${tail} ${"a".repeat(60)}`, fragment: tail, line: 4 },
  ]);
  const [, second] = stitchedQuoteFragments(
    { quote, sourceFile: path },
    capContext
  );
  // Le candidat reste une portion EXACTE de la ligne, sous la borne, et il
  // passe le contrat de citation du fichier critique.
  expect(second!.candidate.length).toBeLessThanOrEqual(120);
  expect(tailLine).toContain(second!.candidate);
  expect(second!.candidate).toContain(tail);
  expect(quoteCarriesContent(second!.candidate)).toBe(true);
  expect(
    stitchedQuoteRemedy({ quote, sourceFile: path }, capContext)
  ).toContain(`4: ${JSON.stringify(second!.candidate)}`);
});

it("stays silent when the quote and both its fragments are absent", () => {
  // Cas (c) : rien de la citation n'existe, donc aucun fragment à nommer et
  // aucun candidat à proposer — le refus reste celui d'aujourd'hui.
  const nowhere = "const ouvrirTiroir = () => setOpen(true);";
  expect(
    stitchedQuoteFragments(
      { quote: nowhere, sourceFile: PAGE_TSX_PATH },
      pageTsxContext
    )
  ).toEqual([]);
  const [line = ""] = ungroundedPlanRefusals(
    pageTsxPlan(nowhere),
    pageTsxContext,
    policyFor()
  );
  expect(line).toContain(
    `Rejected quote: ${JSON.stringify(nowhere)}. ${UNGROUNDED_ABSENT_REMEDY}`
  );
  expect(line).not.toContain("assembles fragments");
  expect(line).not.toContain("to quote instead");
  // Une citation exacte du fichier cité reste acceptée : le gate ne bouge pas.
  expect(
    validateCoverage(
      pageTsxPlan(PAGE_TSX_LINE_61),
      pageTsxContext,
      policyFor(),
      config
    ).gate
  ).toBe("complete");
});

/**
 * Défaut signalé par la vérification interne : le remède de témoin énumérait
 * sans plafond tous les fichiers qui portent la citation, et une liste longue
 * portée par le préambule fatal écrasait la tête de la dernière classe. La
 * liste est plafonnée et les fichiers non montrés sont comptés.
 */
it("caps the witness path list and counts the files it omits", () => {
  const quote = 'const witness = "carried by many changed files";';
  const paths = Array.from(
    { length: 8 },
    (_, index) => `src/witness-${index}-with-a-long-name.ts`
  );
  const changed = contextWith(
    paths.map((filename) => ({ filename, patch: `+ ${quote}` }))
  );
  expect(witnessFiles(quote, changed)).toEqual(paths);
  expect(
    absentRequirementRemedy({ quote, sourceFile: "src/cited.ts" }, changed)
  ).toBe(
    `The quote appears verbatim in ${paths.slice(0, 3).join(", ")} (+5 more); declare that file and attribute the requirement to it.`
  );
  // Même borne pour la branche hors diff : la liste des fichiers que la PR ne
  // change pas est comptée elle aussi.
  const outside: PrContext = {
    ...changed,
    files: [],
    context: paths.map((path) => ({ content: quote, path, ref: context.sha })),
  };
  expect(
    absentRequirementRemedy({ quote, sourceFile: "src/cited.ts" }, outside)
  ).toBe(
    `The quote only appears in ${paths.slice(0, 3).join(", ")} (+5 more), which this PR does not change; quote the changed file instead.`
  );
});

it("shows one witness path whole rather than a path the planner cannot open", () => {
  const quote = 'const witness = "carried by the longest path";';
  const longest = `src/${"d".repeat(140)}/module.ts`;
  const paths = [longest, "src/second.ts", "src/third.ts"];
  const many = contextWith(
    paths.map((filename) => ({ filename, patch: `+ ${quote}` }))
  );
  expect(witnessFiles(quote, many)).toEqual(paths);
  expect(
    absentRequirementRemedy({ quote, sourceFile: "src/cited.ts" }, many)
  ).toBe(
    `The quote appears verbatim in ${longest} (+2 more); declare that file and attribute the requirement to it.`
  );
});

it("suggests only head-path lines for a file renamed without deletion", () => {
  // Contenu de tête de l'ANCIEN chemin : c'est lui qui portait la ligne
  // trompeuse quand l'appariement lisait `previous_filename` à la révision de
  // tête.
  const oldHead = [
    'export const brandNew = countCash({ "500": "3,6" });',
    "const legacy = 'old head only';",
  ].join("\n");
  const newHead = [
    "const countCash = (cash: string) => cash;",
    'const normalized = countCash({ "500": "3,5" });',
  ].join("\n");
  const newPath = "src/util/new.ts";
  const renamed: PrContext = {
    ...context,
    files: [
      {
        filename: newPath,
        patch:
          "@@ -1,2 +1,2 @@\n- const countCash = legacy;\n+ const countCash = renamed;",
        previous_filename: "src/util/old.ts",
        status: "renamed",
      },
    ],
    context: [
      { content: oldHead, path: "src/util/old.ts", ref: context.sha },
      { content: oldHead, path: "src/util/old.ts", ref: context.baseSha },
      { content: newHead, path: newPath, ref: context.sha },
    ],
  };
  const suggestions = suggestedQuoteLines(
    { quote: 'countCash({ "500": "3,5" })', sourceFile: newPath },
    renamed
  );
  expect(suggestions).toEqual([
    { line: 2, text: 'const normalized = countCash({ "500": "3,5" });' },
  ]);
  // Chaque candidat est une ligne exacte du fichier cité, avec son numéro :
  // comparé caractère par caractère au contenu de tête du chemin de tête. La
  // ligne de l'ancien chemin n'est jamais proposée, même quand elle recouvre la
  // citation mieux que toute ligne du fichier cité.
  const headLines = newHead.split("\n");
  for (const candidate of suggestions) {
    expect(headLines[candidate.line - 1]).toBe(candidate.text);
  }
  expect(suggestions.map((candidate) => candidate.text)).not.toContain(
    oldHead.split("\n")[0]
  );
  // Quand seul l'ancien chemin recouvre la citation, le remède préfère
  // l'absence de suggestion à une ligne qui n'existe pas dans le fichier cité.
  const unrelated: PrContext = {
    ...renamed,
    context: renamed.context.map((item) =>
      item.path === newPath
        ? { ...item, content: "const untouched = 'nothing to quote here';" }
        : item
    ),
  };
  expect(
    suggestedQuoteLines(
      { quote: 'countCash({ "500": "3,5" })', sourceFile: newPath },
      unrelated
    )
  ).toEqual([]);
});

it("never proposes more than two candidate lines", () => {
  const quote = "const alpha = value + offset;";
  const content = [
    "const alpha = 1 + offset;",
    "const alpha = 2 + offset;",
    "const alpha = 3 + offset;",
    "const alpha = 4 + offset;",
  ].join("\n");
  const ctx: PrContext = {
    ...contextWith([
      {
        filename: "src/logic.ts",
        patch: [
          "@@ -1,4 +1,4 @@",
          " const alpha = 1 + offset;",
          " const alpha = 2 + offset;",
          " const alpha = 3 + offset;",
          " const alpha = 4 + offset;",
        ].join("\n"),
      },
    ]),
    context: [{ content, path: "src/logic.ts", ref: context.sha }],
  };
  // Quatre lignes franchissent le seuil ; deux sont proposées, dans l'ordre
  // déterministe du critère.
  expect(
    suggestedQuoteLines({ quote, sourceFile: "src/logic.ts" }, ctx)
  ).toEqual([
    { line: 1, text: "const alpha = 1 + offset;" },
    { line: 2, text: "const alpha = 2 + offset;" },
  ]);
});

it("accepts an exact single-line quote from the cited file", () => {
  const plan = cashSpecPlan(CASH_SPEC_LINES[46]!);
  expect(ungroundedRequirements(plan, cashSpecContext)).toEqual([]);
  expect(
    validateCoverage(plan, cashSpecContext, policyFor(), config).gate
  ).toBe("complete");
});

it("accepts a contiguous multi-line quote copied from the cited file", () => {
  const contiguous = [
    CASH_SPEC_LINES[46],
    CASH_SPEC_LINES[47],
    CASH_SPEC_LINES[48],
  ].join("\n");
  const plan = cashSpecPlan(contiguous);
  expect(
    validateCoverage(plan, cashSpecContext, policyFor(), config).gate
  ).toBe("complete");
  // Recoudre deux lignes NON contiguës du même fichier — 47 et 49, en sautant
  // 48 — reste refusé : c'est la jointure qui est fausse, jamais la longueur.
  const skipped = [CASH_SPEC_LINES[46], CASH_SPEC_LINES[48]].join("\n");
  expect(
    ungroundedRequirements(cashSpecPlan(skipped), cashSpecContext)
  ).toHaveLength(1);
});

/**
 * H1 : pour un fichier modifié au-delà du plafond de contexte, la preuve ne
 * portait que le patch brut, dont les préfixes `+`/`-` ne sont pas des blancs —
 * une citation multi-lignes du nouveau contenu n'y avait donc pas de témoin. Le
 * contenu après changement est reconstruit depuis les hunks du patch, chaque
 * hunk restant un segment témoin à part entière : une citation fabriquée en
 * recousant la fin d'un hunk au début du suivant n'a pas de témoin, sans que
 * cette garantie repose sur le choix d'un séparateur.
 */
const RECONSTRUCTED_PATH = "src/cash.ts";
const RECONSTRUCTED_PATCH = [
  "@@ -1,3 +1,4 @@",
  " const before = 1;",
  '+ const witness = "reconstructed witness value";',
  " const after = 2;",
  "@@ -10,3 +11,4 @@",
  " const tail = 3;",
  "+ const other = 4;",
  " };",
].join("\n");
/** Contenu de tête absent, comme lorsqu'un fichier dépasse le plafond de contexte. */
const reconstructedContext: PrContext = contextWith([
  { filename: RECONSTRUCTED_PATH, patch: RECONSTRUCTED_PATCH },
]);

/** Segments témoins de `RECONSTRUCTED_PATCH` : le patch, puis un par hunk. */
const RECONSTRUCTED_SEGMENTS = [
  RECONSTRUCTED_PATCH,
  [
    "const before = 1;",
    ' const witness = "reconstructed witness value";',
    "const after = 2;",
  ].join("\n"),
  ["const tail = 3;", " const other = 4;", "};"].join("\n"),
];

it("witnesses a new-content quote from the reconstructed hunks", () => {
  const quote = [
    "const before = 1;",
    'const witness = "reconstructed witness value";',
  ].join("\n");
  expect(reconstructedContext.context).toEqual([]);
  // Le patch brut ne porte pas la citation : le `+` de la ligne ajoutée est un
  // caractère non blanc que la comparaison ne tolère pas.
  expect(quoteHasWitness(RECONSTRUCTED_PATCH, quote)).toBe(false);
  // Le patch, puis chaque hunk pris séparément : deux hunks ne se joignent
  // jamais en une chaîne, même séparée.
  expect(
    requirementEvidence(
      { quote, sourceFile: RECONSTRUCTED_PATH },
      reconstructedContext
    )
  ).toEqual(RECONSTRUCTED_SEGMENTS);
  expect(
    requirementHasWitness(
      { quote, sourceFile: RECONSTRUCTED_PATH },
      reconstructedContext
    )
  ).toBe(true);
  expect(ungroundedRequirements(cashPlan(quote), reconstructedContext)).toEqual(
    []
  );
});

it("refuses a quote stitched across two reconstructed hunks", () => {
  const stitched = ["const after = 2;", "const tail = 3;"].join("\n");
  // Les deux lignes sont réelles, mais chacune appartient à son propre hunk :
  // aucune portion réelle du fichier ne les joint, et aucun segment témoin ne
  // les contient ensemble.
  for (const segment of RECONSTRUCTED_SEGMENTS) {
    expect(segment).not.toContain(stitched);
  }
  expect(
    requirementHasWitness(
      { quote: stitched, sourceFile: RECONSTRUCTED_PATH },
      reconstructedContext
    )
  ).toBe(false);
  expect(
    ungroundedRequirements(cashPlan(stitched), reconstructedContext)
  ).toHaveLength(1);
});

it("forbids stitching fragments read in different places in the planner prompt", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // La consigne est opérationnelle : le critère que le planificateur peut
  // vérifier lui-même — deux parties de la citation lues à des endroits NON
  // CONTIGUS du fichier — remplace la seule interdiction abstraite. Réserve 3 de
  // la vérification de la PR #49 : la règle ne porte jamais sur le nombre de
  // lignes, sinon elle interdirait le repli légitime d'un bloc multi-lignes sur
  // une ligne, que le gate accepte.
  expect(prompt).toMatch(
    /Never stitch fragments you read in different places into one quote/i
  );
  expect(prompt).toMatch(
    /two parts of your quote come from two places that are not contiguous in the file/i
  );
  expect(prompt).not.toMatch(
    /different lines of the file, the quote is wrong/i
  );
  // La preuve ne peut venir que d'un fichier déclaré par le scénario : le code
  // lu dans un module importé ou un fichier de contexte n'en est pas une, même
  // quand le fichier cité l'importe — cause mesurée du lot H.
  expect(prompt).toMatch(
    /that file must be one of the scenario's own sourceFiles/i
  );
  expect(prompt).toMatch(
    /code you read in an imported module or a context file cannot prove the requirement/i
  );
  // Le repli d'un bloc multi-lignes sur une ligne reste permis — cas accepté du
  // lot E — et une jointure inventée reste interdite ; c'est la distinction que
  // le prompt doit enseigner.
  expect(prompt).toMatch(
    /Reflowing one real multi-line block onto one line stays allowed/i
  );
  // Le contre-exemple réel du lot G est enseigné : ses deux fragments mesurés,
  // le chemin du fichier du cas, et la jointure qu'ils ont produite.
  expect(prompt).toContain("apps/web/app/page.tsx");
  expect(prompt).toContain(STITCH_FRAGMENT_A);
  expect(prompt).toContain(STITCH_FRAGMENT_B);
  expect(prompt).toContain("joined them with a space");
  // La conséquence mesurée est enseignée avec l'exemple : la citation recousue a
  // fait refuser l'exigence faute de témoin.
  expect(prompt).toMatch(/refused as an absent quote/i);
});

it("asks for the first character of a quote without forbidding a verbatim fragment", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // La consigne est opérationnelle sans contredire le gate : une copie exacte
  // commencée au milieu d'une ligne est un témoin, donc la règle demande de
  // partir du premier caractère quand le texte est court, sans jamais exiger
  // une ligne entière qu'aucun plan ne pourrait citer.
  expect(prompt).toMatch(
    /Copy a quote from the first character of the text you take from the file whenever that text is short enough/i
  );
  expect(prompt).toMatch(
    /an exact suffix or an interior fragment of a line is a witness/i
  );
  expect(prompt).toMatch(
    /Prefer a whole line to a fragment of it — a line carrying `.*` interpolations is short — but never force a whole line/i
  );
  // Une ligne minifiée dépasse la borne du schéma `quote` : la copie partielle
  // est alors la seule citation possible, et la règle doit le dire.
  expect(prompt).toMatch(
    /quotes are capped at 1000 characters, so a long or minified line must be witnessed by an exact fragment of it/i
  );
  // Les deux phrases qui affirmaient le contraire du gate ne doivent pas
  // revenir : ce contrôle tombe si on les rétablit.
  expect(prompt).not.toMatch(/has no witness and is refused even when/i);
  expect(prompt).not.toMatch(/do not quote from that line at all/i);
  // L'exemple enseigné est le cas mesuré avec son invention, et la ligne réelle
  // qu'il vise : le début de la ligne, la copie fautive, et le remède exact.
  expect(prompt).toMatch(/Another real refusal: a planner quoted/i);
  expect(prompt).toContain(COUNTED_PAGE_PATH);
  expect(prompt).toContain(COUNTED_LINE_HEAD);
  expect(prompt).toContain(COUNTED_LINE);
  expect(prompt).toContain(COUNTED_TAIL_QUOTE);
  expect(prompt).toMatch(/its exact tail alone would have been a witness/i);
});
it("teaches the character-by-character copy of an expression to the planner", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // La consigne nomme les constructions que la recopie rate — gabarits et
  // `\${...}`, flèches typées — sans contredire le gate : toute sous-chaîne
  // verbatim reste un témoin, et la ligne entière reste préférée, jamais exigée.
  expect(prompt).toMatch(
    /Copy an expression character by character, never retype it/i
  );
  expect(prompt).toMatch(
    /a template literal keeps its backticks and the exact characters inside each/i
  );
  expect(prompt).toMatch(/a typed arrow keeps the spaces its line writes/i);
  expect(prompt).toMatch(
    /Do not reformat an expression, do not drop or add a space inside it, do not complete one the file leaves open/i
  );
  expect(prompt).toMatch(
    /These rules never replace the gate: an exact substring of the file is a witness/i
  );
  // Les deux refus mesurés du lot K sont enseignés avec leurs citations.
  expect(prompt).toContain(RETYPED_TEMPLATE_PATH);
  expect(prompt).toContain(RETYPED_TEMPLATE_QUOTE);
  expect(prompt).toContain(RETYPED_ARROW_QUOTE);
});
it("asks the planner to derive a number from the material instead of assuming it", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // Le défaut mesuré du run 5c5cfdb6 : un attendu de 500,00 € écrit d'avance
  // alors que le scénario compte 3 billets de 500,00 € contre 1 240,00 €
  // attendus, soit 260,00 €. La consigne exige les opérandes et leur résultat
  // dans la description de l'assertion, et le nombre calculé dans `expected`.
  expect(prompt).toMatch(
    /must be the one your own scenario produces, never the one you assumed/i
  );
  expect(prompt).toMatch(
    /write the operands and their result into the assertion description/i
  );
  expect(prompt).toMatch(/expected amount, counted total, variance/i);
  // Le cas réel est enseigné avec ses deux montants : le montant supposé du
  // plan et le montant que son propre scénario produit.
  expect(prompt).toContain(
    "Écart de 500,00 € : une justification écrite est obligatoire avant clôture."
  );
  expect(prompt).toMatch(
    /3 billets de 500,00 € against an expected amount of 1 240,00 €/i
  );
  expect(prompt).toMatch(/a 260,00 € variance/i);
  // La règle ne pousse jamais à affaiblir l'assertion quand le matériel ne
  // permet pas de calculer : elle interdit d'inventer un nombre.
  expect(prompt).toMatch(/do not invent one and do not weaken the assertion/i);
});

/**
 * Le corpus mesuré des refus `REQUIREMENT_UNGROUNDED` rejoué contre la ligne
 * réelle de chaque copie : `MEASURED_COPY_REFUSALS` (test/fixture.ts) porte la
 * citation du plan, la ligne du fichier au SHA publié, le rang que le refus
 * nomme et le verdict du contrat actuel. Deux invariants sont tenus pour chaque
 * ligne — une copie encore refusée n'a aucun témoin dans le fichier déclaré, et
 * la ligne réelle en a un : le refus vient de la copie, jamais du gate. Une copie
 * `a-floor` — exacte, privée de blanc, refusée par l'ancien proxy — est acceptée
 * et ne bloque plus son run. Quand le refus propose un fragment exact, ce
 * fragment est un témoin à son tour, sinon la seule réparation offerte au
 * planificateur serait refusée elle aussi.
 */
function proposedFragment(hint: string): string | null {
  const match = hint.match(/(?:^|\s)\d+: ("(?:[^"\\]|\\.)*")\.$/);
  if (!match?.[1]) {
    return null;
  }
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return null;
  }
}
/**
 * La ligne que le remède fait DÉSIGNER au lieu de la faire recopier : quand elle
 * est dans le matériel de résolution, le remède donne son numéro et aucun texte
 * — c'est la forme que le run 76249900 réclamait, où la recopie d'une seule
 * apostrophe a coûté le run. Un remède qui désigne doit désigner une ligne que
 * le gate sait écrire, sinon il enverrait le planificateur vers un refus.
 */
function designatedLine(hint: string): number | null {
  const match = hint.match(/send "line": (\d+) for /);
  return match?.[1] === undefined ? null : Number(match[1]);
}
/** Ce que le refus mesuré doit dire de la ligne réelle de cette copie. */
function measuredRemedy(measured: MeasuredCopyRefusal): string {
  if (measured.remedy === "names-line") {
    return `copied from line ${measured.lineNumber} of ${measured.lineFile}`;
  }
  if (measured.remedy === "names-other-file") {
    return `appears verbatim in ${measured.lineFile}`;
  }
  return "quote a real line of the declared file instead";
}
it("replays every measured ungrounded refusal against the real line", () => {
  const measuredPolicy = policyFor();
  let withRealLine = 0;
  let withDesignation = 0;
  let withProposal = 0;
  let accepted = 0;
  let refused = 0;
  for (const measured of MEASURED_COPY_REFUSALS) {
    const label = `${measured.runId} requirement ${measured.rank}`;
    const context =
      measured.realLine === ""
        ? contextWith([])
        : contextWith([
            lineAt(measured.lineFile, measured.lineNumber, measured.realLine),
          ]);
    const requirement = {
      behavior: "Changed behavior under review",
      quote: measured.quote,
      sourceFile: measured.declaredFile,
    };
    if (measured.realLine !== "") {
      withRealLine += 1;
      expect(
        requirementHasWitness(
          { quote: measured.realLine, sourceFile: measured.lineFile },
          context
        ),
        `${label}: la ligne réelle ${measured.lineNumber} n'est pas un témoin`
      ).toBe(true);
    }
    if (measured.outcome === "accepted") {
      accepted += 1;
      // La copie exacte que l'ancien plancher de blancs refusait porte du
      // contenu visible : elle est un témoin, et son exigence ne bloque plus le
      // run — le plan qui la porte n'a plus aucune exigence sans témoin.
      expect(quoteCarriesContent(measured.quote), `${label}: contenu`).toBe(
        true
      );
      expect(measured.cause, `${label}: cause mesurée`).toBe("a-floor");
      expect(
        requirementHasWitness(requirement, context),
        `${label}: la copie exacte n'est pas un témoin`
      ).toBe(true);
      expect(
        ungroundedRequirements(
          planWithWitnesses([
            {
              id: measured.scenarioId,
              sourceFiles: [measured.declaredFile],
              requirements: [
                {
                  sourceFile: measured.declaredFile,
                  quote: measured.quote,
                },
              ],
            },
          ]),
          context
        ),
        `${label}: le run meurt encore`
      ).toEqual([]);
      continue;
    }
    refused += 1;
    const refusal = ungroundedRequirement(
      measured.scenarioId,
      requirement,
      context,
      measuredPolicy,
      measured.rank
    );
    expect(
      requirementHasWitness(requirement, context),
      `${label}: la copie mesurée a un témoin`
    ).toBe(false);
    expect(refusal.code, `${label}: code du refus mesuré`).toBe(
      "REQUIREMENT_UNGROUNDED"
    );
    expect(
      refusal.message,
      `${label}: scénario, fichier déclaré et rang mesurés`
    ).toContain(
      `for ${measured.scenarioId}: ${measured.declaredFile} (requirement ${measured.rank})`
    );
    expect(refusal.hint, `${label}: cause mesurée`).toContain(
      measuredRemedy(measured)
    );
    const designated = designatedLine(refusal.hint);
    if (designated !== null) {
      withDesignation += 1;
      // Le remède ne rend aucun texte : le numéro qu'il donne se résout, et la
      // ligne que le gate écrirait est un témoin du fichier déclaré.
      const resolution = resolveLineReference(
        measured.declaredFile,
        designated,
        sourceLineMaterial(context)
      );
      expect(
        "text" in resolution,
        `${label}: la ligne désignée ne se résout pas`
      ).toBe(true);
      expect(String(refusal.hint)).not.toContain(
        JSON.stringify(measured.realLine)
      );
      expect(
        requirementHasWitness(
          {
            quote: (resolution as { text: string }).text,
            sourceFile: measured.declaredFile,
          },
          context
        ),
        `${label}: la ligne désignée n'est pas un témoin`
      ).toBe(true);
    }
    const proposed = proposedFragment(refusal.hint);
    if (proposed === null) {
      continue;
    }
    withProposal += 1;
    expect(
      requirementHasWitness(
        { quote: proposed, sourceFile: measured.declaredFile },
        context
      ),
      `${label}: la réparation proposée n'est pas un témoin`
    ).toBe(true);
  }
  expect(MEASURED_COPY_REFUSALS.length).toBe(20);
  expect(accepted).toBe(4);
  expect(refused).toBe(16);
  expect(withRealLine).toBe(19);
  // Chaque remède qui propose une réparation la propose dans une des deux
  // formes que le gate accepte : un numéro qui se résout, ou un fragment témoin.
  // Le compte est inchangé — la réparation reste offerte pour le même nombre de
  // refus mesurés —, seule sa forme change pour les lignes du diff.
  expect(withDesignation + withProposal).toBe(13);
});

/**
 * Les mutations d'une copie exacte, mesurées une par une : changer UN caractère
 * d'une ligne réelle suffit à la refuser, et le refus vient de l'exactitude —
 * chaque mutation porte encore assez de contenu visible pour que le plancher ne
 * soit pas la cause. C'est la mesure du mandat : aucune citation inexacte ne
 * devient acceptable, quelle que soit la mutation.
 */
const EXACT_LINE =
  "const total=formatAmountFr(centsToEuros(counted.totalCents));";
const QUOTE_MUTATIONS: { fault: string; quote: string }[] = [
  {
    fault: "substitution",
    quote: "const total=formatAmountEr(centsToEuros(counted.totalCents));",
  },
  {
    fault: "suppression",
    quote: "const total=formatAmountFr(centsToEuros(counted.totalCents);",
  },
  {
    fault: "insertion",
    quote: "const total=formatAmountFrr(centsToEuros(counted.totalCents));",
  },
  {
    fault: "casse",
    quote: "const Total=formatAmountFr(centsToEuros(counted.totalCents));",
  },
  {
    fault: "blanc",
    quote: "const  total=formatAmountFr(centsToEuros(counted.totalCents));",
  },
  {
    fault: "point médian",
    quote: "const total=formatAmountFr(centsToEuros(counted·totalCents));",
  },
  {
    fault: "accent grave",
    quote: "const total=formatAmountFr(centsToèuros(counted.totalCents));",
  },
  {
    fault: "guillemet interne",
    quote: 'const total=formatAmountFr(centsToEuros(counted."totalCents));',
  },
  {
    fault: "saut de ligne",
    quote: "const total=formatAmountFr(centsToEuros(counted.\ntotalCents));",
  },
];

it("refuses every one-character mutation of an exact quote", () => {
  const file = "src/cash.ts";
  const scenarioContext = contextWith([
    { filename: file, patch: `+ ${EXACT_LINE}` },
  ]);
  // La ligne exacte, elle, est un témoin : les mutations refusées le sont pour
  // leur faute, pas parce que le fichier serait hors du matériel.
  expect(
    requirementHasWitness(
      { quote: EXACT_LINE, sourceFile: file },
      scenarioContext
    )
  ).toBe(true);
  for (const { fault, quote } of QUOTE_MUTATIONS) {
    const label = `${fault}: ${JSON.stringify(quote)}`;
    expect(quote, label).not.toBe(EXACT_LINE);
    expect(quoteCarriesContent(quote), label).toBe(true);
    expect(
      requirementHasWitness({ quote, sourceFile: file }, scenarioContext),
      label
    ).toBe(false);
    const plan = planWithWitnesses([
      {
        id: "cash",
        sourceFiles: [file],
        requirements: [{ sourceFile: file, quote }],
      },
    ]);
    expect(ungroundedRequirements(plan, scenarioContext), label).toHaveLength(
      1
    );
    expect(refusalOfPlan(plan, scenarioContext, policyFor()).code, label).toBe(
      "REQUIREMENT_UNGROUNDED"
    );
  }
});

/**
 * Les bords du plancher de contenu : huit caractères normalisés portant une
 * lettre ou un chiffre sont un témoin, sept ne le sont pas, et le refus est
 * celui des deux couches — le schéma pour la longueur, le gate pour le contenu.
 */
it("accepts a quote at the content floor and refuses one under it", () => {
  const file = "src/cash.ts";
  const floor = "total=17";
  const under = "total=1";
  expect(floor).toHaveLength(QUOTE_MIN_TEXT_CHARS);
  expect(quoteCarriesContent(floor)).toBe(true);
  expect(quoteCarriesContent(under)).toBe(false);
  const scenarioContext = contextWith([
    { filename: file, patch: `+ ${floor}` },
  ]);
  expect(
    requirementHasWitness({ quote: floor, sourceFile: file }, scenarioContext)
  ).toBe(true);
  expect(
    requirementHasWitness({ quote: under, sourceFile: file }, scenarioContext)
  ).toBe(false);
  // Le plancher de longueur reste celui du schéma : une citation plus courte
  // n'entre jamais dans un plan.
  expect(() =>
    planWithWitnesses([
      {
        id: "cash",
        sourceFiles: [file],
        requirements: [{ sourceFile: file, quote: under }],
      },
    ])
  ).toThrow();
});

/**
 * Les bords du plafond de citation : le fragment de mille caractères exacts d'une
 * ligne minifiée est un témoin et entre dans un plan ; la ligne qui en fait mille
 * un est refusée par le contrat, avant le gate. Aucun plafond n'oblige donc à
 * citer ce qui ne tient pas.
 */
it("accepts a quote at the 1000-character cap and refuses the line above it", () => {
  const file = "src/bundle.js";
  const line = `const bundle=${"a".repeat(987)};`;
  expect(line).toHaveLength(1001);
  const scenarioContext = contextWith([{ filename: file, patch: `+ ${line}` }]);
  const fragment = line.slice(0, 1000);
  expect(
    requirementHasWitness(
      { quote: fragment, sourceFile: file },
      scenarioContext
    )
  ).toBe(true);
  const plan = planWithWitnesses([
    {
      id: "bundle",
      sourceFiles: [file],
      requirements: [{ sourceFile: file, quote: fragment }],
    },
  ]);
  expect(ungroundedRequirements(plan, scenarioContext)).toEqual([]);
  expect(() =>
    planWithWitnesses([
      {
        id: "bundle",
        sourceFiles: [file],
        requirements: [{ sourceFile: file, quote: line }],
      },
    ])
  ).toThrow();
});

/**
 * Les faux refus sont interdits : toute citation verbatim du matériel fourni est
 * acceptée. Ce test parcourt un fichier RÉEL du dépôt, ligne par ligne, et
 * demande chaque ligne comme citation du fichier qui la porte — seules les
 * lignes sous le plancher documenté (moins de huit caractères normalisés, ou
 * aucune lettre ni chiffre visible) sont refusées, et jamais une ligne
 * substantielle.
 */
it("accepts every substantial line of a real file as its own witness", () => {
  const path = "src/schema.ts";
  const lines = readFileSync(
    new URL("../src/schema.ts", import.meta.url),
    "utf8"
  ).split("\n");
  const patch = `@@ -1,${lines.length} +1,${lines.length} @@\n${lines
    .map((line) => `+${line}`)
    .join("\n")}`;
  const scenarioContext = contextWith([{ filename: path, patch }]);
  let accepted = 0;
  let belowFloor = 0;
  for (const [index, line] of lines.entries()) {
    const label = `ligne ${index + 1}: ${JSON.stringify(quoteExcerpt(line))}`;
    if (quoteCarriesContent(line)) {
      accepted += 1;
      expect(
        requirementHasWitness(
          { quote: line, sourceFile: path },
          scenarioContext
        ),
        label
      ).toBe(true);
      continue;
    }
    belowFloor += 1;
    expect(
      requirementHasWitness({ quote: line, sourceFile: path }, scenarioContext),
      label
    ).toBe(false);
  }
  expect(accepted + belowFloor).toBe(lines.length);
  // Le fichier réel offre des deux : des lignes substantielles acceptées, et des
  // lignes sous le plancher, refusées par la règle documentée et non par hasard.
  expect(accepted).toBeGreaterThan(200);
  expect(belowFloor).toBeGreaterThan(0);
});

/**
 * Le matériel numéroté que le planificateur reçoit : les lignes réelles du
 * contenu après changement, avec le numéro qu'un refus nomme. Chaque copie
 * mesurée dont la ligne réelle est connue doit retrouver cette ligne, à son
 * numéro, dans le matériel de son fichier : le planificateur peut recopier ce
 * que le refus lui demande au lieu de le retaper.
 */
it("lists the real line a refusal names in the numbered material", () => {
  for (const measured of MEASURED_COPY_REFUSALS) {
    if (measured.realLine === "") {
      continue;
    }
    const label = `${measured.runId} requirement ${measured.rank}`;
    const material = numberedSourceLines(
      contextWith([
        lineAt(measured.lineFile, measured.lineNumber, measured.realLine),
      ]),
      100_000
    );
    const file = material.find((item) => item.path === measured.lineFile);
    expect(file, label).toBeDefined();
    expect(file?.lines, label).toContainEqual({
      line: measured.lineNumber,
      text: measured.realLine,
    });
  }
});

it("builds the numbered material from the patch, with the file's own numbers", () => {
  const material = numberedSourceLines(
    contextWith([
      {
        filename: "src/a.ts",
        patch:
          "@@ -10,3 +10,4 @@\n context line\n-removed line\n+added line one\n+added line two\n",
      },
      {
        filename: "src/b.ts",
        patch: "@@ -1,1 +1,2 @@\n+first line of b\n+second line of b\n",
      },
    ]),
    1_000_000
  );
  expect(material).toEqual([
    {
      path: "src/a.ts",
      lines: [
        { line: 10, text: "context line" },
        { line: 11, text: "added line one" },
        { line: 12, text: "added line two" },
      ],
    },
    {
      path: "src/b.ts",
      lines: [
        { line: 1, text: "first line of b" },
        { line: 2, text: "second line of b" },
      ],
    },
  ]);
});

/**
 * Le matériel numéroté reste borné par le budget qu'il reçoit : sa taille
 * sérialisée ne le dépasse jamais, il se réduit au lieu de faire échouer le
 * message, et un budget plus large ne perd aucune ligne du patch.
 */
it("bounds the numbered material by the budget it is given", () => {
  const lines = Array.from(
    { length: 40 },
    (_, index) => `+line number ${index + 1} carries real code`
  );
  const scenarioContext = contextWith([
    {
      filename: "src/a.ts",
      patch: `@@ -1,1 +1,${lines.length} @@\n${lines.join("\n")}`,
    },
  ]);
  const all = numberedSourceLines(scenarioContext, 1_000_000);
  expect(all[0]?.lines).toHaveLength(lines.length);
  for (const budget of [10, 100, 200, 400, 800]) {
    const bounded = numberedSourceLines(scenarioContext, budget);
    expect(
      JSON.stringify(bounded).length,
      `budget ${budget}`
    ).toBeLessThanOrEqual(budget);
    const shown = bounded[0]?.lines.length ?? 0;
    expect(shown, `budget ${budget}`).toBeLessThan(lines.length);
  }
  expect(numberedSourceLines(scenarioContext, 10)).toEqual([]);
});

/**
 * P2 de la revue : git accepte un guillemet ou un antislash dans un nom de
 * fichier, que JSON échappe. Le budget comptait la longueur BRUTE du nom, donc
 * un nom long échappé laissait entrer une ligne de trop et le matériel
 * sérialisé dépassait le budget reçu — `planPayload` rejetait alors un payload
 * qui tenait avant l'ajout du matériel. Le coût se mesure sur le chemin
 * SÉRIALISÉ, ce que la mesure sous le budget du nom échappé prouve.
 */
it("charges an escaped filename its serialized length in the line budget", () => {
  // Un nom court, puis le même diff sous un nom que JSON échappe beaucoup :
  // 40 guillemets et 40 antislashs ajoutent 82 caractères à la sérialisation.
  const shortName = "src/a.ts";
  const escapedName = `src/${'\\"'.repeat(40)}.ts`;
  expect(escapedName.length).toBeLessThan(JSON.stringify(escapedName).length);
  const patch =
    "@@ -1,1 +1,2 @@\n+const first = compute();\n+const second = compute();\n";
  for (const name of [shortName, escapedName]) {
    const scenarioContext = contextWith([{ filename: name, patch }]);
    const all = numberedSourceLines(scenarioContext, 1_000_000);
    expect(all[0]?.lines, name).toHaveLength(2);
    // Un caractère de moins que la taille sérialisée réelle : la marge couvre
    // la structure JSON, donc le nom échappé ne peut plus tenir avec sa ligne.
    // Compté sur la longueur brute, il y tenait — et le matériel dépassait.
    const serialized = JSON.stringify(all).length;
    const bounded = numberedSourceLines(scenarioContext, serialized - 1);
    expect(
      JSON.stringify(bounded).length,
      `${name} sous ${serialized - 1}`
    ).toBeLessThanOrEqual(serialized - 1);
  }
});

const PLAN_PREVIEW: Preview = {
  evidence: "JSON sha at /version.json",
  sha: "1".repeat(40),
  url: "https://preview.example/",
};
const PLAN_PAGE: Observation = {
  snapshot: "",
  url: "https://preview.example/",
};
const PLAN_FIXTURES = { fixtures: {}, roles: [], visuals: [] };
/** La réserve que le message garantit au matériel numéroté (`runner.ts`). */
const MATERIAL_RESERVE_CHARS = 30_000;
/**
 * La ligne 71 du fichier cité du run 76249900 : le fichier y écrit l'apostrophe
 * ASCII `'`, et la copie du plan portait l'apostrophe typographique `’`
 * (U+2019). C'est ce seul caractère qui a fait perdre le run : le refus était
 * correct sur le fond, et son remède renvoyait le planificateur recopier.
 */
const CASH_LINE_71 = " * « 3,5 » : une demi-coupure n'existe pas.";
/**
 * La borne du message du planificateur, telle que `planPayload` la calcule : le
 * contexte de dépendances (`QA_CONTEXT_CHARS`), le diff — que cette borne ne
 * compte pas — puis la réserve du matériel. Les deux chiffres sont relus ici,
 * jamais recopiés de l'implémentation.
 */
function plannerPayloadBound(
  files: PrContext["files"],
  contextChars: number = config.QA_CONTEXT_CHARS
): number {
  return contextChars + JSON.stringify(files).length + MATERIAL_RESERVE_CHARS;
}

/**
 * Le message envoyé au planificateur porte le matériel numéroté, et sa taille
 * reste celle d'avant : le matériel prend la place que la borne de contexte
 * laisse libre. Un contexte qui sature la borne produit un message qui tient
 * encore — le run n'est jamais refusé pour un prompt trop lourd à cause du
 * matériel.
 */
it("keeps the planner message inside the context budget with its numbered material", () => {
  const payload = planPayload(
    contextWith([
      {
        filename: "src/a.ts",
        patch: "@@ -1,1 +1,2 @@\n+first real line\n+second real line",
      },
    ]),
    PLAN_PREVIEW,
    PLAN_PAGE,
    PLAN_FIXTURES,
    config
  );
  expect(payload.sourceLines).toEqual([
    {
      path: "src/a.ts",
      lines: [
        { line: 1, text: "first real line" },
        { line: 2, text: "second real line" },
      ],
    },
  ]);
  // La consigne qui fait recopier le matériel fait partie du prompt envoyé, au
  // chemin réel du payload : `sourceLines` à la racine (voir
  // `unit.test.ts`, qui vérifie que tout chemin cité existe dans le message).
  expect(PLANNER_PROMPT).toContain("`sourceLines`");
  // Le prompt enseigne la forme qui supprime la recopie : désigner la ligne que
  // `sourceLines` liste, et laisser le gate en écrire le texte. La recopie reste
  // permise pour la forme `quote`, jamais recommandée.
  expect(PLANNER_PROMPT).toMatch(
    /Reference the line instead of copying it: write `"line": <number>`/
  );
  expect(PLANNER_PROMPT).toMatch(
    /the gate reads that line from the material and writes its text as the requirement's quote/
  );
  expect(PLANNER_PROMPT).toMatch(
    /This is the recommended form; a `quote` you copy stays accepted/
  );
  // L'exemple est celui du run mesuré, et il mène au remède : la ligne 368 était
  // dans le matériel, donc la désigner ne laisse rien à altérer.
  expect(PLANNER_PROMPT).toMatch(
    /designating `"line": 368` is resolved by the gate/
  );
  expect(PLANNER_PROMPT).toMatch(
    /Never send `quote` and `line` together: they are alternatives, and the pair is refused/
  );
  // Les refus d'une référence sont annoncés avec leurs familles, pour que le
  // planificateur sache quoi corriger sans recevoir de texte. Les familles sont
  // celles du DIFF : le gate résout dans tout le diff, donc une ligne que
  // `sourceLines` n'affiche pas reste désignable, et le prompt le dit.
  expect(PLANNER_PROMPT).toMatch(
    /a file the diff does not change, a number the diff carries in no hunk \(the refusal names the numbers it does carry around yours\), a number it carries twice, a blank or punctuation-only line, or a line longer than the 1000-character cap/
  );
  expect(PLANNER_PROMPT).toMatch(
    /A line the diff carries is resolvable even when the budget cut it from `sourceLines`/
  );
  expect(PLANNER_PROMPT).toMatch(
    /resolved against the diff itself, so designate its number instead of retyping its text/
  );
  // Le squelette JSON du prompt ne demande plus une citation à recopier.
  expect(PLANNER_PROMPT).toContain(
    '"requirements":[{"sourceFile":"changed/path","line":368,"behavior":"required changed behavior"}]'
  );
  // Un contexte qui remplit la borne : le message tient dans une borne qui
  // compte désormais le diff et la réserve du matériel, séparément.
  const saturated: PrContext = {
    ...contextWith([
      {
        filename: "src/big.ts",
        patch: `@@ -1,1 +1,2 @@\n+${"x".repeat(400)}\n+${"y".repeat(400)}`,
      },
    ]),
    context: [
      {
        content: "z".repeat(config.QA_CONTEXT_CHARS),
        path: "src/big.ts",
        ref: context.sha,
      },
    ],
  };
  const bounded = planPayload(
    saturated,
    PLAN_PREVIEW,
    PLAN_PAGE,
    PLAN_FIXTURES,
    config
  );
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(
    plannerPayloadBound(bounded.pr.files)
  );
  expect(bounded.sourceLines[0]?.lines.length).toBeGreaterThan(0);
  // La borne reste celle d'avant l'ajout du matériel : un contexte plus lourd
  // que la borne est refusé, matériel numéroté ou non.
  expect(() =>
    planPayload(
      {
        ...saturated,
        context: [
          {
            content: "z".repeat(config.QA_CONTEXT_CHARS + 40_000),
            path: "src/big.ts",
            ref: context.sha,
          },
        ],
      },
      PLAN_PREVIEW,
      PLAN_PAGE,
      PLAN_FIXTURES,
      config
    )
  ).toThrow();
});

/**
 * Le compte mesuré du run 76249900 : la borne annonçait `QA_CONTEXT_CHARS +
 * 30_000`, mais le message portait déjà les patches du diff dans `pr`, que
 * `QA_CONTEXT_CHARS` ne compte pas — elle borne les fichiers de contexte lus par
 * `collectContext`. La réserve de 30 000 était donc dépensée avant le premier
 * affichage : 838 caractères de matériel, un fichier sur dix, et le fichier cité
 * absent. Ce test tient le correctif par les deux bouts : le compte d'avant ne
 * laissait rien, celui d'aujourd'hui donne au matériel sa réserve entière, avec
 * le dernier fichier du diff et sa ligne.
 */
it("gives the numbered material its reserve even when the diff fills the budget", () => {
  // Le fichier cité est le DERNIER du diff : la troncature de l'affichage le
  // perdait en premier.
  const cited = "packages/domain/src/cash.ts";
  const filler = Array.from(
    { length: 9 },
    (_, index) => `src/module-${index + 1}.ts` // nom du fichier du diff
  );
  const files = [
    ...filler.map((filename) => ({
      filename,
      patch: `@@ -1,1 +1,40 @@\n${Array.from(
        { length: 40 },
        (_, index) =>
          `+export const value${index} = compute(${index}); // ligne réelle du module`
      ).join("\n")}`,
    })),
    {
      filename: cited,
      patch: `@@ -1,0 +1,80 @@\n${Array.from(
        { length: 80 },
        (_, index) =>
          `+ * ligne de documentation ${index + 1} du module de caisse`
      )
        .join("\n")
        .replace(
          "+ * ligne de documentation 71 du module de caisse",
          `+${CASH_LINE_71}`
        )}`,
    },
  ];
  const saturatedContext: PrContext = {
    ...contextWith(files),
    context: [
      {
        // La collecte réelle remplit sa borne au caractère près.
        content: "z".repeat(config.QA_CONTEXT_CHARS),
        path: cited,
        ref: context.sha,
      },
    ],
  };
  const payload = planPayload(
    saturatedContext,
    PLAN_PREVIEW,
    PLAN_PAGE,
    PLAN_FIXTURES,
    config
  );
  // Le message tient dans la borne, qui compte maintenant séparément le
  // contexte, le diff et la réserve du matériel.
  expect(JSON.stringify(payload).length).toBeLessThanOrEqual(
    plannerPayloadBound(saturatedContext.files)
  );
  // Le compte d'AVANT ne laissait presque rien : les patches étaient déjà là,
  // donc `QA_CONTEXT_CHARS + 30_000` était presque tout dépensé avant le premier
  // affichage — 838 caractères mesurés sur le run 76249900.
  const withoutMaterial = JSON.stringify({
    ...payload,
    sourceLines: [],
  }).length;
  const oldRemainder = Math.max(
    0,
    config.QA_CONTEXT_CHARS + MATERIAL_RESERVE_CHARS - withoutMaterial
  );
  expect(oldRemainder).toBeLessThan(2000);
  // Sous ce compte-là, le fichier cité n'était même pas listé : la troncature
  // perlait le matériel avant le dernier fichier du diff.
  expect(
    numberedSourceLines(saturatedContext, oldRemainder).map((file) => file.path)
  ).not.toContain(cited);
  // La réserve existe donc réellement : le matériel occupe sa part et couvre
  // sept fichiers sur dix, là où le compte d'avant n'en laissait aucun — le
  // fichier cité compris.
  const material = JSON.stringify(payload.sourceLines);
  expect(material.length).toBeGreaterThan(20_000);
  expect(material.length).toBeLessThanOrEqual(MATERIAL_RESERVE_CHARS);
  const shown = payload.sourceLines.map((file) => file.path);
  expect(shown.length).toBeGreaterThan(1);
  // L'affichage reste BORNÉ et ne montre pas le fichier cité : c'est pourtant
  // toujours lui que la référence `line` atteint, parce que la résolution lit
  // tout le diff (`sourceLineMaterial`) et non la seule part affichée.
  expect(shown).not.toContain(cited);
  expect(
    resolveLineReference(cited, 71, sourceLineMaterial(saturatedContext))
  ).toEqual({ text: CASH_LINE_71 });
});

/**
 * Lot T, run 9add286d : la correction contrainte. Sa mesure est que la boucle de
 * correction ne converge pas quand elle demande de RECOPIER le plan — l'appel de
 * correction est payé et le run s'achève sur la copie altérée, alors que la
 * ligne exacte est dans le matériel et que le refus la nomme. Quand la citation est le seul
 * défaut du plan, le gate énumère donc les portions réelles du fichier cité, le
 * planificateur choisit un INDICE, et le gate écrit le texte. Ces tests tiennent
 * les deux bornes : aucune copie refusée n'est acceptée, et tout ce qui est
 * proposé au choix est un témoin.
 */
function measuredContextOf(measured: MeasuredCopyRefusal): PrContext {
  return measured.realLine === ""
    ? contextWith([])
    : contextWith([
        lineAt(measured.lineFile, measured.lineNumber, measured.realLine),
      ]);
}
/**
 * Le plan mesuré réduit à ses exigences : une citation témoin du fichier déclaré
 * quand la ligne réelle y est (c'est le cas de tous les scénarios mesurés dont
 * la copie est une altération), puis la copie refusée. Sans ce témoin, la classe
 * `COVERAGE_WITNESS_MISSING` s'ajouterait au refus et la correction contrainte
 * ne serait pas posée — ce qui est justement l'un des plateaux mesurés.
 */
function measuredPlanOf(measured: MeasuredCopyRefusal): Plan {
  const witness =
    measured.lineFile === measured.declaredFile ? measured.realLine : "";
  return planWithWitnesses([
    {
      id: measured.scenarioId,
      sourceFiles: [measured.declaredFile],
      requirements: [
        ...(witness === ""
          ? []
          : [{ sourceFile: measured.declaredFile, quote: witness }]),
        { sourceFile: measured.declaredFile, quote: measured.quote },
      ],
    },
  ]);
}
const MEASURED_NINE_ADD = MEASURED_COPY_REFUSALS.find((measured) =>
  measured.runId.startsWith("9add286d")
) as MeasuredCopyRefusal;
it("replays the corpus with a pick, and only ever offers real witnesses", () => {
  let resolvable = 0;
  const plateaus: string[] = [];
  let refusedCopies = 0;
  for (const measured of MEASURED_COPY_REFUSALS) {
    if (measured.outcome !== "refused") {
      continue;
    }
    refusedCopies += 1;
    const label = `${measured.runId} requirement ${measured.rank}`;
    const context = measuredContextOf(measured);
    // Le gate ne bouge pas : la copie refusée reste sans témoin, quel que soit
    // le nombre de candidats que la correction peut offrir.
    expect(
      ungroundedRequirements(measuredPlanOf(measured), context).length,
      label
    ).toBeGreaterThan(0);
    for (const candidate of quoteResolutionCandidates(
      { quote: measured.quote, sourceFile: measured.declaredFile },
      context
    )) {
      expect(
        requirementHasWitness(
          { quote: candidate.text, sourceFile: measured.declaredFile },
          context
        ),
        `${label}: le candidat ${JSON.stringify(candidate.text)} n'est pas un témoin`
      ).toBe(true);
    }
    if (
      quotePickCorrection(
        measuredPlanOf(measured),
        policyFor(),
        context,
        config
      )
    ) {
      resolvable += 1;
    } else {
      plateaus.push(label);
    }
  }
  // Le chiffre mesuré du lot T : 14 des 16 copies refusées du corpus reçoivent
  // une correction par indice. Les deux plateaux sont nommés, jamais arrondis :
  // `9ee36233 requirement 2` est une citation INVENTÉE pour laquelle le corpus
  // ne conserve aucune ligne réelle (`realLine` vide, donc aucun contexte
  // hors ligne à proposer) ; `36926219 requirement 3` est une citation EXACTE
  // attribuée à un autre fichier, que `repairRequirementAttribution` répare déjà
  // sans rien demander au planificateur. Ce test tombe si un plateau devient
  // résolvable ou l'inverse.
  expect(refusedCopies).toBe(16);
  expect(resolvable).toBe(14);
  expect(plateaus).toEqual([
    "9ee36233-f353-41ff-a2ea-ca175b150a5b requirement 2",
    "36926219-c46c-4431-9f45-8419a919b758 requirement 3",
  ]);
});
it("accepts every verbatim fragment of the measured line, down to eight characters", () => {
  const context = measuredContextOf(MEASURED_NINE_ADD);
  // Le préfixe de 56 caractères est EXACTEMENT ce que la copie du run 9add286d
  // reproduit avant d'insérer `:""` : s'arrêter trois caractères plus tôt était
  // un témoin, et le gate ne peut pas le refuser.
  const prefix = MEASURED_NINE_ADD.quote.slice(0, 56);
  expect(MEASURED_NINE_ADD.realLine).toContain(prefix);
  expect(
    requirementHasWitness(
      { quote: prefix, sourceFile: MEASURED_NINE_ADD.declaredFile },
      context
    )
  ).toBe(true);
  // La même copie une fois son invention retirée — trois caractères de moins —
  // est un témoin : c'est le correctif minimal que le gate reconnaît.
  expect(
    requirementHasWitness(
      {
        quote: `${prefix}}`,
        sourceFile: MEASURED_NINE_ADD.declaredFile,
      },
      context
    )
  ).toBe(true);
  // Un préfixe court reste un témoin dès qu'il porte du contenu visible : huit
  // caractères de cette ligne suffisent.
  const short = MEASURED_NINE_ADD.quote.slice(0, 8);
  expect(short.length).toBe(8);
  expect(
    requirementHasWitness(
      { quote: short, sourceFile: MEASURED_NINE_ADD.declaredFile },
      context
    )
  ).toBe(true);
});
it("resolves the measured copy by pick and leaves the refused plan intact", () => {
  const context = measuredContextOf(MEASURED_NINE_ADD);
  const plan = measuredPlanOf(MEASURED_NINE_ADD);
  const correction = quotePickCorrection(
    plan,
    policyFor(),
    context,
    config,
    MEASURED_NINE_ADD.runId
  );
  expect(correction).toBeDefined();
  const candidates = quoteResolutionCandidates(
    {
      quote: MEASURED_NINE_ADD.quote,
      sourceFile: MEASURED_NINE_ADD.declaredFile,
    },
    context
  );
  const [candidate] = candidates;
  // La question ne demande aucun texte : elle nomme le scénario, le rang, et les
  // portions exactes avec leur indice.
  expect(correction?.message).toContain('"picks"');
  expect(correction?.message).toContain(MEASURED_NINE_ADD.scenarioId);
  expect(correction?.message).toContain(JSON.stringify(candidate?.text));
  const resolved = correction?.resolve({
    picks: [
      {
        candidate: 1,
        requirement: MEASURED_NINE_ADD.rank,
        scenario: MEASURED_NINE_ADD.scenarioId,
      },
    ],
  }) as Plan | undefined;
  expect(
    resolved?.scenarios[0]?.requirements[MEASURED_NINE_ADD.rank - 1]?.quote
  ).toBe(candidate?.text);
  // Le plan refusé reste intact : une correction qui ne converge pas laisse à
  // l'appelant le plan exact qu'il avait refusé, donc son message exact.
  expect(
    plan.scenarios[0]?.requirements[MEASURED_NINE_ADD.rank - 1]?.quote
  ).toBe(MEASURED_NINE_ADD.quote);
  expect(ungroundedRequirements(resolved as Plan, context)).toEqual([]);
  expect(() =>
    validateCoverage(resolved as Plan, context, policyFor(), config)
  ).not.toThrow();
});
it("keeps the refusal of today when a pick does not resolve the citation", () => {
  const context = measuredContextOf(MEASURED_NINE_ADD);
  const correction = quotePickCorrection(
    measuredPlanOf(MEASURED_NINE_ADD),
    policyFor(),
    context,
    config
  );
  for (const answer of [
    {
      picks: [
        {
          candidate: 99,
          requirement: MEASURED_NINE_ADD.rank,
          scenario: MEASURED_NINE_ADD.scenarioId,
        },
      ],
    },
    { picks: [{ candidate: 1, requirement: 1, scenario: "autre-scenario" }] },
    { picks: [] },
    {},
  ]) {
    expect(correction?.resolve(answer)).toBeUndefined();
  }
});
it("stays on today's refusal when no real candidate can be offered", () => {
  // Une copie sans aucun recouvrement avec le fichier cité ne donne pas un seul
  // candidat : la correction contrainte n'est pas posée, et le refus reste
  // entier — c'est la plateau mesuré des copies inventées.
  const junk = "zzzz{{{zzzz";
  const context = measuredContextOf(MEASURED_NINE_ADD);
  expect(
    quoteResolutionCandidates(
      { quote: junk, sourceFile: MEASURED_NINE_ADD.declaredFile },
      context
    )
  ).toEqual([]);
  const plan = planWithWitnesses([
    {
      id: MEASURED_NINE_ADD.scenarioId,
      sourceFiles: [MEASURED_NINE_ADD.declaredFile],
      requirements: [
        {
          sourceFile: MEASURED_NINE_ADD.declaredFile,
          quote: MEASURED_NINE_ADD.realLine,
        },
        { sourceFile: MEASURED_NINE_ADD.declaredFile, quote: junk },
      ],
    },
  ]);
  expect(ungroundedRequirements(plan, context)).toHaveLength(1);
  expect(
    quotePickCorrection(plan, policyFor(), context, config)
  ).toBeUndefined();
  expect(ungroundedPlanRefusals(plan, context, policyFor())).toHaveLength(1);
});
it("does not pose a pick while another defect remains in the plan", () => {
  // La citation n'est pas le seul défaut — ici une exigence attribuée à un
  // fichier que le scénario ne déclare pas : le planificateur reçoit le refus
  // d'aujourd'hui, entier, et non une question sur sa citation.
  const context = measuredContextOf(MEASURED_NINE_ADD);
  const bare = measuredPlanOf(MEASURED_NINE_ADD);
  const plan = PlanSchema.parse({
    ...bare,
    scenarios: [
      {
        ...bare.scenarios[0],
        requirements: [
          ...(bare.scenarios[0]?.requirements.slice(0, 1) ?? []),
          {
            behavior: "b",
            quote: MEASURED_NINE_ADD.quote,
            sourceFile: "packages/domain/src/cash.ts",
          },
        ],
      },
    ],
  });
  expect(
    undeclaredSourcePlanRefusals(plan, context).length +
      ungroundedPlanRefusals(plan, context, policyFor()).length
  ).toBeGreaterThan(0);
  expect(
    quotePickCorrection(plan, policyFor(), context, config)
  ).toBeUndefined();
});
it("bounds a fragment's end in the planner prompt without forbidding it", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // Le cas mesuré du lot T : la copie s'arrête dans l'expression, puis la
  // referme. La consigne dit que s'arrêter au milieu d'une expression est un
  // témoin, et que refermer ce que la copie laisse ouvert est le défaut.
  expect(prompt).toMatch(/Your copy may STOP anywhere inside a listed line/i);
  expect(prompt).toMatch(/never close the expression your copy leaves open/i);
  expect(prompt).toMatch(
    /never add a bracket, a semicolon or a ternary branch to make the fragment look complete/i
  );
  // Le contre-exemple porte le fichier, le numéro de ligne et l'invention.
  expect(prompt).toContain("line 368");
  expect(prompt).toContain('inserted `:""`');
  // La règle ne contredit pas le gate : un préfixe verbatim reste un témoin.
  expect(prompt).toMatch(
    /stopping three characters earlier was an exact witness/i
  );
});
