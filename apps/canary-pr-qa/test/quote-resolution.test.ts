import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import {
  amputationScans,
  PolicySchema,
  quoteResolutionCandidates,
  requirementHasWitness,
  ungroundedRequirements,
  uniqueQuoteCandidate,
  validateCoverage,
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
