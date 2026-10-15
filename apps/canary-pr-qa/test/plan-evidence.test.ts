import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Canary,
  compileAction,
  MODEL_SNAPSHOT_CHARS,
  PLAN_EVIDENCE_SNAPSHOT_CHARS,
} from "../src/canary.js";
import { Model } from "../src/model.js";
import {
  ariaRoleNameNodes,
  ariaRoleNames,
  planEvidenceDiagnostic,
  typographicTargetNote,
  unstableSelectorRefusals,
  validatePlanEvidence,
} from "../src/plan-evidence.js";
import { runQa } from "../src/runner.js";
import { type Plan, PlanSchema } from "../src/schema.js";
import { fixture, PR_URL } from "./fixture.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(close.splice(0).map((fn) => fn()));
});
async function setup(options?: Parameters<typeof fixture>[0]) {
  const f = await fixture(options);
  close.push(f.close);
  return f;
}

/** Instantané d'accessibilité réaliste : la navigation contient un bouton « P&L », pas de titre « P&L ». */
const ARIA = `- main [ref=e1]:
  - navigation [ref=e2]:
    - button "Pilotage" [ref=e3]
    - button "P&L" [ref=e4]
  - heading "Pilotage" [level=1] [ref=e5]
  - generic [ref=e6]: Aperçu de PR · vérifié par Canary
  - combobox "Pharmacie active" [ref=e7]`;

/** Reproduit le scénario refusé du run 4f1f66f0 : titre « P&L » attendu après un changement de vue. */
function observedPlan(): Plan {
  return {
    summary: "Le bandeau de préversion survit au changement de vue",
    scenarios: [
      {
        id: "preview-badge-kept-across-views",
        title:
          "Le bandeau de préversion reste affiché après un changement de vue",
        kind: "edge_case",
        rationale: "Le titre de l'en-tête dépend de la vue sélectionnée",
        sourceFiles: ["src/form.ts"],
        preconditions: [],
        steps: [
          {
            id: "load",
            description: "ouvrir la page d'accueil",
            action: { type: "goto", path: "/" },
          },
          {
            id: "go-pnl",
            description: "basculer sur la vue P&L",
            action: {
              type: "click",
              locator: { by: "role", value: "button", name: "P&L" },
            },
          },
          {
            id: "check-heading",
            description: "vérifier le titre affiché",
            action: { type: "assert", assertionId: "heading-pnl" },
          },
        ],
        requirements: [
          {
            sourceFile: "src/form.ts",
            quote: "show('Welcome '+name)",
            behavior: "La vue P&L affiche son titre",
          },
        ],
        assertions: [
          {
            id: "heading-pnl",
            description: "Le titre de l'en-tête correspond à la vue",
            kind: "text",
            expected: "P&L",
            target: { by: "role", value: "heading", name: "P&L" },
            afterStep: "go-pnl",
            verification: "transition",
          },
        ],
      },
    ],
    skipped: [],
  };
}

/** Scénario sans interaction : la cible doit résoudre sur la page de découverte elle-même. */
function readOnlyPlan(
  target: Plan["scenarios"][number]["assertions"][number]["target"]
): Plan {
  return {
    summary: "Le titre de la vue par défaut est affiché",
    scenarios: [
      {
        id: "heading-visible",
        title: "Le titre de l'en-tête est affiché",
        kind: "regression",
        rationale: "Le titre de page ne doit pas disparaître",
        sourceFiles: ["src/form.ts"],
        preconditions: [],
        steps: [
          {
            id: "load",
            description: "ouvrir la page d'accueil",
            action: { type: "goto", path: "/" },
          },
          {
            id: "check-heading",
            description: "vérifier le titre",
            action: { type: "assert", assertionId: "heading" },
          },
        ],
        requirements: [
          {
            sourceFile: "src/form.ts",
            quote: "show('Welcome '+name)",
            behavior: "Le titre de la vue par défaut reste affiché",
          },
        ],
        assertions: [
          {
            id: "heading",
            description: "Le titre de l'en-tête est visible",
            kind: "visible",
            target,
            afterStep: "load",
            verification: "state",
          },
        ],
      },
    ],
    skipped: [],
  };
}

function scriptPlan(plan: Plan) {
  vi.spyOn(Model.prototype, "json").mockImplementationOnce(
    (async () => plan) as unknown as Model["json"]
  );
}

/** Remplace Canary par une session de découverte scriptée, comme le fait le run réel. */
function stubCanary(evidence: string) {
  const labels: string[] = [];
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("fixture-session");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_id: string, label: string) => {
      labels.push(label);
      return {
        url: "http://fixture/",
        snapshot: ARIA.slice(0, MODEL_SNAPSHOT_CHARS),
        evidence: label === "discover-preview" ? evidence : undefined,
        actual: label.endsWith("assert") ? true : undefined,
      };
    }
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([
    "video.webm",
    "trace.zip",
  ]);
  return labels;
}

describe("inventaire des noms accessibles", () => {
  it("lit le rôle et le nom accessibles, jamais le texte inline", () => {
    const roles = ariaRoleNames(ARIA);
    expect(roles.get("heading")).toEqual(new Set(["Pilotage"]));
    expect(roles.get("button")).toEqual(new Set(["Pilotage", "P&L"]));
    expect(roles.get("generic")).toEqual(new Set([""]));
    expect(roles.get("text")).toBeUndefined();
  });
  it("déséchappe les noms et ignore les propriétés", () => {
    const roles = ariaRoleNames(
      `- fragment:\n  - text: P&L\n  - button "Lire \\"P&L\\"" [ref=e1]\n  - /url: "http://fixture/"`
    );
    expect(roles.get("button")).toEqual(new Set(['Lire "P&L"']));
    expect(roles.get("text")).toBeUndefined();
    expect(roles.has("/url")).toBe(false);
  });
});

describe("explication d'une cible typographiquement voisine", () => {
  const nodes = ariaRoleNameNodes(
    `- main [ref=e1]:\n  - textbox "Justification de l’écart" [ref=e2]`
  );

  it("nomme les deux graphies et leurs codepoints", () => {
    expect(
      typographicTargetNote("Justification de l'écart", "textbox", nodes)
    ).toBe(
      "le plan vise Justification de l'écart (U+0027) ; la page expose Justification de l’écart (U+2019)"
    );
  });

  it("nomme l'espace insécable, que le repli d'exécution n'essaie pas", () => {
    const spaced = ariaRoleNameNodes(
      `- textbox "Montant d’espèces\u00a0attendu" [ref=e1]`
    );
    expect(
      typographicTargetNote("Montant d'espèces attendu", "textbox", spaced)
    ).toContain("(U+2019 U+00A0)");
  });

  it("reste muet pour un nom identique, un nom différent, un autre rôle ou deux candidats", () => {
    // Le nom exact ne demande aucune explication, et une cible réellement
    // différente n'a pas de voisin typographique à nommer.
    expect(
      typographicTargetNote("Justification de l’écart", "textbox", nodes)
    ).toBeUndefined();
    expect(
      typographicTargetNote("Justification du montant", "textbox", nodes)
    ).toBeUndefined();
    expect(
      typographicTargetNote("Justification de l'écart", "button", nodes)
    ).toBeUndefined();
    // Deux graphies concurrentes : le message reste générique, comme le repli
    // ne vise aucune des deux.
    const ambiguous = ariaRoleNameNodes(
      `- textbox "Justification de l’écart" [ref=e1]\n  - textbox "Justification de l‘écart" [ref=e2]`
    );
    expect(
      typographicTargetNote("Justification de l'écart", "textbox", ambiguous)
    ).toBeUndefined();
  });
});

describe("validation du plan contre l'instantané de découverte", () => {
  it("accepte un nom accessible que le repli d'exécution saura viser", () => {
    const aria = `- main [ref=e1]:\n  - textbox "Justification de l’écart" [ref=e2]`;
    const report = validatePlanEvidence(
      PlanSchema.parse(
        readOnlyPlan({
          by: "role",
          value: "textbox",
          name: "Justification de l'écart",
        })
      ),
      { url: "https://preview.test/", aria }
    );
    // Le refus porterait sur un élément que la page expose réellement : la même
    // relation que le repli décide de l'acceptation.
    expect(report).toEqual({ refusals: [], inconclusive: [] });
  });
  it("refuse une cible portée par plusieurs graphies, que le run ne saurait pas trancher", () => {
    const planned = readOnlyPlan({
      by: "role",
      value: "textbox",
      name: "Justification de l'écart",
    });
    // Deux graphies concurrentes : le repli d'exécution n'en retient aucune et
    // lève sur l'ambiguïté, donc le plan est refusé avant toute dépense.
    const competing = validatePlanEvidence(PlanSchema.parse(planned), {
      url: "https://preview.test/",
      aria: `- main [ref=e1]:\n  - textbox "Justification de l’écart" [ref=e2]\n  - textbox "Justification de l‘écart" [ref=e3]`,
    });
    expect(competing.incomplete).toBeUndefined();
    expect(competing.refusals).toEqual([
      {
        scenarioId: "heading-visible",
        stepId: "check-heading",
        target: 'role=textbox name="Justification de l\'écart"',
      },
    ]);
    // Une seule graphie portée par deux éléments n'est pas plus unique : le run
    // ne saurait pas lequel viser.
    const duplicated = validatePlanEvidence(PlanSchema.parse(planned), {
      url: "https://preview.test/",
      aria: `- main [ref=e1]:\n  - textbox "Justification de l’écart" [ref=e2]\n  - textbox "Justification de l’écart" [ref=e3]`,
    });
    expect(duplicated.refusals).toHaveLength(1);
  });
  it("refuse encore un nom que le repli ne saurait pas viser", () => {
    const aria = `- main [ref=e1]:\n  - textbox "Justification de l’écart" [ref=e2]`;
    const report = validatePlanEvidence(
      PlanSchema.parse(
        readOnlyPlan({
          by: "role",
          value: "textbox",
          name: "Justification de l’écart du jour",
        })
      ),
      { url: "https://preview.test/", aria }
    );
    expect(report.refusals).toHaveLength(1);
  });
  it("refuse une cible role+nom absente de la page de découverte", () => {
    const report = validatePlanEvidence(PlanSchema.parse(observedPlan()), {
      url: "https://preview.test/",
      aria: ARIA,
    });
    expect(report.incomplete).toBeUndefined();
    expect(report.refusals).toEqual([
      {
        scenarioId: "preview-badge-kept-across-views",
        stepId: "go-pnl",
        target: 'role=heading name="P&L"',
      },
    ]);
    expect(report.inconclusive).toEqual([]);
  });
  it("accepte une cible role+nom présente et une cible de la même page", () => {
    const report = validatePlanEvidence(
      PlanSchema.parse(
        readOnlyPlan({ by: "role", value: "heading", name: "Pilotage" })
      ),
      { url: "https://preview.test/", aria: ARIA }
    );
    expect(report).toEqual({ refusals: [], inconclusive: [] });
  });
  it("n'oppose aucun refus quand l'instantané est coupé au plafond", () => {
    const report = validatePlanEvidence(PlanSchema.parse(observedPlan()), {
      url: "https://preview.test/",
      aria: "x".repeat(PLAN_EVIDENCE_SNAPSHOT_CHARS),
    });
    expect(report.refusals).toEqual([]);
    expect(report.incomplete).toContain(
      `coupé au plafond de ${PLAN_EVIDENCE_SNAPSHOT_CHARS} caractères`
    );
  });
  it("n'oppose aucun refus sans instantané de découverte", () => {
    const report = validatePlanEvidence(PlanSchema.parse(observedPlan()), {
      url: "https://preview.test/",
      aria: "   ",
    });
    expect(report.refusals).toEqual([]);
    expect(report.incomplete).toContain("aucun instantané");
  });
  it("déclare non concluant un locator que l'arbre d'accessibilité ne porte pas", () => {
    const report = validatePlanEvidence(
      PlanSchema.parse(readOnlyPlan({ by: "css", value: "#saved" })),
      { url: "https://preview.test/", aria: ARIA }
    );
    expect(report.refusals).toEqual([]);
    expect(report.inconclusive).toEqual([
      {
        scenarioId: "heading-visible",
        stepId: "check-heading",
        target: 'css="#saved"',
        reason: "type de locator css absent de l'arbre d'accessibilité",
      },
    ]);
  });
  it("déclare non concluante une cible relevée après une interaction antérieure", () => {
    const plan = observedPlan();
    const scenario = plan.scenarios[0]!;
    scenario.steps.splice(1, 0, {
      id: "search",
      description: "chercher une pharmacie",
      action: {
        type: "fill",
        locator: { by: "label", value: "Recherche" },
        value: "DEMO01",
      },
    });
    const report = validatePlanEvidence(PlanSchema.parse(plan), {
      url: "https://preview.test/",
      aria: ARIA,
    });
    expect(report.refusals).toEqual([]);
    expect(
      report.inconclusive.map((item) => `${item.stepId} ${item.target}`)
    ).toEqual([
      'search label="Recherche"',
      'go-pnl role=button name="P&L"',
      'go-pnl role=heading name="P&L"',
    ]);
    expect(report.inconclusive[0]?.reason).toBe(
      "type de locator label absent de l'arbre d'accessibilité"
    );
    expect(report.inconclusive[2]?.reason).toBe(
      "une étape antérieure a interagi avec la page ou en a changé la route"
    );
  });
  it("déclare non concluant ce qui suit un goto vers une autre route", () => {
    const plan = readOnlyPlan({ by: "role", value: "heading", name: "P&L" });
    plan.scenarios[0]!.steps[0]!.action = { type: "goto", path: "/comptes" };
    const report = validatePlanEvidence(PlanSchema.parse(plan), {
      url: "https://preview.test/",
      aria: ARIA,
    });
    expect(report.refusals).toEqual([]);
    expect(report.inconclusive[0]?.reason).toContain(
      "une étape antérieure a interagi"
    );
  });
  it("nomme le scénario, l'étape et la cible dans le diagnostic de refus", () => {
    const scenario = PlanSchema.parse(observedPlan()).scenarios[0]!;
    const { message, hint } = planEvidenceDiagnostic(
      scenario,
      [
        {
          scenarioId: scenario.id,
          stepId: "go-pnl",
          target: 'role=heading name="P&L"',
        },
      ],
      2
    );
    expect(message).toContain("preview-badge-kept-across-views");
    expect(message).toContain("go-pnl");
    expect(message).toContain('role=heading name="P&L"');
    expect(hint).toContain("12 niveaux");
    expect(hint).toContain("css/text/label/placeholder/testId");
    expect(hint).toContain("2 autre(s) cible(s)");
  });
});

describe("évidence de découverte", () => {
  it("relève l'arbre d'accessibilité une seule fois et garde l'instantané du modèle tronqué", () => {
    const script = compileAction(
      { type: "goto", path: "/" },
      "https://preview.test/",
      undefined,
      { evidenceSnapshotChars: PLAN_EVIDENCE_SNAPSHOT_CHARS }
    );
    expect(script.match(/snapshotForAI/g)).toHaveLength(1);
    expect(script).toContain(`slice(0, ${MODEL_SNAPSHOT_CHARS})`);
    expect(script).toContain(
      `evidence: ariaSnapshot.slice(0, ${PLAN_EVIDENCE_SNAPSHOT_CHARS})`
    );
  });
  it("n'ajoute aucune évidence aux étapes de scénario", () => {
    const script = compileAction(
      { type: "click", locator: { by: "role", value: "button", name: "P&L" } },
      "https://preview.test/"
    );
    expect(script.match(/snapshotForAI/g)).toHaveLength(1);
    expect(script).not.toContain("evidence:");
  });
});

describe("scénario refusé avant exécution", () => {
  it("bloque le scénario sans dépenser aucune étape navigateur", async () => {
    const f = await setup();
    const labels = stubCanary(ARIA);
    scriptPlan(PlanSchema.parse(observedPlan()));
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.scenarios).toHaveLength(1);
    const scenario = result.scenarios[0]!;
    expect(scenario.outcome).toBe("blocked");
    expect(scenario.diagnostic?.code).toBe("PLAN_TARGET_MISSING");
    expect(scenario.error).toContain("preview-badge-kept-across-views");
    expect(scenario.error).toContain('role=heading name="P&L"');
    expect(scenario.steps).toEqual([]);
    expect(scenario.artifacts).toEqual([]);
    // Seule la découverte ouvre le navigateur : le scénario refusé n'exécute rien.
    expect(labels).toEqual(["discover-preview"]);
    expect(
      f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
        .state
    ).toBe("error");
    const saved = JSON.parse(
      await readFile(join(f.dataDir, result.id, "result.json"), "utf8")
    ) as { scenarios: { diagnostic?: { code?: string } }[] };
    expect(saved.scenarios[0]?.diagnostic?.code).toBe("PLAN_TARGET_MISSING");
    const events = await readFile(
      join(f.dataDir, result.id, "events.jsonl"),
      "utf8"
    );
    expect(events).toContain('"PLAN_TARGET_MISSING"');
    expect(events).toContain("aucune étape navigateur n'a été dépensée");
  });
  it("exécute normalement un scénario dont la cible existe", async () => {
    const f = await setup();
    const labels = stubCanary(ARIA);
    scriptPlan(
      PlanSchema.parse(
        readOnlyPlan({ by: "role", value: "heading", name: "Pilotage" })
      )
    );
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(labels).toEqual([
      "discover-preview",
      "open-preview",
      "1-goto",
      "2-assert",
    ]);
    const events = await readFile(
      join(f.dataDir, result.id, "events.jsonl"),
      "utf8"
    );
    expect(events).not.toContain('"PLAN_EVIDENCE_INCOMPLETE"');
  });
  it("n'oppose aucun refus quand l'instantané est coupé au plafond, mais le dit", async () => {
    const f = await setup();
    stubCanary("x".repeat(PLAN_EVIDENCE_SNAPSHOT_CHARS));
    scriptPlan(
      PlanSchema.parse(
        readOnlyPlan({ by: "role", value: "heading", name: "P&L" })
      )
    );
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    expect(result.scenarios[0]?.outcome).toBe("passed");
    const events = await readFile(
      join(f.dataDir, result.id, "events.jsonl"),
      "utf8"
    );
    expect(events).toContain('"PLAN_EVIDENCE_INCOMPLETE"');
    expect(events).toContain("coupé au plafond");
  });
});

describe("sélecteur construit sur une classe ou une couleur", () => {
  const refusals = (value: string) =>
    unstableSelectorRefusals(
      PlanSchema.parse(readOnlyPlan({ by: "css", value }))
    );
  it("refuse la forme observée p[class*=...] et une classe simple", () => {
    const observed = refusals('p[class*="text-[#b42318]"]');
    expect(observed).toHaveLength(1);
    expect(observed[0]?.error.code).toBe("PLAN_SELECTOR_UNSTABLE");
    expect(observed[0]?.error.message).toContain(
      'a class attribute selector ([class*="text-[#b42318]"])'
    );
    expect(observed[0]?.error.message).toContain("heading-visible");
    expect(observed[0]?.error.message).toContain(
      "load (assertion heading) → css="
    );
    expect(observed[0]?.error.hint).toContain(
      "a role with its accessible name"
    );
    expect(observed[0]?.error.hint).toContain('kind "hidden"');
    const simple = refusals(".text-red-500");
    expect(simple).toHaveLength(1);
    expect(simple[0]?.error.message).toContain("a class name (.text-red-500)");
    for (const value of [
      "button.text-red-500",
      "css=.text-red-500",
      ":not(.hidden)",
      '[class^="text-"]',
      "[class$=500]",
      '[class~="text-red-500"]',
      "[class|=foo]",
      "[class=foo].bar",
      "div[data-x].b",
      'p[class*="text-[rgb(180,35,24)]"]',
    ]) {
      expect(refusals(value), value).toHaveLength(1);
    }
  });
  it("refuse la couleur de la déclaration qui la porte", () => {
    for (const value of [
      '[style*="color:#fff8"]',
      '[style*="fill:#FFFFFF80"]',
      '[style*="color:rgb(180, 35, 24)"]',
      '[style*="color:hsl(0 80% 50%)"]',
      '[style*="color: hsla(1,2%,3%,.5)"]',
      '[style*="color: hwb(0 0% 0%)"]',
      '[style*="color:lab(50% 0 0)"]',
      '[style*="color: lch(50% 40 30)"]',
      '[style*="color: oklab(50% 0.1 0.1)"]',
      '[style*="color: oklch(50% 0.1 30)"]',
      '[style*="color: color-mix(in srgb, red, blue)"]',
      '[style*="color: red"]',
      '[style*="background:white"]',
      "[background-color:white]",
      "[stroke=white]",
      '[fill="#b42318"]',
      "[stroke=#fff]",
      '[style="color:#b42318"]',
      '[style*="border-color: hsl(0 0% 0%)"]',
      '[style*="color:transparent"]',
      '[style*="border:1px solid red"]',
      '[style*="box-shadow:0 0 0 1px #b42318"]',
    ]) {
      expect(refusals(value), value).toHaveLength(1);
    }
  });
  it("cite la déclaration de couleur, sans guillemet ni deux-points voisins", () => {
    const declaration = refusals('[style*="background:rgb(0,0,0)"]')[0];
    expect(declaration?.error.message).toContain(
      "a color value (background:rgb(0,0,0))"
    );
    const attribute = refusals('[fill="#b42318"]')[0];
    expect(attribute?.error.message).toContain("a color value (fill=#b42318)");
  });
  it("accepte une référence url(), jamais une couleur", () => {
    for (const value of [
      "[fill=url(#abc)]",
      "[stroke=url(#FFFFFF)]",
      '[fill="url( #abc )"]',
      '[fill="url(#gradient-a1b2c3)"]',
      '[style*="background:url(#abc)"]',
      '[style*="filter:url(#abc)"]',
      '[style*="background-image:url(#ffffff)"]',
    ]) {
      expect(refusals(value), value).toEqual([]);
    }
  });
  it("accepte une donnée de la page, même quand sa valeur ressemble à une couleur", () => {
    for (const value of [
      "[data-state=red]",
      "[value=red]",
      "[data-color=red]",
      "[fill=none]",
      "[data-file=report.png]",
      "[data-testid=user.name]",
      "[data-x=foo.bar]",
      '[aria-label="#abc"]',
      '[id="#abc"]',
      '[value="#ffffff"]',
      '[data-label="rgb(0,0,0)"]',
      '[style*="display:none"]',
      '[style*="background-repeat:no-repeat"]',
    ]) {
      expect(refusals(value), value).toEqual([]);
    }
  });
  it("lit chaque segment d'une chaîne de sélecteurs", () => {
    for (const value of [
      "role=button >> .foo",
      "role=button >> [class*=x]",
      "text=hi >> css=.text-red-500",
      '[style*="color:#fff8"] >> role=button',
    ]) {
      expect(refusals(value), value).toHaveLength(1);
    }
    for (const value of [
      'role=button[name="Save"]',
      "text=Se connecter",
      'role=button >> [aria-label="#abc"]',
      '[aria-label="a>>b"]',
    ]) {
      expect(refusals(value), value).toEqual([]);
    }
  });
  it("nomme l'assertion refusée, pas seulement son étape", () => {
    const plan = PlanSchema.parse(
      readOnlyPlan({ by: "css", value: ".text-red-500" })
    );
    const scenario = plan.scenarios[0]!;
    const assertion = scenario.assertions[0]!;
    const named = unstableSelectorRefusals({
      ...plan,
      scenarios: [
        {
          ...scenario,
          assertions: [
            {
              ...assertion,
              id: "heading-a",
              target: { by: "css", value: ".text-red-500" },
            },
            {
              ...assertion,
              id: "heading-b",
              target: { by: "css", value: ".text-blue-500" },
            },
          ],
        },
      ],
    });
    expect(named).toHaveLength(1);
    const message = named[0]?.error.message ?? "";
    expect(message).toContain("load (assertion heading-a) → ");
    expect(message).toContain("load (assertion heading-b) → ");
  });
  it("n'oppose aucun refus à un id, une chaîne, un data-* ou un autre moteur", () => {
    for (const value of [
      "#saved",
      "#abc",
      '[aria-label="Save.now"]',
      '[data-cash-state="cloture"]',
      'a[href$=".pdf"]',
      'role=status[name=""]',
      "text=Save.now",
      "label=Save.now",
      "input",
      "#saved > span",
    ]) {
      expect(refusals(value), value).toEqual([]);
    }
  });
});

describe("sélecteur instable refusé avant exécution", () => {
  const unstable = () =>
    PlanSchema.parse(readOnlyPlan({ by: "css", value: ".text-red-500" }));
  const repaired = () =>
    PlanSchema.parse(
      readOnlyPlan({ by: "role", value: "heading", name: "Pilotage" })
    );
  /** Corrections envoyées au planificateur, une par refus de plan. */
  function plannerFeedback(f: Awaited<ReturnType<typeof fixture>>): string[] {
    return f.modelRequests
      .filter((request) =>
        (request.messages as { content: string }[])[0]?.content.startsWith(
          "You plan"
        )
      )
      .filter((request) => (request.messages as unknown[]).length > 2)
      .map(
        (request) =>
          (request.messages as { content: string }[]).at(-1)?.content ?? ""
      );
  }
  it("envoie le refus au planificateur puis exécute le plan corrigé", async () => {
    const f = await setup({ plans: [unstable(), repaired()] });
    stubCanary(ARIA);
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(plannerFeedback(f)).toHaveLength(1);
    expect(plannerFeedback(f)[0]).toContain("a class name (.text-red-500)");
    expect(plannerFeedback(f)[0]).toContain("a role with its accessible name");
    expect(result.outcome).toBe("passed");
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(result.plan?.scenarios[0]?.assertions[0]?.target?.value).toBe(
      "heading"
    );
  });
  it("bloque le scénario non corrigé sans dépenser d'étape navigateur", async () => {
    const f = await setup({ plans: [unstable()] });
    const labels = stubCanary(ARIA);
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const scenario = result.scenarios[0]!;
    expect(scenario.outcome).toBe("blocked");
    expect(scenario.diagnostic?.code).toBe("PLAN_SELECTOR_UNSTABLE");
    expect(scenario.error).toContain(".text-red-500");
    expect(scenario.steps).toEqual([]);
    expect(scenario.artifacts).toEqual([]);
    // La découverte seule ouvre le navigateur : le scénario refusé n'exécute rien.
    expect(labels).toEqual(["discover-preview"]);
    expect(plannerFeedback(f)).toHaveLength(1);
    expect(result.outcome).toBe("blocked");
  });
});
