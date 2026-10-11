import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
const locator = z.discriminatedUnion("by", [
  z.object({ by: z.literal("css"), value: text }).strict(),
  z.object({ by: z.literal("role"), value: text, name: text }).strict(),
  z.object({ by: z.literal("text"), value: text }).strict(),
  z.object({ by: z.literal("label"), value: text }).strict(),
  z.object({ by: z.literal("placeholder"), value: text }).strict(),
  z.object({ by: z.literal("testId"), value: text }).strict(),
]);
const assertionBase = {
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  description: text,
};
export const AssertionSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...assertionBase, kind: z.literal("text"), expected: text })
    .strict(),
  z
    .object({
      ...assertionBase,
      kind: z.literal("value"),
      expected: z.string().max(2000),
    })
    .strict(),
  z
    .object({ ...assertionBase, kind: z.literal("url"), expected: text })
    .strict(),
  z
    .object({
      ...assertionBase,
      kind: z.literal("count"),
      expected: z.number().int().min(0).max(10_000),
    })
    .strict(),
  z.object({ ...assertionBase, kind: z.literal("visible") }).strict(),
  z.object({ ...assertionBase, kind: z.literal("hidden") }).strict(),
]);
export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    title: text,
    rationale: text,
    kind: z.enum(["happy_path", "edge_case", "regression"]),
    sourceFiles: z.array(text).min(1).max(30),
    preconditions: z.array(text).max(10),
    steps: z.array(text).min(1).max(20),
    assertions: z.array(AssertionSchema).min(1).max(10),
  })
  .strict();
export const PlanSchema = z
  .object({
    summary: text,
    scenarios: z.array(ScenarioSchema).max(20),
    skipped: z
      .array(z.object({ sourceFile: text, reason: text }).strict())
      .max(100),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const ids = plan.scenarios.map((scenario) => scenario.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "Duplicate scenario ids" });
    }
    for (const scenario of plan.scenarios) {
      const assertionIds = scenario.assertions.map((assertion) => assertion.id);
      if (new Set(assertionIds).size !== assertionIds.length) {
        ctx.addIssue({ code: "custom", message: "Duplicate assertion ids" });
      }
    }
  });
const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("observe") }).strict(),
  z.object({ type: z.literal("goto"), path: text }).strict(),
  z.object({ type: z.literal("click"), locator }).strict(),
  z
    .object({ type: z.literal("fill"), locator, value: z.string().max(2000) })
    .strict(),
  z.object({ type: z.literal("press"), locator, key: text }).strict(),
  z.object({ type: z.literal("select"), locator, value: text }).strict(),
  z
    .object({ type: z.literal("check"), locator, checked: z.boolean() })
    .strict(),
  z
    .object({
      type: z.literal("assert"),
      assertionId: text,
      locator: locator.optional(),
    })
    .strict(),
  z.object({ type: z.literal("finish") }).strict(),
  z.object({ type: z.literal("blocked"), explanation: text }).strict(),
]);
export const DecisionSchema = z.object({ reason: text, action }).strict();
export type Plan = z.infer<typeof PlanSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;
export type Action = z.infer<typeof action>;
export type Locator = z.infer<typeof locator>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Outcome = "passed" | "failed" | "blocked" | "skipped" | "stale";

export interface Preview {
  evidence: string;
  sha: string;
  url: string;
}
export interface StepResult {
  action: Action;
  index: number;
  observation: string;
  ok: boolean;
  reason: string;
}
export interface ScenarioResult {
  artifacts: string[];
  assertions: { id: string; passed: boolean; actual: unknown }[];
  error?: string;
  outcome: Outcome;
  scenario: Scenario;
  sessionId?: string;
  steps: StepResult[];
}
export interface RunResult {
  endedAt?: string;
  error?: string;
  id: string;
  outcome: Outcome;
  plan?: Plan;
  preview?: Preview;
  prUrl: string;
  publication?: { commentUrl: string; status: string };
  scenarios: ScenarioResult[];
  sha?: string;
  startedAt: string;
}
