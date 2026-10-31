import { assertionMatches, type Canary, compileProbe } from "./canary.js";
import type { Config } from "./config.js";
import { diagnose } from "./diagnostics.js";
import { durableWriteClaimed } from "./durable-write.js";
import type {
  Assertion,
  Scenario,
  ScenarioResult,
  SourceLineMaterial,
} from "./schema.js";
import { captureBaselines } from "./step-outcome.js";

/**
 * Une `persisted` jugée à la RÉENTRÉE plutôt qu'après un rechargement.
 *
 * Sans écriture durable dans le diff (voir `durable-write.ts`), la persistance
 * qu'un scénario peut prouver est celle de la vue qu'on quitte puis qu'on
 * retrouve. Le jugement à la réentrée n'est accordé que sur preuve mesurée,
 * jamais sur la seule forme du plan :
 *
 * - le plan joue un aller-retour : l'étape d'ancrage (`afterStep`) est une
 *   navigation — `goto` ou clic qui n'est pas `ifPresent` — et l'étape qui la
 *   précède immédiatement, le départ, en est une aussi, après au moins une
 *   étape qui a pu produire l'état ; entre le retour et la lecture de
 *   l'assertion, le plan ne joue que des lectures ;
 * - juste avant le départ, la cible montre DÉJÀ la valeur attendue : l'état
 *   existait avant qu'on quitte la vue ;
 * - juste avant le retour (la valeur d'avant de l'ancre), la cible est absente
 *   — ou invisible pour une assertion `visible` : la vue a bien été quittée ;
 * - après le retour, la valeur attendue est relue et diffère de cette valeur
 *   d'avant, comme pour une `transition`.
 *
 * La réentrée n'est jamais accordée sans oracle de base
 * (`QA_BASELINE_URL_TEMPLATE`), ni pour un scénario à fixtures que la base ne
 * rejoue pas : une PR peut casser une persistance existante dont l'appel de
 * stockage est hors du diff (`setItems(loadCart())` devenu `setItems([])`).
 * Sans base, le rechargement reste la règle, comme sur main. Avec base, la
 * page est EN PLUS rechargée et relue en fin de scénario
 * (`readReloaded`) : ce relevé ne décide rien de ce côté, la
 * comparaison à la base le juge (`reload-oracle.ts`).
 *
 * Un plan qui parle de rechargement, ou un scénario `regression`, garde le
 * rechargement. Seuls les kinds `text`, `value` et `visible` ont une absence
 * lisible. Dans tous les autres cas, rien ne change : la page est rechargée
 * et relue. Le résultat publie « reload persistence not claimed » sur chaque
 * assertion jugée ainsi.
 */
const REENTRY_KINDS = new Set(["text", "value", "visible"]);
const RELOAD_WORDING = /reload|refresh|recharg|rafra[iî]ch|actualis|\bF5\b/i;
const departures = new WeakMap<ScenarioResult, Map<string, unknown>>();

function navigation(step: Scenario["steps"][number] | undefined): boolean {
  return (
    step?.action.type === "goto" ||
    (step?.action.type === "click" && step.action.ifPresent !== true)
  );
}

/** L'étape de départ de l'aller-retour, quand l'assertion peut en relever. */
function leaveStepOf(
  scenario: Scenario,
  assertion: Assertion
): string | undefined {
  // Un scénario `regression` déclare inchangée une persistance qui existe
  // déjà : une PR qui casse sa relecture (hydratation, restauration) sans
  // mot-clé d'écriture doit toujours être rechargée, comme sur la base.
  if (
    scenario.kind === "regression" ||
    assertion.verification !== "persisted" ||
    !REENTRY_KINDS.has(assertion.kind) ||
    RELOAD_WORDING.test(JSON.stringify(scenario))
  ) {
    return;
  }
  const anchor = scenario.steps.findIndex(
    (step) => step.id === assertion.afterStep
  );
  const leave = scenario.steps[anchor - 1];
  // Entre le retour et la lecture, rien ne doit pouvoir réécrire la valeur :
  // seules des lectures (`assert`, `observe`) y sont admises.
  const read = scenario.steps.findIndex(
    (step) =>
      step.action.type === "assert" && step.action.assertionId === assertion.id
  );
  const rewritten = scenario.steps
    .slice(anchor + 1, read)
    .some((step) => !["assert", "observe"].includes(step.action.type));
  if (
    anchor < 2 ||
    read <= anchor ||
    rewritten ||
    !navigation(scenario.steps[anchor]) ||
    !navigation(leave)
  ) {
    return;
  }
  return leave?.id;
}

/**
 * Vrai quand une base rejouera ce scénario : seule elle peut dire si la
 * persistance après rechargement existait avant la PR. Un scénario à fixtures
 * n'est pas rejoué sur la base (`runner.ts`).
 */
function baseReplays(config: Config, scenario: Scenario): boolean {
  return (
    Boolean(config.QA_BASELINE_URL_TEMPLATE) &&
    !scenario.preconditions.some((item) => item.startsWith("fixture:"))
  );
}

/**
 * Les relevés d'avant-étape : la valeur d'avant de `captureBaselines`, puis,
 * avant une étape de départ, la valeur que la vue montre encore. Une sonde de
 * départ en échec ne laisse aucun relevé : l'assertion est alors rechargée,
 * jamais jugée à la réentrée.
 */
export async function captureReadings(input: {
  baselines: Map<string, unknown>;
  canary: Canary;
  config: Config;
  material: SourceLineMaterial[];
  preview: string;
  result: ScenarioResult;
  sessionId: string;
  stepId: string | undefined;
}) {
  const { canary, preview, result, sessionId, stepId } = input;
  await captureBaselines(
    sessionId,
    result.scenario,
    stepId,
    input.baselines,
    preview,
    canary
  );
  if (
    stepId === undefined ||
    !baseReplays(input.config, result.scenario) ||
    durableWriteClaimed(input.material)
  ) {
    return;
  }
  for (const assertion of result.scenario.assertions) {
    if (leaveStepOf(result.scenario, assertion) !== stepId) {
      continue;
    }
    try {
      const observation = await canary.act(
        sessionId,
        `departure-${assertion.id}`,
        compileProbe(assertion, preview)
      );
      const read = departures.get(result) ?? new Map<string, unknown>();
      read.set(assertion.id, observation.actual);
      departures.set(result, read);
    } catch {
      // Cible illisible avant le départ : aucune preuve d'aller-retour, le
      // rechargement reste la règle.
    }
  }
}

/**
 * La preuve d'aller-retour de l'assertion, quand elle est complète : la valeur
 * attendue était là avant le départ, et la cible avait disparu avant le retour.
 * `undefined` garde la relecture après rechargement.
 */
export function reentryEvidence(
  result: ScenarioResult,
  assertion: Assertion,
  baseline: unknown
): { reloadPersistence: "not-claimed" } | undefined {
  const read = departures.get(result);
  if (!read?.has(assertion.id)) {
    return;
  }
  const left =
    baseline === null || (assertion.kind === "visible" && baseline === false);
  return left && assertionMatches(assertion, read.get(assertion.id))
    ? { reloadPersistence: "not-claimed" }
    : undefined;
}

/**
 * Recharge la page et relit la cible de chaque assertion jugée à la réentrée,
 * une fois le scénario joué : relire au milieu du scénario effacerait l'état en
 * mémoire que les étapes suivantes lisent encore. Le relevé est consigné sur
 * l'assertion (`reloadReading`, `reloadPassed`) sans toucher à l'issue : la
 * base, qui joue le même plan, fait le même relevé, et la comparaison les
 * confronte. Une cible absente après rechargement est un relevé en échec ; une
 * autre erreur ne laisse aucun relevé, que la comparaison tient pour non
 * prouvé, jamais pour passé.
 */
export async function readReloaded(
  result: ScenarioResult,
  preview: string,
  canary: Canary,
  config: Config
) {
  const sessionId = result.sessionId ?? "";
  for (const entry of result.assertions) {
    const assertion = result.scenario.assertions.find(
      (item) => item.id === entry.id
    );
    if (entry.reloadPersistence !== "not-claimed" || assertion === undefined) {
      continue;
    }
    try {
      const { actual } = await canary.act(
        sessionId,
        `reload-${assertion.id}`,
        compileProbe(assertion, preview, true)
      );
      entry.reloadReading = actual;
      entry.reloadPassed = assertionMatches(assertion, actual);
    } catch (error) {
      if (diagnose(error, config).code === "TARGET_NOT_FOUND") {
        entry.reloadPassed = false;
      }
    }
  }
}
