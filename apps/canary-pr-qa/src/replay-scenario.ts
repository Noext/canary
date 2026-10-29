import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Canary } from "./canary.js";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import {
  executeScenario as execute,
  type executeScenario,
} from "./executor.js";
import { verifyPreviewUrl } from "./preview.js";
import { readReplayBundle } from "./replay.js";
import {
  type Plan,
  PlanSchema,
  type Preview,
  type Scenario,
} from "./schema.js";

/**
 * Rejeu **navigateur ciblé** : un seul scénario d'un plan conservé, exécuté sur
 * la preview qui sert le SHA du head historique. Aucun modèle n'est appelé, le
 * plan n'est pas régénéré, et les autres scénarios du plan ne sont pas joués.
 *
 * Le rejeu offline (`replay --mode gate`) reste le mode par défaut : il juge le
 * plan sans navigateur. Celui-ci existe pour les échecs qui ne se constatent
 * qu'à l'exécution — cible absente après navigation, transition à observer.
 */

/** Ce que le rejeu a réellement fait, pour l'artefact et la comparaison. */
export interface ReplayScenarioResult {
  /** Nombre de scénarios dans le plan conservé : les autres ne sont PAS joués. */
  planScenarios: number;
  preview: Preview;
  result: Awaited<ReturnType<typeof executeScenario>>;
  scenario: Scenario;
  scenarioId: string;
  /** Le head historique que la preview doit servir, vérifié avant interaction. */
  sha: string;
}

export type ScenarioExecutor = typeof executeScenario;

/**
 * Vérifie la cible avant toute interaction, puis joue le seul scénario demandé.
 *
 * L'ordre n'est pas négociable : `verifyPreviewUrl` applique la liste d'hôtes
 * autorisés (`PREVIEW_ALLOWED_HOSTS`) **et** exige le SHA complet du head
 * historique. Une preview qui a avancé, un hôte non autorisé ou un SHA tronqué
 * bloquent le rejeu avant qu'un seul clic ne parte.
 */
export async function replayScenario(input: {
  bundlePath: string;
  config: Config;
  /** Exécuteur injecté, pour les tests : jamais un mock en production. */
  execute?: ScenarioExecutor;
  /** Dossier des artefacts ; un dossier temporaire si absent. */
  root?: string;
  scenarioId: string;
}): Promise<ReplayScenarioResult> {
  const bundle = await readReplayBundle(input.bundlePath);
  const plan: Plan = PlanSchema.parse(bundle.plan);
  const scenario = plan.scenarios.find((item) => item.id === input.scenarioId);
  if (!scenario) {
    throw new QaError(
      "REPLAY_SCENARIO_MISSING",
      `Scenario ${input.scenarioId} is not in the stored plan`,
      `Pick one of: ${plan.scenarios.map((item) => item.id).join(", ")}`
    );
  }
  const preview = await verifyPreviewUrl(
    bundle.evidence.url,
    bundle.source.headSha,
    input.config
  );
  const root =
    input.root ?? (await mkdtemp(join(tmpdir(), "canary-replay-scenario-")));
  const run = input.execute ?? execute;
  const result = await run(
    scenario,
    preview.url,
    root,
    input.config,
    new Canary(input.config)
  );
  return {
    planScenarios: plan.scenarios.length,
    preview,
    result,
    scenario,
    scenarioId: input.scenarioId,
    sha: bundle.source.headSha,
  };
}
