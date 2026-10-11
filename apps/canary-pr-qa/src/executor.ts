import { join } from "node:path";
import {
  assertionMatches,
  type Canary,
  compileAction,
  type Observation,
} from "./canary.js";
import type { Config } from "./config.js";
import { EXECUTOR_PROMPT, type Model } from "./model.js";
import {
  type Decision,
  DecisionSchema,
  type Scenario,
  type ScenarioResult,
} from "./schema.js";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
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
  model: Model
) {
  let observation: Observation = await canary.act(
    sessionId,
    "open-preview",
    compileAction({ type: "goto", path: preview }, preview)
  );
  let errors = 0;
  for (let index = 1; index <= config.QA_MAX_STEPS; index++) {
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
      1800
    );
    if (decision.action.type === "blocked") {
      result.error = decision.action.explanation;
      return;
    }
    if (decision.action.type === "finish") {
      finish(result);
      return;
    }
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
    } catch (error) {
      result.steps.push({
        index,
        ...decision,
        ok: false,
        observation: message(error),
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
  model: Model
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
      model
    );
  } catch (error) {
    result.error = message(error);
  } finally {
    if (result.sessionId) {
      try {
        result.artifacts = await canary.end(
          result.sessionId,
          join(root, scenario.id)
        );
      } catch (error) {
        result.outcome = "blocked";
        result.error = `${result.error ?? ""} Evidence finalization: ${message(error)}`;
        await canary.abort(result.sessionId);
      }
    }
  }
  return result;
}
