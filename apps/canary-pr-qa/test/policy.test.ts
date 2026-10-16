import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import { PLANNER_PROMPT } from "../src/model.js";
import {
  absentRequirementRemedy,
  isDocumentationPath,
  PolicySchema,
  quoteHasWitness,
  repairRequirementAttribution,
  requirementEvidence,
  requirementHasWitness,
  stitchedQuoteFragments,
  stitchedQuoteRemedy,
  suggestedQuoteLines,
  UNGROUNDED_ABSENT_REMEDY,
  undeclaredSourcePlanRefusals,
  ungroundedPlanRefusals,
  ungroundedRequirements,
  unwitnessedPlanRefusals,
  validateCoverage,
  witnessFiles,
} from "../src/policy.js";
import { planShapeRefusals } from "../src/runner.js";
import {
  CRITICAL_QUOTE_MIN_WORD_CHARS,
  type Plan,
  PlanSchema,
  QUOTE_MIN_TEXT_CHARS,
  quoteCarriesContent,
} from "../src/schema.js";

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
  expect(
    ungroundedRequirements(plan, reflowedCashContext, policyFor())
  ).toEqual([]);
  expect(
    unwitnessedPlanRefusals(plan, reflowedCashContext, policyFor())
  ).toEqual([]);
  expect(
    validateCoverage(plan, reflowedCashContext, policyFor(), config).gate
  ).toBe("complete");
});

it("still refuses a quote with one different character", () => {
  const plan = cashPlan(REFLOWED_QUOTE.replace("false", "true"));
  expect(
    ungroundedRequirements(plan, reflowedCashContext, policyFor())
  ).toHaveLength(1);
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
  expect(ungroundedRequirements(plan, cashPatchOnly, policyFor())).toHaveLength(
    1
  );
});

it("refuses a quote that carries no real content", () => {
  // Le seuil vit dans le schéma de `quote` (PlanSchema) : un plan dont la
  // citation n'a pas de contenu réel n'est pas valide. Sept espaces suivis
  // d'une accolade se normalisent en « } », que tout fichier contient, et
  // couvriraient un fichier entier ; huit caractères invisibles se normalisent
  // en chaîne vide, que `includes` accepte toujours.
  expect(() => cashPlan("        ")).toThrow();
  expect(() => cashPlan(`${"\u200b".repeat(7)}}`)).toThrow();
  expect(() => cashPlan("        }")).toThrow();
  // Le gate de témoin refuse la même citation, y compris forgée après le schéma :
  // la comparaison reste la dernière barrière si un plan contourne le contrat.
  expect(quoteHasWitness(CASH_FILE, "")).toBe(false);
  expect(quoteHasWitness(CASH_FILE, "   \n\t ")).toBe(false);
  expect(quoteHasWitness(CASH_FILE, "        ")).toBe(false);
  expect(quoteHasWitness(CASH_FILE, "        }")).toBe(false);
  expect(quoteHasWitness(CASH_FILE, `${"\u200b".repeat(7)}}`)).toBe(false);
  const forged = cashPlan(REFLOWED_QUOTE);
  forged.scenarios[0]!.requirements[0]!.quote = "        }";
  expect(
    ungroundedRequirements(forged, reflowedCashContext, policyFor())
  ).toHaveLength(1);
  expect(refusalOfPlan(forged, reflowedCashContext, policyFor()).code).toBe(
    "REQUIREMENT_UNGROUNDED"
  );
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
      invisibleIdContext,
      policyFor()
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
  expect(ungroundedRequirements(plan, scenarioContext, policyFor())).toEqual(
    []
  );
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
  expect(quoteCarriesContent(shortQuote, true)).toBe(true);
  const logic = witnessed(shortQuote, "src/logic.ts", "logic");
  expect(
    ungroundedRequirements(logic.plan, logic.scenarioContext, policyFor())
  ).toEqual([]);
  expect(
    validateCoverage(logic.plan, logic.scenarioContext, policyFor(), config)
      .gate
  ).toBe("complete");
  // Le cas nommé par la revue du tour 3 : `src/value.json` réduit à `{"x": 1}`,
  // deux alphanumériques, chemin critique.
  expect(quoteCarriesContent(JSON_QUOTE, true)).toBe(true);
  const json = witnessed(JSON_QUOTE, JSON_FILE, "value");
  expect(
    ungroundedRequirements(json.plan, json.scenarioContext, policyFor())
  ).toEqual([]);
  expect(
    validateCoverage(json.plan, json.scenarioContext, policyFor(), config).gate
  ).toBe("complete");
});

it("refuses a critical quote with no visible content", () => {
  // Les fragments nommés par la revue du tour 4 : un séparateur de ponctuation
  // et huit zéro-largeurs non-joignants, plantés dans un diff hostile.
  const separator = "// ------";
  const invisible = ZWNJ.repeat(8);
  expect(quoteCarriesContent(separator)).toBe(true);
  expect(quoteCarriesContent(separator, true)).toBe(false);
  // Le plancher universel suffit déjà pour les invisibles : huit zéro-largeurs
  // forment un seul jeton, refusé par le contrat de `quote` comme par le gate.
  expect(quoteCarriesContent(invisible)).toBe(false);
  expect(quoteHasWitness(`${invisible}\n`, invisible, true)).toBe(false);
  const { plan, scenarioContext } = witnessed(
    separator,
    "src/logic.ts",
    "logic"
  );
  expect(
    ungroundedRequirements(plan, scenarioContext, policyFor())
  ).toHaveLength(1);
  const refusal = refusalOfPlan(plan, scenarioContext, policyFor());
  expect(refusal.code).toBe("REQUIREMENT_UNGROUNDED");
  // La citation EXISTE dans le fichier : lui répondre « no source witness »
  // ferait renvoyer la même citation exacte au planificateur. Le refus nomme la
  // règle du fichier critique, et ne propose pas un skip que le gate refuse.
  expect(refusal.message).toBe("Weak source witness for logic: src/logic.ts");
  expect(refusal.hint).toContain(
    `at least ${CRITICAL_QUOTE_MIN_WORD_CHARS} letter or digit`
  );
  expect(refusal.hint).toContain(".canary/qa.json");
  // Aucun fichier n'est proposé comme portant la citation : elle y est, et le
  // remède est une citation qui porte du contenu, pas une réattribution.
  const [line] = ungroundedPlanRefusals(plan, scenarioContext, policyFor());
  expect(line).toContain(JSON.stringify(separator));
  expect(witnessFiles(separator, scenarioContext, policyFor())).toEqual([]);
  expect(line).not.toContain("appears verbatim in");
  // Le fragment invisible forgé après le contrat ne franchit pas le gate non
  // plus : le schéma le refuse déjà.
  expect(() =>
    planWithWitnesses([
      {
        id: "logic",
        sourceFiles: ["src/logic.ts"],
        requirements: [{ sourceFile: "src/logic.ts", quote: invisible }],
      },
    ])
  ).toThrow();
  // Hors chemin critique, le même séparateur exact reste un témoin : un
  // séparateur recopié d'un script n'est pas un faux vert.
  const script = witnessed(separator, SCRIPT_FILE, "toggle");
  expect(
    validateCoverage(script.plan, script.scenarioContext, policyFor(), config)
      .gate
  ).toBe("complete");
});

it("does not count a default-ignorable letter as visible content", () => {
  // U+115F HANGUL CHOSEONG FILLER, U+1160 HANGUL JUNGSEONG FILLER, U+3164
  // HANGUL FILLER et U+FFA0 HALFWIDTH HANGUL FILLER sont à la fois `\p{L}` et
  // `Default_Ignorable_Code_Point` : invisibles, ils satisfaisaient la lettre
  // exigée d'un témoin critique. Un diff hostile les plante et couvrait le
  // fichier sans rien montrer.
  for (const filler of ["\u115f", "\u1160", "\u3164", "\uffa0"]) {
    const quote = `${filler.repeat(4)} ${filler.repeat(4)}`;
    // Le plancher universel est franchi : assez de caractères, deux jetons.
    expect(quote.length).toBeGreaterThanOrEqual(QUOTE_MIN_TEXT_CHARS);
    expect(quoteCarriesContent(quote)).toBe(true);
    // Mais aucun caractère visible ne subsiste, donc aucun témoin critique.
    expect(quoteCarriesContent(quote, true)).toBe(false);
    expect(quoteHasWitness(`+ ${quote}`, quote, true)).toBe(false);
  }
  // Une vraie lettre ou un vrai chiffre reste visible, y compris quand la
  // source en offre peu — les cas que la revue du tour 3 demandait de garder.
  for (const visible of ["if (x) {", JSON_QUOTE, "value 12"]) {
    expect(quoteCarriesContent(visible, true)).toBe(true);
  }
});

it("refuses a quote reduced to a single token, exact or not", () => {
  const line = "finish(function(){return;});";
  // Longue mais d'un seul jeton : elle ne désigne aucun endroit précis, et le
  // plancher de longueur seul l'accepterait. Le contrat de `quote` la refuse
  // déjà, comme le gate de témoin si un plan la forge après coup.
  expect(line.length).toBeGreaterThanOrEqual(QUOTE_MIN_TEXT_CHARS);
  expect(quoteCarriesContent(line)).toBe(false);
  expect(quoteCarriesContent("alt")).toBe(false);
  expect(quoteCarriesContent("end();")).toBe(false);
  const singleTokenFile = ["alt", "  end();", `  ${line}`].join("\n");
  expect(quoteHasWitness(singleTokenFile, line)).toBe(false);
  expect(quoteHasWitness(singleTokenFile, "alt")).toBe(false);
  // Refusée partout, y compris dans le fichier ordinaire où le seuil critique
  // ne s'applique pas.
  for (const path of [SCRIPT_FILE, "src/logic.ts"]) {
    const scenario = {
      id: "finish",
      sourceFiles: [path],
      requirements: [{ sourceFile: path, quote: line }],
    };
    expect(() => planWithWitnesses([scenario])).toThrow();
    const forged = planWithWitnesses([
      {
        id: "finish",
        sourceFiles: [path],
        requirements: [{ sourceFile: path, quote: "end(); run();" }],
      },
    ]);
    forged.scenarios[0]!.requirements[0]!.quote = line;
    const segment = contextWith([{ filename: path, patch: `+ ${line}` }]);
    expect(ungroundedRequirements(forged, segment, policyFor())).toHaveLength(
      1
    );
    expect(refusalOfPlan(forged, segment, policyFor()).code).toBe(
      "REQUIREMENT_UNGROUNDED"
    );
  }
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
  expect(quoteCarriesContent(CRITICAL_FILE_LINE, true)).toBe(true);
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
  expect(ungroundedRequirements(plan, criticalContext, policyFor())).toEqual(
    []
  );
  expect(
    validateCoverage(plan, criticalContext, policyFor(), config).gate
  ).toBe("complete");
  // Le contenu réel du run, dans le même fichier critique, reste témoin.
  expect(quoteCarriesContent(REFLOWED_QUOTE, true)).toBe(true);
  expect(
    requirementHasWitness(
      { quote: REFLOWED_QUOTE, sourceFile: "src/cash.ts" },
      reflowedCashContext,
      policyFor()
    )
  ).toBe(true);
});

it("still refuses padding under the graded content rule", () => {
  // Le plancher universel fait tout le travail : «        } » se normalise en
  // « } » (un jeton, un caractère), et sept zéro-largeurs suivis d'une accolade
  // en « } » aussi. Aucune citation réduite à une accolade ne passe, quel que
  // soit le fichier.
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
      reflowedCashContext,
      policyFor()
    )
  ).toBe(false);
  expect(
    ungroundedRequirements(cashPlan(stitched), reflowedCashContext, policyFor())
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
      junction,
      policyFor()
    )
  ).toBe(false);
  expect(
    ungroundedRequirements(cashPlan(stitched), junction, policyFor())
  ).toHaveLength(1);
});
it("accepts a quote contained in the patch alone", () => {
  const plan = cashPlan("ok: false,");
  expect(
    requirementHasWitness(
      { quote: "ok: false,", sourceFile: "src/cash.ts" },
      cashPatchOnly,
      policyFor()
    )
  ).toBe(true);
  expect(ungroundedRequirements(plan, cashPatchOnly, policyFor())).toEqual([]);
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
      cashPatchOnly,
      policyFor()
    )
  ).toBe(false);
  expect(
    requirementHasWitness(
      { quote: REFLOWED_QUOTE, sourceFile: "src/cash.ts" },
      reflowedCashContext,
      policyFor()
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
  expect(ungroundedRequirements(plan, pageContext, policyFor())).toHaveLength(
    1
  );
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
      pageContext,
      policyFor()
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
  expect(witnessFiles(REFLOWED_QUOTE, misattributed, policyFor())).toEqual([
    "src/cash.ts",
  ]);
  const [refusal] = ungroundedPlanRefusals(plan, misattributed, policyFor());
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
  expect(
    repairRequirementAttribution(attributed, misattributed, policyFor())
  ).toEqual([
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
    repairRequirementAttribution(
      cashPlan(REFLOWED_QUOTE),
      reflowedCashContext,
      policyFor()
    )
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
      id: "flow",
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
  expect(
    ungroundedRequirements(plan, cashSpecContext, policyFor())
  ).toHaveLength(1);
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
    cashSpecContext,
    policyFor()
  );
  expect(suggestions.length).toBeGreaterThan(0);
  expect(suggestions.length).toBeLessThanOrEqual(2);
  for (const candidate of suggestions) {
    expect(CASH_SPEC_LINES[candidate.line - 1]).toBe(candidate.text);
    expect(CASH_SPEC_FILE).toContain(candidate.text);
    expect(quoteCarriesContent(candidate.text, true)).toBe(true);
  }
  // La ligne 47 reprend quatre des huit mots de la citation ; la ligne 55 en
  // reprend quatre aussi, mais ne forme qu'un seul jeton au contrat de `quote`
  // (aucun blanc intérieur) : le remède ne propose jamais un fragment que le
  // plan refuserait.
  expect(suggestions).toEqual([
    { line: 47, text: '  const result = countCash({ "500": "3,5" });' },
  ]);
  expect(line).toContain(
    `Real lines of ${CASH_SPEC_PATH} to quote instead: 47: ${JSON.stringify(suggestions[0]!.text)}.`
  );
});

it("measures the absent-quote suggestion inside the correction budget", () => {
  const plan = cashSpecPlan(STITCHED_QUOTE);
  const [line = ""] = ungroundedPlanRefusals(
    plan,
    cashSpecContext,
    policyFor()
  );
  const remedy =
    "Quote exact source or diff text; page content alone is not a requirement.";
  const before = line.slice(0, line.indexOf(remedy) + remedy.length);
  // Mesure du coût réel : 132 caractères ajoutés à la ligne de détail, qui
  // reste loin du budget restant après le préambule fatal (1860) dans la
  // correction que `model.ts` tronque à 2000 — le cas intégré est mesuré par
  // `unit.test.ts` ("returns real lines to quote instead of an absent quote").
  expect(before).toContain("No source witness for cash");
  expect(before).toHaveLength(220);
  expect(line).toHaveLength(352);
  expect(line.length - before.length).toBe(132);
});

it("proposes no line when none overlaps the quote", () => {
  const invented = "let totally unrelated invented statement here;";
  expect(
    suggestedQuoteLines(
      { quote: invented, sourceFile: CASH_SPEC_PATH },
      cashSpecContext,
      policyFor()
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
      elsewhere,
      policyFor()
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
  expect(
    suggestedQuoteLines(requirement, elsewhere, policyFor()).length
  ).toBeGreaterThan(0);
  expect(absentRequirementRemedy(requirement, elsewhere, policyFor())).toBe(
    "The quote appears verbatim in src/form.ts; declare that file and attribute the requirement to it."
  );
});

it("proposes a real line of the cited file when the quote exists nowhere", () => {
  const remedy = absentRequirementRemedy(
    { quote: STITCHED_QUOTE, sourceFile: CASH_SPEC_PATH },
    cashSpecContext,
    policyFor()
  );
  expect(remedy).toBe(
    `Real lines of ${CASH_SPEC_PATH} to quote instead: 47: ${JSON.stringify('  const result = countCash({ "500": "3,5" });')}.`
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
      pageTsxContext,
      policyFor()
    )
  ).toEqual([]);
  const fragments = stitchedQuoteFragments(
    { quote: STITCHED_JSX_QUOTE, sourceFile: PAGE_TSX_PATH },
    pageTsxContext,
    policyFor()
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
    expect(quoteCarriesContent(item.candidate, true)).toBe(true);
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
    ungroundedRequirements(
      pageTsxPlan(STITCHED_JSX_QUOTE),
      pageTsxContext,
      policyFor()
    )
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
    pageTsxContext,
    policyFor()
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
      pageTsxContext,
      policyFor()
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
      pageTsxContext,
      policyFor()
    )
  ).toEqual([]);
  expect(
    stitchedQuoteRemedy(
      { quote: partial, sourceFile: PAGE_TSX_PATH },
      pageTsxContext,
      policyFor()
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
    stitchedQuoteFragments(
      { quote, sourceFile: SPLIT_PATH },
      splitContext,
      policyFor()
    )
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
    stitchedQuoteFragments(
      { quote, sourceFile: single },
      singleContext,
      policyFor()
    )
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
    stitchedQuoteFragments({ quote, sourceFile: path }, capContext, policyFor())
  ).toEqual([
    { candidate: head, fragment: head, line: 2 },
    { candidate: `${tail} ${"a".repeat(60)}`, fragment: tail, line: 4 },
  ]);
  const [, second] = stitchedQuoteFragments(
    { quote, sourceFile: path },
    capContext,
    policyFor()
  );
  // Le candidat reste une portion EXACTE de la ligne, sous la borne, et il
  // passe le contrat de citation du fichier critique.
  expect(second!.candidate.length).toBeLessThanOrEqual(120);
  expect(tailLine).toContain(second!.candidate);
  expect(second!.candidate).toContain(tail);
  expect(quoteCarriesContent(second!.candidate, true)).toBe(true);
  expect(
    stitchedQuoteRemedy({ quote, sourceFile: path }, capContext, policyFor())
  ).toContain(`4: ${JSON.stringify(second!.candidate)}`);
});

it("stays silent when the quote and both its fragments are absent", () => {
  // Cas (c) : rien de la citation n'existe, donc aucun fragment à nommer et
  // aucun candidat à proposer — le refus reste celui d'aujourd'hui.
  const nowhere = "const ouvrirTiroir = () => setOpen(true);";
  expect(
    stitchedQuoteFragments(
      { quote: nowhere, sourceFile: PAGE_TSX_PATH },
      pageTsxContext,
      policyFor()
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
  expect(witnessFiles(quote, changed, policyFor())).toEqual(paths);
  expect(
    absentRequirementRemedy(
      { quote, sourceFile: "src/cited.ts" },
      changed,
      policyFor()
    )
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
    absentRequirementRemedy(
      { quote, sourceFile: "src/cited.ts" },
      outside,
      policyFor()
    )
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
  expect(witnessFiles(quote, many, policyFor())).toEqual(paths);
  expect(
    absentRequirementRemedy(
      { quote, sourceFile: "src/cited.ts" },
      many,
      policyFor()
    )
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
    renamed,
    policyFor()
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
      unrelated,
      policyFor()
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
    suggestedQuoteLines({ quote, sourceFile: "src/logic.ts" }, ctx, policyFor())
  ).toEqual([
    { line: 1, text: "const alpha = 1 + offset;" },
    { line: 2, text: "const alpha = 2 + offset;" },
  ]);
});

it("accepts an exact single-line quote from the cited file", () => {
  const plan = cashSpecPlan(CASH_SPEC_LINES[46]!);
  expect(ungroundedRequirements(plan, cashSpecContext, policyFor())).toEqual(
    []
  );
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
    ungroundedRequirements(cashSpecPlan(skipped), cashSpecContext, policyFor())
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
      reconstructedContext,
      policyFor()
    )
  ).toBe(true);
  expect(
    ungroundedRequirements(cashPlan(quote), reconstructedContext, policyFor())
  ).toEqual([]);
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
      reconstructedContext,
      policyFor()
    )
  ).toBe(false);
  expect(
    ungroundedRequirements(
      cashPlan(stitched),
      reconstructedContext,
      policyFor()
    )
  ).toHaveLength(1);
});

it("forbids stitching two real lines into one quote in the planner prompt", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  expect(prompt).toMatch(/never stitch two separate lines into one quote/i);
  // Le repli d'un bloc multi-lignes sur une ligne reste permis — cas accepté du
  // lot E — et la reformulation en une ligne qui « devrait » exister est
  // interdite ; c'est la distinction que le prompt doit enseigner.
  expect(prompt).toMatch(
    /Reflowing a multi-line block onto one line stays allowed/i
  );
  // Le contre-exemple réel du lot F est enseigné, dans ses deux lignes réelles
  // et dans la citation recousue qu'elles ont produite.
  expect(prompt).toContain('const result = countCash({ "500": "3,5" });');
  expect(prompt).toContain("expect(result.ok).toBe(false);");
  expect(prompt).toContain(STITCHED_QUOTE);
});
