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
  unwitnessedPlanRefusals,
  unwitnessedSources,
  validateCoverage,
  weakWitnessLines,
} from "../src/policy.js";
import { coverageFatalClasses, quotePickCorrection } from "../src/runner.js";
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

/**
 * La moitié `runner.ts` du correctif : la tête fatale apparie la citation fautive
 * à la ligne réelle qui la porte. C'est le texte qui survit à la troncature du
 * canal de correction quand les classes fatales saturent le préambule, là où le
 * détail par exigence peut disparaître.
 */
it("pairs the fatal class fault with the real line, not only the class advice", () => {
  const context = measuredContext();
  const fatal = coverageFatalClasses(
    measuredPlan(),
    context,
    policy,
    amputationScans()
  ).find((item) => item.code === "REQUIREMENT_UNGROUNDED");
  expect(fatal?.faults).toHaveLength(1);
  expect(fatal?.faults?.[0]?.quote).toBe("ecart-a-justifier");
  // La ligne mesurée, écrite comme le planificateur la reçoit.
  expect(fatal?.faults?.[0]?.remedy).toContain(
    `116: ${JSON.stringify(cashLine(116))}`
  );
});

/**
 * Le plan mesuré privé du scénario qui témoigne de `cash.ts` par une citation
 * substantielle : l'identifiant faible devient le SEUL témoin de son fichier
 * déclaré, et la couverture dérive donc son propre refus de la même citation
 * (finding P2 de la PR #62, `policy.ts:1392`). C'est le cas courant d'un
 * scénario à une seule exigence, celui que la correction par indice doit encore
 * pouvoir traiter.
 */
function singleWitnessPlan() {
  const plan = measuredPlan();
  return PlanSchema.parse({
    ...plan,
    scenarios: plan.scenarios.filter(
      (scenario) => scenario.id !== "cash-invalid-decimal-quantity"
    ),
  });
}

/**
 * Le finding P2 : le refus de couverture dérivé de la même citation faible
 * bloquait la correction contrainte avant qu'elle n'offre le moindre candidat.
 * La correction écrit une ligne RÉELLE et vérifiée comme témoin du fichier,
 * donc elle répare les deux refus ensemble, et la règle de contenu ne bouge pas
 * — l'identifiant nu reste refusé au premier tour.
 */
it("opens the pick when the weak quote is the scenario's only file witness", () => {
  const context = measuredContext();
  const plan = singleWitnessPlan();
  const faults = ungroundedRequirements(plan, context);
  expect(faults).toHaveLength(1);
  const unwitnessed = unwitnessedSources(plan, context);
  expect(unwitnessed).toEqual([
    {
      file: CASH,
      scenarioId: "cash-variance-blocked-then-justified",
      weak: true,
    },
  ]);
  // Le refus dérivé existe bien, et c'est lui que la correction écarte : le
  // test tombe si la paire (scénario, fichier) cesse d'être traitée comme
  // résolue par le choix.
  expect(unwitnessedPlanRefusals(plan, context, policy)[0]).toContain(
    "Scenario cash-variance-blocked-then-justified declares packages/domain/src/cash.ts without a source requirement witness"
  );
  const correction = quotePickCorrection(
    plan,
    policy,
    context,
    config,
    "lot-v-replay"
  );
  expect(correction).toBeDefined();
  if (!correction) {
    throw new Error("Expected the pick for a scenario's only file witness");
  }
  const [fault] = faults;
  if (!fault) {
    throw new Error("Expected the measured weak witness refusal");
  }
  // Les deux lignes réelles qui portent l'identifiant, dans la borne d'ambiguïté
  // de 168c394 : le choix reste au planificateur, aucun indice n'est imposé.
  expect(
    quoteResolutionCandidates(fault.requirement, context).map(
      (candidate) => candidate.line
    )
  ).toEqual([116, 146]);
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
  // Le gate accepte le plan corrigé : plus de citation fautive, plus de fichier
  // déclaré sans témoin, et la validation de couverture passe.
  expect(ungroundedRequirements(resolved, context)).toEqual([]);
  expect(unwitnessedSources(resolved, context)).toEqual([]);
  expect(validateCoverage(resolved, context, policy, config).gate).toBe(
    "complete"
  );
});

/**
 * L'autre moitié de la borne, mesurée sur le même plan : un identifiant commun
 * (`return`, trois lignes de `cash.ts`) garde le refus sans proposition. Écrire
 * l'une de ces lignes serait un choix arbitraire, donc la correction par indice
 * reste fermée et le planificateur réécrit l'exigence.
 */
it("keeps the refusal without a pick when the only file witness is ambiguous", () => {
  const context = measuredContext();
  const plan = singleWitnessPlan();
  const requirement = plan.scenarios[0]?.requirements[2];
  if (!requirement) {
    throw new Error("Expected the measured weak requirement");
  }
  requirement.quote = "return";
  const [fault] = ungroundedRequirements(plan, context);
  expect(fault?.requirement.quote).toBe("return");
  expect(
    weakWitnessLines({ quote: "return", sourceFile: CASH }, context)
  ).toEqual([]);
  expect(
    quoteResolutionCandidates({ quote: "return", sourceFile: CASH }, context)
  ).toEqual([]);
  expect(
    quotePickCorrection(plan, policy, context, config, "lot-v-replay")
  ).toBeUndefined();
  // Le refus rendu au planificateur est celui d'aujourd'hui, mot pour mot :
  // la couverture dérivée y figure toujours.
  expect(unwitnessedPlanRefusals(plan, context, policy)).toHaveLength(1);
  expect(() => validateCoverage(plan, context, policy, config)).toThrow(
    "Weak source witness"
  );
});

/**
 * Ce que la correction n'a pas le droit d'écarter : un fichier déclaré sans
 * témoin qu'aucun candidat ne témoigne. Seule la paire que le choix répare
 * disparaît du gate, donc le refus du fichier restant garde la correction
 * fermée — sinon le plan passerait la couverture sur un fichier non témoigné.
 */
it("keeps the pick closed for a declared file the pick does not witness", () => {
  const context = measuredContext();
  const plan = singleWitnessPlan();
  const scenario = plan.scenarios[0];
  if (!scenario) {
    throw new Error("Expected the measured weak scenario");
  }
  scenario.requirements = scenario.requirements.filter(
    (requirement) => requirement.sourceFile !== PAGE
  );
  expect(unwitnessedSources(plan, context).map(({ file }) => file)).toEqual([
    PAGE,
    CASH,
  ]);
  expect(
    quotePickCorrection(plan, policy, context, config, "lot-v-replay")
  ).toBeUndefined();
  expect(unwitnessedPlanRefusals(plan, context, policy)).toHaveLength(2);
});
