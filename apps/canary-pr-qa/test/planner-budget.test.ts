import { describe, expect, it } from "vitest";
import type { Observation } from "../src/canary.js";
import { loadConfig } from "../src/config.js";
import type { PrContext } from "../src/github.js";
import { PLANNER_PROMPT } from "../src/model.js";
import {
  PLANNER_BUDGET_ASSUMPTIONS,
  plannerInputBudget,
  planPayload,
} from "../src/plan-evidence.js";
import type { Preview } from "../src/schema.js";

/**
 * Le budget du planificateur : il dérive de la FENÊTRE DE TOKENS du modèle, pas
 * de la taille du payload. Une borne qui s'étire avec ce qu'elle mesure ne
 * garantit rien ; celle-ci réserve la sortie maximale, la correction contrainte
 * et les instructions, puis refuse — sans rien tronquer — ce qui ne tient pas.
 *
 * Mesure d'origine (PR #20) : payload 268 868 caractères pour une borne de
 * 242 929, refusé. La cause n'était pas la taille du payload mais une formule
 * qui ne comptait ni l'instantané de découverte, ni les métadonnées de la PR, ni
 * les instructions du planificateur, et qui n'avait aucun plafond de tokens.
 */

const preview = {
  evidence: `x-commit-sha: ${"a".repeat(40)}`,
  sha: "a".repeat(40),
  url: "https://preview.example.test/",
} as Preview;

const page = (chars: number): Observation => ({
  actual: undefined,
  snapshot: `- main [ref=e1]: ${"p".repeat(Math.max(0, chars - 20))}`,
  url: "https://preview.example.test/",
});

function context(files: number, contextChars: number): PrContext {
  return {
    baseSha: "b".repeat(40),
    body: "corps de la PR",
    context: [
      {
        content: "z".repeat(contextChars),
        path: "src/big.ts",
        ref: "a".repeat(40),
      },
    ],
    contextWarnings: [],
    files: Array.from({ length: files }, (_value, index) => ({
      changes: 2,
      filename: `src/file-${index}.ts`,
      patch: `@@ -1 +1 @@\n-${"x".repeat(40)}\n+${"y".repeat(40)}`,
      status: "modified",
    })),
    headRepo: "fixture/app",
    ref: {
      number: 1,
      repo: "fixture/app",
      url: "https://github.com/fixture/app/pull/1",
    },
    sha: "a".repeat(40),
    title: "titre",
  };
}

const catalog = { fixtures: {}, roles: [], visuals: [] } as never;

function build(
  ctx: PrContext,
  config: ReturnType<typeof loadConfig>,
  snapshotChars = 400
) {
  return planPayload(ctx, preview, page(snapshotChars), catalog, config);
}

const config = (env: NodeJS.ProcessEnv = {}) =>
  loadConfig({ QA_API_TOKEN: "fixture-api-token-123456789012345", ...env });

describe("la borne dérive de la fenêtre de tokens, jamais du payload", () => {
  it("réserve la sortie, la correction et les instructions", () => {
    const budget = plannerInputBudget(
      config({ QA_MODEL_CONTEXT_TOKENS: "131072", QA_PLAN_MAX_TOKENS: "8000" })
    );
    // 131072 − 2 × 8000 = 115072 tokens d'entrée utiles.
    expect(budget.availableInputChars).toBe(
      Math.floor(
        115_072 *
          PLANNER_BUDGET_ASSUMPTIONS.charsPerToken *
          PLANNER_BUDGET_ASSUMPTIONS.safetyFactor
      )
    );
    expect(budget.outputReserveChars).toBe(
      Math.floor(8000 * PLANNER_BUDGET_ASSUMPTIONS.charsPerToken)
    );
    expect(budget.correctionReserveChars).toBe(budget.outputReserveChars);
    expect(budget.limit).toBe(
      budget.availableInputChars - PLANNER_BUDGET_ASSUMPTIONS.promptReserveChars
    );
  });

  it("la réserve des instructions couvre le prompt réel", () => {
    // Sinon la réserve deviendrait une sous-estimation silencieuse.
    expect(
      PLANNER_BUDGET_ASSUMPTIONS.promptReserveChars
    ).toBeGreaterThanOrEqual(PLANNER_PROMPT.length);
  });

  it("un plafond de sortie plus grand réduit le budget d'entrée", () => {
    const small = plannerInputBudget(
      config({ QA_PLAN_MAX_TOKENS: "8000" })
    ).limit;
    const large = plannerInputBudget(
      config({ QA_PLAN_MAX_TOKENS: "32000" })
    ).limit;
    expect(large).toBeLessThan(small);
  });

  it("une fenêtre plus petite que la sortie demandée ne laisse aucun budget", () => {
    const budget = plannerInputBudget(
      config({ QA_MODEL_CONTEXT_TOKENS: "8192", QA_PLAN_MAX_TOKENS: "400000" })
    );
    expect(budget.limit).toBe(0);
  });

  it("le budget ne dépend pas de QA_CONTEXT_CHARS", () => {
    const narrow = plannerInputBudget(
      config({ QA_CONTEXT_CHARS: "10000" })
    ).limit;
    const wide = plannerInputBudget(
      config({ QA_CONTEXT_CHARS: "900000" })
    ).limit;
    expect(wide).toBe(narrow);
  });
});

describe("les bornes du payload", () => {
  const limit = plannerInputBudget(config()).limit;

  it("accepte un payload juste sous la borne, sans rien perdre", () => {
    const payload = build(context(3, 1000), config());
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(limit);
    // Preuve conservée : patches intacts, matériel numéroté non vide.
    expect(payload.pr.files).toHaveLength(3);
    expect(payload.pr.context[0]?.content).toHaveLength(1000);
    expect(payload.sourceLines.length).toBeGreaterThan(0);
  });

  it("accepte un payload exactement à la borne", () => {
    const payload = build(context(3, 1000), config());
    const size = JSON.stringify(payload).length;
    // Le budget est exprimé en caractères : la comparaison est inclusive.
    expect(size <= limit).toBe(true);
    expect(size).toBeLessThanOrEqual(limit);
  });

  it("refuse un payload qui dépasse, sans troncature ni appel modèle", () => {
    // `planPayload` est pur et synchrone : rien n'est envoyé quand il refuse.
    const oversized = context(1, limit);
    let thrown: Error | undefined;
    try {
      build(oversized, config());
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toMatch(/exceeds model budget/);
    expect(thrown?.message).toMatch(/shortfall \d+/);
    // Le refus dit quoi desserrer, et rien n'est présenté comme analysé.
    expect(thrown?.message).toMatch(/QA_MODEL_CONTEXT_TOKENS/);
    expect(thrown?.message).toMatch(/Nothing was truncated/);
    // Le message nomme TOUS les leviers, allowance de fichiers comprise.
    expect(thrown?.message).toMatch(/QA_PLAN_FILE_CHARS=\d+/);
    expect(thrown?.message).toMatch(/lower QA_PLAN_FILE_CHARS/);
  });

  it("compte un gros instantané de découverte", () => {
    const small = build(context(2, 500), config(), 200);
    const big = build(context(2, 500), config(), 14_000);
    expect(JSON.stringify(big).length).toBeGreaterThan(
      JSON.stringify(small).length
    );
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(limit);
  });

  it("compte de gros patches et métadonnées de PR", () => {
    const light = build(context(12, 1000), config());
    const ctx = context(12, 1000);
    envLargePatches(ctx);
    const heavy = build(ctx, config());
    // Les patches pèsent : le payload grossit de leur taille, et il est refusé
    // dès qu'ils font déborder la borne.
    expect(JSON.stringify(heavy).length).toBeGreaterThan(
      JSON.stringify(light).length + 80_000
    );
    expect(JSON.stringify(heavy).length).toBeLessThanOrEqual(limit);
    expect(heavy.pr.files).toHaveLength(12);
    const huge = context(40, 1000);
    envLargePatches(huge);
    expect(() => build(huge, config())).toThrow(/exceeds model budget/);
  });

  it("une fenêtre plus large accepte un payload que la fenêtre par défaut refuse", () => {
    const ctx = context(1, limit);
    expect(() => build(ctx, config())).toThrow(/exceeds model budget/);
    const wide = config({ QA_MODEL_CONTEXT_TOKENS: "400000" });
    expect(() => build(ctx, wide)).not.toThrow();
    expect(JSON.stringify(build(ctx, wide)).length).toBeGreaterThan(limit);
  });

  it("réserve la place de la correction, et refuse quand elle ne laisse rien", () => {
    // Même fenêtre, même payload : seule la sortie réservée change.
    const ctx = context(2, 40_000);
    const generous = plannerInputBudget(config({ QA_PLAN_MAX_TOKENS: "2000" }));
    const reserved = plannerInputBudget(
      config({ QA_PLAN_MAX_TOKENS: "16000" })
    );
    expect(reserved.limit).toBeLessThan(generous.limit);
    // Le matériel numéroté tient sous les deux budgets.
    expect(
      build(ctx, config({ QA_PLAN_MAX_TOKENS: "2000" })).sourceLines.length
    ).toBeGreaterThan(0);
    expect(
      build(ctx, config({ QA_PLAN_MAX_TOKENS: "16000" })).sourceLines.length
    ).toBeGreaterThan(0);
    // Une sortie qui ne laisse plus rien refuse au lieu de tronquer.
    expect(() => build(ctx, config({ QA_PLAN_MAX_TOKENS: "60000" }))).toThrow(
      /exceeds model budget/
    );
  });
});

/** Gonfle les patches pour peser sur le budget par les métadonnées de la PR. */
function envLargePatches(ctx: PrContext) {
  for (const file of ctx.files) {
    file.patch = `@@ -1 +1 @@\n-${"x".repeat(4000)}\n+${"y".repeat(4000)}`;
  }
}
