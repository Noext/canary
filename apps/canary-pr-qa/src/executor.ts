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
import { diagnose, QaError } from "./diagnostics.js";
import { prepareScenario } from "./fixtures.js";
import { EXECUTOR_PROMPT, type Model } from "./model.js";
import type { ProgressEvent } from "./progress.js";
import {
  type Assertion,
  type Decision,
  DecisionSchema,
  type Scenario,
  type ScenarioResult,
} from "./schema.js";
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
async function performDecision(
  sessionId: string,
  decision: Decision,
  index: number,
  result: ScenarioResult,
  preview: string,
  canary: Canary,
  baselines: Map<string, unknown>,
  config: Config,
  repo: string
) {
  const { action } = decision;
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
    ...decision,
    ok: true,
    observation: JSON.stringify(observation),
  });
  return observation;
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
    persisted = (
      await canary.act(
        sessionId,
        `persistence-${assertion.id}`,
        compileProbe(assertion, preview, true)
      )
    ).actual;
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
function ensureContractDecision(
  decision: Decision,
  required: Scenario["steps"][number] | undefined
) {
  if (decision.action.type === "observe") {
    return;
  }
  if (
    !required ||
    decision.stepId !== required.id ||
    !isDeepStrictEqual(decision.action, required.action)
  ) {
    throw new QaError(
      "CONTRACT_VIOLATION",
      "AI action differs from the next required contract step",
      "Targets, values, actions and ordering are immutable. A blocked scenario cannot be repaired by selecting unrelated matching text."
    );
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
async function driveScenario(
  sessionId: string,
  result: ScenarioResult,
  preview: string,
  config: Config,
  canary: Canary,
  model: Model,
  record: (event: ProgressEvent) => Promise<void>,
  repo: string
) {
  let observation: Observation = await canary.act(
    sessionId,
    "open-preview",
    compileAction({ type: "goto", path: preview }, preview)
  );
  const baselines = new Map<string, unknown>();
  for (let index = 1; index <= config.QA_MAX_STEPS; index++) {
    const started = Date.now();
    await record({
      phase: "execution",
      scenarioId: result.scenario.id,
      step: index,
      action: "model-decision",
    });
    const required =
      result.scenario.steps[result.contract?.completedSteps.length ?? 0];
    const decision = await model.json(
      EXECUTOR_PROMPT,
      {
        scenario: result.scenario,
        nextRequiredStep: required ?? null,
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
    ensureContractDecision(decision, required);
    await captureBaselines(
      sessionId,
      result.scenario,
      decision.action.type === "observe" ? undefined : required?.id,
      baselines,
      preview,
      canary
    );
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
        canary,
        baselines,
        config,
        repo
      );
      if (decision.action.type !== "observe" && required) {
        result.contract?.completedSteps.push(required.id);
      }
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
      throw error;
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
      model,
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
