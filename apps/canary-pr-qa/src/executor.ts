import { join } from "node:path";
import {
  assertionMatches,
  type Canary,
  compileAction,
  type Observation,
} from "./canary.js";
import type { Config } from "./config.js";
import { diagnose } from "./diagnostics.js";
import { EXECUTOR_PROMPT, type Model } from "./model.js";
import type { ProgressEvent } from "./progress.js";
import {
  type Decision,
  DecisionSchema,
  type Scenario,
  type ScenarioResult,
} from "./schema.js";

function finish(result: ScenarioResult) {
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
async function performDecision(
  sessionId: string,
  decision: Decision,
  index: number,
  result: ScenarioResult,
  preview: string,
  canary: Canary
) {
  const { action } = decision;
  const assertion =
    action.type === "assert"
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
    compileAction(action, preview, assertion)
  );
  result.steps.push({
    index,
    ...decision,
    ok: true,
    observation: JSON.stringify(observation),
  });
  if (assertion) {
    const passed = assertionMatches(assertion, observation.actual);
    result.assertions.push({
      id: assertion.id,
      passed,
      actual: observation.actual,
    });
    if (!passed) {
      result.outcome = "failed";
      result.error = `Assertion ${assertion.id} failed: ${assertion.description}`;
    }
  }
  return observation;
}
async function driveScenario(
  sessionId: string,
  result: ScenarioResult,
  preview: string,
  config: Config,
  canary: Canary,
  model: Model,
  record: (event: ProgressEvent) => Promise<void>
) {
  let observation: Observation = await canary.act(
    sessionId,
    "open-preview",
    compileAction({ type: "goto", path: preview }, preview)
  );
  let errors = 0;
  for (let index = 1; index <= config.QA_MAX_STEPS; index++) {
    const started = Date.now();
    await record({
      phase: "execution",
      scenarioId: result.scenario.id,
      step: index,
      action: "model-decision",
    });
    const decision = await model.json(
      EXECUTOR_PROMPT,
      {
        scenario: result.scenario,
        preview,
        observation,
        completedAssertions: result.assertions,
        history: result.steps.map((step) => ({
          ...step,
          observation: step.observation.slice(0, 1500),
        })),
        remainingSteps: config.QA_MAX_STEPS - index + 1,
      },
      DecisionSchema,
      config.QA_ACTION_MAX_TOKENS
    );
    if (decision.action.type === "blocked") {
      result.error = decision.action.explanation;
      await record({
        phase: "execution",
        scenarioId: result.scenario.id,
        step: index,
        action: "blocked",
        outcome: "blocked",
      });
      return;
    }
    if (decision.action.type === "finish") {
      finish(result);
      return;
    }
    await record({
      phase: "execution",
      scenarioId: result.scenario.id,
      step: index,
      action: decision.action.type,
    });
    try {
      observation = await performDecision(
        sessionId,
        decision,
        index,
        result,
        preview,
        canary
      );
      errors = 0;
      await record({
        phase: "execution",
        scenarioId: result.scenario.id,
        step: index,
        action: decision.action.type,
        outcome: result.outcome === "failed" ? "failed" : "ok",
        durationMs: Date.now() - started,
      });
    } catch (error) {
      const diagnostic = diagnose(error, config);
      result.steps.push({
        index,
        ...decision,
        ok: false,
        observation: diagnostic.message,
      });
      await record({
        phase: "execution",
        scenarioId: result.scenario.id,
        step: index,
        action: decision.action.type,
        outcome: "error",
        diagnostic,
      });
      errors++;
      if (decision.action.type === "assert" || errors >= 3) {
        throw error;
      }
      observation = await canary.act(
        sessionId,
        `${index}-recover-observation`,
        compileAction({ type: "observe" }, preview)
      );
    }
    if (result.outcome === "failed") {
      return;
    }
  }
  result.error =
    "Scenario exhausted its action budget without completing every assertion";
}
export async function executeScenario(
  scenario: Scenario,
  preview: string,
  root: string,
  config: Config,
  canary: Canary,
  model: Model,
  record: (event: ProgressEvent) => Promise<void> = async () =>
    Promise.resolve()
): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    scenario,
    outcome: "blocked",
    steps: [],
    assertions: [],
    artifacts: [],
  };
  try {
    result.sessionId = await canary.start(scenario.title);
    await driveScenario(
      result.sessionId,
      result,
      preview,
      config,
      canary,
      model,
      record
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
  await record({
    phase: "execution",
    scenarioId: scenario.id,
    outcome: result.outcome,
    diagnostic: result.diagnostic,
  });
  return result;
}
