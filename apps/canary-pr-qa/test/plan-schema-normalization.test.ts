import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary, compileProbe, locatorExpression } from "../src/canary.js";
import { runQa } from "../src/runner.js";
import { type Plan, PlanSchema, plannerPlanSchema } from "../src/schema.js";
import { fixture, PR_URL, plan } from "./fixture.js";

/**
 * Normalisation du schéma (plan du juge, point 4). Mesure du banc : sur 26
 * refus de schéma, 12 étaient une cible `role` sans `name` et 10 un clic
 * `ifPresent` sans assertion rattachée — et la seconde erreur n'apparaissait
 * qu'au tour suivant la première, car zod saute les raffinements d'un plan
 * dont un champ enfant échoue. Sept runs ont ainsi brûlé leurs deux tours de
 * correction, une classe d'erreur par tour.
 */

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(close.splice(0).map((fn) => fn()));
});

/** Le plan de référence, dont la cible d'assertion est un rôle écrit sans `name`. */
function unnamedStatusPlan(): unknown {
  const raw = structuredClone(plan) as unknown as {
    scenarios: { assertions: { target: unknown }[] }[];
  };
  raw.scenarios[0]!.assertions[0]!.target = { by: "role", value: "status" };
  return raw;
}

/** Un clic `ifPresent` qu'aucune assertion ne vérifie : la règle croisée. */
function withUnverifiedIfPresent(faulty: Plan): Plan {
  faulty.scenarios[0]!.steps.unshift({
    id: "ensure-open",
    description: "Reopen the counting session when it is closed",
    action: {
      type: "click",
      locator: { by: "role", value: "button", name: "Reopen the count" },
      ifPresent: true,
    },
  });
  return faulty;
}

/** Les deux classes d'erreur dans la même réponse : une de schéma, une croisée. */
function schemaAndCrossFieldFaults(): Plan {
  const faulty = withUnverifiedIfPresent(structuredClone(plan));
  (
    faulty.scenarios[0]!.assertions[0] as { verification: string }
  ).verification = "sometimes";
  return faulty;
}

const IF_PRESENT_RULE =
  /Scenario welcome step ensure-open: ifPresent skips the step when its target is absent, so an assertion must verify the state it establishes: no assertion has afterStep ensure-open/;
const SCHEMA_RULE = /scenarios\.0\.assertions\.0\.verification: /;

function issuesOf(value: unknown): string[] {
  const parsed = plannerPlanSchema([]).safeParse(value);
  expect(parsed.success).toBe(false);
  return (parsed.error?.issues ?? []).map(
    (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`
  );
}

describe("une cible role sans name vaut name vide, en correspondance exacte", () => {
  it('se lit comme name "" dans le schéma du planificateur et le plan persisté', () => {
    for (const schema of [plannerPlanSchema([]), PlanSchema]) {
      const parsed = schema.parse(unnamedStatusPlan());
      expect(parsed.scenarios[0]?.assertions[0]?.target).toEqual({
        by: "role",
        value: "status",
        name: "",
      });
    }
  });

  it("joue exactement le locator que le modèle écrit une fois corrigé", () => {
    const parsed = PlanSchema.parse(unnamedStatusPlan());
    const target = parsed.scenarios[0]?.assertions[0]?.target;
    const corrected = { by: "role", value: "status", name: "" } as const;
    // `exact: true` : seul un élément de ce rôle SANS nom accessible répond,
    // jamais n'importe quel élément du rôle.
    expect(locatorExpression(target!)).toBe(locatorExpression(corrected));
    expect(locatorExpression(corrected)).toBe(
      'page.getByRole("status", { name: "", exact: true })'
    );
  });

  it("ne relâche jamais une sonde construite hors du parse", () => {
    const probe = compileProbe(
      {
        id: "a",
        description: "d",
        kind: "visible",
        target: { by: "role", value: "status" },
      },
      "http://fixture/"
    );
    expect(probe).toContain('getByRole("status", { name: "", exact: true })');
    expect(probe).not.toContain("name: undefined");
  });

  it("refuse toujours un name qui n'est pas une chaîne", () => {
    const raw = unnamedStatusPlan() as {
      scenarios: { assertions: { target: unknown }[] }[];
    };
    raw.scenarios[0]!.assertions[0]!.target = {
      by: "role",
      value: "status",
      name: null,
    };
    expect(issuesOf(raw).join("\n")).toMatch(
      /scenarios\.0\.assertions\.0\.target\.name/
    );
  });
});

describe("erreurs de schéma et règles croisées dans le même tour", () => {
  it("nomme l'ifPresent fautif à côté de l'erreur de schéma", () => {
    const issues = issuesOf(schemaAndCrossFieldFaults());
    expect(issues.some((issue) => SCHEMA_RULE.test(issue))).toBe(true);
    expect(issues.some((issue) => IF_PRESENT_RULE.test(issue))).toBe(true);
  });

  it("ne dédouble pas la règle croisée quand le schéma passe", () => {
    const issues = issuesOf(withUnverifiedIfPresent(structuredClone(plan)));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(IF_PRESENT_RULE);
  });

  it("ne juge pas un scénario dont la structure ne se lit pas", () => {
    const raw = structuredClone(plan) as unknown as {
      scenarios: { steps: unknown }[];
    };
    raw.scenarios[0]!.steps = "not steps";
    const issues = issuesOf(raw);
    expect(issues.join("\n")).toMatch(/scenarios\.0\.steps/);
    expect(issues.join("\n")).not.toMatch(/Scenario welcome/);
  });

  it("transmet les deux classes au modèle dès le premier tour de correction", async () => {
    const f = await fixture({
      plans: [
        schemaAndCrossFieldFaults(),
        schemaAndCrossFieldFaults(),
        schemaAndCrossFieldFaults(),
      ],
    });
    close.push(f.close);
    vi.spyOn(Canary.prototype, "start").mockResolvedValue("fixture-session");
    vi.spyOn(Canary.prototype, "act").mockResolvedValue({
      url: "http://fixture/",
      snapshot: "textbox Name, button Save",
    });
    vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    // Le plan reste fautif à chaque tour : il est refusé, jamais exécuté.
    expect(result.outcome).toBe("blocked");
    expect(result.scenarios).toEqual([]);
    const correction = (
      f.modelRequests[1]?.messages as { content: string; role: string }[]
    )
      .filter((item) => item.role === "user")
      .at(-1)?.content;
    expect(correction).toContain("violates the contract");
    expect(correction).toMatch(SCHEMA_RULE);
    expect(correction).toMatch(IF_PRESENT_RULE);
  });
});
