import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertionMatches,
  type Canary,
  compileAction,
  compileProbe,
  type Observation,
} from "./canary.js";
import type { Config } from "./config.js";
import { type Diagnostic, diagnose, QaError } from "./diagnostics.js";
import { prepareScenario } from "./fixtures.js";
import type { ProgressEvent } from "./progress.js";
import type { Assertion, Scenario, ScenarioResult } from "./schema.js";
import { compareVisual } from "./visual.js";

function finish(result: ScenarioResult) {
  if (result.contract?.completedSteps.length !== result.scenario.steps.length) {
    throw new QaError(
      "CONTRACT_INCOMPLETE",
      "AI attempted to finish before all planned assertions and required steps completed",
      "Execute the original ordered contract; do not omit actions or weaken assertions."
    );
  }
  if (
    !result.scenario.assertions.every((a) =>
      result.assertions.some((item) => item.id === a.id && item.passed)
    )
  ) {
    throw new Error(
      "AI attempted to finish before all planned assertions passed"
    );
  }
  result.outcome = "passed";
}
async function performStep(
  sessionId: string,
  step: Scenario["steps"][number],
  index: number,
  result: ScenarioResult,
  preview: string,
  canary: Canary,
  baselines: Map<string, unknown>,
  config: Config,
  repo: string
) {
  const { action } = step;
  const assertion =
    action.type === "assert" ||
    action.type === "download" ||
    action.type === "popup"
      ? result.scenario.assertions.find(
          (item) => item.id === action.assertionId
        )
      : undefined;
  if (
    action.type === "assert" &&
    result.assertions.some((item) => item.id === action.assertionId)
  ) {
    throw new Error("Assertion has already been evaluated");
  }
  const observation = await canary.act(
    sessionId,
    `${index}-${action.type}`,
    compileAction(
      action.type === "assert"
        ? {
            type: "assert",
            assertionId: action.assertionId,
            ...(assertion?.target ? { locator: assertion.target } : {}),
          }
        : action,
      preview,
      assertion
    )
  );

  if (assertion) {
    await evaluateAssertion(
      sessionId,
      assertion,
      observation,
      result,
      preview,
      canary,
      baselines,
      config,
      repo
    );
  }
  result.steps.push({
    index,
    stepId: step.id,
    reason: step.description,
    action,
    ok: true,
    observation: JSON.stringify(observation),
  });
}
/**
 * Relit la cible après le rechargement pour prouver une `persisted`. Une cible
 * qui disparaît entre la première lecture et cette relecture n'efface pas la
 * valeur déjà lue : c'est une régression réelle, enregistrée avec cette valeur
 * plutôt qu'annoncée comme une cible « jamais apparue ».
 */
async function readPersisted(
  sessionId: string,
  assertion: Assertion,
  observation: Observation,
  result: ScenarioResult,
  preview: string,
  canary: Canary,
  config: Config,
  baseline: unknown
): Promise<{ handled: true } | { handled: false; persisted: unknown }> {
  try {
    const persisted = (
      await canary.act(
        sessionId,
        `persistence-${assertion.id}`,
        compileProbe(assertion, preview, true)
      )
    ).actual;
    return { handled: false, persisted };
  } catch (error) {
    const diagnostic = diagnose(error, config);
    if (
      diagnostic.code !== "TARGET_NOT_FOUND" ||
      observation.actual === undefined
    ) {
      throw error;
    }
    result.assertions.push({
      id: assertion.id,
      passed: false,
      actual: observation.actual,
      baseline,
    });
    result.outcome = "failed";
    result.diagnostic = diagnostic;
    result.error = `Assertion ${assertion.id} failed: the value read before the reload (${JSON.stringify(observation.actual)}) is no longer present in the target after it — persistence is not demonstrated — ${diagnostic.message}`;
    return { handled: true };
  }
}
async function evaluateAssertion(
  sessionId: string,
  assertion: Assertion,
  observation: Observation,
  result: ScenarioResult,
  preview: string,
  canary: Canary,
  baselines: Map<string, unknown>,
  config: Config,
  repo: string
) {
  const baseline = baselines.get(assertion.id);
  let persisted: unknown;
  if (assertion.verification === "persisted") {
    const probe = await readPersisted(
      sessionId,
      assertion,
      observation,
      result,
      preview,
      canary,
      config,
      baseline
    );
    if (probe.handled) {
      return;
    }
    persisted = probe.persisted;
  }
  const actual =
    assertion.kind === "visual"
      ? await compareVisual(
          observation.actual,
          assertion.expected,
          repo,
          config
        )
      : observation.actual;
  const verification = assertion.verification ?? "state";
  const passed =
    (assertion.kind === "visual"
      ? (actual as { passed: boolean }).passed
      : assertionMatches(assertion, actual)) &&
    (!["transition", "persisted"].includes(verification) ||
      (baselines.has(assertion.id) &&
        !isDeepStrictEqual(baseline, observation.actual))) &&
    (verification !== "persisted" || assertionMatches(assertion, persisted));
  // A transition whose value did not change proves nothing: the element may be
  // broken or invariant, and the identical baseline cannot tell the two apart.
  const unchanged =
    ["transition", "persisted"].includes(verification) &&
    baselines.has(assertion.id) &&
    isDeepStrictEqual(baseline, observation.actual);
  if (assertion.kind === "visual") {
    observation.actual = actual;
  }
  result.assertions.push({
    id: assertion.id,
    passed,
    actual,
    baseline,
    persisted,
  });
  if (!passed) {
    result.outcome = "failed";
    if (unchanged) {
      // Naming the missing transition, not recopying the assertion description:
      // "the element still shows X" reads as a regression while actual and
      // baseline agree, and sends the operator after an innocent element.
      result.diagnostic = diagnose(
        new QaError(
          "TRANSITION_NOT_OBSERVED",
          `Assertion ${assertion.id}: no change observed — the value after step ${assertion.afterStep ?? "the interaction"} is identical to the baseline probed before it, so the required ${verification} is not demonstrated`,
          `Require a change only from a value that must change. For an invariance after an interaction, use verification "state" with afterStep set to the interaction step (the element is still there after clicking X).`
        ),
        config
      );
      result.error = result.diagnostic.message;
    } else {
      result.error = `Assertion ${assertion.id} failed: ${assertion.description}`;
    }
  }
}
async function captureBaselines(
  sessionId: string,
  scenario: Scenario,
  stepId: string | undefined,
  baselines: Map<string, unknown>,
  preview: string,
  canary: Canary
) {
  for (const assertion of scenario.assertions) {
    if (
      assertion.afterStep === stepId &&
      ["transition", "persisted"].includes(assertion.verification) &&
      !baselines.has(assertion.id)
    ) {
      const observation = await canary.act(
        sessionId,
        `baseline-${assertion.id}`,
        compileProbe(assertion, preview)
      );
      baselines.set(assertion.id, observation.actual);
    }
  }
}
/**
 * Une cible qui n'apparaît jamais est une promesse non tenue, pas une panne :
 * un `assert` affirme qu'un élément existe, donc son échec est une assertion
 * fausse et le scénario échoue. Un clic dont la même cible ne résout jamais
 * reste une panne d'exécution (`false`) : l'action n'a pas atteint son but.
 */
function failAssertionOnMissingTarget(
  result: ScenarioResult,
  step: Scenario["steps"][number],
  diagnostic: Diagnostic,
  baselines: Map<string, unknown>
): boolean {
  if (step.action.type !== "assert" || diagnostic.code !== "TARGET_NOT_FOUND") {
    return false;
  }
  const { assertionId } = step.action;
  if (!result.assertions.some((item) => item.id === assertionId)) {
    result.assertions.push({
      id: assertionId,
      passed: false,
      actual: undefined,
      baseline: baselines.get(assertionId),
    });
  }
  result.outcome = "failed";
  result.diagnostic = diagnostic;
  result.error = `Assertion ${assertionId} failed: the target never appeared — ${diagnostic.message}`;
  return true;
}
async function driveScenario(
  sessionId: string,
  result: ScenarioResult,
  preview: string,
  config: Config,
  canary: Canary,
  record: (event: ProgressEvent) => Promise<void>,
  repo: string
) {
  await canary.act(
    sessionId,
    "open-preview",
    compileAction({ type: "goto", path: preview }, preview)
  );
  const baselines = new Map<string, unknown>();
  // Le plan est un contrat figé : l'hôte joue chaque étape dans l'ordre, sans
  // consulter le modèle. Une cible que l'IA choisirait autrement n'existe plus,
  // et aucun jeton d'exécution n'est dépensé pour recopier le plan.
  for (const [offset, step] of result.scenario.steps.entries()) {
    const index = offset + 1;
    const started = Date.now();
    await captureBaselines(
      sessionId,
      result.scenario,
      step.action.type === "observe" ? undefined : step.id,
      baselines,
      preview,
      canary
    );
    await record({
      phase: "execution",
      scenarioId: result.scenario.id,
      step: index,
      action: step.action.type,
    });
    try {
      await performStep(
        sessionId,
        step,
        index,
        result,
        preview,
        canary,
        baselines,
        config,
        repo
      );
      if (step.action.type !== "observe") {
        result.contract?.completedSteps.push(step.id);
      }
      await record({
        phase: "execution",
        scenarioId: result.scenario.id,
        step: index,
        action: step.action.type,
        outcome: result.outcome === "failed" ? "failed" : "ok",
        durationMs: Date.now() - started,
      });
    } catch (error) {
      const diagnostic = diagnose(error, config);
      result.steps.push({
        index,
        stepId: step.id,
        action: step.action,
        ok: false,
        reason: diagnostic.message,
        observation: diagnostic.message,
      });
      await record({
        phase: "execution",
        scenarioId: result.scenario.id,
        step: index,
        action: step.action.type,
        outcome: "error",
        diagnostic,
      });
      // Le verdict et l'erreur nommée sont déjà posés : renvoyer ici évite que
      // le catch de `executeScenario` les remplace par le message brut.
      if (failAssertionOnMissingTarget(result, step, diagnostic, baselines)) {
        return;
      }
      throw error;
    }
    if (result.outcome === "failed") {
      return;
    }
  }
  finish(result);
}
export async function executeScenario(
  scenario: Scenario,
  preview: string,
  root: string,
  config: Config,
  canary: Canary,
  record: (event: ProgressEvent) => Promise<void> = async () =>
    Promise.resolve(),
  repo = ""
): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    scenario,
    outcome: "blocked",
    steps: [],
    assertions: [],
    artifacts: [],
    contract: {
      completedSteps: [],
      totalSteps: scenario.steps.length,
      hash: createHash("sha256").update(JSON.stringify(scenario)).digest("hex"),
    },
  };
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const prepared = await prepareScenario(scenario, repo, config);
    cleanup = prepared.cleanup;
    result.sessionId = await canary.start(scenario.title, prepared.auth);
    await driveScenario(
      result.sessionId,
      result,
      preview,
      config,
      canary,
      record,
      repo
    );
  } catch (error) {
    result.diagnostic = diagnose(error, config);
    result.error = result.diagnostic.message;
  } finally {
    if (result.sessionId) {
      try {
        await record({ phase: "evidence", scenarioId: scenario.id });
        result.artifacts = await canary.end(
          result.sessionId,
          join(root, scenario.id)
        );
      } catch (error) {
        result.outcome = "blocked";
        result.diagnostic = diagnose(error, config);
        result.error = `${result.error ?? ""} Evidence finalization: ${result.diagnostic.message}`;
        await canary.abort(result.sessionId);
      }
    }
  }
  try {
    await cleanup?.();
  } catch (error) {
    result.outcome = "blocked";
    result.diagnostic = diagnose(error, config);
    result.error = `Fixture cleanup failed: ${result.diagnostic.message}`;
  }
  await record({
    phase: "execution",
    scenarioId: scenario.id,
    outcome: result.outcome,
    diagnostic: result.diagnostic,
  });
  return result;
}
