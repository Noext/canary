import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import {
  fixtureCatalog,
  NO_DECLARED_PRECONDITIONS,
  PRECONDITION_MESSAGE_CHARS,
  preconditionPlanRefusal,
  preconditionRefusals,
  prepareScenario,
  type TrustedCatalog,
  trustedCatalog,
} from "../src/fixtures.js";
import type { Plan, Scenario } from "../src/schema.js";
import { plan } from "./fixture.js";
import { LOT_W_PRECONDITIONS, LOT_W_REPO } from "./lot-w-preconditions.js";

const REPO = LOT_W_REPO;
/**
 * La borne après laquelle `model.ts` coupe une correction déposée au
 * planificateur. Les sondes ci-dessous mesurent ce qui reste VISIBLE.
 */
const CORRECTION_CHARS = 2000;
/**
 * La longueur maximale qu'un nom de précondition peut atteindre : le schéma
 * accepte `text` jusqu'à 2000 caractères, d'où des messages qui tenaient en
 * nombre et pas en caractères.
 */
const LONG_NAME_CHARS = 1990;
/** Un nom de précondition à la longueur maximale admise par le schéma. */
function longPrecondition(tag: string, index: number): string {
  const prefix = `fixture:${tag}-${index}-`;
  return `${prefix}${"x".repeat(LONG_NAME_CHARS - prefix.length)}`;
}

/** Le même plan mesuré, réduit à ce que le gate de préconditions lit. */
function measuredPlan(): Plan {
  return planOf(LOT_W_PRECONDITIONS);
}
/** Un plan de scénarios nus : seules leurs préconditions comptent ici. */
function planOf(scenarios: { id: string; preconditions: string[] }[]): Plan {
  const base = structuredClone(plan.scenarios[0]!);
  return {
    scenarios: scenarios.map(({ id, preconditions }) => ({
      ...base,
      id,
      preconditions,
    })),
    skipped: [],
    summary: "rejeu du run 985c3de7",
  };
}
/** Ce que le planificateur lit d'un message : la fenêtre que la troncature garde. */
function visible(text: string): string {
  return text.slice(0, CORRECTION_CHARS);
}
/** La marque de troncature honnête, avec le compte de ce qui est omis. */
const TRUNCATION = /… \(\+\d+ more\)/;
function declaredCatalog(): TrustedCatalog {
  return {
    fixtures: { checkout: "Create an isolated checkout cart" },
    roles: ["member"],
    visuals: [],
  };
}
async function catalogFile(content: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "canary-preconditions-"));
  const file = join(directory, "fixtures.json");
  await writeFile(file, JSON.stringify(content));
  return file;
}
/** Le refus d'exécution, relu plutôt que comparé à une sous-chaîne devinée. */
async function refusal(
  scenario: Scenario,
  file: string
): Promise<QaError | Error> {
  try {
    await prepareScenario(
      scenario,
      REPO,
      loadConfig({ QA_FIXTURES_FILE: file })
    );
  } catch (error) {
    return error as QaError;
  }
  throw new Error("prepareScenario accepted an unbacked precondition");
}

it("names the empty catalog instead of the bare missing name", () => {
  const refusals = preconditionRefusals(
    measuredPlan(),
    NO_DECLARED_PRECONDITIONS,
    REPO
  );
  // Le catalogue de production est vide : aucun nom ne peut y correspondre, sous
  // aucune graphie, et chaque scénario qui porte une précondition est arrêté.
  expect(refusals).toHaveLength(6);
  expect(refusals.map((item) => item.scenario.id)).toEqual(
    LOT_W_PRECONDITIONS.map((entry) => entry.id)
  );
  const [first] = refusals;
  expect(first?.error.code).toBe("PRECONDITION_UNVERIFIED");
  expect(first?.error.message).toContain("role:Administrateur démo 1");
  // Ce que le refus d'hier ne disait pas : ce qui existe réellement.
  expect(first?.error.message).toContain(
    `The trusted catalog declares nothing for ${REPO}`
  );
  // Le message d'hier, mot pour mot, ne suffit plus.
  expect(first?.error.message).not.toMatch(/^Role .+ missing$/);
  // Et la voie de correction, quand la valeur est un choix de la page.
  expect(first?.error.hint).toContain("fixture:name");
  expect(first?.error.hint).toContain("role:name");
  expect(first?.error.hint).toContain("is a step, not a precondition");
  expect(first?.error.hint).toContain("select or click");
});

it("hands the planner one bounded roll-up for the six measured scenarios", () => {
  const rollUp = preconditionPlanRefusal(
    measuredPlan(),
    NO_DECLARED_PRECONDITIONS,
    REPO
  );
  expect(rollUp).toContain("Preconditions no scenario can satisfy");
  for (const entry of LOT_W_PRECONDITIONS) {
    expect(rollUp).toContain(entry.id);
  }
  expect(rollUp).toContain("role:Pharmacie DEMO17 active");
  expect(rollUp).toContain(`The trusted catalog declares nothing for ${REPO}`);
  // Six scénarios bloqués par la même précondition ne remplissent pas à eux seuls
  // les 2000 caractères de la correction : le remède et les autres refus restent
  // lisibles par le planificateur.
  expect((rollUp ?? "").length).toBeLessThan(PRECONDITION_MESSAGE_CHARS + 1);
  // Le plan mesuré tient dans le budget : rien n'y est coupé, donc aucun
  // scénario fautif n'y manque.
  expect(rollUp).not.toMatch(TRUNCATION);
});

it("keeps the catalog and the remedy visible through twenty saturated scenarios", () => {
  // Sonde mesurée : 20 scénarios × 10 préconditions de 1990 caractères faisaient
  // 36 774 caractères. La troncature à 2000 emportait le catalogue ET le remède,
  // donc le planificateur recevait une liste de noms sans rien pour la corriger.
  const saturated = Array.from({ length: 20 }, (_, index) => ({
    id: `scenario-${index}`,
    preconditions: Array.from({ length: 10 }, (_, rank) =>
      longPrecondition(`s${index}`, rank)
    ),
  }));
  const rollUp =
    preconditionPlanRefusal(
      planOf(saturated),
      NO_DECLARED_PRECONDITIONS,
      REPO
    ) ?? "";
  expect(rollUp.length).toBeLessThanOrEqual(PRECONDITION_MESSAGE_CHARS);
  // Priorité (1) : ce que le catalogue porte réellement, et sous quelle forme un
  // nom se déclare. Priorité (2) : un choix offert par la page est une étape.
  expect(visible(rollUp)).toContain(
    `The trusted catalog declares nothing for ${REPO}`
  );
  expect(visible(rollUp)).toContain("is a step, not a precondition");
  expect(visible(rollUp)).toContain("fixture:name");
  // Priorité (3) : la liste des scénarios fautifs, coupée la dernière et jamais
  // en silence.
  expect(rollUp).toMatch(TRUNCATION);
  expect(rollUp).not.toContain("scenario-19");
  expect(rollUp).toContain("scenario-0");
});

it("abbreviates a twelve-name catalog without losing the remedy", () => {
  // Sonde mesurée : 12 noms de 340 caractères faisaient 4 253 caractères, et le
  // remède disparaissait de la troncature.
  const catalog: TrustedCatalog = {
    fixtures: Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `catalogue-${index}-${"y".repeat(330)}`,
        "Create an isolated cart",
      ])
    ),
    roles: [],
    visuals: [],
  };
  const rollUp = preconditionPlanRefusal(measuredPlan(), catalog, REPO) ?? "";
  expect(rollUp.length).toBeLessThanOrEqual(PRECONDITION_MESSAGE_CHARS);
  expect(visible(rollUp)).toContain(
    `The trusted catalog declares this for ${REPO}`
  );
  expect(visible(rollUp)).toContain("is a step, not a precondition");
  // Le catalogue est bien celui du dépôt, même abrégé : la marque compte les
  // noms omis au lieu de laisser croire qu'il n'en porte que deux.
  expect(rollUp).toContain("fixture:catalogue-0-");
  expect(rollUp).toMatch(TRUNCATION);
});

it("bounds each per-scenario refusal of ten saturated offenders", async () => {
  // Sonde mesurée : un message par scénario sur 10 fautifs de 1990 caractères
  // faisait 20 200 caractères ; tronqué, il ne restait ni catalogue ni remède.
  const faulty = Array.from({ length: 10 }, (_, index) => ({
    id: `scenario-${index}`,
    preconditions: Array.from({ length: 10 }, (_, rank) =>
      longPrecondition(`f${index}`, rank)
    ),
  }));
  const refusals = preconditionRefusals(
    planOf(faulty),
    NO_DECLARED_PRECONDITIONS,
    REPO
  );
  expect(refusals).toHaveLength(10);
  for (const { error } of refusals) {
    // Le message et son remède voyagent ensemble : c'est leur somme que
    // `model.ts` tronque, donc c'est elle qui reste dans le budget.
    expect(
      error.message.length + 2 + (error.hint ?? "").length
    ).toBeLessThanOrEqual(PRECONDITION_MESSAGE_CHARS);
    expect(visible(error.message)).toContain(
      `The trusted catalog declares nothing for ${REPO}`
    );
    expect(visible(error.hint ?? "")).toContain(
      "is a step, not a precondition"
    );
    expect(error.message).toMatch(TRUNCATION);
  }
  // Le refus d'exécution nomme le même manquement, borné de la même façon.
  const file = await catalogFile({
    [REPO]: { roles: { member: "QA_ROLE_MEMBER" } },
  });
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.preconditions = [longPrecondition("e", 0)];
  const error = (await refusal(scenario, file)) as QaError;
  expect(error.code).toBe("PRECONDITION_UNVERIFIED");
  expect(
    error.message.length + 2 + (error.hint ?? "").length
  ).toBeLessThanOrEqual(PRECONDITION_MESSAGE_CHARS);
  expect(error.message).toContain(`declares this for ${REPO}: role:member`);
});

/**
 * Ce test tombe si la borne en caractères disparaît : les bornes en NOMBRE (12
 * noms, 6 scénarios, 3 conditions) n'arrêtaient rien, puisqu'un nom pouvait
 * peser 1990 caractères. Il mesure l'enveloppe exacte que `runner.ts` compose et
 * que `model.ts` tronque à 2000.
 */
it("keeps the composed correction readable when the character bound carries it", () => {
  const saturated = Array.from({ length: 20 }, (_, index) => ({
    id: `scenario-${index}`,
    preconditions: Array.from({ length: 10 }, (_, rank) =>
      longPrecondition(`c${index}`, rank)
    ),
  }));
  const rollUp = preconditionPlanRefusal(
    planOf(saturated),
    NO_DECLARED_PRECONDITIONS,
    REPO
  );
  expect(rollUp).toBeDefined();
  const correction = `Plan rejected: ${rollUp} Return the complete corrected plan.`;
  expect(correction.length).toBeLessThan(CORRECTION_CHARS);
  expect(visible(correction)).toContain(
    `The trusted catalog declares nothing for ${REPO}`
  );
  expect(visible(correction)).toContain("is a step, not a precondition");
  expect(correction).toMatch(TRUNCATION);
});

it("keeps accepting preconditions the catalog declares", () => {
  const declared = declaredCatalog();
  const acceptance = structuredClone(measuredPlan());
  acceptance.scenarios[0]!.preconditions = ["role:member", "fixture:checkout"];
  acceptance.scenarios = [acceptance.scenarios[0]!];
  expect(preconditionRefusals(acceptance, declared, REPO)).toEqual([]);
  expect(preconditionPlanRefusal(acceptance, declared, REPO)).toBeUndefined();
});

/**
 * Les noms que la chaîne de prototypes rend présents dans tout objet. `in` et
 * l'indexation les déclaraient sans que le catalogue ne porte rien : un plan qui
 * écrivait `fixture:toString` traversait le gate et n'était arrêté qu'à
 * l'exécution, sur une variable d'environnement introuvable.
 */
const PROTOTYPE_NAMES = [
  "fixture:toString",
  "fixture:hasOwnProperty",
  "role:constructor",
  "role:__proto__",
];

it("refuses a precondition a prototype property would declare", () => {
  const acceptance = structuredClone(measuredPlan());
  acceptance.scenarios[0]!.preconditions = [...PROTOTYPE_NAMES];
  acceptance.scenarios = [acceptance.scenarios[0]!];
  const [refusal] = preconditionRefusals(
    acceptance,
    NO_DECLARED_PRECONDITIONS,
    REPO
  );
  expect(refusal?.error.code).toBe("PRECONDITION_UNVERIFIED");
  for (const name of PROTOTYPE_NAMES) {
    expect(refusal?.error.message).toContain(name);
  }
  // Aucun n'est devenu acceptable : le catalogue vide les refuse tous les quatre.
  expect(refusal?.error.message).not.toContain("is declared in the trusted");
  expect(
    preconditionPlanRefusal(acceptance, NO_DECLARED_PRECONDITIONS, REPO)
  ).toContain("Preconditions no scenario can satisfy");
});

it("refuses at execution the names a prototype property would declare", async () => {
  const file = await catalogFile({
    [REPO]: { roles: { member: "QA_ROLE_MEMBER" } },
  });
  for (const name of PROTOTYPE_NAMES) {
    const scenario = structuredClone(plan.scenarios[0]!);
    scenario.preconditions = [name];
    const error = (await refusal(scenario, file)) as QaError;
    expect(error.code, name).toBe("PRECONDITION_UNVERIFIED");
    // Le refus est celui du nom non déclaré, jamais celui d'une variable
    // introuvable : la propriété héritée n'a jamais été une déclaration.
    expect(error.message, name).toContain(
      "is not declared in the trusted catalog"
    );
    expect(error.message, name).not.toContain("is empty in this worker");
  }
  // Un nom réellement déclaré passe toujours, lui.
  const declaredScenario = structuredClone(plan.scenarios[0]!);
  declaredScenario.preconditions = ["role:member"];
  const declaredError = (await refusal(declaredScenario, file)) as QaError;
  expect(declaredError.message).toContain(
    "is declared in the trusted catalog but its variable QA_ROLE_MEMBER is empty in this worker"
  );
});

it("reads a real catalog file and lists the names it declares", async () => {
  const file = await catalogFile({
    [REPO]: {
      fixtures: {
        checkout: {
          cleanupUrl: "https://test-data.example.com/cleanup",
          description: "Create an isolated checkout cart",
          seedUrl: "https://test-data.example.com/seed",
          tokenEnv: "QA_FIXTURE_TOKEN",
        },
      },
      roles: { member: "QA_ROLE_MEMBER" },
    },
  });
  const catalog = trustedCatalog(
    await fixtureCatalog(loadConfig({ QA_FIXTURES_FILE: file }), REPO)
  );
  expect(catalog.roles).toEqual(["member"]);
  expect(catalog.fixtures).toEqual({
    checkout: "Create an isolated checkout cart",
  });
  // Un nom déclaré reste acceptable, y compris pour un scénario mesuré : le
  // refus ne vient jamais de la forme, seulement de l'absence de déclaration.
  const acceptance = structuredClone(measuredPlan());
  acceptance.scenarios[0]!.preconditions = ["role:member"];
  acceptance.scenarios = [acceptance.scenarios[0]!];
  expect(preconditionRefusals(acceptance, catalog, REPO)).toEqual([]);
});

it("refuses at execution a precondition no catalog backs, naming what exists", async () => {
  const file = await catalogFile({
    [REPO]: { roles: { member: "QA_ROLE_MEMBER" } },
  });
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.preconditions = ["role:Administrateur démo 1"];
  const error = await refusal(scenario, file);
  expect(error).toBeInstanceOf(QaError);
  expect((error as QaError).code).toBe("PRECONDITION_UNVERIFIED");
  expect(error.message).toContain(
    "Precondition role:Administrateur démo 1 is not declared in the trusted catalog"
  );
  expect(error.message).toContain(`declares this for ${REPO}: role:member`);
  expect(error.message).not.toContain("Role Administrateur démo 1 missing");
});

it("names the empty variable of a declared precondition", async () => {
  const file = await catalogFile({
    [REPO]: { roles: { member: "QA_ROLE_MEMBER" } },
  });
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.preconditions = ["role:member"];
  const error = await refusal(scenario, file);
  expect(error).toBeInstanceOf(QaError);
  expect(error.message).toContain(
    "is declared in the trusted catalog but its variable QA_ROLE_MEMBER is empty in this worker"
  );
  // Le remède nomme la variable, jamais sa valeur ; le nom seul ne dit rien du
  // secret qu'elle porte.
  expect((error as QaError).hint).toContain(
    "Set QA_ROLE_MEMBER for the worker"
  );
});
