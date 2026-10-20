import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import {
  fixtureCatalog,
  NO_DECLARED_PRECONDITIONS,
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

/** Le même plan mesuré, réduit à ce que le gate de préconditions lit. */
function measuredPlan(): Plan {
  const base = structuredClone(plan.scenarios[0]!);
  return {
    scenarios: LOT_W_PRECONDITIONS.map(({ id, preconditions }) => ({
      ...base,
      id,
      preconditions,
    })),
    skipped: [],
    summary: "rejeu du run 985c3de7",
  };
}
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
  expect((rollUp ?? "").length).toBeLessThan(2000);
});

it("keeps accepting preconditions the catalog declares", () => {
  const declared = declaredCatalog();
  const acceptance = structuredClone(measuredPlan());
  acceptance.scenarios[0]!.preconditions = ["role:member", "fixture:checkout"];
  acceptance.scenarios = [acceptance.scenarios[0]!];
  expect(preconditionRefusals(acceptance, declared, REPO)).toEqual([]);
  expect(preconditionPlanRefusal(acceptance, declared, REPO)).toBeUndefined();
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
