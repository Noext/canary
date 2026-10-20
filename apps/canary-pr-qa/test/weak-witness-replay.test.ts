import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import {
  amputationScans,
  PolicySchema,
  quoteResolutionCandidates,
  requirementHasWitness,
  ungroundedRequirement,
  ungroundedRequirements,
  validateCoverage,
  weakWitnessLines,
} from "../src/policy.js";
import { quotePickCorrection } from "../src/runner.js";
import { PlanSchema } from "../src/schema.js";
import { lineAt } from "./fixture.js";
import { CASH_TS_LINES, LOT_V_PLAN, PAGE_TS_LINES } from "./lot-v-replay.js";

const CASH = "packages/domain/src/cash.ts";
const PAGE = "apps/web/app/page.tsx";
const SHA = "814b671305b005ab516db66bc3da1d8239bcef16";
const config = loadConfig({});
const policy = PolicySchema.parse({ approvedSkips: [], version: 1 });

/**
 * Le contexte du run 58e47755 : les deux fichiers changés que le plan mesuré
 * cite, chacun portant les lignes réelles du fichier à la révision testée —
 * celles que le plan cite et celles qui portent les identifiants refusés.
 */
function measuredContext(): PrContext {
  const patch = (path: string, lines: { line: number; text: string }[]) =>
    lines.map((item) => lineAt(path, item.line, item.text).patch).join("\n");
  return {
    baseSha: "2".repeat(40),
    body: "",
    context: [],
    contextWarnings: [],
    files: [
      { filename: PAGE, patch: patch(PAGE, PAGE_TS_LINES), status: "modified" },
      { filename: CASH, patch: patch(CASH, CASH_TS_LINES), status: "modified" },
    ],
    headRepo: "pharmania/arpilabe-pilotage",
    ref: parsePrUrl("https://github.com/pharmania/arpilabe-pilotage/pull/17"),
    sha: SHA,
    title: "",
  };
}

function measuredPlan() {
  return PlanSchema.parse(LOT_V_PLAN);
}

function cashLine(line: number): string {
  const found = CASH_TS_LINES.find((item) => item.line === line);
  if (!found) {
    throw new Error(`No measured cash.ts line ${line}`);
  }
  return found.text;
}

/**
 * Le refus mesuré du run 58e47755, mot pour mot : le message et le conseil que
 * l'artefact `result.json` porte. Le rejeu les compare à l'identique, donc un
 * élargissement de la règle de témoin se verrait ici.
 */
const MEASURED_MESSAGE =
  'Weak source witness for cash-variance-blocked-then-justified: packages/domain/src/cash.ts (requirement 3). Rejected quote: "ecart-a-justifier"';

/**
 * Le run 58e47755 est mort d'un témoin trop pauvre : `ecart-a-justifier` existe
 * dans `cash.ts` mais ne porte aucune structure de code. Le correctif ne touche
 * pas la règle — le refus reste identique — il ajoute la piste qui manquait : la
 * ligne réelle qui porte l'identifiant, comme candidat de la correction
 * contrainte et comme remède du refus. Le rejeu prouve les deux moitiés : le
 * refus tombe encore sur le premier tour, et le choix d'un indice rend le plan
 * conforme sans que le modèle recopie quoi que ce soit.
 */
it("replays the weak-witness refusal of run 58e47755 and resolves it by pick", () => {
  const context = measuredContext();
  const plan = measuredPlan();
  const faults = ungroundedRequirements(plan, context);
  expect(faults).toHaveLength(1);
  const [fault] = faults;
  expect(fault?.scenarioId).toBe("cash-variance-blocked-then-justified");
  expect(fault?.rank).toBe(3);
  expect(fault?.requirement.quote).toBe("ecart-a-justifier");
  if (!fault) {
    throw new Error("Expected the measured weak witness refusal");
  }
  // La règle n'a pas bougé : l'identifiant nu reste refusé, et le refus est
  // celui que l'artefact du run porte, mot pour mot.
  const refusal = ungroundedRequirement(
    fault.scenarioId,
    fault.requirement,
    context,
    policy,
    fault.rank
  );
  expect(refusal.message).toBe(MEASURED_MESSAGE);
  expect(
    requirementHasWitness(
      { quote: "ecart-a-justifier", sourceFile: CASH },
      context
    )
  ).toBe(false);
  expect(() => validateCoverage(plan, context, policy, config)).toThrow(
    MEASURED_MESSAGE
  );
  // Le conseil nomme la ligne réelle qui porte l'identifiant : c'est la piste
  // que le message mesuré ne donnait pas.
  expect(refusal.hint).toContain(`116: ${JSON.stringify(cashLine(116))}`);
  const correction = quotePickCorrection(
    plan,
    policy,
    context,
    config,
    "lot-v-replay"
  );
  expect(correction).toBeDefined();
  if (!correction) {
    throw new Error("Expected a constrained correction for the weak witness");
  }
  expect(correction.message).toContain(`1: ${JSON.stringify(cashLine(116))}`);
  const resolved = correction.resolve({
    picks: [
      {
        scenario: "cash-variance-blocked-then-justified",
        requirement: 3,
        candidate: 1,
      },
    ],
  });
  expect(resolved).toBeDefined();
  if (!resolved) {
    throw new Error("Expected the pick to resolve the refused quote");
  }
  const repaired = resolved.scenarios.find(
    (scenario) => scenario.id === "cash-variance-blocked-then-justified"
  )?.requirements[2]?.quote;
  expect(repaired).toBe(cashLine(116));
  // Le plan corrigé passe le gate : le run n'est plus bloqué sur ce motif.
  expect(ungroundedRequirements(resolved, context)).toEqual([]);
  expect(
    validateCoverage(resolved, context, policy, config).gate.length
  ).toBeGreaterThan(0);
});

/**
 * Les citations insuffisantes du corpus, relevées sur 248 runs et 5450
 * exigences : cinq occurrences, trois runs, toutes attribuées au fichier qui
 * les contient. Avant le correctif, deux d'entre elles n'obtenaient aucun
 * candidat et aucun remède — `ecart-justifie` et `counted.totalUnits` ne
 * partagent que deux jetons avec leur ligne, sous le seuil de
 * `suggestedQuoteLines`, et la ligne de `counted.totalUnits` dépasse sa borne de
 * 120 caractères. Chacune doit maintenant recevoir la ligne réelle qui la porte.
 */
const INSUFFICIENT = [
  { file: CASH, quote: "ecart-a-justifier", line: 116 },
  { file: CASH, quote: "ecart-justifie", line: 116 },
  { file: PAGE, quote: "counted.totalUnits", line: 368 },
];

it("offers the real line that carries every insufficient quote of the corpus", () => {
  const context = measuredContext();
  for (const item of INSUFFICIENT) {
    const requirement = { quote: item.quote, sourceFile: item.file };
    const candidates = quoteResolutionCandidates(requirement, context);
    expect(candidates.length, item.quote).toBeGreaterThan(0);
    expect(candidates[0]?.line, item.quote).toBe(item.line);
    for (const candidate of candidates) {
      // Le candidat est une portion EXACTE d'une ligne réelle, il porte la
      // citation, et il est un témoin que le gate accepterait : la correction
      // par indice ne peut donc pas proposer un texte refusé au tour suivant.
      expect(candidate.text, item.quote).toContain(item.quote);
      expect(
        requirementHasWitness(
          { quote: candidate.text, sourceFile: item.file },
          context
        ),
        `${item.quote} → ${candidate.line}`
      ).toBe(true);
    }
    // Ce qui est offert est la ligne ENTIÈRE, jamais l'identifiant nu : la
    // proposition apporte la structure qui manquait au témoin.
    expect(
      requirementHasWitness(requirement, context),
      `${item.quote}: identifiant nu`
    ).toBe(false);
    expect(weakWitnessLines(requirement, context).length).toBeGreaterThan(0);
  }
});

/**
 * La correction contrainte ne s'ouvre que sur des candidats réels : un plan qui
 * garde un identifiant nu ailleurs n'est pas corrigé par indice pour autant. Le
 * second scénario du plan mesuré porte une citation substantielle de `cash.ts` ;
 * en la remplaçant par un identifiant nu, le refus vise deux exigences et la
 * correction doit nommer les lignes des deux.
 */
it("keeps every refused requirement in the pick, and never a bare identifier", () => {
  const context = measuredContext();
  const plan = measuredPlan();
  const scenario = plan.scenarios.find(
    (item) => item.id === "cash-invalid-decimal-quantity"
  );
  const requirement = scenario?.requirements[0];
  if (!requirement) {
    throw new Error("Expected the measured decimal scenario");
  }
  requirement.quote = "countedValue";
  expect(ungroundedRequirements(plan, context)).toHaveLength(2);
  const scans = amputationScans();
  const correction = quotePickCorrection(
    plan,
    policy,
    context,
    config,
    "lot-v-replay",
    scans
  );
  // `countedValue` n'existe dans aucune ligne du fichier cité : la correction
  // par indice ne peut pas le résoudre, donc le refus d'aujourd'hui est rendu
  // au lieu d'une question sans réponse.
  expect(correction).toBeUndefined();
});
