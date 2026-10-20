import { createHash } from "node:crypto";
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
  quoteResolutionCandidates,
  requirementHasWitness,
  ungroundedRequirements,
  uniqueQuoteCandidate,
  validateCoverage,
  weakWitnessLines,
} from "../src/policy.js";
import {
  quotePickCorrection,
  resolveQuotesWithoutAsking,
} from "../src/runner.js";
import { type Plan, PlanSchema } from "../src/schema.js";
import { lineAt, MEASURED_COPY_REFUSALS } from "./fixture.js";
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
const config = loadConfig({});
const policy = PolicySchema.parse({ approvedSkips: [], version: 1 });

/**
 * Toutes les lignes réelles du corpus mesuré, par fichier : celles des refus
 * `MEASURED_COPY_REFUSALS` et celles du plan du run 58e47755 (`lot-v-replay.ts`).
 * C'est le matériel le plus complet disponible hors ligne pour juger l'ambiguïté
 * d'une citation — le corpus de production n'est pas lisible depuis un worktree.
 */
function knownLines(): { file: string; line: number; text: string }[] {
  const known = new Map<string, { file: string; line: number; text: string }>();
  const add = (file: string, line: number, text: string) => {
    const key = `${file}\u0000${line}`;
    if (!known.has(key) && line > 0 && text !== "") {
      known.set(key, { file, line, text });
    }
  };
  for (const measured of MEASURED_COPY_REFUSALS) {
    add(measured.lineFile, measured.lineNumber, measured.realLine);
  }
  for (const item of PAGE_TS_LINES) {
    add(PAGE, item.line, item.text);
  }
  for (const item of CASH_TS_LINES) {
    add(CASH, item.line, item.text);
  }
  return [...known.values()];
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

/** Ce que la mesure retient d'un nombre de portions réelles : une, plusieurs, aucune. */
function verdictsFor(candidates: number): string {
  if (candidates === 1) {
    return "unique";
  }
  return candidates === 0 ? "aucun" : "multiple";
}

/** Citation mesurée du run 07429b97 : `:""` inséré dans la première interpolation. */
const UNIT_QUOTE_07429B97 = `\${counted.totalUnits} unité\${counted.totalUnits>1?"s":"":""} comptée\${counted.totalUnits>1?"s":""}`;

/**
 * Le plan minimal qui porte une citation fautive et rien d'autre : un scénario
 * qui couvre le fichier changé, un témoin exact, et la copie refusée au rang 2.
 * Aucune autre classe fatale ne s'ouvre, donc le gate a le droit d'écrire.
 */
function planWith(faulty: string): Plan {
  return PlanSchema.parse({
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

/**
 * MESURE, lot X. Sur les 16 copies encore refusées du corpus mesuré (20 copies,
 * 4 acceptées depuis le retrait du plancher de blancs) et les cinq citations
 * faibles ou ambiguës du corpus de la famille, combien de fois une SEULE portion
 * réelle du fichier déclaré résout la citation, combien de fois plusieurs se la
 * disputent, combien de fois aucune n'existe. C'est ce rapport qui décide de la
 * portée du correctif : il ne couvre que le cas unique, et laisse les deux
 * autres au refus et à la correction par indice d'aujourd'hui.
 */
describe("mesure : combien de portions réelles résolvent une citation refusée", () => {
  it("compte les cas uniques, multiples et absents du corpus mesuré", () => {
    const measured = MEASURED_COPY_REFUSALS.filter(
      (item) => item.outcome === "refused"
    ).map((item) => ({
      label: `${item.runId.slice(0, 8)} requirement ${item.rank}`,
      lineNumber: item.lineNumber,
      quote: item.quote,
      sourceFile: item.declaredFile,
    }));
    const family = [
      {
        label: "58e47755 weak ecart-a-justifier",
        lineNumber: 0,
        quote: "ecart-a-justifier",
        sourceFile: CASH,
      },
      {
        label: "9ee36233 weak ecart-justifie",
        lineNumber: 0,
        quote: "ecart-justifie",
        sourceFile: CASH,
      },
      {
        label: "9ee36233 weak counted.totalUnits",
        lineNumber: 0,
        quote: "counted.totalUnits",
        sourceFile: PAGE,
      },
      {
        label: "07429b97 requirement 2",
        lineNumber: 368,
        quote: UNIT_QUOTE_07429B97,
        sourceFile: PAGE,
      },
      {
        label: "shared return",
        lineNumber: 0,
        quote: "return",
        sourceFile: CASH,
      },
    ];
    const verdicts = [...measured, ...family].map((item) => {
      const requirement = { quote: item.quote, sourceFile: item.sourceFile };
      const context = contextFor(item.sourceFile);
      const candidates = quoteResolutionCandidates(
        requirement,
        context,
        amputationScans()
      );
      return {
        candidates: candidates.length,
        label: item.label,
        lines: candidates.map((candidate) => candidate.line),
        verdict: verdictsFor(candidates.length),
      };
    });
    const count = (verdict: string) =>
      verdicts.filter((item) => item.verdict === verdict).length;
    expect(verdicts).toHaveLength(21);
    expect(count("unique")).toBe(16);
    expect(count("multiple")).toBe(2);
    expect(count("aucun")).toBe(3);
    // Les deux cas multiples sont l'ambiguïté mesurée de la famille : deux lignes
    // de `cash.ts` portent chacune de ces clés, donc aucune n'est choisie.
    expect(
      verdicts
        .filter((item) => item.verdict === "multiple")
        .map((item) => `${item.label} → ${item.lines.join("/")}`)
    ).toEqual([
      "58e47755 weak ecart-a-justifier → 116/146",
      "9ee36233 weak ecart-justifie → 116/144",
    ]);
    // Chaque cas unique du corpus pointe la ligne réelle que l'artefact du run
    // nomme : la résolution ne choisit pas une autre portion du fichier.
    for (const item of verdicts.slice(0, measured.length)) {
      if (item.verdict !== "unique") {
        continue;
      }
      const source = measured.find((entry) => entry.label === item.label);
      expect(item.lines, item.label).toEqual([source?.lineNumber]);
    }
  });
});

/**
 * REJEU du corpus mesuré, copie par copie : ce que le gate fait de chaque refus
 * réel. Les 16 copies du corpus et la citation du run 07429b97 sont résolues
 * quand une seule portion réelle les résout, et le plan résolu passe la
 * couverture ; les copies à deux portions et celles qu'aucune portion ne résout
 * gardent le refus d'aujourd'hui, mot pour mot. Avant le correctif, chaque copie
 * refusée coûtait un second appel modèle (mesuré : 2 appels, 0 reprise, blocked,
 * sur le run 07429b97) ; après, un appel suffit pour chaque cas unique.
 */
describe("rejeu du corpus mesuré", () => {
  /** Un plan qui porte cette copie au rang 2, avec un témoin exact du même fichier. */
  function replayPlan(declaredFile: string, quote: string): Plan {
    const witness = knownLines().find((item) => item.file === declaredFile);
    if (!witness) {
      throw new Error(`No measured line for ${declaredFile}`);
    }
    const base = planWith(quote);
    return PlanSchema.parse({
      ...base,
      scenarios: base.scenarios.map((scenario) => ({
        ...scenario,
        requirements: [
          {
            behavior: "Le comportement changé est prouvé",
            quote: witness.text,
            sourceFile: declaredFile,
          },
          {
            behavior: "La copie refusée est remplacée",
            quote,
            sourceFile: declaredFile,
          },
        ],
        sourceFiles: [declaredFile],
      })),
    });
  }
  it("résout les copies uniques et laisse les autres au refus d'aujourd'hui", () => {
    const cases = MEASURED_COPY_REFUSALS.filter(
      (item) => item.outcome === "refused"
    );
    const resolved: string[] = [];
    const refused: string[] = [];
    for (const measured of cases) {
      const label = `${measured.runId.slice(0, 8)} requirement ${measured.rank}`;
      const context = contextFor(measured.declaredFile);
      const plan = replayPlan(measured.declaredFile, measured.quote);
      const written = resolveQuotesWithoutAsking(
        plan,
        policy,
        context,
        config,
        measured.runId
      );
      const quote = plan.scenarios[0]?.requirements[1]?.quote;
      if (written.length === 0) {
        refused.push(label);
        // Le refus est celui d'aujourd'hui : la copie du planificateur est
        // intacte, et la couverture la refuse encore.
        expect(quote, label).toBe(measured.quote);
        expect(() => validateCoverage(plan, context, policy, config)).toThrow(
          /source witness/
        );
        continue;
      }
      resolved.push(label);
      // Le texte écrit est une portion verbatim de la ligne mesurée, jamais la
      // citation du planificateur, et le plan résolu passe la couverture.
      expect(written, label).toHaveLength(1);
      expect(written[0]?.line, label).toBe(measured.lineNumber);
      expect(measured.realLine, label).toContain(quote);
      expect(quote, label).not.toBe(measured.quote);
      expect(ungroundedRequirements(plan, context), label).toEqual([]);
      expect(validateCoverage(plan, context, policy, config).gate, label).toBe(
        "complete"
      );
    }
    // Quatorze copies uniques sur seize sont écrites par le gate, et deux — la
    // fabrication sans ligne réelle et l'attribution fautive — gardent leur
    // refus. Avec `counted.totalUnits` et la copie du run 07429b97, c'est la
    // classe entière des copies retapées qui ne coûte plus d'appel.
    expect(resolved).toHaveLength(14);
    expect(refused).toEqual([
      "9ee36233 requirement 2",
      "36926219 requirement 3",
    ]);
  });
});

describe("résolution déterministe d'une citation refusée", () => {
  it("écrit la portion réelle du run 07429b97 et laisse la couverture valide", () => {
    const context = contextFor(PAGE);
    const plan = planWith(UNIT_QUOTE_07429B97);
    // Le gate refuse encore la copie mesurée : c'est bien elle qui est résolue.
    expect(ungroundedRequirements(plan, context)).toHaveLength(1);
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "No source witness for cash-balanced-closure: apps/web/app/page.tsx (requirement 2)"
    );
    const written = resolveQuotesWithoutAsking(
      plan,
      policy,
      context,
      config,
      "07429b97-a5e5-4c29-9a1e-3ff4e8d9e7f1"
    );
    expect(written).toHaveLength(1);
    const [resolution] = written;
    expect(resolution?.from).toBe(UNIT_QUOTE_07429B97);
    expect(resolution?.line).toBe(368);
    expect(resolution?.rank).toBe(2);
    expect(resolution?.scenarioId).toBe("cash-balanced-closure");
    expect(resolution?.sourceFile).toBe(PAGE);
    // Le texte écrit est une portion VERBATIM de la ligne réelle déclarée,
    // jamais la citation fautive recollée.
    expect(pageLine(368)).toContain(resolution?.to ?? "");
    expect(resolution?.to).not.toBe(UNIT_QUOTE_07429B97);
    // Le plan persisté porte le texte résolu, et il n'a plus de défaut.
    expect(plan.scenarios[0]?.requirements[1]?.quote).toBe(resolution?.to);
    expect(ungroundedRequirements(plan, context)).toEqual([]);
    expect(validateCoverage(plan, context, policy, config).gate).toBe(
      "complete"
    );
  });
  it("choisit la ligne qui porte la structure quand la citation est un identifiant nu", () => {
    const context = contextFor(PAGE);
    // `counted.totalUnits` existe dans `page.tsx` mais ne porte aucune structure
    // de code : le gate refuse le témoin, et la résolution écrit la ligne réelle.
    expect(
      requirementHasWitness(
        { quote: "counted.totalUnits", sourceFile: PAGE },
        context
      )
    ).toBe(false);
    const only = uniqueQuoteCandidate(
      { quote: "counted.totalUnits", sourceFile: PAGE },
      context
    );
    expect(only?.line).toBe(368);
    expect(only?.text).toContain("counted.totalUnits");
    // Le texte écrit n'est pas l'identifiant nu : il porte la structure que le
    // gate exige, sinon le plan résolu serait refusé au tour suivant.
    expect(only?.text).not.toBe("counted.totalUnits");
    expect(
      requirementHasWitness(
        { quote: only?.text ?? "", sourceFile: PAGE },
        context
      )
    ).toBe(true);
  });
  it("ne résout jamais quand deux portions réelles se disputent la citation", () => {
    const context = contextFor(CASH);
    const plan = PlanSchema.parse({
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
    // Deux lignes réelles portent la clé : le choix reste au planificateur.
    expect(
      quoteResolutionCandidates(
        { quote: "ecart-a-justifier", sourceFile: CASH },
        context,
        amputationScans()
      ).map((candidate) => candidate.line)
    ).toEqual([116, 146]);
    expect(
      uniqueQuoteCandidate(
        { quote: "ecart-a-justifier", sourceFile: CASH },
        context
      )
    ).toBeUndefined();
    expect(
      resolveQuotesWithoutAsking(plan, policy, context, config, "58e47755")
    ).toEqual([]);
    // Le refus et la correction par indice restent ceux d'aujourd'hui, mot pour
    // mot : c'est la mécanique de la PR #60, inchangée.
    expect(plan.scenarios[0]?.requirements[1]?.quote).toBe("ecart-a-justifier");
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "Weak source witness"
    );
    const correction = quotePickCorrection(
      plan,
      policy,
      context,
      config,
      "58e47755"
    );
    expect(correction?.message).toContain("picks");
  });
  it("ne résout jamais quand aucune portion réelle n'existe", () => {
    const context = contextFor(PAGE);
    const absent = "expect(total(result)).toBe(170);";
    expect(
      uniqueQuoteCandidate({ quote: absent, sourceFile: PAGE }, context)
    ).toBeUndefined();
    const plan = planWith(absent);
    expect(
      resolveQuotesWithoutAsking(plan, policy, context, config, "9ee36233")
    ).toEqual([]);
    // La citation que le planificateur a écrite n'est ni acceptée ni remplacée :
    // le refus d'aujourd'hui est rendu.
    expect(plan.scenarios[0]?.requirements[1]?.quote).toBe(absent);
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "No source witness"
    );
  });
  it("n'écrit rien quand le plan a un autre défaut que la citation", () => {
    const context = contextFor(PAGE, CASH);
    const plan = planWith(UNIT_QUOTE_07429B97);
    // `cash.ts` est changé mais aucun scénario ne le couvre : la résolution
    // écrirait une citation dans un plan refusé pour une autre raison, et le
    // refus ne nommerait plus ce que le planificateur avait écrit.
    expect(
      resolveQuotesWithoutAsking(plan, policy, context, config, "07429b97")
    ).toEqual([]);
    expect(plan.scenarios[0]?.requirements[1]?.quote).toBe(UNIT_QUOTE_07429B97);
  });
});

describe("trace de la résolution", () => {
  it("journalise quelle citation a été remplacée par quelle ligne, sans le texte", () => {
    const context = contextFor(PAGE);
    const plan = planWith(UNIT_QUOTE_07429B97);
    logged.length = 0;
    const [resolution] = resolveQuotesWithoutAsking(
      plan,
      policy,
      context,
      config,
      "07429b97-a5e5-4c29-9a1e-3ff4e8d9e7f1"
    );
    const entries = logged.filter(
      (entry) => entry.message === "Requirement quote resolved by the gate"
    );
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    // Aucune portion du texte du dépôt testé n'entre au journal : ni la copie
    // refusée, ni la ligne réelle écrite.
    const serialized = JSON.stringify(entry);
    for (const fragment of ["counted", "unité", "comptée"]) {
      expect(serialized).not.toContain(fragment);
    }
    const fingerprint = (text: string) =>
      createHash("sha256").update(text).digest("hex").slice(0, 16);
    expect(entry).toMatchObject({
      line: 368,
      replaced: {
        quoteChars: UNIT_QUOTE_07429B97.length,
        quoteFingerprint: fingerprint(UNIT_QUOTE_07429B97),
      },
      requirement: 2,
      resolved: {
        quoteChars: resolution?.to.length,
        quoteFingerprint: fingerprint(resolution?.to ?? ""),
      },
      runId: "07429b97-a5e5-4c29-9a1e-3ff4e8d9e7f1",
      scenario: "cash-balanced-closure",
      sourceFile: PAGE,
    });
  });
});

/**
 * Les vues partielles du fichier cité que le vérificateur de l'étape 2 a
 * mesurées, et celles que la revue de la PR a nommées : un fichier plus long que
 * `CITED_LINES_EXAMINED` cache la vraie ligne derrière un sosie, un identifiant
 * nu porté par trois lignes dont deux dépassent la borne de suggestion n'en
 * laisse qu'un candidat, et un contenu coupé au plafond de 16 000 caractères par
 * fichier — ou jamais lu faute de budget — cache une portion réelle sans que son
 * nombre de lignes restantes le trahisse. Dans tous les cas
 * `quoteResolutionCandidates` offre UN candidat — donc le gate écrirait — alors
 * que le fichier ne prouve pas l'unicité. Le refus d'aujourd'hui reste rendu, et
 * la correction par indice reste offerte.
 */
describe("vues partielles du fichier cité", () => {
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
   * et l'avertissement nomme le fichier et la révision coupés. C'est cet
   * avertissement que `citedSourceIncomplete` lit — sans lui, la vue paraît
   * complète dès qu'elle tient sous `CITED_LINES_EXAMINED`. Le patch est gardé :
   * c'est le cas de production, un fichier changé dont le diff suffit à la
   * preuve de source alors que sa source de tête est coupée.
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
  it("n'écrit pas la ligne sosie quand la vraie ligne dépasse le plafond de lecture", () => {
    const fuzzLine = `  const label = \`\${counted.totalUnits} unité\${counted.totalUnits>1?"s":""}\`;`;
    // La ligne 2005 est la seule qui porte la citation mesurée, mais
    // `CITED_LINES_EXAMINED` s'arrête à 2000 : seul le sosie de la ligne 1500 est
    // lu. Écrire 1500 nommerait une ligne qui ne prouve pas le comportement.
    const context = contextFromLines(PAGE, [
      { line: 350, text: pageLine(350) },
      { line: 1500, text: fuzzLine },
      { line: 2005, text: pageLine(368) },
    ]);
    const plan = planWith(UNIT_QUOTE_07429B97);
    // Le candidat unique existe dans la vue tronquée : c'est le piège mesuré.
    expect(
      quoteResolutionCandidates(
        { quote: UNIT_QUOTE_07429B97, sourceFile: PAGE },
        context,
        amputationScans()
      ).map((candidate) => candidate.line)
    ).toEqual([1500]);
    expect(
      uniqueQuoteCandidate(
        { quote: UNIT_QUOTE_07429B97, sourceFile: PAGE },
        context
      )
    ).toBeUndefined();
    expect(
      resolveQuotesWithoutAsking(plan, policy, context, config, "cap")
    ).toEqual([]);
    expect(plan.scenarios[0]?.requirements[1]?.quote).toBe(UNIT_QUOTE_07429B97);
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "No source witness"
    );
  });
  it("n'écrit rien quand le fichier cité est coupé au plafond de caractères", () => {
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
    // Le candidat unique de la vue coupée est le sosie : c'est le piège.
    expect(
      quoteResolutionCandidates(
        { quote, sourceFile: PAGE },
        context,
        amputationScans()
      ).map((candidate) => candidate.line)
    ).toEqual([100]);
    expect(
      uniqueQuoteCandidate({ quote, sourceFile: PAGE }, context)
    ).toBeUndefined();
    const plan = planWith(quote);
    expect(
      resolveQuotesWithoutAsking(plan, policy, context, config, "charcap")
    ).toEqual([]);
    // Le refus est celui d'aujourd'hui, et la correction par indice reste
    // offerte : le planificateur choisit, le gate n'écrit rien d'office.
    expect(plan.scenarios[0]?.requirements[1]?.quote).toBe(quote);
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
    // Le seul indice est le sosie de la vue coupée : le planificateur choisit
    // ce que le gate refusait d'écrire d'office.
    expect(correction?.message).toContain(`1: ${JSON.stringify(sosie)}`);
  });
  it("s'abstient sur toute troncature connue du fichier déclaré", () => {
    // Vue complète et candidat unique : sans la troncature, le gate écrirait.
    const complete = contextFromLines(PAGE, [
      { line: 350, text: pageLine(350) },
      { line: 368, text: pageLine(368) },
    ]);
    expect(
      uniqueQuoteCandidate(
        { quote: UNIT_QUOTE_07429B97, sourceFile: PAGE },
        complete
      )?.line
    ).toBe(368);
    // Chaque plafond de `collectContext` qui laisse le fichier déclaré lu en
    // partie interdit d'écrire : la mesure serait prise sur une vue partielle.
    const warnings = [
      truncatedContextWarning(PAGE, SHA),
      unavailableContextWarning(PAGE, SHA),
      CONTEXT_BUDGET_EXHAUSTED_WARNING,
      DEPENDENCY_CONTEXT_LIMIT_WARNING,
    ];
    for (const warning of warnings) {
      const context = { ...complete, contextWarnings: [warning] };
      const plan = planWith(UNIT_QUOTE_07429B97);
      expect(
        uniqueQuoteCandidate(
          { quote: UNIT_QUOTE_07429B97, sourceFile: PAGE },
          context
        ),
        warning
      ).toBeUndefined();
      expect(
        resolveQuotesWithoutAsking(plan, policy, context, config, "partial"),
        warning
      ).toEqual([]);
      expect(plan.scenarios[0]?.requirements[1]?.quote, warning).toBe(
        UNIT_QUOTE_07429B97
      );
      expect(() => validateCoverage(plan, context, policy, config)).toThrow(
        "No source witness"
      );
    }
  });
  it("résout encore quand la troncature nomme un autre fichier ou une autre révision", () => {
    // Le matériel du fichier cité est intact : la troncature des autres fichiers
    // et celle de la révision de base, que `allFileContentLines` ne lit pas pour
    // un fichier modifié, ne disent rien de son unicité.
    const context = {
      ...contextFor(PAGE),
      contextWarnings: [
        truncatedContextWarning(CASH, SHA),
        truncatedContextWarning(PAGE, "2".repeat(40)),
        unavailableContextWarning(CASH, SHA),
      ],
    };
    const plan = planWith(UNIT_QUOTE_07429B97);
    const written = resolveQuotesWithoutAsking(
      plan,
      policy,
      context,
      config,
      "07429b97"
    );
    expect(written).toHaveLength(1);
    expect(written[0]?.line).toBe(368);
    expect(plan.scenarios[0]?.requirements[1]?.quote).toBe(written[0]?.to);
    expect(validateCoverage(plan, context, policy, config).gate).toBe(
      "complete"
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
    const plan = PlanSchema.parse({
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
    // Trois lignes réelles portent l'identifiant ; la borne de #62 les écarte
    // toutes, mais la suggestion n'en garde qu'une — c'est le piège mesuré.
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
    expect(
      uniqueQuoteCandidate(
        { quote: "ecart-a-justifier", sourceFile: CASH },
        context
      )
    ).toBeUndefined();
    expect(
      resolveQuotesWithoutAsking(plan, policy, context, config, "weak3")
    ).toEqual([]);
    expect(plan.scenarios[0]?.requirements[1]?.quote).toBe("ecart-a-justifier");
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "Weak source witness"
    );
  });
  it("résout encore un identifiant porté par deux lignes au texte identique", () => {
    // Deux occurrences du même texte forment UNE réponse, pas une ambiguïté :
    // l'ambiguïté se compte sur les textes distincts, comme `offer` dédoublonne.
    const text = "  const unit = counted.totalUnits;";
    const context = contextFromLines(PAGE, [
      { line: 100, text },
      { line: 350, text: pageLine(350) },
      { line: 368, text },
    ]);
    const plan = planWith("counted.totalUnits");
    const written = resolveQuotesWithoutAsking(
      plan,
      policy,
      context,
      config,
      "duplicate"
    );
    expect(written).toHaveLength(1);
    expect(written[0]?.to).toBe(text);
    expect(plan.scenarios[0]?.requirements[1]?.quote).toBe(text);
    expect(validateCoverage(plan, context, policy, config).gate).toBe(
      "complete"
    );
  });
});
