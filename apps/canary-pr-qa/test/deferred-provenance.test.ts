import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary, MODEL_SNAPSHOT_CHARS } from "../src/canary.js";
import { Model } from "../src/model.js";
import {
  deferredProvenanceRefusals,
  provenanceRefusals,
} from "../src/plan-evidence.js";
import { runQa } from "../src/runner.js";
import type { Plan } from "../src/schema.js";
import { fixture, PR_URL } from "./fixture.js";

/**
 * Point 1 du plan du juge (A′ + W) : avec une préversion de base, un attendu que
 * l'exigence citée ne justifie pas, ou un objectif sans témoin dans le diff, ne
 * bloque plus avant exécution. Le scénario est joué des deux côtés ; il ne peut
 * finir que bloqué, ou rouge sur une régression que la base confirme
 * (`BASELINE_REGRESSION`). Jamais vert. Sans base, le run est celui de main.
 */
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(close.splice(0).map((fn) => fn()));
});

/** Le diff écrit l'élément `#saved` que l'assertion lit : le témoin est là. */
const PATCH =
  "- show('Hello')\n+ show('Welcome '+name)\n+ <p id=\"saved\"></p>";

async function setup() {
  const f = await fixture({ formPatch: PATCH });
  close.push(f.close);
  return f;
}

const ARIA = `- main [ref=e1]:
  - heading "Pilotage" [level=1] [ref=e2]`;

/** Une valeur qu'aucune exigence citée n'écrit : la provenance la refuse. */
const UNJUSTIFIED = "quarante-deux palettes";

function deferredPlan(
  kind: "happy_path" | "regression",
  extra: Record<string, unknown> = {}
): Plan {
  return {
    summary: "Le total affiché",
    scenarios: [
      {
        id: "total",
        title: "Le total est affiché",
        kind,
        rationale: "Le diff change le total affiché",
        sourceFiles: ["src/form.ts"],
        preconditions: [],
        objective: "total-text",
        steps: [
          {
            id: "load",
            description: "ouvrir la page d'accueil",
            action: { type: "goto", path: "/" },
          },
          {
            id: "check",
            description: "vérifier le total",
            action: { type: "assert", assertionId: "total-text" },
          },
        ],
        requirements: [
          {
            sourceFile: "src/form.ts",
            quote: "show('Welcome '+name)",
            behavior: "Le nom enregistré reste affiché",
          },
        ],
        assertions: [
          {
            id: "total-text",
            description: "le total est affiché",
            kind: "text",
            target: { by: "css", value: "#saved" },
            afterStep: "load",
            verification: "state",
            expected: UNJUSTIFIED,
            requirement: 0,
            ...extra,
          },
        ],
      },
    ],
    skipped: [],
  } as unknown as Plan;
}

/**
 * Canary scripté : la tête et la base (ouverte sur `/baseline`) lisent chacune
 * leur valeur. `undefined` côté base : la base ne lit rien (cible absente).
 */
function stubSides(head: unknown, base: unknown) {
  const labels: string[] = [];
  let onBase = false;
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("deferred-session");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_id: string, label: string, script: string) => {
      labels.push(label);
      if (label === "open-preview") {
        onBase = script.includes("/baseline");
      }
      const discovery = label === "discover-preview";
      const read = onBase ? base : head;
      return {
        url: "http://fixture/",
        snapshot: ARIA.slice(0, MODEL_SNAPSHOT_CHARS),
        evidence: discovery ? ARIA : undefined,
        actual: discovery ? undefined : read,
      };
    }
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([
    "video.webm",
    "trace.zip",
  ]);
  return labels;
}

function scriptPlan(plan: Plan) {
  vi.spyOn(Model.prototype, "json").mockImplementation((async () =>
    structuredClone(plan)) as unknown as Model["json"]);
}

async function run(
  plan: Plan,
  sides: { base: unknown; head: unknown },
  template?: (baseUrl: string) => string
) {
  const f = await setup();
  const labels = stubSides(sides.head, sides.base);
  scriptPlan(plan);
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    template
      ? { ...f.config, QA_BASELINE_URL_TEMPLATE: template(f.baseUrl) }
      : f.config
  );
  return { labels, result, scenario: result.scenarios[0]! };
}

const withBase = (baseUrl: string) => `${baseUrl}/baseline`;

describe("A′ — provenance différée à la base", () => {
  it("le plan de test porte bien un refus de provenance, et lui seul", () => {
    const plan = deferredPlan("happy_path");
    expect(provenanceRefusals(plan)).toHaveLength(1);
    expect(
      deferredProvenanceRefusals(
        plan,
        { QA_BASELINE_URL_TEMPLATE: "" } as never,
        { files: [] }
      ).size
    ).toBe(0);
  });

  it("sans base, la sortie est celle de main : refusé avant toute étape", async () => {
    const plan = deferredPlan("happy_path");
    const { labels, result, scenario } = await run(plan, {
      head: UNJUSTIFIED,
      base: UNJUSTIFIED,
    });
    expect(result.outcome).toBe("blocked");
    expect(scenario.outcome).toBe("blocked");
    expect(scenario.diagnostic?.code).toBe("PLAN_SCHEMA_INVALID");
    expect(scenario.error).toBe(provenanceRefusals(plan)[0]?.error.message);
    expect(scenario.steps).toEqual([]);
    expect(labels).toEqual(["discover-preview"]);
    expect(result.baseline).toBeUndefined();
    expect(result.baselineComparison).toBeUndefined();
  });

  it("passe des deux côtés : bloqué, jamais vert", async () => {
    const { result, scenario } = await run(
      deferredPlan("happy_path"),
      { head: UNJUSTIFIED, base: UNJUSTIFIED },
      withBase
    );
    // Le scénario a bien été joué des deux côtés.
    expect(scenario.steps.length).toBeGreaterThan(0);
    expect(result.baseline?.scenarios.map((item) => item.scenario.id)).toEqual([
      "total",
    ]);
    expect(scenario.outcome).toBe("blocked");
    expect(scenario.classification).toBe("test-defect");
    expect(scenario.diagnostic?.code).toBe("PLAN_SCHEMA_INVALID");
    expect(result.outcome).toBe("blocked");
  });

  it("passe sur la tête, autre valeur sur la base : un changement non justifié reste bloqué", async () => {
    const { result, scenario } = await run(
      deferredPlan("happy_path"),
      { head: UNJUSTIFIED, base: "trente palettes" },
      withBase
    );
    expect(
      result.baselineComparison?.changes.map((item) => item.assertionId)
    ).toEqual(["total-text"]);
    expect(scenario.outcome).toBe("blocked");
    expect(scenario.diagnostic?.code).toBe("PLAN_SCHEMA_INVALID");
    expect(result.outcome).toBe("blocked");
  });

  it("passe sur la tête, base non concluante : bloqué", async () => {
    // La base n'annonce pas le SHA de la base de fusion : comparaison indisponible.
    const { result, scenario } = await run(
      deferredPlan("happy_path"),
      { head: UNJUSTIFIED, base: UNJUSTIFIED },
      (baseUrl) => `${baseUrl}/`
    );
    expect(result.baselineComparison?.status).toBe("unavailable");
    expect(scenario.steps.length).toBeGreaterThan(0);
    expect(scenario.outcome).toBe("blocked");
    expect(scenario.diagnostic?.code).toBe("PLAN_SCHEMA_INVALID");
    expect(result.outcome).toBe("blocked");
  });

  it("échoue sur la tête seule, sans confirmation de la base : bloqué, pas rouge", async () => {
    for (const [base, template] of [
      ["trente palettes", withBase],
      [UNJUSTIFIED, (baseUrl: string) => `${baseUrl}/`],
    ] as const) {
      vi.restoreAllMocks();
      const { result, scenario } = await run(
        deferredPlan("happy_path"),
        { head: "trente palettes", base },
        template
      );
      expect(scenario.outcome, String(base)).toBe("blocked");
      expect(scenario.diagnostic?.code).toBe("PLAN_SCHEMA_INVALID");
      expect(result.outcome).toBe("blocked");
    }
  });

  it("passe sur la base, échoue sur la tête : BASELINE_REGRESSION, rouge", async () => {
    const { result, scenario } = await run(
      deferredPlan("happy_path"),
      { head: "trente palettes", base: UNJUSTIFIED },
      withBase
    );
    expect(scenario.outcome).toBe("failed");
    expect(scenario.diagnostic?.code).toBe("BASELINE_REGRESSION");
    expect(result.outcome).toBe("failed");
    expect(
      result.baselineComparison?.regressions.map((item) => item.assertionId)
    ).toEqual(["total-text"]);
  });

  it("un autre refus du scénario reste avant exécution, base ou non", async () => {
    // Un attendu non justifié ET un sélecteur instable : seul le premier se
    // diffère, le scénario n'est joué ni sur la tête ni sur la base.
    const { labels, result, scenario } = await run(
      deferredPlan("happy_path", {
        target: { by: "css", value: ".text-green-600" },
      }),
      { head: "trente palettes", base: UNJUSTIFIED },
      withBase
    );
    expect(scenario.steps).toEqual([]);
    expect(labels).toEqual(["discover-preview"]);
    expect(result.baseline?.scenarios).toEqual([]);
    expect(scenario.outcome).toBe("blocked");
    expect(result.outcome).toBe("blocked");
  });
});

describe("W — objectif sans témoin différé à la base", () => {
  /**
   * L'assertion lit `#autre` et attend « Bonjour à tous » : le diff n'écrit ni
   * l'une ni l'autre. Elle ne cite aucune exigence, donc aucune provenance.
   */
  const unwitnessed = () =>
    deferredPlan("happy_path", {
      target: { by: "css", value: "#autre" },
      expected: "Bonjour à tous",
      requirement: undefined,
    });

  it("le plan de test porte un refus de témoin, pas de provenance", async () => {
    const plan = unwitnessed();
    expect(provenanceRefusals(plan)).toEqual([]);
    const f = await setup();
    const context = {
      files: [{ filename: "src/form.ts", patch: PATCH }],
    } as never;
    const deferred = deferredProvenanceRefusals(
      plan,
      { ...f.config, QA_BASELINE_URL_TEMPLATE: withBase(f.baseUrl) },
      context
    );
    expect(deferred.get("total")?.code).toBe("OBJECTIVE_UNWITNESSED");
  });

  it("sans base, refusé avant toute étape comme sur main", async () => {
    const { labels, scenario } = await run(unwitnessed(), {
      head: "Bonjour à tous",
      base: "Bonjour à tous",
    });
    expect(scenario.outcome).toBe("blocked");
    expect(scenario.diagnostic?.code).toBe("OBJECTIVE_UNWITNESSED");
    expect(labels).toEqual(["discover-preview"]);
  });

  it("passe des deux côtés : bloqué sur le refus de témoin", async () => {
    const { result, scenario } = await run(
      unwitnessed(),
      { head: "Bonjour à tous", base: "Bonjour à tous" },
      withBase
    );
    expect(scenario.steps.length).toBeGreaterThan(0);
    expect(scenario.outcome).toBe("blocked");
    expect(scenario.diagnostic?.code).toBe("OBJECTIVE_UNWITNESSED");
    expect(result.outcome).toBe("blocked");
  });

  it("la base passe, la tête échoue : BASELINE_REGRESSION, rouge", async () => {
    const { result, scenario } = await run(
      unwitnessed(),
      { head: "Au revoir", base: "Bonjour à tous" },
      withBase
    );
    expect(scenario.outcome).toBe("failed");
    expect(scenario.diagnostic?.code).toBe("BASELINE_REGRESSION");
    expect(result.outcome).toBe("failed");
  });
});

describe("refus différés et réécriture après observation", () => {
  const unwitnessed = () =>
    deferredPlan("happy_path", {
      target: { by: "css", value: "#autre" },
      expected: "Bonjour à tous",
      requirement: undefined,
    });

  /**
   * Un scénario dont l'étape vise un bouton absent de la découverte
   * (PLAN_TARGET_MISSING, refus que la réécriture traite) : il déclenche la
   * réécriture après observation.
   */
  function missingTarget(): Plan["scenarios"][number] {
    const plan = deferredPlan("happy_path");
    const scenario = plan.scenarios[0]!;
    scenario.id = "manquant";
    scenario.steps.splice(1, 0, {
      id: "press",
      description: "appuyer sur le bouton",
      action: {
        type: "click",
        locator: { by: "role", value: "button", name: "Inexistant" },
      },
    } as never);
    Object.assign(scenario.assertions[0]!, {
      expected: "Welcome",
      afterStep: "press",
    });
    return scenario;
  }

  /** Le modèle rend `plans[i]` au i-ème appel, puis le dernier. */
  function scriptPlans(plans: Plan[]) {
    let calls = 0;
    vi.spyOn(Model.prototype, "json").mockImplementation((async () => {
      const plan = plans[Math.min(calls, plans.length - 1)]!;
      calls += 1;
      return structuredClone(plan);
    }) as unknown as Model["json"]);
    return () => calls;
  }

  async function runPlans(plans: Plan[], head: unknown, base: unknown) {
    const f = await setup();
    stubSides(head, base);
    const calls = scriptPlans(plans);
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      { ...f.config, QA_BASELINE_URL_TEMPLATE: withBase(f.baseUrl) }
    );
    const by = (id: string) =>
      result.scenarios.find((item) => item.scenario.id === id);
    return { by, calls: calls(), result };
  }

  it("une réécriture adoptée garde la base d'un scénario différé : BASELINE_REGRESSION", async () => {
    const plan = unwitnessed();
    plan.scenarios.push(missingTarget());
    const { by, calls, result } = await runPlans(
      [plan],
      "Au revoir",
      "Bonjour à tous"
    );
    // La réécriture a bien eu lieu, et le plan rendu est adopté.
    expect(calls).toBe(2);
    expect(result.replannedScenarioIds).toBeDefined();
    expect(result.baseline?.scenarios.map((item) => item.scenario.id)).toEqual([
      "total",
    ]);
    expect(by("total")?.diagnostic?.code).toBe("BASELINE_REGRESSION");
    expect(by("total")?.outcome).toBe("failed");
    expect(result.outcome).toBe("failed");
  });

  it("un scénario réécrit sans témoin, réexécuté, n'est jamais vert", async () => {
    const first = deferredPlan("happy_path");
    first.scenarios = [missingTarget()];
    // La réécriture retire le bouton absent, mais lit une cible que le diff
    // n'écrit pas : objectif sans témoin, différé à la base.
    const rewritten = unwitnessed();
    rewritten.scenarios[0]!.id = "manquant";
    (rewritten.scenarios[0]!.assertions[0] as { expected: string }).expected =
      "Au revoir";
    const { by, calls, result } = await runPlans(
      [first, rewritten],
      "Au revoir",
      "Bonjour à tous"
    );
    expect(calls).toBe(2);
    const scenario = by("manquant");
    expect(scenario?.steps.length).toBeGreaterThan(0);
    expect(scenario?.outcome).toBe("blocked");
    expect(scenario?.diagnostic?.code).toBe("OBJECTIVE_UNWITNESSED");
    expect(result.outcome).not.toBe("passed");
  });

  /**
   * Un scénario `regression` justifié et témoigné, joué une fois sur la tête,
   * puis réécrit par la réécriture du plan entier SANS être réexécuté : seul
   * `manquant` l'est. `rewrite` change son contrat dans le plan final.
   */
  function rewrittenUnexecuted(
    rewrite: (scenario: Plan["scenarios"][number]) => void
  ): Plan[] {
    const first = deferredPlan("regression", { expected: "Welcome" });
    first.scenarios.push(missingTarget());
    const second = structuredClone(first);
    rewrite(second.scenarios[0]!);
    return [first, second];
  }

  it("une réécriture qui change un scénario sans le réexécuter garde sa comparaison à la base : BASELINE_REGRESSION", async () => {
    const { by, calls, result } = await runPlans(
      rewrittenUnexecuted((scenario) => {
        scenario.title = "Le total réécrit est affiché";
      }),
      "Welcome Ada",
      "Hello Ada"
    );
    expect(calls).toBe(2);
    expect(result.replannedScenarioIds ?? []).not.toContain("total");
    expect(result.plan?.scenarios[0]?.title).toBe(
      "Le total réécrit est affiché"
    );
    // La base rejoue le contrat que la tête a exécuté : mêmes hashes.
    const base = result.baseline?.scenarios.find(
      (item) => item.scenario.id === "total"
    );
    expect(base?.contract?.hash).toBe(by("total")?.contract?.hash);
    expect(result.baselineComparison?.inconclusive ?? []).not.toContainEqual(
      expect.objectContaining({ scenarioId: "total" })
    );
    expect(by("total")?.outcome).toBe("failed");
    expect(by("total")?.diagnostic?.code).toBe("BASELINE_REGRESSION");
  });

  it("une réécriture refusée d'un scénario déjà exécuté ne lui retire pas sa base", async () => {
    const { by, result } = await runPlans(
      rewrittenUnexecuted((scenario) => {
        Object.assign(scenario.assertions[0]!, {
          target: { by: "css", value: ".text-green-600" },
        });
      }),
      "Welcome Ada",
      "Hello Ada"
    );
    expect(
      result.baseline?.scenarios.map((item) => item.scenario.id)
    ).toContain("total");
    expect(by("total")?.outcome).toBe("failed");
    expect(by("total")?.diagnostic?.code).toBe("BASELINE_REGRESSION");
  });

  it("un refus avant exécution garde son code précis, base ou non", async () => {
    // Objectif sans témoin ET sélecteur instable : rien n'est joué, le
    // diagnostic reste celui du sélecteur, comme sur main.
    const plan = deferredPlan("happy_path", {
      target: { by: "css", value: ".text-green-600" },
      expected: "Bonjour à tous",
      requirement: undefined,
    });
    for (const template of [undefined, withBase]) {
      vi.restoreAllMocks();
      const { scenario } = await run(
        plan,
        { head: "Au revoir", base: "Bonjour à tous" },
        template
      );
      expect(scenario.steps, String(template)).toEqual([]);
      expect(scenario.outcome).toBe("blocked");
      expect(scenario.diagnostic?.code).toBe("PLAN_SELECTOR_UNSTABLE");
    }
  });
});
