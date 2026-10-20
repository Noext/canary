import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type BrowserAuth, BrowserAuthSchema } from "@usecanary/protocol";
import { z } from "zod";
import {
  cookieDomainAllowed,
  hostAllowed,
} from "../../canary-daemon/src/network-policy.js";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import { fetchText } from "./http.js";
import { runScope } from "./run-scope.js";
import type { Plan, Scenario } from "./schema.js";

const schema = z.record(
  z
    .object({
      roles: z.record(z.string()).default({}),
      visuals: z.record(z.string()).default({}),
      visualTolerance: z.number().min(0).max(0.1).default(0.001),
      fixtures: z
        .record(
          z.object({
            seedUrl: z.string().url(),
            cleanupUrl: z.string().url(),
            tokenEnv: z.string(),
            description: z.string(),
          })
        )
        .default({}),
    })
    .strict()
);
type CatalogEntry = z.infer<typeof schema>[string];
/**
 * Le catalogue tel qu'il est remis au planificateur : les noms déclarés, jamais
 * une valeur. Une précondition n'est satisfiable que si son nom y figure, donc
 * c'est cette liste qui est rendue au plan et citée par un refus.
 */
export interface TrustedCatalog {
  fixtures: Record<string, string>;
  roles: string[];
  visuals: string[];
}
export async function fixtureCatalog(
  config: Config,
  repo: string
): Promise<CatalogEntry> {
  const all = config.QA_FIXTURES_FILE
    ? schema.parse(JSON.parse(await readFile(config.QA_FIXTURES_FILE, "utf8")))
    : {};
  return (
    all[repo.toLowerCase()] ?? {
      roles: {},
      fixtures: {},
      visuals: {},
      visualTolerance: 0.001,
    }
  );
}
export function trustedCatalog(catalog: CatalogEntry): TrustedCatalog {
  return {
    fixtures: Object.fromEntries(
      Object.entries(catalog.fixtures).map(([name, fixture]) => [
        name,
        fixture.description,
      ])
    ),
    roles: Object.keys(catalog.roles),
    visuals: Object.keys(catalog.visuals),
  };
}
/**
 * Un catalogue vide est l'état réel de la production mesuré sur le run
 * 985c3de7 : `QA_FIXTURES_FILE` non défini, donc aucune précondition exécutable.
 * Il sert aussi de défaut aux appels qui n'ont pas de catalogue à portée : ils
 * refusent alors toute précondition au lieu d'en supposer une satisfaite.
 */
export const NO_DECLARED_PRECONDITIONS: TrustedCatalog = {
  fixtures: {},
  roles: [],
  visuals: [],
};
/**
 * Le remède d'une précondition non satisfiable. Le run 985c3de7 s'est arrêté six
 * fois sur « Role Administrateur démo 1 missing » : le refus nommait le nom
 * fautif, jamais ce que le catalogue portait, ni que la bascule de profil
 * observée dans la page se conduit par une étape. Le catalogue est la seule
 * source de préconditions, et un choix que la page offre déjà n'en est pas une.
 */
const PRECONDITION_REMEDY =
  "Only a declared precondition can be satisfied: fixture:name seeds isolated data through a controlled endpoint, role:name loads a stored browser state through an environment variable the operator sets, and an undeclared name has neither behind it. A choice the page itself offers — selected profile, active pharmacy, dropdown option — is a step, not a precondition: drop it from preconditions and drive that control with select or click, then let an assertion prove the switch.";
/** Borne des noms cités : un refus reste lisible et la correction du planificateur est tronquée à 2000 caractères. */
const DECLARED_LISTED = 12;
const SCENARIOS_LISTED = 6;
const CONDITIONS_LISTED = 3;
function declaredPreconditionNames(catalog: TrustedCatalog): string[] {
  return [
    ...Object.keys(catalog.fixtures).map((name) => `fixture:${name}`),
    ...catalog.roles.map((name) => `role:${name}`),
  ];
}
function listedDeclared(catalog: TrustedCatalog, repo: string): string {
  const declared = declaredPreconditionNames(catalog);
  if (declared.length === 0) {
    return `The trusted catalog declares nothing for ${repo}: no precondition can run until QA_FIXTURES_FILE declares one.`;
  }
  const listed = declared.slice(0, DECLARED_LISTED);
  const rest = declared.length - listed.length;
  return `The trusted catalog declares this for ${repo}: ${listed.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}.`;
}
/**
 * Les préconditions qu'un scénario déclare sans que le catalogue les porte :
 * nom absent, ou forme qui n'est ni `fixture:name` ni `role:name`. Le nom est
 * rendu tel que le plan l'écrit — c'est lui que le planificateur doit corriger.
 */
function unbackedConditions(
  scenario: Scenario,
  catalog: TrustedCatalog
): string[] {
  return scenario.preconditions.filter((condition) => {
    if (condition.startsWith("fixture:")) {
      return !(condition.slice(8) in catalog.fixtures);
    }
    if (condition.startsWith("role:")) {
      return !catalog.roles.includes(condition.slice(5));
    }
    return true;
  });
}
/**
 * Le refus, par scénario, d'une précondition que le catalogue ne porte pas. Il
 * bloque le scénario avant la première étape navigateur et nomme ce qui existe.
 */
export function preconditionRefusals(
  plan: Plan,
  catalog: TrustedCatalog,
  repo: string
): { error: QaError; scenario: Scenario }[] {
  const declared = listedDeclared(catalog, repo);
  const refusals: { error: QaError; scenario: Scenario }[] = [];
  for (const scenario of plan.scenarios) {
    const offenders = unbackedConditions(scenario, catalog);
    if (offenders.length === 0) {
      continue;
    }
    refusals.push({
      scenario,
      error: new QaError(
        "PRECONDITION_UNVERIFIED",
        `Scenario ${scenario.id} declares preconditions this run cannot satisfy: ${offenders.join(", ")}. ${declared}`,
        PRECONDITION_REMEDY
      ),
    });
  }
  return refusals;
}
/**
 * Le même défaut, rassemblé en une ligne pour le planificateur : six scénarios
 * bloqués par la même précondition ne doivent pas remplir à eux seuls les 2000
 * caractères de la correction et faire disparaître les autres refus.
 */
export function preconditionPlanRefusal(
  plan: Plan,
  catalog: TrustedCatalog,
  repo: string
): string | undefined {
  const offenders = plan.scenarios
    .map((scenario) => ({
      conditions: unbackedConditions(scenario, catalog),
      id: scenario.id,
    }))
    .filter((entry) => entry.conditions.length > 0);
  if (offenders.length === 0) {
    return;
  }
  const listed = offenders.slice(0, SCENARIOS_LISTED).map((entry) => {
    const shown = entry.conditions.slice(0, CONDITIONS_LISTED);
    const rest = entry.conditions.length - shown.length;
    return `${entry.id} (${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""})`;
  });
  const rest = offenders.length - listed.length;
  return `Preconditions no scenario can satisfy: ${listed.join(" ; ")}${rest > 0 ? ` ; +${rest} more scenarios` : ""}. ${listedDeclared(catalog, repo)} ${PRECONDITION_REMEDY}`;
}
export async function prepareScenario(
  scenario: Scenario,
  repo: string,
  config: Config
): Promise<{
  auth?: BrowserAuth;
  cleanup: () => Promise<void>;
  namespace: string;
}> {
  const catalog = await fixtureCatalog(config, repo);
  const trusted = trustedCatalog(catalog);
  const namespace = `${runScope.getStore()?.id ?? randomUUID()}-${scenario.id}`;
  const seeded: string[] = [];
  let auth: BrowserAuth | undefined;
  async function call(name: string, cleanup = false) {
    const entry = catalog.fixtures[name];
    if (!entry) {
      throw unbackedPrecondition(`fixture:${name}`, trusted, repo);
    }
    const token = process.env[entry.tokenEnv];
    if (!token) {
      throw unbackedStorageState(`fixture:${name}`, entry.tokenEnv);
    }
    await fetchText(cleanup ? entry.cleanupUrl : entry.seedUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `${namespace}:${cleanup ? "cleanup" : "seed"}`,
      },
      body: JSON.stringify({ namespace, scenario: scenario.id }),
    });
  }
  const cleanup = async () => {
    for (const name of seeded.reverse()) {
      await runScope.exit(() => call(name, true));
    }
  };
  try {
    for (const condition of scenario.preconditions) {
      if (condition.startsWith("fixture:")) {
        const name = condition.slice(8);
        await call(name);
        seeded.push(name);
        continue;
      }
      if (condition.startsWith("role:")) {
        const name = condition.slice(5);
        const env = catalog.roles[name];
        if (!env) {
          throw unbackedPrecondition(condition, trusted, repo);
        }
        if (!process.env[env]) {
          throw unbackedStorageState(condition, env);
        }
        auth = BrowserAuthSchema.parse(JSON.parse(process.env[env] ?? ""));
        validateAuth(auth, config);
        continue;
      }
      throw unbackedPrecondition(condition, trusted, repo);
    }
    return { auth, cleanup, namespace };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
/**
 * Le nom n'est pas dans le catalogue : rien ne peut le satisfaire. Le refus
 * nomme ce que le catalogue porte et le remède, au lieu du seul nom fautif.
 */
function unbackedPrecondition(
  condition: string,
  catalog: TrustedCatalog,
  repo: string
): QaError {
  return new QaError(
    "PRECONDITION_UNVERIFIED",
    `Precondition ${condition} is not declared in the trusted catalog. ${listedDeclared(catalog, repo)}`,
    PRECONDITION_REMEDY
  );
}
/**
 * Le nom est déclaré, mais la variable qui porte son état est vide dans ce
 * worker : c'est un défaut d'exploitation, pas de plan. La variable est un nom,
 * jamais une valeur, et le remède nomme la seule action possible.
 */
function unbackedStorageState(condition: string, env: string): QaError {
  return new QaError(
    "PRECONDITION_UNVERIFIED",
    `Precondition ${condition} is declared in the trusted catalog but its variable ${env} is empty in this worker.`,
    `Set ${env} for the worker, or remove ${condition} from the plan. The catalog entry exists; only its state is missing.`
  );
}
function validateAuth(auth: BrowserAuth, config: Config) {
  // A cookie carries no port, and one scoped to a parent domain is precisely
  // what a preview subdomain receives: `cookieDomainAllowed` accepts the base
  // domain of a `*.preview.example.com` entry for that reason.
  if (
    auth.cookies.some(
      (c) =>
        !cookieDomainAllowed(c.domain.replace(/^\./, ""), config.allowedHosts)
    )
  ) {
    throw new Error("Auth cookie domain outside approved previews");
  }
  if (
    auth.origins.some(
      (o) => !hostAllowed(new URL(o.origin), config.allowedHosts)
    )
  ) {
    throw new Error("Auth localStorage origin outside approved previews");
  }
}
