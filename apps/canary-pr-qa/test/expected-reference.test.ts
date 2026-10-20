import { describe, expect, it } from "vitest";
import { assertionMatches } from "../src/canary.js";
import { PLANNER_PROMPT } from "../src/model.js";
import { missingExpectationRefusals } from "../src/plan-evidence.js";
import {
  type Plan,
  PlanSchema,
  plannerPlanSchema,
  resolveExpectedLiteral,
  type SourceLineMaterial,
} from "../src/schema.js";
import { CASH_TS_LINES, PAGE_TS_LINES } from "./lot-v-replay.js";

const PAGE = "apps/web/app/page.tsx";
const CASH = "packages/domain/src/cash.ts";

function lineOf(
  file: string,
  line: number,
  lines: { line: number; text: string }[]
): string {
  const found = lines.find((item) => item.line === line);
  if (!found) {
    throw new Error(`No measured line ${line} of ${file}`);
  }
  return found.text;
}

function pageLine(line: number): string {
  return lineOf(PAGE, line, PAGE_TS_LINES);
}

function cashLine(line: number): string {
  return lineOf(CASH, line, CASH_TS_LINES);
}

function materialFor(
  file: string,
  lines: { line: number; text: string }[]
): SourceLineMaterial[] {
  return [{ lines, path: file }];
}

/**
 * Le plan minimal qui porte une assertion unique : c'est l'attendu de cette
 * assertion que la forme RÉFÉRENCE désigne, et rien d'autre du plan ne dépend
 * du matériel.
 */
function submission(
  file: string,
  kind: string,
  expected: unknown,
  quote = "ecart-justifie"
) {
  return {
    skipped: [],
    summary: "Le littéral de la ligne est la valeur attendue",
    scenarios: [
      {
        assertions: [
          {
            afterStep: "observe",
            description: "La vue affiche la valeur désignée",
            id: "status",
            kind,
            ...(expected === undefined ? {} : { expected }),
            target: { by: "css", value: "#status" },
            verification: "state",
          },
        ],
        id: "designated-literal",
        kind: "happy_path",
        preconditions: [],
        rationale:
          "Le comportement changé est porté par le littéral de la ligne",
        requirements: [
          {
            behavior: "Le statut changé est prouvé par le littéral de la ligne",
            quote,
            sourceFile: file,
          },
        ],
        sourceFiles: [file],
        steps: [
          {
            action: { type: "observe" },
            description: "Observer la page",
            id: "observe",
          },
          {
            action: { type: "assert", assertionId: "status" },
            description: "Vérifier la valeur désignée",
            id: "check",
          },
        ],
        title: "Littéral désigné",
      },
    ],
  };
}

/** Le plan minimal dont l'attendu de l'assertion unique est `expected`. */
function withExpected(file: string, kind: string, expected: unknown) {
  return submission(file, kind, expected);
}

function referenceSubmission(
  file: string,
  kind: string,
  line: number,
  expectedSource = file
) {
  return withExpected(file, kind, { line, sourceFile: expectedSource });
}

/**
 * Ce que le gate rend d'une réponse du planificateur : le plan persisté, ou le
 * refus nommé quand une référence ne désigne pas un littéral exploitable.
 */
function resolve(
  input: unknown,
  material: SourceLineMaterial[]
): { plan?: Plan; refusal?: string } {
  const parsed = plannerPlanSchema(material).safeParse(input);
  return parsed.success
    ? { plan: parsed.data }
    : { refusal: refusalOf(parsed.error) };
}

function refusalOf(error: unknown): string {
  const issues =
    (error as { issues?: { message: string; path: (string | number)[] }[] })
      .issues ?? [];
  return issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join(" | ");
}

function accepted(plan: Plan | undefined, label: string): Plan {
  expect(plan, label).toBeDefined();
  return plan as Plan;
}

/** L'attendu de l'assertion unique du plan, dont les kinds sans valeur n'en portent pas. */
function expectedOf(plan: Plan): unknown {
  const [assertion] = plan.scenarios[0]?.assertions ?? [];
  return assertion && "expected" in assertion ? assertion.expected : undefined;
}

/** La forme persistée de l'assertion unique du plan. */
function assertionOf(plan: Plan) {
  const [assertion] = plan.scenarios[0]?.assertions ?? [];
  return assertion;
}

describe("résolution d'un expected désigné par sa ligne", () => {
  it("écrit le littéral de la ligne dans expected, identique octet pour octet", () => {
    const material = materialFor(CASH, CASH_TS_LINES);
    const plan = accepted(
      resolve(referenceSubmission(CASH, "value", 144), material).plan,
      "statut désigné"
    );
    // Le littéral est écrit tel quel, sans ses guillemets : la ligne écrit
    // `status: "ecart-justifie"`, donc l'attendu persisté est `ecart-justifie`.
    expect(cashLine(144)).toContain('"ecart-justifie"');
    expect(expectedOf(plan)).toBe("ecart-justifie");
    // La référence ne survit pas dans le plan : `expected` reste du texte, donc
    // tout l'aval (exécution, rapport, UI) est inchangé.
    expect(Object.hasOwn(assertionOf(plan) ?? {}, "line")).toBe(false);
  });

  it("tombe si la résolution est annulée : le plan résolu se revalide par la forme persistée", () => {
    const material = materialFor(CASH, CASH_TS_LINES);
    const plan = accepted(
      resolve(referenceSubmission(CASH, "value", 146), material).plan,
      "statut désigné"
    );
    expect(expectedOf(plan)).toBe("ecart-a-justifier");
    // Sans la résolution, `expected` resterait l'objet `{sourceFile, line}` :
    // la forme persistée le refuserait, et l'assertion ci-dessus tomberait.
    expect(() => PlanSchema.parse(plan)).not.toThrow();
    // Le chemin de LECTURE accepte l'attendu résolu comme n'importe quelle
    // chaîne : `missingExpectationRefusals` ne voit aucun attendu vide.
    expect(missingExpectationRefusals(plan)).toEqual([]);
  });

  it("refuse un littéral que le navigateur évalue : antislash ou interpolation", () => {
    const material = materialFor(PAGE, PAGE_TS_LINES);
    // La ligne 354 porte quatre littéraux : elle ne désigne aucune valeur, avant
    // même d'en venir à ce que le littéral du message porte.
    expect(resolveExpectedLiteral(PAGE, 354, material)).toHaveProperty(
      "refusal"
    );
    // Un gabarit interpolé persisterait `${...}` non évalué : une valeur que la
    // page n'affiche jamais, donc un rouge fabriqué par la lecture. Refusé.
    const template =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: la ligne citée porte un littéral, pas un gabarit à interpoler.
      "  const message = `Écart de ${formatAmountFr(centsToEuros(closure.varianceCents))} : une justification écrite est obligatoire avant clôture.`;";
    expect(
      resolveExpectedLiteral(
        PAGE,
        12,
        materialFor(PAGE, [{ line: 12, text: template }])
      )
    ).toEqual({
      refusal: `The string literal on line 12 of ${PAGE} is a template carrying a \`\${...}\` interpolation, which the view evaluates at render, and this reading writes the interpolation unevaluated: designating it would persist a value the page never displays. Write the value the page displays in expected instead.`,
    });
    // Un échappement persisterait l'antislash que la ligne écrit : le navigateur
    // rend `"`, donc l'attendu ne matcherait aucune page correcte. Refusé aussi.
    expect(
      resolveExpectedLiteral(
        PAGE,
        13,
        materialFor(PAGE, [
          { line: 13, text: "  onChange({ reason: 'il a dit \\\"non\\\"' });" },
        ])
      )
    ).toEqual({
      refusal: `The string literal on line 13 of ${PAGE} carries a backslash: an escape or a line continuation, so the characters this line spells are not the text the browser renders (\\n is a newline there, not two characters). Designating it would persist a value the page never displays, so write the value the page displays in expected instead.`,
    });
  });

  it("refuse une ligne dont un guillemet de regex a été apparié au littéral", () => {
    // Le cas du relecteur : `if (/"/.test(value)) setMessage("Ready")` apparie le
    // guillemet de la regex avec celui qui ouvre `"Ready"`, et la lecture rend
    // `/.test(value)) setMessage(` — une valeur qu'aucune page n'affiche. Le
    // guillemet resté orphelin après le littéral retenu fait refuser la ligne.
    const regex = resolveExpectedLiteral(
      CASH,
      213,
      materialFor(CASH, [
        { line: 213, text: '  if (/"/.test(value)) setMessage("Ready");' },
      ])
    );
    expect(regex).toEqual({
      refusal: `The line around the only string literal on line 213 of ${CASH} carries an unpaired quote character — a quote inside a regular expression or a comment does not open a string — so the fragment this reading would take is not a string the view displays. Write the value the page displays in expected instead; a \`quote\` requirement for this file's changed behavior is unaffected.`,
    });
    // Même traversée par une classe de caractères.
    expect(
      resolveExpectedLiteral(
        CASH,
        214,
        materialFor(CASH, [
          { line: 214, text: '  if (/["]/.test(value)) setMessage("Ready");' },
        ])
      )
    ).toHaveProperty("refusal");
  });

  it("n'ajoute aucun refus aux lignes que le garde ne concerne pas", () => {
    // Le garde ne coûte aucune ligne réelle : ces huit formes portent un seul
    // littéral, un reste sans guillemet orphelin, et restent résolues.
    const cases = [
      '  setMessage("Ready");',
      '  return "Session clôturée";',
      "  if (value === 'cloture') return true;",
      "  const s = `Comptage juste`;",
      '  const r = a / b; setMessage("Total");',
      '  // l\'écart justifié : setMessage("Ready");',
      '  const ratio = total / count; // setMessage("Ready");',
      '  onChange({ reason: "ecart-justifie" });',
    ];
    for (const [index, text] of cases.entries()) {
      const resolved = resolveExpectedLiteral(
        CASH,
        300 + index,
        materialFor(CASH, [{ line: 300 + index, text }])
      );
      expect(resolved, text).toHaveProperty("literal");
    }
  });

  it("garde `${` dans un littéral simple, où il n'est pas une interpolation", () => {
    // Une chaîne entre apostrophes rend `${...}` tel quel : rien n'y est évalué,
    // donc la lecture y est fidèle et la forme reste acceptée. Seul le gabarit
    // (backticks) interpole.
    const line =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: la ligne citée porte un `${` que rien n'évalue.
      "  label = 'Total ${counted}'";
    expect(
      resolveExpectedLiteral(
        CASH,
        212,
        materialFor(CASH, [{ line: 212, text: line }])
      )
      // biome-ignore lint/suspicious/noTemplateCurlyInString: la valeur attendue garde le `${` du littéral simple.
    ).toEqual({ literal: "Total ${counted}" });
  });

  it("lit un littéral délimité par des guillemets simples", () => {
    const material = materialFor(CASH, [
      { line: 200, text: "  if (value === 'cloture') return true;" },
    ]);
    expect(resolveExpectedLiteral(CASH, 200, material)).toEqual({
      literal: "cloture",
    });
  });

  it("n'invente pas de littéral sur les apostrophes d'une prose", () => {
    const prose = materialFor(CASH, [
      { line: 201, text: "  // l'écart d'espèces reste exigible" },
    ]);
    // Sans la règle des apostrophes, cette ligne rendrait `écart d` comme valeur.
    expect(resolveExpectedLiteral(CASH, 201, prose)).toHaveProperty("refusal");
  });
});

/**
 * Les refus d'une référence de littéral, nommés et actionnables : la ligne
 * demandée, puis ce que la ligne porte réellement. Aucun refus n'écrit de
 * valeur devinée, et aucun ne déverse la ligne entière dans le diagnostic.
 */
describe("refus d'une référence de littéral : la ligne demandée, puis ce qu'elle porte", () => {
  it("nomme les lignes disponibles autour d'une ligne absente du matériel", () => {
    const resolved = resolve(
      referenceSubmission(PAGE, "text", 999),
      materialFor(PAGE, PAGE_TS_LINES)
    );
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      `scenarios.0.assertions.0.expected: Line 999 of ${PAGE} is not in the numbered material`
    );
    expect(resolved.refusal).toContain("354, 368, 375 before it");
    expect(resolved.refusal).toContain("write the value itself in expected");
  });

  it("nomme les lignes qui portent un seul littéral quand la ligne n'en porte aucun", () => {
    const material = materialFor(CASH, CASH_TS_LINES);
    const resolved = resolve(referenceSubmission(CASH, "text", 77), material);
    expect(resolved.plan).toBeUndefined();
    // La ligne 77 est `if (!/^\d{1,9}$/.test(text)) return null;` : aucune
    // chaîne entre guillemets, donc aucune valeur attendue à en tirer.
    expect(resolved.refusal).toContain(
      `Line 77 of ${CASH} carries no string literal at all`
    );
    // Les lignes qui portent, elles, exactement un littéral : 144 et 146.
    expect(resolved.refusal).toContain(
      "Lines that carry exactly one string literal: 144, 146"
    );
  });

  it("nomme les littéraux quand la ligne en porte plusieurs", () => {
    const material = materialFor(CASH, CASH_TS_LINES);
    const resolved = resolve(referenceSubmission(CASH, "text", 116), material);
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      `Line 116 of ${CASH} carries 3 string literals`
    );
    // Les littéraux réels de la ligne, nommés entre leurs propres guillemets.
    expect(resolved.refusal).toContain(
      '"compte-juste", "ecart-justifie", "ecart-a-justifier"'
    );
  });

  it("borne le nombre de littéraux nommés et la longueur de chacun", () => {
    const resolved = resolve(
      referenceSubmission(PAGE, "text", 350),
      materialFor(PAGE, PAGE_TS_LINES)
    );
    expect(resolved.plan).toBeUndefined();
    // Sept littéraux sur la ligne 350 : quatre sont nommés, les trois autres
    // comptés — un refus ne déverse jamais la ligne dans le diagnostic.
    expect(resolved.refusal).toContain(
      `Line 350 of ${PAGE} carries 7 string literals`
    );
    expect(resolved.refusal).toContain("(+3 more)");
  });

  it("refuse un littéral au-delà du plafond de citation, sans le rogner", () => {
    const line = `  setMessage("${"x".repeat(1200)}");`;
    const resolved = resolve(
      referenceSubmission("src/notice.ts", "text", 1, "src/notice.ts"),
      materialFor("src/notice.ts", [{ line: 1, text: line }])
    );
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      "The string literal on line 1 of src/notice.ts holds 1200 characters, beyond the 1000-character citation cap"
    );
    expect(resolved.refusal).toContain("write the value itself in expected");
  });

  it("refuse une ligne que le matériel liste deux fois", () => {
    const lines = [...CASH_TS_LINES, { line: 144, text: cashLine(144) }];
    const resolved = resolve(
      referenceSubmission(CASH, "value", 144),
      materialFor(CASH, lines)
    );
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      `Line 144 of ${CASH} is ambiguous: sourceLines lists it 2 times`
    );
  });

  it("refuse un fichier que le matériel ne liste pas, en nommant ceux qu'il liste", () => {
    const resolved = resolve(
      referenceSubmission("src/absent.ts", "text", 12),
      materialFor(PAGE, PAGE_TS_LINES)
    );
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      "No numbered line for src/absent.ts: sourceLines lists no such file"
    );
    expect(resolved.refusal).toContain(`(it lists ${PAGE})`);
  });

  it("refuse un fichier listé sans aucune ligne, plutôt que de deviner", () => {
    const resolved = resolve(referenceSubmission(PAGE, "text", 1), [
      { lines: [], path: PAGE },
    ]);
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      `No numbered line for ${PAGE}: sourceLines lists that file but no line of it`
    );
  });

  it("refuse un littéral vide pour un text, qui matcherait toute page", () => {
    const resolved = resolve(
      referenceSubmission(CASH, "text", 210),
      materialFor(CASH, [{ line: 210, text: '  setMessage("");' }])
    );
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      `The string literal on line 210 of ${CASH} is empty or blank`
    );
  });

  it("refuse au plan entier un littéral échappé : aucun faux rouge ne peut être persisté", () => {
    // Le cas du relecteur : `setMessage("line 1\nline 2")`. La graphie source
    // porte deux caractères après l'antislash, le navigateur rend un saut de
    // ligne ; persister la graphie accepterait le plan puis ferait échouer
    // l'assertion sur une UI correcte. Le plan est donc refusé, pas persisté.
    const resolved = resolve(
      referenceSubmission(CASH, "text", 210),
      materialFor(CASH, [
        { line: 210, text: '  setMessage("line 1\\nline 2");' },
      ])
    );
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      `The string literal on line 210 of ${CASH} carries a backslash`
    );
    expect(resolved.refusal).toContain(
      "write the value the page displays in expected instead"
    );
  });

  it("refuse une ligne coupée par une continuation : elle ne porte aucun littéral clos", () => {
    // La continuation (`"écart \` + retour à la ligne + `justifié"`) coupe le
    // littéral sur deux lignes du fichier : la ligne du matériel n'en porte
    // donc aucun, et le refus existant la refuse avant la lecture de contenu.
    const resolved = resolve(
      referenceSubmission(CASH, "text", 211),
      materialFor(CASH, [
        { line: 211, text: '  const reason = "écart justifié \\' },
      ])
    );
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain(
      `Line 211 of ${CASH} carries no string literal at all`
    );
  });
});

/**
 * La forme chaîne libre est STRICTEMENT inchangée : elle traverse le schéma sans
 * être comparée à un matériel dont elle n'a pas besoin, et n'ouvre aucun refus
 * nouveau. Les kinds sans valeur attendue restent inchangés eux aussi.
 */
describe("compatibilité : la forme chaîne libre est inchangée", () => {
  it("accepte la valeur écrite telle quelle, sans matériel et sans la lire", () => {
    const plan = accepted(
      resolve(withExpected(CASH, "text", "Comptage juste"), []).plan,
      "attendu libre"
    );
    expect(expectedOf(plan)).toBe("Comptage juste");
  });

  it("n'ouvre aucun refus pour une valeur composée au rendu", () => {
    const composed =
      "Écart de 500,00 € : une justification écrite est obligatoire avant clôture.";
    const resolved = resolve(withExpected(PAGE, "text", composed), []);
    expect(resolved.refusal).toBeUndefined();
    expect(expectedOf(accepted(resolved.plan, "attendu composé"))).toBe(
      composed
    );
  });

  it("garde l'attendu vide de kind value, qui compare à un champ vide", () => {
    const resolved = resolve(withExpected(CASH, "value", ""), []);
    expect(resolved.refusal).toBeUndefined();
    expect(expectedOf(accepted(resolved.plan, "attendu vide"))).toBe("");
  });

  it("garde la règle du text vide et son message d'origine", () => {
    const resolved = resolve(withExpected(CASH, "text", "   "), []);
    expect(resolved.plan).toBeUndefined();
    expect(resolved.refusal).toContain("scenarios.0.assertions.0.expected:");
    expect(resolved.refusal).toContain(
      "expected is required and cannot be blank"
    );
  });

  it("garde la forme libre de kind value, espaces compris", () => {
    const resolved = resolve(withExpected(CASH, "value", " écart "), []);
    expect(expectedOf(accepted(resolved.plan, "attendu espacé"))).toBe(
      " écart "
    );
  });

  it("laisse les kinds sans valeur attendue inchangés", () => {
    const visible = resolve(withExpected(CASH, "visible", undefined), []);
    expect(visible.refusal).toBeUndefined();
    expect(visible.plan?.scenarios[0]?.assertions[0]?.kind).toBe("visible");
    // Une référence n'est acceptée que par text et value : `count` porte un
    // nombre et les autres nomment une URL, un fichier ou une baseline.
    const count = resolve(
      withExpected(CASH, "count", { line: 144, sourceFile: CASH }),
      materialFor(CASH, CASH_TS_LINES)
    );
    expect(count.plan).toBeUndefined();
  });
});

/**
 * REJEU des deux seuls rouges réels d'attendu du corpus (262 runs portant un
 * plan) : runs `3d9ce851` et `5c5cfdb6`, qui attendaient « Écart de 500,00 € »
 * là où la page affichait 260,00 € — la valeur est COMPOSÉE au rendu. Cette
 * forme ne les résout pas, et c'est le fait à documenter : une lecture de
 * littéral ne produit jamais un nombre calculé.
 */
describe("rejeu des rouges composés : hors d'atteinte de cette forme", () => {
  const COMPOSED =
    "Écart de 500,00 € : une justification écrite est obligatoire avant clôture.";
  const RENDERED =
    "Écart de 260,00 € : une justification écrite est obligatoire avant clôture.";
  /** Les deux runs mesurés : même message attendu, même ligne qui le rend. */
  const redRuns = ["3d9ce851", "5c5cfdb6"];

  it("ne peut pas désigner la ligne qui rend le message : elle porte quatre littéraux", () => {
    const material = materialFor(PAGE, PAGE_TS_LINES);
    for (const runId of redRuns) {
      const resolved = resolve(
        referenceSubmission(PAGE, "text", 354),
        material
      );
      expect(resolved.plan, runId).toBeUndefined();
      expect(resolved.refusal, runId).toContain(
        `Line 354 of ${PAGE} carries 4 string literals`
      );
    }
  });

  it("ne produit jamais la valeur composée : le littéral garde son interpolation", () => {
    const literals = pageLine(354).match(/`[^`]*`|"[^"]*"/g) ?? [];
    expect(literals.length).toBe(4);
    for (const literal of literals) {
      // Ni l'attendu du plan ni le texte réellement affiché ne sortent d'une
      // lecture : le nombre est calculé par `formatAmountFr` au rendu.
      expect(literal, "aucun littéral n'est la valeur attendue").not.toContain(
        "500,00"
      );
      expect(literal, "aucun littéral n'est la valeur affichée").not.toContain(
        "260,00"
      );
    }
    // Le littéral du message composé rend son interpolation telle quelle.
    expect(literals).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: le littéral lu garde son interpolation, non évaluée.
      "`Écart de ${formatAmountFr(centsToEuros(closure.varianceCents))} : une justification écrite est obligatoire avant clôture.`"
    );
  });

  it("laisse le rouge intact : la forme libre ne le répare pas", () => {
    const plan = accepted(
      resolve(withExpected(PAGE, "text", COMPOSED), []).plan,
      "attendu composé écrit à la main"
    );
    const assertion = assertionOf(plan);
    // Le plan est accepté comme avant, et l'assertion reste fausse : le run
    // échoue toujours, parce que la valeur attendue est calculée au rendu.
    expect(expectedOf(plan)).toBe(COMPOSED);
    expect(assertion && assertionMatches(assertion, RENDERED)).toBe(false);
  });
});

/**
 * Le prompt est le seul endroit où le planificateur peut découvrir la forme :
 * sans la consigne, il retape la valeur attendue, donc il peut l'inventer — les
 * deux rouges qui ont motivé cette forme écrivaient l'écart supposé au lieu de
 * celui que leur scénario produisait. Chaque point ci-dessous tombe si sa
 * consigne disparaît du prompt.
 */
describe("le prompt enseigne la forme référence, sans l'imposer", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");

  it("enseigne la forme référence pour un attendu qui est un littéral du code", () => {
    // Le champ et sa forme, pour que le modèle ne cherche pas une troisième
    // écriture : ce qu'il écrit dans expected, tel quel.
    expect(prompt).toMatch(
      /For a text or value expected that is a literal the code writes, designate its line — `"expected":\{"sourceFile":"changed\/path","line":368\}` — instead of retyping the text/
    );
    // La lecture est celle de la référence de ligne d'une exigence : le gate
    // écrit le littéral, et aucun caractère ne passe par le modèle.
    expect(prompt).toMatch(
      /the gate writes the single string literal that line of `sourceLines` carries, quotes excluded, exactly as a requirement's `line` does/
    );
  });

  it("énonce la frontière, avec l'exemple littéral et l'exemple composé", () => {
    expect(prompt).toMatch(
      /The boundary is whether one literal holds the value/
    );
    // Littéral d'un côté : la ligne mesurée qui écrit le statut.
    expect(prompt).toMatch(
      /line 144 of `packages\/domain\/src\/cash\.ts` writes `status: "ecart-justifie"`, so designating that line IS the expected `ecart-justifie`/
    );
    // Composé de l'autre : le montant calculé et le total compté, qu'aucun
    // littéral ne porte.
    expect(prompt).toMatch(/a computed amount, a counted total/);
    // Désigner n'est pas un passe-droit : la ligne doit porter le seul littéral,
    // et ce littéral ne doit pas être ce que le navigateur évalue — un
    // échappement ou une interpolation produiraient une valeur que la page
    // n'affiche jamais, donc un rouge fabriqué par la lecture.
    expect(prompt).toMatch(
      /A designated line must carry exactly one string literal, inside the 1000-character cap/
    );
    expect(prompt).toMatch(
      /so are the literals the browser evaluates instead of displaying — one carrying a backslash/
    );
    expect(prompt).toMatch(/a template carrying `\$\{\.\.\.\}`/);
  });

  it("laisse la forme chaîne libre pour une valeur composée au rendu", () => {
    expect(prompt).toMatch(
      /are composed at render — a computed amount, a counted total — so no literal holds them and you write them out/
    );
    // Jamais obligatoire : aucun plan légitime n'est refusé faute de référence.
    expect(prompt).toMatch(
      /This form is never mandatory: a composed value has no literal to designate, so the string form stays accepted for every kind, and no assertion is refused for writing it/
    );
  });

  it("montre les deux formes dans le squelette JSON", () => {
    // La forme chaîne libre reste dans le squelette, à côté de la référence.
    expect(prompt).toContain('"expected":"concrete expected value"');
    expect(prompt).toContain(
      '"expected":{"sourceFile":"changed/path","line":368}'
    );
  });
});
