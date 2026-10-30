import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  CONTEXT_BUDGET_EXHAUSTED_WARNING,
  DEPENDENCY_CONTEXT_LIMIT_WARNING,
  type PrContext,
  parsePrUrl,
  truncatedContextWarning,
  unavailableContextWarning,
} from "../src/github.js";
import {
  amputationScans,
  PolicySchema,
  quoteExcerpt,
  quoteResolutionCandidates,
  requirementHasWitness,
  ungroundedRequirements,
  validateCoverage,
  weakWitnessLines,
} from "../src/policy.js";
import { quotePickCorrection } from "../src/runner.js";
import { type Plan, PlanSchema } from "../src/schema.js";
import { lineAt } from "./fixture.js";
import { CASH_TS_LINES, PAGE_TS_LINES } from "./lot-v-replay.js";

/**
 * Journal capturé, comme dans `quote-pick-logging.test.ts` : `runner.ts` crée son
 * logger à l'import, donc seul un `createLogger` factice rend la trace de
 * production observable.
 */
const logged = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@usecanary/logger", () => {
  function createLogger(): Record<string, unknown> {
    const record =
      (level: string) =>
      (bindings: Record<string, unknown>, message: string): void => {
        logged.push({ ...bindings, level, message });
      };
    return {
      child: createLogger,
      debug: record("debug"),
      error: record("error"),
      fatal: record("fatal"),
      info: record("info"),
      trace: record("trace"),
      warn: record("warn"),
    };
  }
  return { createLogger };
});

const PAGE = "apps/web/app/page.tsx";
const CASH = "packages/domain/src/cash.ts";
const SHA = "814b671305b005ab516db66bc3da1d8239bcef16";
const RUN_07429B97 = "07429b97-a5e5-4c29-9a1e-3ff4e8d9e7f1";
const config = loadConfig({});
const policy = PolicySchema.parse({ approvedSkips: [], version: 1 });

/**
 * Les lignes réelles du corpus de la famille (`lot-v-replay.ts`) : le matériel
 * hors ligne qui juge une citation, la production n'étant pas lisible depuis un
 * worktree.
 */
function knownLines(): { file: string; line: number; text: string }[] {
  return [
    ...PAGE_TS_LINES.map((item) => ({
      file: PAGE,
      line: item.line,
      text: item.text,
    })),
    ...CASH_TS_LINES.map((item) => ({
      file: CASH,
      line: item.line,
      text: item.text,
    })),
  ];
}

/** Le contexte d'un fichier du corpus : ses lignes réelles, comme contenu après changement. */
function contextFor(...files: string[]): PrContext {
  return {
    baseSha: "2".repeat(40),
    body: "",
    context: [],
    contextWarnings: [],
    files: files.map((file) => ({
      filename: file,
      patch: knownLines()
        .filter((item) => item.file === file)
        .map((item) => lineAt(file, item.line, item.text).patch)
        .join("\n"),
      status: "modified",
    })),
    headRepo: "pharmania/arpilabe-pilotage",
    ref: parsePrUrl("https://github.com/pharmania/arpilabe-pilotage/pull/17"),
    sha: SHA,
    title: "",
  };
}

/** Le texte d'une ligne réelle mesurée d'un fichier du corpus. */
function measuredLine(file: string, line: number): string {
  const found = knownLines().find(
    (item) => item.file === file && item.line === line
  );
  if (!found) {
    throw new Error(`No measured line ${line} of ${file}`);
  }
  return found.text;
}

function pageLine(line: number): string {
  return measuredLine(PAGE, line);
}

/** Citation mesurée du run 07429b97 : `:""` inséré dans la première interpolation. */
const UNIT_QUOTE_07429B97 = `\${counted.totalUnits} unité\${counted.totalUnits>1?"s":"":""} comptée\${counted.totalUnits>1?"s":""}`;

/**
 * Le véhicule de ces plans est une présence : depuis le témoin d'objectif
 * (OBJECTIVE_UNWITNESSED), elle doit lire un mot que le diff écrit, sinon le
 * plan porterait un second défaut, hors citation, et la correction par indice
 * ne serait jamais posée. Elle lit donc le texte du témoin exact du scénario
 * (sa première exigence), qu'elle cite.
 */
function parseVehicle(input: unknown): Plan {
  const plan = PlanSchema.parse(input);
  return {
    ...plan,
    scenarios: plan.scenarios.map((scenario) => ({
      ...scenario,
      assertions: scenario.assertions.map((assertion) => ({
        ...assertion,
        requirement: 0,
        target: {
          by: "text" as const,
          value: scenario.requirements[0]?.quote.trim() ?? "",
        },
      })),
    })),
  };
}

/**
 * Le plan minimal qui porte une citation fautive et rien d'autre : un scénario
 * qui couvre le fichier changé, un témoin exact, et la copie refusée au rang 2.
 * Aucune autre classe fatale ne s'ouvre, donc la correction par indice reste
 * offerte.
 */
function planWith(faulty: string): Plan {
  return parseVehicle({
    scenarios: [
      {
        assertions: [
          {
            afterStep: "load",
            description: "L'état de la caisse est visible",
            id: "seen",
            kind: "visible",
            target: { by: "role", name: "", value: "status" },
            verification: "state",
          },
        ],
        id: "cash-balanced-closure",
        kind: "happy_path",
        preconditions: [],
        rationale: "La vue affiche son état",
        requirements: [
          {
            behavior: "La vue expose son état de caisse",
            quote: pageLine(350),
            sourceFile: PAGE,
          },
          {
            behavior: "Le badge unité accorde le pluriel",
            quote: faulty,
            sourceFile: PAGE,
          },
        ],
        sourceFiles: [PAGE],
        steps: [
          {
            action: { type: "goto", path: "/" },
            description: "Ouvrir la caisse",
            id: "load",
          },
          {
            action: { type: "assert", assertionId: "seen" },
            description: "Vérifier l'état affiché",
            id: "check",
          },
        ],
        title: "Clôture équilibrée",
      },
    ],
    skipped: [],
    summary: "Comptage et clôture de la caisse",
  });
}

/** La citation que le plan persiste au rang 2, celle que le planificateur a écrite. */
function plannerQuote(plan: Plan): string | undefined {
  return plan.scenarios[0]?.requirements[1]?.quote;
}

/** Un cliché du plan, pour juger toute écriture en place après coup. */
function snapshot(plan: Plan): Plan {
  return structuredClone(plan);
}

/**
 * La PR #64 a retiré `resolveQuotesWithoutAsking` et `uniqueQuoteCandidate` : la
 * résolution automatique d'une citation refusée écrivait dans le plan une ligne
 * choisie par recouvrement de jetons, donc une preuve que le planificateur
 * n'avait pas citée. Ces tests encodent ce qui reste vrai après le retrait — le
 * gate n'écrit plus aucune citation — là où les tests supprimés décrivaient
 * l'écriture qu'il faisait.
 *
 * Une copie refusée qui partage ses jetons avec une ligne réelle est le cas
 * mesuré : c'est ce recouvrement, et lui seul, qui désignait une ligne à écrire
 * (run 07429b97, `:"":""` inséré dans la ligne 368). La ligne réelle reste
 * offerte à l'indice ; le plan, lui, ne bouge pas.
 */
describe("copie refusée qui partage ses jetons avec une ligne réelle", () => {
  it("reste celle du planificateur : le gate n'écrit aucun remplacement", () => {
    const context = contextFor(PAGE);
    const plan = planWith(UNIT_QUOTE_07429B97);
    const before = snapshot(plan);
    // Le recouvrement de jetons nomme la ligne 368 : c'est exactement la piste
    // que l'écriture automatique prenait, et elle existe encore.
    const candidates = quoteResolutionCandidates(
      { quote: UNIT_QUOTE_07429B97, sourceFile: PAGE },
      context,
      amputationScans()
    );
    expect(candidates.map((candidate) => candidate.line)).toEqual([368]);
    expect(pageLine(368)).toContain(candidates[0]?.text ?? "");
    // Le refus tombe, et rien n'est écrit à la place de la copie.
    expect(ungroundedRequirements(plan, context)).toHaveLength(1);
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "No source witness"
    );
    expect(
      quotePickCorrection(plan, policy, context, config, RUN_07429B97)?.message
    ).toContain("picks");
    expect(plannerQuote(plan)).toBe(UNIT_QUOTE_07429B97);
    expect(plan).toEqual(before);
  });
});

/**
 * Une copie refusée qui EST une portion verbatim d'une ligne réelle est acceptée
 * en amont, par `requirementHasWitness` : le gate n'a donc aucune écriture à
 * faire dans ce cas, et la résolution automatique n'avait pas de raison d'être
 * pour lui. Le test fige cette frontière — c'est elle qui rend l'ancien
 * mécanisme inutile quand il exigeait une relation exacte, et fabulateur quand
 * il ne l'exigeait pas.
 */
describe("copie refusée qui est une portion exacte d'une ligne réelle", () => {
  it("est acceptée en amont, sans laisser aucune écriture à faire", () => {
    const context = contextFor(PAGE);
    // Les 56 premiers caractères de la copie du run 07429b97 sont recopiés de la
    // ligne 368, octet pour octet : la portion est un témoin valide.
    const exact = pageLine(368).slice(0, 56);
    expect(exact).toHaveLength(56);
    expect(pageLine(368)).toContain(exact);
    const plan = planWith(exact);
    const before = snapshot(plan);
    expect(
      requirementHasWitness({ quote: exact, sourceFile: PAGE }, context)
    ).toBe(true);
    expect(ungroundedRequirements(plan, context)).toEqual([]);
    expect(validateCoverage(plan, context, policy, config).gate).toBe(
      "complete"
    );
    // Plus rien à refuser, donc rien à corriger : aucune écriture ne reste au
    // gate, et le plan persiste la portion telle que le planificateur l'a citée.
    expect(
      quotePickCorrection(plan, policy, context, config, RUN_07429B97)
    ).toBeUndefined();
    expect(plannerQuote(plan)).toBe(exact);
    expect(plan).toEqual(before);
  });
});

/**
 * Le refus rendu est celui d'aujourd'hui, mot pour mot : l'exigence nommée avec
 * son rang, la citation refusée en extrait. La seule écriture possible passe par
 * la réponse du planificateur à la question à indices — le plan persisté garde
 * son texte jusque-là.
 */
describe("refus rendu et plan persisté", () => {
  it("rend le refus d'aujourd'hui, offre l'indice, et n'écrit que sur le choix du planificateur", () => {
    const context = contextFor(PAGE);
    const plan = planWith(UNIT_QUOTE_07429B97);
    const before = snapshot(plan);
    let refusal = "";
    try {
      validateCoverage(plan, context, policy, config);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain(
      "No source witness for cash-balanced-closure: apps/web/app/page.tsx (requirement 2)"
    );
    expect(refusal).toContain(
      `Rejected quote: ${JSON.stringify(quoteExcerpt(UNIT_QUOTE_07429B97))}`
    );
    // Le refus ne touche pas au plan : la copie refusée reste lisible telle que
    // le planificateur l'a écrite, pour qu'il la reconnaisse.
    expect(plan).toEqual(before);
    const correction = quotePickCorrection(
      plan,
      policy,
      context,
      config,
      RUN_07429B97
    );
    expect(correction?.message).toContain("picks");
    // L'indice nomme la portion réelle ; il ne l'écrit pas.
    const [offered] = quoteResolutionCandidates(
      { quote: UNIT_QUOTE_07429B97, sourceFile: PAGE },
      context,
      amputationScans()
    );
    expect(offered?.line).toBe(368);
    expect(pageLine(368)).toContain(offered?.text ?? "");
    expect(correction?.message).toContain(
      `1: ${JSON.stringify(offered?.text)}`
    );
    expect(plan).toEqual(before);
    expect(plannerQuote(plan)).toBe(UNIT_QUOTE_07429B97);
    const resolved = correction?.resolve({
      picks: [
        { candidate: 1, requirement: 2, scenario: "cash-balanced-closure" },
      ],
    });
    const chosen = resolved?.scenarios[0]?.requirements[1]?.quote ?? "";
    // La seule écriture est celle du choix : une portion exacte de la ligne 368,
    // et l'altération `:""` du planificateur a disparu parce qu'il l'a quittée.
    expect(pageLine(368)).toContain(chosen);
    expect(chosen).not.toBe(UNIT_QUOTE_07429B97);
    expect(ungroundedRequirements(resolved as Plan, context)).toEqual([]);
    expect(
      validateCoverage(resolved as Plan, context, policy, config).gate
    ).toBe("complete");
    // Le plan d'origine n'est jamais modifié en place : la correction travaille
    // sur une copie, donc un refus non résolu laisse la citation intacte.
    expect(plan).toEqual(before);
  });
});

/**
 * L'événement `Requirement quote resolved by the gate` accompagnait l'écriture
 * automatique ; il a disparu avec elle. La trace de résolution qui subsiste est
 * celle de l'indice, `Requirement quote resolved by pick`, et elle nomme la
 * ligne que le planificateur a choisie.
 */
describe("trace de la résolution", () => {
  it("n'émet aucun événement « resolved by the gate »", () => {
    const context = contextFor(PAGE);
    const plan = planWith(UNIT_QUOTE_07429B97);
    logged.length = 0;
    expect(() => validateCoverage(plan, context, policy, config)).toThrow();
    const correction = quotePickCorrection(
      plan,
      policy,
      context,
      config,
      RUN_07429B97
    );
    correction?.resolve({
      picks: [
        { candidate: 1, requirement: 2, scenario: "cash-balanced-closure" },
      ],
    });
    const messages = logged.map((entry) => String(entry.message));
    expect(
      messages.filter((message) =>
        message.toLowerCase().includes("resolved by the gate")
      )
    ).toEqual([]);
    const picks = logged.filter(
      (entry) => entry.message === "Requirement quote resolved by pick"
    );
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({
      line: 368,
      requirement: 2,
      runId: RUN_07429B97,
      scenario: "cash-balanced-closure",
      sourceFile: PAGE,
    });
  });
});

/**
 * Un plan qui porte un autre défaut que la citation garde son refus et sa
 * citation : écrire une citation dans un plan refusé pour une autre raison ne
 * nommerait plus ce que le planificateur avait écrit, et le refus qu'il lit ne
 * serait plus celui de sa faute. `cash.ts` est changé mais aucun scénario ne le
 * couvre — c'est la classe fatale qui écarte la correction, et le plan reste
 * intact.
 */
describe("plan qui porte un autre défaut que la citation", () => {
  it("garde la citation du planificateur et n'offre aucun indice", () => {
    const context = contextFor(PAGE, CASH);
    const plan = planWith(UNIT_QUOTE_07429B97);
    const before = snapshot(plan);
    expect(
      quotePickCorrection(plan, policy, context, config, RUN_07429B97)
    ).toBeUndefined();
    expect(plannerQuote(plan)).toBe(UNIT_QUOTE_07429B97);
    expect(plan).toEqual(before);
  });
});

/**
 * Les vues partielles du fichier cité que la revue de #62 a mesurées : un
 * fichier plus long que `CITED_LINES_EXAMINED` cache la vraie ligne derrière un
 * sosie, et un contenu coupé au plafond de caractères par fichier cache une
 * portion réelle sans que son nombre de lignes restantes le trahisse. L'ancien
 * mécanisme écrivait le sosie ; l'indice, lui, continue de le nommer — c'est au
 * planificateur de voir que la preuve manque.
 */
describe("vue partielle du fichier cité", () => {
  /** Le contexte d'un fichier donné ligne à ligne, source complète aux deux révisions. */
  function contextFromLines(
    file: string,
    lines: { line: number; text: string }[]
  ): PrContext {
    const byLine = new Map(lines.map((item) => [item.line, item.text]));
    const size = Math.max(...byLine.keys());
    const content = Array.from(
      { length: size },
      (_, index) => byLine.get(index + 1) ?? `  const filler${index + 1}=0;`
    ).join("\n");
    const base = contextFor(file);
    return {
      ...base,
      files: [{ filename: file, patch: "", status: "modified" }],
      context: [
        { content, path: file, ref: SHA },
        { content, path: file, ref: base.baseSha },
      ],
    };
  }
  /** Plafond de caractères par fichier de `collectContext` (github.ts). */
  const FILE_CONTEXT_CHARS = 16_000;
  /**
   * Le contexte que `collectContext` rend pour un fichier plus long que son
   * plafond de caractères : le contenu lu est le préfixe de 16 000 caractères,
   * et l'avertissement nomme le fichier et la révision coupés. Le patch est
   * gardé : c'est le cas de production, un fichier changé dont le diff suffit à
   * la preuve de source alors que sa source de tête est coupée.
   */
  function contextCutAtCharCap(
    file: string,
    lines: { line: number; text: string }[],
    patch: string
  ): PrContext {
    const full = contextFromLines(file, lines);
    return {
      ...full,
      context: [
        {
          content: (full.context[0]?.content ?? "").slice(
            0,
            FILE_CONTEXT_CHARS
          ),
          path: file,
          ref: SHA,
        },
      ],
      contextWarnings: [truncatedContextWarning(file, SHA)],
      files: [{ filename: file, patch, status: "modified" }],
    };
  }
  it("nomme la ligne sosie sans l'écrire quand la vraie ligne dépasse le plafond de lecture", () => {
    const fuzzLine = `  const label = \`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""}\`;`;
    // La ligne 2005 est la seule qui porte la citation mesurée, mais
    // `CITED_LINES_EXAMINED` s'arrête à 2000 : seul le sosie de la ligne 1500 est
    // lu. L'écrire nommerait une ligne qui ne prouve pas le comportement.
    const context = contextFromLines(PAGE, [
      { line: 350, text: pageLine(350) },
      { line: 1500, text: fuzzLine },
      { line: 2005, text: pageLine(368) },
    ]);
    const plan = planWith(UNIT_QUOTE_07429B97);
    const before = snapshot(plan);
    expect(
      quoteResolutionCandidates(
        { quote: UNIT_QUOTE_07429B97, sourceFile: PAGE },
        context,
        amputationScans()
      ).map((candidate) => candidate.line)
    ).toEqual([1500]);
    // Le sosie reste l'indice offert, et le plan reste celui du planificateur.
    const correction = quotePickCorrection(
      plan,
      policy,
      context,
      config,
      "cap"
    );
    expect(correction?.message).toContain(`1: ${JSON.stringify(fuzzLine)}`);
    expect(plannerQuote(plan)).toBe(UNIT_QUOTE_07429B97);
    expect(plan).toEqual(before);
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "No source witness"
    );
  });
  it("nomme le sosie d'une vue coupée au plafond de caractères, sans l'écrire", () => {
    // Un identifiant nu : la famille mesurée où le gate écrivait une ligne
    // réelle sans demander, parce que la vue lue n'en portait qu'une.
    const quote = "counted.totalUnits";
    // Le fichier tient en 1200 lignes, donc `CITED_LINES_EXAMINED` n'est pas
    // atteint : seule la coupure de caractères est en cause. Le second porteur
    // réel est au-delà du préfixe lu, le témoin et le sosie sont dedans.
    const sosie = `  const label = \`\${${quote}}\`;`;
    const context = contextCutAtCharCap(
      PAGE,
      [
        { line: 100, text: sosie },
        { line: 300, text: pageLine(350) },
        { line: 1200, text: pageLine(368) },
      ],
      `@@ -300,1 +300,1 @@\n+${pageLine(350)}`
    );
    const [read] = context.context;
    const content = read?.content ?? "";
    expect(content).toHaveLength(FILE_CONTEXT_CHARS);
    expect(context.contextWarnings).toEqual([
      truncatedContextWarning(PAGE, SHA),
    ]);
    expect(content).toContain(pageLine(350));
    // Le second porteur réel n'est PAS dans la vue lue.
    expect(content).not.toContain(pageLine(368));
    expect(
      quoteResolutionCandidates(
        { quote, sourceFile: PAGE },
        context,
        amputationScans()
      ).map((candidate) => candidate.line)
    ).toEqual([100]);
    const plan = planWith(quote);
    const before = snapshot(plan);
    // Le refus est celui d'aujourd'hui, et la correction par indice reste
    // offerte : le planificateur choisit, le gate n'écrit rien d'office.
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "Weak source witness"
    );
    const correction = quotePickCorrection(
      plan,
      policy,
      context,
      config,
      "charcap"
    );
    expect(correction?.message).toContain("picks");
    expect(correction?.message).toContain(`1: ${JSON.stringify(sosie)}`);
    expect(plannerQuote(plan)).toBe(quote);
    expect(plan).toEqual(before);
  });
  it("ne résout rien pour aucune troncature connue du fichier déclaré", () => {
    const complete = contextFromLines(PAGE, [
      { line: 350, text: pageLine(350) },
      { line: 368, text: pageLine(368) },
    ]);
    const offered = (context: PrContext) =>
      quoteResolutionCandidates(
        { quote: UNIT_QUOTE_07429B97, sourceFile: PAGE },
        context,
        amputationScans()
      ).map((candidate) => candidate.line);
    expect(offered(complete)).toEqual([368]);
    // Une source de tête coupée n'est pas un matériel partiel sur lequel lire
    // un indice : elle ouvre le refus `CONTEXT_INCOMPLETE`, qui écarte la
    // correction. C'est l'abstention que les tests supprimés mesuraient, portée
    // par le refus et non plus par l'écriture.
    const cut = {
      ...complete,
      contextWarnings: [truncatedContextWarning(PAGE, SHA)],
    };
    const cutPlan = planWith(UNIT_QUOTE_07429B97);
    const cutBefore = snapshot(cutPlan);
    expect(
      quotePickCorrection(cutPlan, policy, cut, config, "cut")
    ).toBeUndefined();
    expect(cutPlan).toEqual(cutBefore);
    // Les plafonds qui ne disent rien du fichier cité laissent l'indice
    // inchangé : la ligne réelle est offerte, jamais écrite.
    const otherWarnings = [
      unavailableContextWarning(PAGE, SHA),
      CONTEXT_BUDGET_EXHAUSTED_WARNING,
      DEPENDENCY_CONTEXT_LIMIT_WARNING,
    ];
    for (const warning of otherWarnings) {
      const context = { ...complete, contextWarnings: [warning] };
      const plan = planWith(UNIT_QUOTE_07429B97);
      const before = snapshot(plan);
      expect(offered(context), warning).toEqual([368]);
      expect(
        quotePickCorrection(plan, policy, context, config, "partial")?.message,
        warning
      ).toContain("picks");
      expect(plannerQuote(plan), warning).toBe(UNIT_QUOTE_07429B97);
      expect(plan, warning).toEqual(before);
      expect(
        () => validateCoverage(plan, context, policy, config),
        warning
      ).toThrow("No source witness");
    }
  });
  it("nomme la même portion quand la troncature concerne un autre fichier ou la révision de base", () => {
    // Le matériel du fichier cité est intact : la troncature des autres fichiers
    // et celle de la révision de base, que la lecture du fichier modifié ne
    // touche pas, ne changent rien à l'indice ni au refus.
    const context = {
      ...contextFor(PAGE),
      contextWarnings: [
        truncatedContextWarning(CASH, SHA),
        truncatedContextWarning(PAGE, "2".repeat(40)),
        unavailableContextWarning(CASH, SHA),
      ],
    };
    const plan = planWith(UNIT_QUOTE_07429B97);
    const before = snapshot(plan);
    const correction = quotePickCorrection(
      plan,
      policy,
      context,
      config,
      RUN_07429B97
    );
    const [offered] = quoteResolutionCandidates(
      { quote: UNIT_QUOTE_07429B97, sourceFile: PAGE },
      context,
      amputationScans()
    );
    expect(offered?.line).toBe(368);
    expect(correction?.message).toContain(
      `1: ${JSON.stringify(offered?.text)}`
    );
    expect(plannerQuote(plan)).toBe(UNIT_QUOTE_07429B97);
    expect(plan).toEqual(before);
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "No source witness"
    );
  });
  it("n'écrit pas un identifiant porté par trois lignes dont deux hors de la suggestion", () => {
    const short = "  if (ecart-a-justifier) { blocage(); }";
    const long1 = `  const a = 1; // ${"x".repeat(120)} ecart-a-justifier`;
    const long2 = `  const b = 2; // ${"y".repeat(120)} ecart-a-justifier`;
    const context = contextFromLines(CASH, [
      { line: 77, text: measuredLine(CASH, 77) },
      { line: 100, text: long1 },
      { line: 116, text: short },
      { line: 146, text: long2 },
    ]);
    // Trois lignes réelles portent l'identifiant ; la borne de suggestion les
    // écarte toutes en tant que témoins faibles, et l'indice n'en garde qu'une.
    expect(
      weakWitnessLines(
        { quote: "ecart-a-justifier", sourceFile: CASH },
        context
      )
    ).toEqual([]);
    expect(
      quoteResolutionCandidates(
        { quote: "ecart-a-justifier", sourceFile: CASH },
        context,
        amputationScans()
      ).map((candidate) => candidate.line)
    ).toEqual([116]);
    const plan = parseVehicle({
      ...planWith("ecart-a-justifier"),
      scenarios: [
        {
          ...planWith("ecart-a-justifier").scenarios[0],
          requirements: [
            {
              behavior: "Le statut des clôtures est défini",
              quote: measuredLine(CASH, 77),
              sourceFile: CASH,
            },
            {
              behavior: "L'écart non justifié bloque la clôture",
              quote: "ecart-a-justifier",
              sourceFile: CASH,
            },
          ],
          sourceFiles: [CASH],
        },
      ],
    });
    const before = snapshot(plan);
    expect(plannerQuote(plan)).toBe("ecart-a-justifier");
    expect(plan).toEqual(before);
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "Weak source witness"
    );
  });
  it("offre une seule fois un identifiant porté par deux lignes au texte identique", () => {
    // Deux occurrences du même texte forment UN candidat, pas une ambiguïté : le
    // dédoublonnage se fait sur le texte, comme l'offre le fait déjà. Le gate
    // n'écrit rien — le planificateur choisit le candidat unique.
    const text = "  const unit = counted.totalUnits;";
    const context = contextFromLines(PAGE, [
      { line: 100, text },
      { line: 350, text: pageLine(350) },
      { line: 368, text },
    ]);
    const plan = planWith("counted.totalUnits");
    const before = snapshot(plan);
    const candidates = quoteResolutionCandidates(
      { quote: "counted.totalUnits", sourceFile: PAGE },
      context,
      amputationScans()
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toBe(text);
    const correction = quotePickCorrection(
      plan,
      policy,
      context,
      config,
      "duplicate"
    );
    expect(correction?.message).toContain(`1: ${JSON.stringify(text)}`);
    expect(plannerQuote(plan)).toBe("counted.totalUnits");
    expect(plan).toEqual(before);
  });
});

/**
 * Le retrait lui-même, comme sonnette : `resolveQuotesWithoutAsking`
 * (runner.ts) et `uniqueQuoteCandidate` (policy.ts) traversaient la frontière
 * entre les deux modules, donc chacun était exporté, et réintroduire l'un ou
 * l'autre pour écrire une citation d'office le rend visible ici en un test qui
 * ne dépend d'aucune entrée. Ce n'est qu'une sonnette : elle ne dit rien d'un
 * aide renommé ou privé, ni du chemin qui l'appellerait.
 *
 * Ce chemin est gardé par le rejeu de bout en bout de `plan-evidence.test.ts`,
 * qui couvre les familles où l'écriture automatique écrivait réellement — copie
 * altérée (run 9add286d), identifiant nu porté par une seule ligne réelle (la
 * mesure de #62), vue partielle du fichier déclaré, question restée sans
 * réponse. Chacune attend DEUX appels modèle et la citation du planificateur
 * dans le plan persisté : une écriture automatique n'en paierait qu'un.
 */
describe("mécanisme retiré", () => {
  it("n'expose ni resolveQuotesWithoutAsking ni uniqueQuoteCandidate", async () => {
    const modules = await Promise.all([
      import("../src/policy.js"),
      import("../src/runner.js"),
    ]);
    const exposed = new Set(modules.flatMap((module) => Object.keys(module)));
    expect(
      ["resolveQuotesWithoutAsking", "uniqueQuoteCandidate"].filter((name) =>
        exposed.has(name)
      )
    ).toEqual([]);
    // Témoin de chargement : la correction par indice, elle, est bien exportée.
    expect(exposed.has("quotePickCorrection")).toBe(true);
    expect(exposed.has("quoteResolutionCandidates")).toBe(true);
  });
});
