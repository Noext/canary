import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import {
  isDocumentationPath,
  PolicySchema,
  quoteHasWitness,
  repairRequirementAttribution,
  requirementEvidence,
  requirementHasWitness,
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
