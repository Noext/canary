import { z } from "zod";
import type { Diagnostic } from "./diagnostics.js";

const text = z.string().trim().min(1).max(2000);
const locator = z.discriminatedUnion("by", [
  z.object({ by: z.literal("css"), value: text }).strict(),
  z
    .object({ by: z.literal("role"), value: text, name: z.string().max(2000) })
    .strict(),
  z.object({ by: z.literal("text"), value: text }).strict(),
  z.object({ by: z.literal("label"), value: text }).strict(),
  z.object({ by: z.literal("placeholder"), value: text }).strict(),
  z.object({ by: z.literal("testId"), value: text }).strict(),
]);
const assertionBase = {
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  description: text,
  target: locator.optional(),
  afterStep: text.optional(),
  verification: z.enum(["state", "transition", "persisted"]).default("state"),
};
export const AssertionSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...assertionBase, kind: z.literal("visual"), expected: text })
    .strict(),
  z
    .object({ ...assertionBase, kind: z.literal("download"), expected: text })
    .strict(),
  z
    .object({ ...assertionBase, kind: z.literal("popup"), expected: text })
    .strict(),
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
export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("observe") }).strict(),
  z
    .object({ type: z.literal("download"), locator, assertionId: text })
    .strict(),
  z.object({ type: z.literal("popup"), locator, assertionId: text }).strict(),
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
export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    title: text,
    rationale: text,
    kind: z.enum(["happy_path", "edge_case", "regression"]),
    sourceFiles: z.array(text).min(1).max(30),
    preconditions: z.array(text).max(10),
    steps: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
            description: text,
            action: ActionSchema,
          })
          .strict()
      )
      .min(1)
      .max(40),
    requirements: z
      .array(
        z
          .object({
            sourceFile: text,
            quote: z.string().min(8).max(1000),
            behavior: text,
          })
          .strict()
      )
      .min(1)
      .max(20),
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
      validateScenarioContract(scenario, ctx);
    }
  });
function validateContractAssertion(
  scenario: z.infer<typeof ScenarioSchema>,
  index: number,
  ctx: z.RefinementCtx
): string | undefined {
  const step = scenario.steps[index];
  if (
    !(
      step?.action.type === "assert" ||
      step?.action.type === "download" ||
      step?.action.type === "popup"
    )
  ) {
    return;
  }
  const { assertionId } = step.action;
  const assertion = scenario.assertions.find((item) => item.id === assertionId);
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (!assertion) {
    issue("Unknown contract assertion");
    return;
  }
  if (
    !(["url", "download", "popup"].includes(assertion.kind) || assertion.target)
  ) {
    issue("Assertion requires a frozen target");
  }
  if (step.action.type === "assert" && step.action.locator) {
    issue(
      "Assertion targets belong to the original contract, never executor actions"
    );
  }
  if (
    ["visual", "popup", "download"].includes(assertion.kind) &&
    assertion.verification !== "state"
  ) {
    issue("Visual, popup and download assertions require state verification");
  }
  if (
    (step.action.type === "download" || step.action.type === "popup") &&
    assertion.kind !== step.action.type
  ) {
    issue("Event action must use an assertion of the same kind");
  }
  if (
    step.action.type === "assert" &&
    ["download", "popup"].includes(assertion.kind)
  ) {
    issue("Event assertions require their corresponding event action");
  }
  const preceding = scenario.steps.slice(0, index);
  const dependency = preceding.find((item) => item.id === assertion.afterStep);
  if (!dependency) {
    issue("Assertion must reference an earlier required step");
  }
  if (
    assertion.verification !== "state" &&
    !(
      dependency &&
      ["click", "fill", "press", "select", "check"].includes(
        dependency.action.type
      )
    )
  ) {
    issue(
      "Transition/persistence verification requires a preceding interaction"
    );
  }
  return assertion.id;
}
function validateScenarioContract(
  scenario: z.infer<typeof ScenarioSchema>,
  ctx: z.RefinementCtx
) {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const stepIds = scenario.steps.map((step) => step.id);
  if (new Set(stepIds).size !== stepIds.length) {
    issue("Duplicate contract step ids");
  }
  const evaluated: string[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    if (["finish", "blocked"].includes(step.action.type)) {
      issue("Finish/blocked cannot be a contract step");
    }
    const id = validateContractAssertion(scenario, index, ctx);
    if (id) {
      evaluated.push(id);
    }
  }
  if (new Set(evaluated).size !== evaluated.length) {
    issue("Repeated contract assertion");
  }
  if (evaluated.length !== scenario.assertions.length) {
    issue("Every assertion requires one ordered contract step");
  }
  const ids = scenario.assertions.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    issue("Duplicate assertion ids");
  }
}
export type Plan = z.infer<typeof PlanSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Assertion = z.input<typeof AssertionSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Locator = z.infer<typeof locator>;
export type Outcome = "passed" | "failed" | "blocked" | "skipped" | "stale";
/**
 * Issue de la publication du rapport : c'est la seule chose que dit
 * `Publication.status`. L'état du commit status posté sur GitHub est un autre
 * fait, consigné à part dans `Publication.commitStatus`.
 */
export type PublicationIssue = "published" | "failed";

/**
 * Ce que porte `publication` : deux faits distincts qui ne se recopient jamais.
 * Les result.json écrits avant cette séparation portent l'état du commit status
 * dans `status` ("success"/"error"/"failure") et aucun `commitStatus` : les
 * lecteurs restent donc tolérants à l'ancien vocabulaire d'un côté comme à
 * l'absence de l'autre.
 */
export interface Publication {
  /** URL du commentaire qui porte le rapport, absent si rien n'a été écrit. */
  commentUrl?: string;
  /**
   * Dernier état de commit status réellement écrit sur le commit par ce run
   * ("success"/"failure"/"error") : c'est le verdict du dernier post réussi,
   * qui peut donc précéder la fin du run — un run bloqué dont l'écriture du
   * verdict "error" a échoué garde le verdict écrit avant lui
   * (`runner.ts:publish`). Absent quand aucune écriture de commit status n'a
   * abouti, même si le rapport est publié : les deux écritures sont indépendantes
   * et ne s'attestent pas l'une l'autre.
   */
  commitStatus?: string;
  /**
   * "published" dès que le commentaire de rapport est sur la PR, "failed"
   * sinon : l'échec du verdict de statut n'en fait jamais partie.
   */
  status: PublicationIssue | "success" | "failure" | "error";
}

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
  /** Étape du contrat jouée ici : l'hôte exécute le plan, il ne l'interprète pas. */
  stepId?: string;
}
export interface ScenarioResult {
  artifacts: string[];
  assertions: {
    id: string;
    passed: boolean;
    actual: unknown;
    baseline?: unknown;
    persisted?: unknown;
  }[];
  contract?: { completedSteps: string[]; totalSteps: number; hash: string };
  diagnostic?: Diagnostic;
  error?: string;
  outcome: Outcome;
  scenario: Scenario;
  sessionId?: string;
  steps: StepResult[];
}
export interface RunResult {
  baseline?: { sha: string; url: string; scenarios: ScenarioResult[] };
  coverage?: {
    covered: string[];
    skipped: Plan["skipped"];
    policyRef: string;
    gate: string;
  };
  diagnostic?: Diagnostic;
  endedAt?: string;
  error?: string;
  id: string;
  model?: string;
  outcome: Outcome;
  plan?: Plan;
  preview?: Preview;
  prUrl: string;
  publication?: Publication;
  scenarios: ScenarioResult[];
  sha?: string;
  startedAt: string;
  usage?: {
    tokens: number;
    costUsd: number;
    /**
     * Cumul des réserves des tentatives perdues, chiffré à part des tokens que
     * l'endpoint a rapportés. Chaque réserve est créditée de ce que le transport
     * a réellement livré, plafonnée par le pire cas de la tentative perdue, et
     * elle compte dans l'admission du run : l'exposition engagée (`tokens` +
     * `reservedTokens`) reste dans l'enveloppe.
     */
    reservedTokens?: number;
    reservedCostUsd?: number;
    calls: number;
    model?: string;
    estimated?: boolean;
    pricingConfigured?: boolean;
    /** Reprises de transport effectuées pendant les appels modèle du run. */
    retries?: number;
  };
}
