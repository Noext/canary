import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import {
  amputationScans,
  PolicySchema,
  quoteResolutionCandidates,
  requirementHasWitness,
  ungroundedRequirements,
  validateCoverage,
} from "../src/policy.js";
import { quotePickCorrection } from "../src/runner.js";
import { type Plan, PlanSchema } from "../src/schema.js";
import { lineAt, MEASURED_COPY_REFUSALS } from "./fixture.js";
import { CASH_TS_LINES, PAGE_TS_LINES } from "./lot-v-replay.js";

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
 * Aucune autre classe fatale ne s'ouvre, donc la correction par indice reste
 * offerte.
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
 * faibles ou ambiguës du corpus de la famille, combien de portions réelles du
 * fichier déclaré la correction par indice peut nommer.
 *
 * Cette table était la prémisse du chemin d'écriture automatique de #64 ; elle
 * mesure désormais ce que l'indice montre au planificateur. La seconde table,
 * juste après, dit pourquoi le gate n'écrit plus rien : aucune de ces copies
 * n'entretient avec sa ligne une relation exacte.
 */
describe("mesure : combien de portions réelles nomment une citation refusée", () => {
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
    // de `cash.ts` portent chacune de ces clés, donc les deux sont nommées.
    expect(
      verdicts
        .filter((item) => item.verdict === "multiple")
        .map((item) => `${item.label} → ${item.lines.join("/")}`)
    ).toEqual([
      "58e47755 weak ecart-a-justifier → 116/146",
      "9ee36233 weak ecart-justifie → 116/144",
    ]);
    // Chaque cas unique du corpus pointe la ligne réelle que l'artefact du run
    // nomme : l'indice ne désigne pas une autre portion du fichier.
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
 * La frontière de nature qui a fait retirer l'écriture automatique. Une copie
 * refusée est, par construction, une copie que le gate n'a pas reconnue comme
 * citation du fichier déclaré : aucune des lignes de CE fichier ne l'inclut, et
 * elle n'inclut aucune d'elles. Les 16 copies refusées du corpus le vérifient,
 * y compris la copie mesurée du run 07429b97.
 *
 * Les deux copies refusées qui échappent au compte sont hors du fichier
 * déclaré : la citation fabriquée n'a aucune ligne réelle, et la copie
 * mal attribuée est un texte exact d'une ligne d'un AUTRE fichier — c'est
 * l'attribution qui est fausse, corrigée par `repairRequirementAttribution`,
 * pas un remplacement de citation.
 *
 * Conséquence : une résolution automatique qui exigerait une relation exacte
 * serait du code mort, et celle qui se déclenchait réellement reposait sur un
 * recouvrement de jetons. C'est une décision prise à la place du planificateur,
 * sur une ressemblance, donc le gate n'écrit plus rien.
 */
describe("frontière : aucune copie refusée n'est une portion exacte du fichier déclaré", () => {
  it("ne trouve aucune inclusion verbatim dans le corpus refusé", () => {
    const refused = MEASURED_COPY_REFUSALS.filter(
      (item) => item.outcome === "refused"
    );
    const exact = refused.filter((item) =>
      knownLines().some(
        (line) =>
          line.file === item.declaredFile &&
          (line.text.includes(item.quote) || item.quote.includes(line.text))
      )
    );
    expect(refused).toHaveLength(16);
    expect(
      exact.map((item) => `${item.runId.slice(0, 8)} requirement ${item.rank}`)
    ).toEqual([]);
  });
  it("ne trouve aucune inclusion verbatim pour la copie du run 07429b97", () => {
    // La copie insère `:""` : trois caractères inventés à l'intérieur de la
    // ligne 368. Sa relation avec la ligne n'est exacte dans aucun sens.
    expect(pageLine(368).includes(UNIT_QUOTE_07429B97)).toBe(false);
    expect(UNIT_QUOTE_07429B97.includes(pageLine(368))).toBe(false);
    // L'indice, lui, nomme bien la ligne 368 : c'est le planificateur qui choisit.
    expect(
      quoteResolutionCandidates(
        { quote: UNIT_QUOTE_07429B97, sourceFile: PAGE },
        contextFor(PAGE),
        amputationScans()
      ).map((candidate) => candidate.line)
    ).toEqual([368]);
  });
});

/**
 * REJEU du corpus mesuré, copie par copie : ce que le gate fait maintenant de
 * chaque refus réel — rien. Le plan du planificateur n'est pas modifié, le refus
 * d'aujourd'hui est rendu mot pour mot, et les copies qu'un indice peut nommer
 * retombent sur la correction contrainte au lieu de bloquer le run. Le compte
 * des écritures automatiques est zéro : c'est la preuve du retrait.
 */
describe("rejeu du corpus mesuré : le gate n'écrit aucun remplacement", () => {
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
            behavior: "La copie refusée reste celle du planificateur",
            quote,
            sourceFile: declaredFile,
          },
        ],
        sourceFiles: [declaredFile],
      })),
    });
  }
  it("laisse chaque copie intacte et retombe sur l'indice quand il existe", () => {
    const cases = MEASURED_COPY_REFUSALS.filter(
      (item) => item.outcome === "refused"
    );
    const hinted: string[] = [];
    const rewritten: string[] = [];
    for (const measured of cases) {
      const label = `${measured.runId.slice(0, 8)} requirement ${measured.rank}`;
      const context = contextFor(measured.declaredFile);
      const plan = replayPlan(measured.declaredFile, measured.quote);
      const correction = quotePickCorrection(
        plan,
        policy,
        context,
        config,
        measured.runId
      );
      // Zéro écriture automatique : la copie du planificateur est celle du plan.
      expect(plan.scenarios[0]?.requirements[1]?.quote, label).toBe(
        measured.quote
      );
      // Le refus est celui d'aujourd'hui, et la couverture le refuse encore.
      expect(ungroundedRequirements(plan, context), label).toHaveLength(1);
      expect(
        () => validateCoverage(plan, context, policy, config),
        label
      ).toThrow(/source witness/);
      if (correction === undefined) {
        rewritten.push(label);
        continue;
      }
      hinted.push(label);
      // L'indice nomme la portion réelle mesurée ; il ne l'écrit pas.
      const [candidate] = quoteResolutionCandidates(
        { quote: measured.quote, sourceFile: measured.declaredFile },
        context,
        amputationScans()
      );
      expect(correction.message, label).toContain("picks");
      expect(correction.message, label).toContain(
        JSON.stringify(candidate?.text)
      );
    }
    // Quatorze copies sur seize tombent sur l'indice. Les deux autres — la
    // citation fabriquée et l'attribution fautive — gardent la réécriture
    // complète du refus d'aujourd'hui, faute de portion réelle à nommer.
    expect(hinted).toHaveLength(14);
    expect(rewritten).toEqual([
      "9ee36233 requirement 2",
      "36926219 requirement 3",
    ]);
  });
  it("résout la copie du run 07429b97 par l'indice, sans blocage", () => {
    const context = contextFor(PAGE);
    const plan = planWith(UNIT_QUOTE_07429B97);
    // Le gate refuse encore la copie mesurée : c'est elle que l'indice doit
    // nommer, sans que le gate décide à sa place.
    expect(ungroundedRequirements(plan, context)).toHaveLength(1);
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "No source witness for cash-balanced-closure: apps/web/app/page.tsx (requirement 2)"
    );
    const correction = quotePickCorrection(
      plan,
      policy,
      context,
      config,
      "07429b97-a5e5-4c29-9a1e-3ff4e8d9e7f1"
    );
    expect(correction?.message).toContain('"picks"');
    expect(plan.scenarios[0]?.requirements[1]?.quote).toBe(UNIT_QUOTE_07429B97);
    const resolved = correction?.resolve({
      picks: [
        {
          candidate: 1,
          requirement: 2,
          scenario: "cash-balanced-closure",
        },
      ],
    }) as Plan | undefined;
    // Le texte retenu est une portion VERBATIM de la ligne 368 : l'altération
    // `:""` du planificateur a disparu, et la couverture passe.
    const quote = resolved?.scenarios[0]?.requirements[1]?.quote ?? "";
    expect(pageLine(368)).toContain(quote);
    expect(quote).not.toBe(UNIT_QUOTE_07429B97);
    expect(quote).toContain('counted.totalUnits>1?"s":""');
    expect(quote).not.toContain('"s":"":""');
    expect(ungroundedRequirements(resolved as Plan, context)).toEqual([]);
    expect(
      validateCoverage(resolved as Plan, context, policy, config).gate
    ).toBe("complete");
  });
  it("nomme la ligne qui porte la structure quand la citation est un identifiant nu", () => {
    const context = contextFor(PAGE);
    // `counted.totalUnits` existe dans `page.tsx` mais ne porte aucune structure
    // de code : le gate refuse le témoin, et l'indice nomme la ligne réelle.
    expect(
      requirementHasWitness(
        { quote: "counted.totalUnits", sourceFile: PAGE },
        context
      )
    ).toBe(false);
    const [only] = quoteResolutionCandidates(
      { quote: "counted.totalUnits", sourceFile: PAGE },
      context,
      amputationScans()
    );
    expect(only?.line).toBe(368);
    expect(only?.text).toContain("counted.totalUnits");
    // Le texte proposé n'est pas l'identifiant nu : il porte la structure que
    // le gate exige, sinon le plan corrigé serait refusé au tour suivant.
    expect(only?.text).not.toBe("counted.totalUnits");
    expect(
      requirementHasWitness(
        { quote: only?.text ?? "", sourceFile: PAGE },
        context
      )
    ).toBe(true);
  });
  it("nomme les deux lignes quand deux portions réelles se disputent la citation", () => {
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
    // Deux lignes réelles portent la clé : l'indice les nomme toutes les deux,
    // et le choix reste au planificateur.
    expect(
      quoteResolutionCandidates(
        { quote: "ecart-a-justifier", sourceFile: CASH },
        context,
        amputationScans()
      ).map((candidate) => candidate.line)
    ).toEqual([116, 146]);
    const correction = quotePickCorrection(
      plan,
      policy,
      context,
      config,
      "58e47755"
    );
    expect(correction?.message).toContain(
      `1: ${JSON.stringify(measuredLine(CASH, 116))}`
    );
    expect(correction?.message).toContain(
      `2: ${JSON.stringify(measuredLine(CASH, 146))}`
    );
    // Aucune écriture : la clé du planificateur est intacte sous le refus.
    expect(plan.scenarios[0]?.requirements[1]?.quote).toBe("ecart-a-justifier");
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "Weak source witness"
    );
  });
  it("ne nomme rien et garde le refus quand aucune portion réelle n'existe", () => {
    const context = contextFor(PAGE);
    const absent = "expect(total(result)).toBe(170);";
    expect(
      quoteResolutionCandidates(
        { quote: absent, sourceFile: PAGE },
        context,
        amputationScans()
      )
    ).toEqual([]);
    const plan = planWith(absent);
    expect(
      quotePickCorrection(plan, policy, context, config, "9ee36233")
    ).toBeUndefined();
    // La citation que le planificateur a écrite n'est ni acceptée ni remplacée :
    // le refus d'aujourd'hui est rendu, mot pour mot.
    expect(plan.scenarios[0]?.requirements[1]?.quote).toBe(absent);
    expect(() => validateCoverage(plan, context, policy, config)).toThrow(
      "No source witness"
    );
  });
});

describe("la correction par indice ne remplace pas la réécriture complète", () => {
  it("s'écarte quand un refus de `after` ne vient pas des citations offertes", () => {
    const context = contextFor(CASH);
    // Une citation faible, réparable par indice…
    const weak = planWith("ecart-a-justifier");
    expect(
      quoteResolutionCandidates(
        { quote: "ecart-a-justifier", sourceFile: CASH },
        context,
        amputationScans()
      ).length
    ).toBeGreaterThan(0);
    // …mais un second scénario porte un sélecteur positionnel, que
    // `applyQuotePicks` ne touche pas : la réécriture complète doit rester.
    const base = weak.scenarios[0]!;
    const polluted = PlanSchema.parse({
      ...weak,
      scenarios: [
        ...weak.scenarios,
        {
          ...structuredClone(base),
          id: "other-scenario",
          steps: [
            ...base.steps,
            {
              id: "click-positional",
              description: "cliquer une carte par position",
              action: {
                type: "click",
                locator: { by: "css", value: "aside > div" },
              },
            },
          ],
        },
      ],
    });
    expect(
      quotePickCorrection(polluted, policy, context, config, "review-p2")
    ).toBeUndefined();
  });
});
