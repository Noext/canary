import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertionMatches,
  Canary,
  compileAction,
  MODEL_SNAPSHOT_CHARS,
  PLAN_EVIDENCE_SNAPSHOT_CHARS,
} from "../src/canary.js";
import { Model } from "../src/model.js";
import {
  ariaLiteralSpellings,
  ariaRoleNameNodes,
  ariaRoleNames,
  missingExpectationRefusals,
  planEvidenceDiagnostic,
  typographicTargetNote,
  unstableSelectorRefusals,
  validatePlanEvidence,
} from "../src/plan-evidence.js";
import { runQa } from "../src/runner.js";
import { type Locator, type Plan, PlanSchema } from "../src/schema.js";
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

/** Scénario sans interaction qui compte les éléments portant la cible visée. */
function countPlan(target: Locator, expected: number): Plan {
  const contract = readOnlyPlan(target);
  contract.scenarios[0]!.assertions[0] = {
    id: "heading",
    description: "Le titre de l'en-tête apparaît le nombre de fois attendu",
    kind: "count",
    expected,
    target,
    afterStep: "load",
    verification: "state",
  };
  return contract;
}

function scriptPlan(plan: Plan) {
  vi.spyOn(Model.prototype, "json").mockImplementationOnce(
    (async () => plan) as unknown as Model["json"]
  );
}

/** Remplace Canary par une session de découverte scriptée, comme le fait le run réel. */
function stubCanary(evidence: string, actual: unknown = true) {
  const labels: string[] = [];
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("fixture-session");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_id: string, label: string) => {
      labels.push(label);
      return {
        url: "http://fixture/",
        snapshot: ARIA.slice(0, MODEL_SNAPSHOT_CHARS),
        evidence: label === "discover-preview" ? evidence : undefined,
        actual: label.endsWith("assert") ? actual : undefined,
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
  it("lit les textes littéraux et les placeholders, jamais les noms", () => {
    const spellings = ariaLiteralSpellings(
      `- main [ref=e1]:
  - paragraph: Justification de l’écart
  - text: "Prix: 12 €"
  - button "Justification de l’écart" [ref=e2]
  - textbox "Champ" [ref=e3]:
    - /placeholder: Justification de l’écart`
    );
    // Le nom accessible d'un contrôle n'est pas du texte pour `getByText`, et un
    // nom entre guillemets n'est pas un contenu : seuls les contenus texte et les
    // valeurs de `placeholder` instruisent une cible littérale.
    expect(spellings.texts).toEqual(["Justification de l’écart", "Prix: 12 €"]);
    expect(spellings.placeholders).toEqual(["Justification de l’écart"]);
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
        // Les deux graphies exposées se nomment : le refus dit l'ambiguïté au
        // lieu de laisser deviner laquelle des deux existe.
        near: [
          {
            target: 'role=textbox name="Justification de l’écart"',
            elements: 1,
          },
          {
            target: 'role=textbox name="Justification de l‘écart"',
            elements: 1,
          },
        ],
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
  it("compte les éléments quand deux boutons portent la graphie repliée", () => {
    // Reproduction du finding P2 : le plan vise « save », la page expose deux
    // boutons « SAVE ». La casse uniforme est une graphie du repli, mais elle
    // atteint deux éléments : le refus doit dire qu'ils sont plusieurs au lieu de
    // laisser lire un candidat unique, et n'en désigner aucun comme la cible
    // réelle — recopier « SAVE » viserait encore deux éléments.
    const planned = readOnlyPlan({
      by: "role",
      value: "button",
      name: "save",
    });
    const report = validatePlanEvidence(PlanSchema.parse(planned), {
      url: "https://preview.test/",
      aria: `- main [ref=e1]:\n  - button "SAVE" [ref=e2]\n  - button "SAVE" [ref=e3]`,
    });
    expect(report.refusals).toEqual([
      {
        scenarioId: "heading-visible",
        stepId: "check-heading",
        target: 'role=button name="save"',
        near: [{ target: 'role=button name="SAVE"', elements: 2 }],
      },
    ]);
    const { message, hint } = planEvidenceDiagnostic(
      PlanSchema.parse(planned).scenarios[0]!,
      report.refusals,
      0
    );
    expect(message).toContain(
      'la page expose role=button name="SAVE" sur 2 éléments'
    );
    // Aucun des deux éléments n'est présenté comme la cible unique à recopier.
    expect(message).not.toContain("la page expose à la place");
    expect(hint).not.toContain("en recopiant la cible exposée");
  });
  it("refuse un texte ou un placeholder porté par plusieurs graphies, comme role+nom", () => {
    // Le défaut aggravant : role+nom refusait déjà une cible que deux graphies
    // concurrentes rendent inexécutable, alors que text et placeholder laissaient
    // partir le run vers un échec d'ambiguïté. L'instantané porte le paragraphe et
    // le placeholder, donc la même exigence s'applique.
    const planned = "l'écart d'espèces n'est pas justifié";
    const spelled = {
      right: "l’écart d’espèces n’est pas justifié",
      left: "l‘écart d’espèces n’est pas justifié",
    };
    const aria = `- main [ref=e1]:
  - paragraph: ${spelled.right}
  - paragraph: ${spelled.left}
  - textbox "${spelled.right}" [ref=e2]
  - textbox "${spelled.left}" [ref=e3]`;
    for (const target of [
      { by: "text" as const, value: planned },
      { by: "placeholder" as const, value: planned },
    ]) {
      const report = validatePlanEvidence(
        PlanSchema.parse(readOnlyPlan(target)),
        {
          url: "https://preview.test/",
          aria,
        }
      );
      expect(report.incomplete, target.by).toBeUndefined();
      expect(report.refusals, target.by).toEqual([
        {
          scenarioId: "heading-visible",
          stepId: "check-heading",
          target: `${target.by}=${JSON.stringify(planned)}`,
        },
      ]);
      expect(report.inconclusive, target.by).toEqual([]);
    }
    // Une seule graphie concurrente reste exécutable : le repli la résout, donc
    // le plan passe sans dépense inutile.
    const single = validatePlanEvidence(
      PlanSchema.parse(readOnlyPlan({ by: "placeholder", value: planned })),
      {
        url: "https://preview.test/",
        aria: `- main [ref=e1]:\n  - textbox "${spelled.right}" [ref=e2]`,
      }
    );
    expect(single).toEqual({ refusals: [], inconclusive: [] });
  });
  it("refuse un texte ou un placeholder que le repli ne saurait pas énumérer", () => {
    // Six signes repliables dépassent le plafond : l'exécution lève au lieu de
    // mesurer dès que la page n'expose pas la graphie du plan. Un jumeau
    // typographique exposé prouve ce cas, donc le plan est refusé avant dépense,
    // comme pour un nom.
    const saturated = "l'l'l'l'l'l'";
    const twin = saturated.replace(/'/g, "\u2019");
    const aria = `- main [ref=e1]:\n  - paragraph: ${twin}\n  - textbox "${twin}" [ref=e2]`;
    for (const target of [
      { by: "text" as const, value: saturated },
      { by: "placeholder" as const, value: saturated },
    ]) {
      const report = validatePlanEvidence(
        PlanSchema.parse(readOnlyPlan(target)),
        {
          url: "https://preview.test/",
          aria,
        }
      );
      expect(
        report.refusals.map((item) => item.target),
        target.by
      ).toEqual([`${target.by}=${JSON.stringify(saturated)}`]);
    }
    // Sans jumeau exposé, la graphie du plan peut être celle de la page : la
    // preuve manque et le plan n'est pas refusé sur une simple absence.
    const silent = validatePlanEvidence(
      PlanSchema.parse(readOnlyPlan({ by: "text", value: saturated })),
      {
        url: "https://preview.test/",
        aria: "- main [ref=e1]:\n  - paragraph: Justification du montant",
      }
    );
    expect(silent.refusals).toEqual([]);
    expect(silent.inconclusive[0]?.reason).toBe(
      "graphies de la cible non énumérables au plafond du repli, et aucune n'est exposée"
    );
  });
  it("déclare non concluant un texte ou un placeholder absent de l'instantané", () => {
    // L'instantané ne porte pas tous les textes ni tous les placeholders : leur
    // absence reste une preuve insuffisante, jamais un refus.
    for (const target of [
      { by: "text" as const, value: "Justification de l'écart" },
      { by: "placeholder" as const, value: "Justification de l'écart" },
    ]) {
      const report = validatePlanEvidence(
        PlanSchema.parse(readOnlyPlan(target)),
        {
          url: "https://preview.test/",
          aria: ARIA,
        }
      );
      expect(report.refusals, target.by).toEqual([]);
      expect(report.inconclusive, target.by).toEqual([
        {
          scenarioId: "heading-visible",
          stepId: "check-heading",
          target: `${target.by}=${JSON.stringify(target.value)}`,
          reason: "aucune graphie de la cible dans l'instantané de découverte",
        },
      ]);
    }
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
  it("accepte un comptage porté par la seule graphie décalée, sans exiger l'unicité", () => {
    const target = {
      by: "role" as const,
      value: "textbox",
      name: "Justification de l'écart",
    };
    // Deux éléments portent la graphie exposée : « count: 2 » est vrai, mais
    // deux nœuds ne sont pas un candidat unique. Une assertion de comptage ne
    // choisit pas un élément, donc l'unicité n'a pas de sens ici.
    const twice = validatePlanEvidence(PlanSchema.parse(countPlan(target, 2)), {
      url: "https://preview.test/",
      aria: `- main [ref=e1]:\n  - textbox "Justification de l’écart" [ref=e2]\n  - textbox "Justification de l’écart" [ref=e3]`,
    });
    expect(twice).toEqual({ refusals: [], inconclusive: [] });
    // Un total qui ne tombe pas juste reste un comptage honnête : la cible est
    // présente, donc le plan est exécutable et le verdict appartient à
    // l'exécution, jamais à un refus d'unicité.
    const mismatched = validatePlanEvidence(
      PlanSchema.parse(countPlan(target, 2)),
      {
        url: "https://preview.test/",
        aria: `- main [ref=e1]:\n  - textbox "Justification de l’écart" [ref=e2]\n  - textbox "Justification de l’écart" [ref=e3]\n  - textbox "Justification de l’écart" [ref=e4]`,
      }
    );
    expect(mismatched).toEqual({ refusals: [], inconclusive: [] });
    // En revanche une cible que rien ne porte reste refusée : un comptage ne
    // peut pas s'appuyer sur une graphie absente de la page.
    const absent = validatePlanEvidence(
      PlanSchema.parse(countPlan(target, 2)),
      {
        url: "https://preview.test/",
        aria: `- main [ref=e1]:\n  - textbox "Justification du montant" [ref=e2]`,
      }
    );
    expect(absent.refusals).toHaveLength(1);
    // Une assertion de visibilité garde l'exigence d'unicité : deux graphies
    // concurrentes restent refusées, sans quoi le run échouerait en ambiguïté.
    const visibility = validatePlanEvidence(
      PlanSchema.parse(
        readOnlyPlan({
          by: "role",
          value: "textbox",
          name: "Justification de l'écart",
        })
      ),
      {
        url: "https://preview.test/",
        aria: `- main [ref=e1]:\n  - textbox "Justification de l’écart" [ref=e2]\n  - textbox "Justification de l‘écart" [ref=e3]`,
      }
    );
    expect(visibility.refusals).toHaveLength(1);
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
        // La page porte ce nom sous un bouton : le refus le nomme, sans
        // l'accepter à la place du titre visé.
        near: [{ target: 'role=button name="P&L"', elements: 1 }],
      },
    ]);
    expect(report.inconclusive).toEqual([]);
  });
  it("nomme le rôle réel quand la page expose le même nom sous un autre rôle", () => {
    // Un `<input type="number">` s'annonce `spinbutton`, jamais `textbox` : le
    // nom du plan existe, seul son rôle est faux, et le refus doit dire lequel.
    const report = validatePlanEvidence(
      PlanSchema.parse(
        readOnlyPlan({
          by: "role",
          value: "textbox",
          name: "Quantité · Pièce de 20 €",
        })
      ),
      {
        url: "https://preview.test/",
        aria: '- main [ref=e1]:\n  - spinbutton "Quantité · Pièce de 20 €" [ref=e2]',
      }
    );
    expect(report.refusals).toEqual([
      {
        scenarioId: "heading-visible",
        stepId: "check-heading",
        target: 'role=textbox name="Quantité · Pièce de 20 €"',
        near: [
          {
            target: 'role=spinbutton name="Quantité · Pièce de 20 €"',
            elements: 1,
          },
        ],
      },
    ]);
    // Le refus reste un refus : nommer la cible réelle n'autorise jamais à viser
    // une cible que le plan n'a pas écrite.
    expect(report.inconclusive).toEqual([]);
  });
  it("nomme la cible réelle quand un seul mot diffère", () => {
    // Écart mesuré du lot L, run 445c9178 : le plan recopie « Pièce de 10 € »,
    // la page expose « Billet de 10 € » pour la même ligne de comptage.
    const report = validatePlanEvidence(
      PlanSchema.parse(
        readOnlyPlan({
          by: "role",
          value: "textbox",
          name: "Quantité · Pièce de 10 €",
        })
      ),
      {
        url: "https://preview.test/",
        aria: `- main [ref=e1]:
  - textbox "Quantité · Billet de 10 €" [ref=e2]
  - textbox "Quantité · Billet de 20 €" [ref=e3]`,
      }
    );
    expect(report.refusals).toEqual([
      {
        scenarioId: "heading-visible",
        stepId: "check-heading",
        target: 'role=textbox name="Quantité · Pièce de 10 €"',
        // La ligne de 20 € diffère par deux mots : elle n'est pas nommée.
        near: [
          {
            target: 'role=textbox name="Quantité · Billet de 10 €"',
            elements: 1,
          },
        ],
      },
    ]);
  });
  it("nomme l'ambiguïté quand deux candidats la portent", () => {
    const planned = readOnlyPlan({
      by: "role",
      value: "textbox",
      name: "Quantité · Pièce de 10 €",
    });
    const report = validatePlanEvidence(PlanSchema.parse(planned), {
      url: "https://preview.test/",
      aria: `- main [ref=e1]:
  - textbox "Quantité · Billet de 10 €" [ref=e2]
  - textbox "Quantité · Rouleau de 10 €" [ref=e3]`,
    });
    expect(report.refusals[0]?.near).toEqual([
      { target: 'role=textbox name="Quantité · Billet de 10 €"', elements: 1 },
      { target: 'role=textbox name="Quantité · Rouleau de 10 €"', elements: 1 },
    ]);
    const { message, hint } = planEvidenceDiagnostic(
      PlanSchema.parse(planned).scenarios[0]!,
      report.refusals,
      0
    );
    expect(message).toContain("plusieurs cibles approchantes");
    expect(message).toContain('role=textbox name="Quantité · Billet de 10 €"');
    expect(message).toContain('role=textbox name="Quantité · Rouleau de 10 €"');
    expect(hint).toContain("en recopiant la cible exposée");
  });
  it("rattache chaque candidat à son refus, sans annoncer une ambiguïté inventée", () => {
    // Deux cibles absentes à un candidat chacune : agréger les candidats au
    // niveau du scénario annonçait « plusieurs cibles approchantes » alors
    // qu'aucune des deux cibles n'en portait plusieurs, et présentait le
    // candidat d'une cible comme le remplacement de l'autre.
    const planned = readOnlyPlan({
      by: "role",
      value: "textbox",
      name: "Quantité · Pièce de 10 €",
    });
    planned.scenarios[0]!.steps.push({
      id: "check-second",
      description: "vérifier la seconde ligne",
      action: { type: "assert", assertionId: "second" },
    });
    planned.scenarios[0]!.assertions.push({
      id: "second",
      description: "La seconde ligne de comptage est affichée",
      kind: "visible",
      target: {
        by: "role",
        value: "textbox",
        name: "Quantité · Pièce de 20 €",
      },
      afterStep: "load",
      verification: "state",
    });
    const parsed = PlanSchema.parse(planned);
    const report = validatePlanEvidence(parsed, {
      url: "https://preview.test/",
      aria: `- main [ref=e1]:
  - textbox "Quantité · Billet de 10 €" [ref=e2]
  - textbox "Quantité · Billet de 20 €" [ref=e3]`,
    });
    expect(report.refusals).toEqual([
      {
        scenarioId: "heading-visible",
        stepId: "check-heading",
        target: 'role=textbox name="Quantité · Pièce de 10 €"',
        near: [
          {
            target: 'role=textbox name="Quantité · Billet de 10 €"',
            elements: 1,
          },
        ],
      },
      {
        scenarioId: "heading-visible",
        stepId: "check-second",
        target: 'role=textbox name="Quantité · Pièce de 20 €"',
        near: [
          {
            target: 'role=textbox name="Quantité · Billet de 20 €"',
            elements: 1,
          },
        ],
      },
    ]);
    const { message } = planEvidenceDiagnostic(
      parsed.scenarios[0]!,
      report.refusals,
      report.inconclusive.length
    );
    expect(message).not.toContain("plusieurs cibles approchantes");
    expect(message).toContain(
      'check-heading → role=textbox name="Quantité · Pièce de 10 €" (la page expose à la place role=textbox name="Quantité · Billet de 10 €")'
    );
    expect(message).toContain(
      'check-second → role=textbox name="Quantité · Pièce de 20 €" (la page expose à la place role=textbox name="Quantité · Billet de 20 €")'
    );
  });
  it("nomme une graphie que le repli d'exécution n'essaie pas", () => {
    // L'espace insécable exposé n'est pas une graphie énumérable du nom du plan
    // (l'inverse l'est) : le refus nomme la cible réelle au lieu de laisser
    // recopier la même cible une deuxième fois.
    const report = validatePlanEvidence(
      PlanSchema.parse(
        readOnlyPlan({
          by: "role",
          value: "textbox",
          name: "Montant d'espèces attendu",
        })
      ),
      {
        url: "https://preview.test/",
        aria: '- main [ref=e1]:\n  - textbox "Montant d’espèces\u00a0attendu" [ref=e2]',
      }
    );
    expect(report.refusals[0]?.near).toEqual([
      {
        target: 'role=textbox name="Montant d’espèces\u00a0attendu"',
        elements: 1,
      },
    ]);
  });
  it("ne nomme aucun candidat quand la page n'en expose aucun", () => {
    const report = validatePlanEvidence(
      PlanSchema.parse(
        readOnlyPlan({
          by: "role",
          value: "textbox",
          name: "Justification de l'écart",
        })
      ),
      { url: "https://preview.test/", aria: ARIA }
    );
    expect(report.refusals).toHaveLength(1);
    expect(report.refusals[0]?.near).toEqual([]);
  });
  it("accepte une casse uniforme et nomme une casse mêlée", () => {
    // « save » contre « SAVE » : la casse uniforme est une graphie que le repli
    // essaie, donc le plan est exécutable. « Save » est une casse mêlée, qu'une
    // énumération bornée ne peut pas viser (2^n candidats) : le plan reste
    // refusé, et le refus nomme la cible réelle.
    const uniform = validatePlanEvidence(
      PlanSchema.parse(
        readOnlyPlan({ by: "role", value: "button", name: "save" })
      ),
      {
        url: "https://preview.test/",
        aria: '- main [ref=e1]:\n  - button "SAVE" [ref=e2]',
      }
    );
    expect(uniform).toEqual({ refusals: [], inconclusive: [] });
    const mixed = validatePlanEvidence(
      PlanSchema.parse(
        readOnlyPlan({ by: "role", value: "button", name: "save" })
      ),
      {
        url: "https://preview.test/",
        aria: '- main [ref=e1]:\n  - button "Save" [ref=e2]',
      }
    );
    expect(mixed.refusals[0]?.near).toEqual([
      { target: 'role=button name="Save"', elements: 1 },
    ]);
  });
  it("accepte le point médian d'une autre graphie", () => {
    const report = validatePlanEvidence(
      PlanSchema.parse(
        readOnlyPlan({
          by: "role",
          value: "textbox",
          name: "Quantité · Pièce de 20 €",
        })
      ),
      {
        url: "https://preview.test/",
        aria: '- main [ref=e1]:\n  - textbox "Quantité ⋅ Pièce de 20 €" [ref=e2]',
      }
    );
    expect(report).toEqual({ refusals: [], inconclusive: [] });
  });
  it("accepte une graphie qui diffère par la casse et par le signe ensemble", () => {
    // « Quantité · Pièce » contre « QUANTITÉ ⋅ PIÈCE » : chaque écart est déclaré
    // équivalent, donc les deux réunis ne peuvent pas fonder un refus.
    const report = validatePlanEvidence(
      PlanSchema.parse(
        readOnlyPlan({
          by: "role",
          value: "textbox",
          name: "Quantité · Pièce",
        })
      ),
      {
        url: "https://preview.test/",
        aria: '- main [ref=e1]:\n  - textbox "QUANTITÉ ⋅ PIÈCE" [ref=e2]',
      }
    );
    expect(report).toEqual({ refusals: [], inconclusive: [] });
  });
  it("nomme la cible réelle de l'écart mesuré du lot L dans le message de refus", () => {
    // Run 445c9178 : le plan a recopié « Pièce de 10 € » d'une autre source, la
    // page expose « Billet de 10 € ». Le message doit nommer la cible réelle,
    // sans quoi le planificateur recopie la même cible absente.
    const planned = observedPlan();
    planned.scenarios[0]!.steps[1]!.action = {
      type: "fill",
      locator: {
        by: "role",
        value: "textbox",
        name: "Quantité · Pièce de 10 €",
      },
      value: "4",
    };
    const aria = `- main [ref=e1]:
  - textbox "Quantité · Billet de 500 €" [ref=e2]
  - textbox "Quantité · Billet de 10 €" [ref=e3]`;
    const report = validatePlanEvidence(PlanSchema.parse(planned), {
      url: "https://preview.test/",
      aria,
    });
    const { message } = planEvidenceDiagnostic(
      PlanSchema.parse(planned).scenarios[0]!,
      report.refusals,
      report.inconclusive.length
    );
    expect(message).toContain(
      'go-pnl → role=textbox name="Quantité · Pièce de 10 €"'
    );
    expect(message).toContain(
      'la page expose à la place role=textbox name="Quantité · Billet de 10 €"'
    );
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
    expect(hint).toContain("css/label/testId");
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
      "div > #saved",
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

/**
 * Le scénario du run 93cd4991 (`comptage-juste-cloture`), réduit à sa forme
 * fautive : l'assertion du total compté lit `aside > div`, le sélecteur
 * structurel qui a résolu 4 éléments et bloqué les 4 scénarios du run en strict
 * mode. L'identifiant d'assertion est celui de l'artefact.
 */
function structuralPlan(selector = "aside > div"): Plan {
  const base = readOnlyPlan({ by: "css", value: selector });
  const scenario = base.scenarios[0]!;
  return {
    ...base,
    scenarios: [
      {
        ...scenario,
        id: "comptage-juste-cloture",
        steps: scenario.steps.map((step) =>
          step.id === "check-heading"
            ? {
                ...step,
                id: "check-total",
                description: "vérifier le total compté",
                action: {
                  type: "assert" as const,
                  assertionId: "total-compte",
                },
              }
            : step
        ),
        assertions: [
          {
            ...scenario.assertions[0]!,
            id: "total-compte",
            description: "Le total compté est affiché : 1 240,00 €",
            kind: "text",
            expected: "1 240,00 €",
            target: { by: "css", value: selector },
            afterStep: "load",
            verification: "state",
          },
        ],
      },
    ],
  };
}

/** La même assertion une fois la cible nommée : `#saved` porte l'élément. */
function namedPlan(): Plan {
  const base = PlanSchema.parse(structuralPlan("#saved"));
  const scenario = base.scenarios[0]!;
  const { expected: _expected, ...presence } = scenario.assertions[0] as {
    expected?: unknown;
  };
  const assertion = {
    ...presence,
    kind: "visible" as const,
  } as (typeof scenario.assertions)[number];
  return {
    ...base,
    scenarios: [{ ...scenario, assertions: [assertion] }],
  };
}

describe("sélecteur structurel : une position ne nomme pas un élément", () => {
  const refusals = (value: string) =>
    unstableSelectorRefusals(
      PlanSchema.parse(readOnlyPlan({ by: "css", value }))
    );
  it("refuse aside > div du run 93cd4991 et rend le message exact", () => {
    const refused = unstableSelectorRefusals(
      PlanSchema.parse(structuralPlan())
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error.code).toBe("PLAN_SELECTOR_UNSTABLE");
    expect(refused[0]?.error.message).toBe(
      'Scenario comptage-juste-cloture targets an element with a CSS selector built from a structural path (aside > div, child combinator >: it names a position instead of an element, so it matches several elements by construction): load (assertion total-compte) → css="aside > div"'
    );
    expect(refused[0]?.error.hint).toContain(
      "it resolves several elements by construction"
    );
  });
  it("refuse chacun des quatre combinateurs et nomme celui qui est en cause", () => {
    const measured = [
      ["aside > div", "child combinator >"],
      ["header h1", "descendant combinator (a space)"],
      ["aside + div", "adjacent-sibling combinator +"],
      ["aside ~ div", "general-sibling combinator ~"],
    ] as const;
    for (const [value, combinator] of measured) {
      const refused = refusals(value);
      expect(refused, value).toHaveLength(1);
      expect(refused[0]?.error.message).toContain(`${combinator}:`);
      expect(refused[0]?.error.message).toContain(
        `css=${JSON.stringify(value)}`
      );
    }
  });
  it("refuse la même position sur un attribut qui ne nomme rien", () => {
    // La forme mesurée du corpus : une présence ([data-cash-state]) puis un
    // chemin positionnel. L'attribut seul n'est pas une ancre.
    const refused = refusals(
      "[data-cash-state] aside > div:first-child > p:nth-of-type(2)"
    );
    expect(refused).toHaveLength(1);
    // La cible stable est déductible du matériel : le conteneur que le plan
    // nomme déjà, [data-cash-state].
    expect(refused[0]?.error.message).toContain(
      "the plan already names [data-cash-state] in it, target that container instead"
    );
  });
  it("nomme l'étape d'action fautive, pas seulement son identifiant", () => {
    const plan = PlanSchema.parse(structuralPlan());
    const scenario = plan.scenarios[0]!;
    const stepPlan: Plan = {
      ...plan,
      scenarios: [
        {
          ...scenario,
          steps: [
            {
              id: "count-500",
              description: "compter 2 billets de 500 €",
              action: {
                type: "fill",
                locator: { by: "css", value: "aside > div" },
                value: "2",
              },
            },
            ...scenario.steps,
          ],
        },
      ],
    };
    const refused = unstableSelectorRefusals(stepPlan);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error.message).toContain(
      'count-500 → css="aside > div"'
    );
  });
  it("refuse une alternative positionnelle d'une liste de sélecteurs", () => {
    // Une liste est lue alternative par alternative : `#saved` nomme son
    // élément, `aside > div` n'en nomme aucun, et Playwright résout l'union
    // des deux, donc le strict mode tombe sur la seconde.
    const refused = refusals("#saved, aside > div");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error.message).toContain("aside > div");
    expect(refused[0]?.error.message).toContain("child combinator >");
  });
  it("refuse une pseudo-classe positionnelle sans combinateur", () => {
    // Le prompt et le catalogue du dashboard annoncent :nth-of-type comme une
    // position : le contrôle doit la refuser sans qu'un combinateur la porte.
    for (const value of [
      "div:nth-of-type(2)",
      "li:first-child",
      "td:nth-child(3)",
    ]) {
      const refused = refusals(value);
      expect(refused, value).toHaveLength(1);
      expect(refused[0]?.error.message).toContain("positional pseudo-class");
    }
  });
  it("n'oppose aucun refus à une liste dont chaque alternative nomme son élément", () => {
    for (const value of [
      "#saved, #total",
      '[data-testid="total"], [role="status"]',
      'li:first-child[id="saved"]',
    ]) {
      expect(refusals(value), value).toEqual([]);
    }
  });
  it("n'oppose aucun refus à une cible qui nomme son élément", () => {
    // Non-régression : id, attribut qui porte une valeur, rôle+nom, data-*
    // stable et forme de seule présence restent acceptés, combinateur ou non.
    for (const value of [
      'header [data-canary-preview="pr"]',
      "div > #saved",
      'input[inputmode="numeric"]:disabled',
      '[role="status"]',
      '[data-cash-state="cloture"]',
      "[data-cash-state]",
      "#saved",
      "div",
    ]) {
      expect(refusals(value), value).toEqual([]);
    }
  });
  it("refuse un chemin dont seul l'ANCÊTRE est nommé", () => {
    // L'ancre doit désigner l'élément SÉLECTIONNÉ : `span` reste `span` sous un
    // conteneur stable, donc Playwright le refuse en strict mode dès qu'il y en
    // a deux. Chaque forme porte une ancre, aucune ne nomme sa cible.
    const refusedForms = [
      ["#saved > span", "child combinator >"],
      ['[data-testid="total"] > span', "child combinator >"],
      [
        'label:has(input[aria-label="Quantité · Billet de 500 €"]) > span:nth-of-type(2)',
        "positional pseudo-class :nth-of-type",
      ],
      ["#saved span", "descendant combinator (a space)"],
      ["#saved + div", "adjacent-sibling combinator +"],
    ] as const;
    for (const [value, position] of refusedForms) {
      const refused = refusals(value);
      expect(refused, value).toHaveLength(1);
      expect(refused[0]?.error.message, value).toContain(
        `structural path (${value}, ${position}: it names a position instead of an element`
      );
    }
  });
  it("refuse une ancre écrite dans :has(), qui nomme un descendant", () => {
    // `#saved > div:has(#total)` sélectionne le `div` qui CONTIENT `#total` :
    // l'id y décrit un descendant, pas le `div` visé, et le conteneur stable
    // `#saved` ne le rend pas unique pour autant.
    for (const value of [
      "#saved > div:has(#total)",
      '#saved > div:has([data-testid="total"])',
    ]) {
      const refused = refusals(value);
      expect(refused, value).toHaveLength(1);
      expect(refused[0]?.error.message, value).toContain(
        "names a position instead of an element"
      );
    }
  });
  it("bloque le scénario structurel non corrigé avant toute étape navigateur", async () => {
    const f = await setup({ plans: [PlanSchema.parse(structuralPlan())] });
    const labels = stubCanary(ARIA);
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const scenario = result.scenarios[0]!;
    expect(scenario.outcome).toBe("blocked");
    expect(scenario.diagnostic?.code).toBe("PLAN_SELECTOR_UNSTABLE");
    expect(scenario.error).toContain("aside > div");
    // Refusé AVANT exécution : aucune étape navigateur, aucun artefact.
    expect(scenario.steps).toEqual([]);
    expect(scenario.artifacts).toEqual([]);
    expect(labels).toEqual(["discover-preview"]);
  });
  it("exécute la même assertion une fois la cible nommée", async () => {
    const f = await setup({ plans: [namedPlan()] });
    const labels = stubCanary(ARIA);
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome, result.scenarios[0]?.error ?? "").toBe("passed");
    expect(labels).toEqual([
      "discover-preview",
      "open-preview",
      "1-goto",
      "2-assert",
    ]);
  });
});

/**
 * Le plan réel du run 5c5cfdb6 (PR pharmania/arpilabe-pilotage#17), scénario
 * `caisse-variance-justification`. L'assertion qui a fait échouer ce run porte
 * un attendu NON vide : le plan avait écrit 500,00 € là où son propre scénario —
 * 3 billets de 500,00 € comptés contre 1 240,00 € attendus — produit 260,00 €.
 * Ces deux chaînes sont recopiées de l'artefact, et c'est leur différence qui
 * explique l'échec : pas une valeur attendue absente.
 */
const VARIANCE_EXPECTED =
  "Écart de 500,00 € : une justification écrite est obligatoire avant clôture.";
const VARIANCE_ACTUAL =
  "Écart de 260,00 € : une justification écrite est obligatoire avant clôture.";

/**
 * Le plan réel du run, réduit aux assertions du scénario fautif. Les steps et
 * les exigences ne jouent aucun rôle ici : la règle ne lit que `assertions`.
 */
function measuredVariancePlan(): Plan {
  return {
    summary: "Un écart non nul bloque la clôture jusqu'à justification écrite",
    scenarios: [
      {
        id: "caisse-variance-justification",
        assertions: [
          {
            id: "s2-units",
            description: "three 500 euro notes give three counted units",
            kind: "text",
            expected: "3 unités comptées",
            target: { by: "css", value: "[data-counted-units]" },
            afterStep: "count",
            verification: "state",
          },
          {
            id: "s2-blocking-message",
            description:
              "closing a 500 euro variance without justification is refused",
            kind: "text",
            expected: VARIANCE_EXPECTED,
            target: { by: "css", value: "[data-variance-message]" },
            afterStep: "close",
            verification: "state",
          },
          {
            id: "s2-closed-count",
            description:
              "the container enters the closed state after justified closure",
            kind: "count",
            expected: 1,
            target: { by: "css", value: "[data-cash-state=cloture]" },
            afterStep: "justify",
            verification: "state",
          },
        ],
      },
    ],
    skipped: [],
  } as unknown as Plan;
}

/**
 * Scénario d'un seul `assert` sur le nom enregistré, bâti à la main. C'est la
 * forme qu'un plan rejoué, un plan écrit à la main ou un test atteint SANS
 * passer par `PlanSchema` : le contrôle de lecture doit donc la couvrir seul.
 */
function savedNamePlan(assertion: Record<string, unknown>): Plan {
  return {
    summary: "Le nom enregistré est affiché",
    scenarios: [
      {
        id: "saved-name",
        title: "Le nom enregistré est affiché",
        kind: "regression",
        rationale: "Le diff change le nom affiché",
        sourceFiles: ["src/form.ts"],
        preconditions: [],
        steps: [
          {
            id: "load",
            description: "ouvrir la page d'accueil",
            action: { type: "goto", path: "/" },
          },
          {
            id: "check",
            description: "vérifier le nom affiché",
            action: { type: "assert", assertionId: String(assertion.id) },
          },
        ],
        requirements: [
          {
            sourceFile: "src/form.ts",
            quote: "show('Welcome '+name)",
            behavior: "Le nom enregistré reste affiché",
          },
        ],
        assertions: [assertion],
      },
    ],
    skipped: [],
  } as unknown as Plan;
}

/** Assertion de `saved-name`, avec la cible et l'étape que le contrat exige. */
function savedNameAssertion(
  kind: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: `${kind}-saved`,
    description: "Le nom enregistré est affiché",
    kind,
    target: { by: "css", value: "#saved" },
    afterStep: "load",
    verification: "state",
    ...extra,
  };
}

/** Un scénario, une assertion : la forme minimale que la règle inspecte. */
function assertionOnlyPlan(
  assertions: Record<string, unknown>[],
  scenarioId = "saved-name"
): Plan {
  return {
    summary: "Le nom enregistré est affiché",
    scenarios: [{ id: scenarioId, assertions }],
    skipped: [],
  } as unknown as Plan;
}

describe("assertion sans valeur attendue", () => {
  it("refuse un attendu absent pour les sept kinds qui comparent à une valeur", () => {
    for (const kind of [
      "text",
      "value",
      "url",
      "count",
      "download",
      "popup",
      "visual",
    ]) {
      const refusals = missingExpectationRefusals(
        assertionOnlyPlan([savedNameAssertion(kind)])
      );
      expect(refusals, kind).toHaveLength(1);
      const refusal = refusals[0]!;
      // Le refus nomme le scénario, l'assertion ET le kind : c'est la forme que
      // le planificateur reçoit des autres refus (write evidence, sélecteur).
      expect(refusal.error.code, kind).toBe("PLAN_EXPECTED_MISSING");
      expect(refusal.error.message, kind).toContain("Scenario saved-name");
      expect(refusal.error.message, kind).toContain(`assertion ${kind}-saved`);
      expect(refusal.error.message, kind).toContain(`kind ${kind}`);
      expect(refusal.error.message, kind).toContain("has no expected");
      // L'aide dit quoi écrire, et rappelle la seule exception mesurée.
      expect(refusal.error.hint, kind).toContain('expected: ""');
      expect(refusal.error.hint, kind).toContain("empty field");
      expect(refusal.error.hint, kind).toContain("can never be satisfied");
      expect(refusal.scenario.id, kind).toBe("saved-name");
    }
  });
  it("n'oppose aucun refus aux kinds qui décident sans attendu", () => {
    // `visible` et `hidden` lisent une présence (`actual === true|false`) : eux
    // seuls tranchent sans `expected`. `visual` et `popup` en dépendent — la
    // baseline nommée pour l'un, l'URL ouverte pour l'autre — et sont couverts
    // par le refus ci-dessous.
    for (const kind of ["visible", "hidden"]) {
      expect(
        missingExpectationRefusals(
          assertionOnlyPlan([savedNameAssertion(kind)])
        ),
        kind
      ).toEqual([]);
    }
  });
  it("refuse popup et visual sans valeur à vérifier, et nomme leur attendu", () => {
    // `popup` compare l'URL ouverte à `expected` (`actual === assertion.expected`)
    // et `visual` passe `expected` comme nom de baseline à `compareVisual`, qui
    // lève « Trusted visual baseline undefined is not configured » : sans
    // attendu, l'un échoue à coup sûr et l'autre lève, après avoir dépensé
    // toutes les étapes du scénario.
    for (const kind of ["popup", "visual"]) {
      for (const expected of [undefined, "", " ", "\n\t"]) {
        const refusals = missingExpectationRefusals(
          assertionOnlyPlan([
            savedNameAssertion(
              kind,
              expected === undefined ? {} : { expected }
            ),
          ])
        );
        expect(refusals, `${kind}:${JSON.stringify(expected)}`).toHaveLength(1);
        const refusal = refusals[0]!;
        expect(refusal.error.code, kind).toBe("PLAN_EXPECTED_MISSING");
        expect(refusal.error.message, kind).toContain("Scenario saved-name");
        expect(refusal.error.message, kind).toContain(
          `assertion ${kind}-saved`
        );
        expect(refusal.error.message, kind).toContain(`kind ${kind}`);
      }
      // L'aide dit quelle valeur écrire pour ces deux kinds, comme pour les
      // autres : c'est elle que le planificateur reçoit pour corriger.
      const hinted = missingExpectationRefusals(
        assertionOnlyPlan([savedNameAssertion(kind)])
      )[0]!;
      expect(hinted.error.hint, kind).toContain(
        kind === "popup"
          ? "popup the exact popup URL"
          : "visual the name of a trusted baseline from the fixture catalog"
      );
      // Un attendu non vide reste accepté, même d'un caractère : la règle
      // juge la présence, jamais le contenu.
      for (const expected of ["x", "…", "http://fixture/popup"]) {
        expect(
          missingExpectationRefusals(
            assertionOnlyPlan([savedNameAssertion(kind, { expected })])
          ),
          `${kind}:${expected}`
        ).toEqual([]);
      }
    }
  });
  it("accepte un attendu présent, même d'un caractère ou de ponctuation seule", () => {
    // La règle ne juge jamais le CONTENU d'un texte attendu : un seul
    // caractère, une ponctuation seule ou un chiffre sont des attentes
    // légitimes, et les refuser rouvrirait un faux refus sur des plans justes.
    for (const kind of ["text", "value", "url", "download"]) {
      for (const expected of ["x", "…", "!?—", "0", "  spaced  "]) {
        expect(
          missingExpectationRefusals(
            assertionOnlyPlan([savedNameAssertion(kind, { expected })])
          ),
          `${kind}:${expected}`
        ).toEqual([]);
      }
    }
    for (const expected of [0, 1, 10_000]) {
      expect(
        missingExpectationRefusals(
          assertionOnlyPlan([savedNameAssertion("count", { expected })])
        ),
        `count:${expected}`
      ).toEqual([]);
    }
  });
  it("garde expected vide légal pour value et le refuse pour text", () => {
    // Les deux sens, mesurés : `value: ""` est l'expression de « le champ est
    // vide » (27 assertions, 26 runs), et un `text` vide ne compare à rien —
    // `includes("")` accepte n'importe quelle page.
    expect(
      missingExpectationRefusals(
        assertionOnlyPlan([savedNameAssertion("value", { expected: "" })])
      )
    ).toEqual([]);
    const refused = missingExpectationRefusals(
      assertionOnlyPlan([savedNameAssertion("text", { expected: "" })])
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error.message).toContain("kind text");
    expect(refused[0]?.error.message).toContain("has an empty expected");
    // Un attendu de blancs se normalise en chaîne vide à la comparaison : il est
    // refusé comme le vide, pour text, url et download.
    for (const kind of ["text", "url", "download"]) {
      for (const expected of [" ", "\n\t", "   \n  "]) {
        expect(
          missingExpectationRefusals(
            assertionOnlyPlan([savedNameAssertion(kind, { expected })])
          ),
          `${kind}:${JSON.stringify(expected)}`
        ).toHaveLength(1);
      }
    }
    // Un attendu non textuel ne peut pas être comparé non plus.
    expect(
      missingExpectationRefusals(
        assertionOnlyPlan([savedNameAssertion("value", { expected: null })])
      )
    ).toHaveLength(1);
  });
  it("refuse un compte hors des bornes du schéma, jamais un compte de zéro", () => {
    for (const expected of [1.5, -1, 10_001, "1"]) {
      expect(
        missingExpectationRefusals(
          assertionOnlyPlan([savedNameAssertion("count", { expected })])
        ),
        JSON.stringify(expected)
      ).toHaveLength(1);
    }
    expect(
      missingExpectationRefusals(
        assertionOnlyPlan([savedNameAssertion("count", { expected: 0 })])
      )
    ).toEqual([]);
  });
  it("ne refuse pas le plan réel du run 5c5cfdb6, dont l'échec est un montant faux", () => {
    const plan = measuredVariancePlan();
    // La règle de présence ne dit rien de ce plan : toutes ses assertions
    // portent un attendu. Ce test tombe si on la durcit jusqu'à l'attraper.
    expect(missingExpectationRefusals(plan)).toEqual([]);
    const assertion = plan.scenarios[0]!.assertions.find(
      (item) => item.id === "s2-blocking-message"
    )!;
    const expected = "expected" in assertion ? assertion.expected : undefined;
    expect(expected).toBe(VARIANCE_EXPECTED);
    expect(expected).not.toBe("");
    // L'échec mesuré vient du montant : 500,00 € attendu, 260,00 € produit. La
    // comparaison `text` normalise les blancs, donc l'espace insécable de la
    // page n'y change rien — c'est le chiffre qui diffère.
    expect(assertionMatches(assertion, VARIANCE_ACTUAL)).toBe(false);
    expect(assertionMatches(assertion, VARIANCE_EXPECTED)).toBe(true);
  });
  it("refuse à l'entrée un attendu vide avec une phrase que le planificateur peut suivre", () => {
    // `PlanSchema` refuse déjà ces plans ; ce que ce test fixe, c'est le message
    // rendu au planificateur lors de sa tentative de correction (`model.ts`
    // renvoie les issues du schéma), et non le « Too small » générique.
    expect(() =>
      PlanSchema.parse(
        savedNamePlan(savedNameAssertion("text", { expected: "" }))
      )
    ).toThrow(/expected is required and cannot be blank/);
    expect(() =>
      PlanSchema.parse(
        savedNamePlan(savedNameAssertion("download", { expected: " " }))
      )
    ).toThrow(/expected is required and cannot be blank/);
    // `value: ""` traverse le schéma : c'est la forme légale mesurée.
    const parsed = PlanSchema.parse(
      savedNamePlan(savedNameAssertion("value", { expected: "" }))
    ).scenarios[0]!.assertions[0]!;
    expect("expected" in parsed ? parsed.expected : undefined).toBe("");
  });
});

describe("attendu manquant sur le chemin de lecture", () => {
  it("bloque le scénario sans dépenser d'étape navigateur, aperçu et base", async () => {
    const f = await setup();
    const labels = stubCanary(ARIA);
    // Plan bâti à la main, donc jamais passé par `PlanSchema` : c'est le plan
    // qu'un rejeu ou un appel direct peut faire entrer dans le run.
    scriptPlan(savedNamePlan(savedNameAssertion("text", { expected: "" })));
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      { ...f.config, QA_BASELINE_URL_TEMPLATE: `${f.baseUrl}/baseline` }
    );
    expect(result.outcome).toBe("blocked");
    const scenario = result.scenarios[0]!;
    expect(scenario.outcome).toBe("blocked");
    expect(scenario.diagnostic?.code).toBe("PLAN_EXPECTED_MISSING");
    // Le refus nomme le scénario, l'assertion et le kind.
    expect(scenario.error).toContain("saved-name");
    expect(scenario.error).toContain("assertion text-saved");
    expect(scenario.error).toContain("kind text");
    expect(scenario.steps).toEqual([]);
    expect(scenario.artifacts).toEqual([]);
    // Seule la découverte ouvre le navigateur : le scénario refusé n'exécute rien.
    expect(labels).toEqual(["discover-preview"]);
    // La préversion de base lit la même table de refus : le scénario refusé n'y
    // dépense pas non plus d'étape.
    expect(result.baseline?.scenarios).toEqual([]);
    const events = await readFile(
      join(f.dataDir, result.id, "events.jsonl"),
      "utf8"
    );
    expect(events).toContain('"PLAN_EXPECTED_MISSING"');
  });
  it("refuse à la lecture le plan rejoué dont popup ou visual ne peut rien vérifier", async () => {
    for (const kind of ["popup", "visual"]) {
      const f = await setup();
      const labels = stubCanary(ARIA);
      // Plan rejoué, jamais passé par `PlanSchema` : sans ce refus de lecture,
      // `popup` ne comparerait à rien et `visual` chercherait une baseline
      // `undefined`, après avoir dépensé les étapes du scénario.
      scriptPlan(savedNamePlan(savedNameAssertion(kind)));
      const result = await runQa(
        { prUrl: PR_URL, previewUrl: f.baseUrl },
        { ...f.config, QA_BASELINE_URL_TEMPLATE: `${f.baseUrl}/baseline` }
      );
      expect(result.outcome, kind).toBe("blocked");
      const scenario = result.scenarios[0]!;
      expect(scenario.outcome, kind).toBe("blocked");
      expect(scenario.diagnostic?.code, kind).toBe("PLAN_EXPECTED_MISSING");
      // Le message produit nomme le scénario, l'assertion et le kind...
      expect(scenario.error, kind).toBe(
        `Scenario saved-name compares to nothing: assertion ${kind}-saved (kind ${kind}) has no expected`
      );
      // ...et l'aide dit quelle valeur écrire pour ce kind précis.
      expect(scenario.diagnostic?.hint, kind).toBe(
        `Give each of these assertions the value its requirement produces: text the exact text to match, value the field's exact content, url the exact URL, count an integer between 0 and 10000, download the exact filename, popup the exact popup URL, visual the name of a trusted baseline from the fixture catalog. kind "value" may keep expected: "" to assert an empty field; for text, url, count, download, popup and visual a missing or blank expected can never be satisfied.`
      );
      expect(scenario.steps, kind).toEqual([]);
      expect(scenario.artifacts, kind).toEqual([]);
      // Seule la découverte ouvre le navigateur, et la préversion de base lit la
      // même table de refus : le scénario refusé n'exécute rien, ni ici ni là.
      expect(labels, kind).toEqual(["discover-preview"]);
      expect(result.baseline?.scenarios, kind).toEqual([]);
    }
  });
  it("exécute et accepte un attendu vide de kind value", async () => {
    const f = await setup({
      plans: [savedNamePlan(savedNameAssertion("value", { expected: "" }))],
    });
    // Le champ est réellement vide : `actual === ""` compare à quelque chose.
    const labels = stubCanary(ARIA, "");
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    expect(result.scenarios[0]?.outcome).toBe("passed");
    expect(labels).toContain("2-assert");
    // Aucune correction demandée au planificateur : ce plan est juste.
    expect(
      f.modelRequests.filter(
        (request) => (request.messages as unknown[]).length > 2
      )
    ).toEqual([]);
  });
});
