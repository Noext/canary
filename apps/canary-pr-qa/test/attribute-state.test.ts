import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary, MODEL_SNAPSHOT_CHARS } from "../src/canary.js";
import { Model } from "../src/model.js";
import {
  attributeValueRefusals,
  ifPresentRefusals,
  stateTargetReadRefusals,
} from "../src/plan-evidence.js";
import { reportMarkdown } from "../src/report.js";
import { runQa } from "../src/runner.js";
import { ActionSchema, type Plan, PlanSchema } from "../src/schema.js";
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

/**
 * Instantané de découverte de la vue « Caisse et Coffre » : les trois contrôles
 * que les plans du lot R nomment, plus le texte que la vue affiche quelle que
 * soit la session. Les cibles css (`[data-cash-state]`) restent hors du champ de
 * l'instantané : elles ne sont donc jamais refusées comme cible absente.
 */
const CASH_ARIA = `- main [ref=e1]:
  - navigation [ref=e2]:
    - button "Pilotage" [ref=e3]
    - button "Caisse et Coffre" [ref=e4]
  - heading "Caisse et Coffre" [ref=e5]
  - paragraph: Coupures et pièces
  - button "Clôturer la session" [ref=e6]
  - button "Réouvrir le comptage" [ref=e7]
  - status [ref=e8]`;

type CashState = "ouvert" | "cloture";

/**
 * Page de caisse scriptée, fidèle à la forme MESURÉE dans les artefacts du run
 * 1b49d751 : `data-cash-state` est un attribut du conteneur de la vue, le texte
 * visible de ce conteneur porte « Session en cours » ou « Session clôturée : le
 * comptage est verrouillé. », `Réouvrir le comptage` n'existe que fermé et
 * `Clôturer la session` que ouvert. `innerText` du conteneur ne contient donc
 * jamais `ouvert` ni `cloture` — c'est exactement ce que l'assertion fautive du
 * lot R comparait.
 *
 * L'état de départ est un paramètre : c'est l'état laissé par un run antérieur
 * (« état sale hérité ») que le même scénario doit affronter.
 */
function cashPage(initial: CashState) {
  let state: CashState = initial;
  let view: "pilotage" | "cash" = "pilotage";
  const labels: string[] = [];
  const region = () =>
    view === "pilotage"
      ? "Pilotage\nVue d'ensemble"
      : `Caisse et Coffre\nCoupures et pièces\n${state === "ouvert" ? "Session en cours" : "Session clôturée : le comptage est verrouillé."}`;
  const title = () => (view === "pilotage" ? "Pilotage" : "Caisse et Coffre");
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("cash-session");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_id: string, label: string, script: string) => {
      labels.push(label);
      // Un chargement de page repart de la vue par défaut ; l'état de la caisse,
      // lui, survit — c'est l'état que laisse un run antérieur.
      if (script.includes("page.goto(")) {
        view = "pilotage";
      }
      // Les contrôles n'agissent que dans la vue de caisse, comme la page réelle.
      if (script.includes("Caisse et Coffre")) {
        view = "cash";
      }
      if (view === "cash" && script.includes("Réouvrir le comptage")) {
        state = "ouvert";
      }
      if (view === "cash" && script.includes("Clôturer la session")) {
        state = "cloture";
      }
      return {
        url: "http://fixture/",
        snapshot: CASH_ARIA.slice(0, MODEL_SNAPSHOT_CHARS),
        evidence: label === "discover-preview" ? CASH_ARIA : undefined,
        actual: label === "discover-preview" ? undefined : read(script),
      };
    }
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([
    "video.webm",
    "trace.zip",
  ]);
  function read(raw: string): unknown {
    // Le script compilé échappe les guillemets du sélecteur : on le lit à plat.
    const script = raw.replace(/\\/g, "");
    const stateOf = (wanted: CashState) => view === "cash" && state === wanted;
    if (script.includes("#view-title")) {
      return title();
    }
    for (const wanted of ["ouvert", "cloture"] as const) {
      if (!script.includes(`[data-cash-state="${wanted}"]`)) {
        continue;
      }
      if (script.includes("isVisible()")) {
        return stateOf(wanted);
      }
      if (script.includes(".count()")) {
        return stateOf(wanted) ? 1 : 0;
      }
    }
    // `innerText` du conteneur : le texte VISIBLE de la vue, jamais l'attribut.
    return region();
  }
  return labels;
}

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

function scriptPlan(plan: Plan) {
  vi.spyOn(Model.prototype, "json").mockImplementation(
    (async () => plan) as unknown as Model["json"]
  );
}

const witness = [
  {
    sourceFile: "src/form.ts",
    quote: "show('Welcome '+name)",
    behavior: "La vue de caisse affiche l'état de la session",
  },
];

/**
 * Le scénario `comptage-juste-cloture` du run 1b49d751, recopié de l'artefact
 * (11 étapes, 4 assertions, mêmes identifiants, mêmes descriptions) : c'est
 * l'ordre exact rejoué ici, avec l'assertion fautive `text` sur
 * `[data-cash-state]` attendant la VALEUR DE L'ATTRIBUT. La mesure du corpus
 * montre que cette forme ne peut pas passer, quel que soit l'état de la caisse.
 */
function assumedStatePlan(): Plan {
  return {
    summary: "Le comptage juste clôture puis réouvre la session",
    scenarios: [
      {
        id: "comptage-juste-cloture",
        title:
          "Comptage juste 2 × 500 € + 2 × 100 € + 2 × 20 € = 1 240,00 € : clôture acceptée, écran verrouillé, puis réouverture",
        kind: "happy_path",
        rationale:
          "La clôture sans écart est acceptée, verrouille la saisie et expose l'état par data-cash-state ; la réouverture rebascule l'état.",
        sourceFiles: ["src/form.ts"],
        preconditions: [],
        steps: [
          {
            id: "goto",
            description: "ouvrir l'application",
            action: { type: "goto", path: "/" },
          },
          {
            id: "open-cash",
            description: "ouvrir la vue Caisse et Coffre",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Caisse et Coffre",
              },
            },
          },
          {
            id: "check-open",
            description:
              "vérifier que la session est ouverte avant toute saisie",
            action: { type: "assert", assertionId: "state-ouvert" },
          },
          {
            id: "fill-500",
            description: "compter 2 billets de 500 €",
            action: {
              type: "fill",
              locator: { by: "label", value: "Quantité · Billet de 500 €" },
              value: "2",
            },
          },
          {
            id: "fill-100",
            description: "compter 2 billets de 100 €",
            action: {
              type: "fill",
              locator: { by: "label", value: "Quantité · Billet de 100 €" },
              value: "2",
            },
          },
          {
            id: "fill-20",
            description: "compter 2 billets de 20 €",
            action: {
              type: "fill",
              locator: { by: "label", value: "Quantité · Billet de 20 €" },
              value: "2",
            },
          },
          {
            id: "close",
            description:
              "clôturer la session : total compté 124 000 centimes = montant attendu 124 000 centimes, écart 0",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Clôturer la session",
              },
            },
          },
          {
            id: "assert-closed",
            description: "l'écran passe à l'état clôturé",
            action: { type: "assert", assertionId: "etat-cloture" },
          },
          {
            id: "assert-message",
            description: "le message de clôture confirme le verrouillage",
            action: { type: "assert", assertionId: "message-cloture" },
          },
          {
            id: "reopen",
            description: "réouvrir le comptage",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Réouvrir le comptage",
              },
            },
          },
          {
            id: "assert-reopened",
            description: "l'écran revient à l'état ouvert",
            action: { type: "assert", assertionId: "retour-ouvert" },
          },
        ],
        requirements: witness,
        assertions: [
          {
            id: "state-ouvert",
            description:
              'Avant toute saisie, la session est ouverte : data-cash-state vaut "ouvert".',
            kind: "text",
            expected: "ouvert",
            target: { by: "css", value: "[data-cash-state]" },
            afterStep: "open-cash",
            verification: "state",
          },
          {
            id: "etat-cloture",
            description:
              'La clôture acceptée fait passer data-cash-state de "ouvert" à "cloture".',
            kind: "text",
            expected: "cloture",
            target: { by: "css", value: "[data-cash-state]" },
            afterStep: "close",
            verification: "transition",
          },
          {
            id: "message-cloture",
            description:
              'Le message confirme la clôture : "Session clôturée : le comptage est verrouillé."',
            kind: "text",
            expected: "Session clôturée : le comptage est verrouillé.",
            target: { by: "role", value: "status", name: "" },
            afterStep: "close",
            verification: "state",
          },
          {
            id: "retour-ouvert",
            description:
              'La réouverture fait repasser data-cash-state à "ouvert".',
            kind: "text",
            expected: "ouvert",
            target: { by: "css", value: "[data-cash-state]" },
            afterStep: "reopen",
            verification: "transition",
          },
        ],
      },
    ],
    skipped: [],
  };
}

/**
 * Le même scénario corrigé, qui ÉTABLIT l'état dont il dépend : la réouverture
 * est une étape observable, et l'assertion « ouvert » vient APRÈS elle. Il ne
 * suppose donc rien de l'état laissé par un run antérieur.
 */
function establishesOpenPlan(): Plan {
  return {
    summary:
      "La réouverture rend la session ouverte puis la clôture la verrouille",
    scenarios: [
      {
        id: "reouverture-etablit-letat",
        title:
          "La réouverture établit la session ouverte, puis la clôture la verrouille",
        kind: "happy_path",
        rationale:
          "La réouverture débloque la saisie et la clôture la reverrouille",
        sourceFiles: ["src/form.ts"],
        preconditions: [],
        steps: [
          {
            id: "goto",
            description: "ouvrir l'application",
            action: { type: "goto", path: "/" },
          },
          {
            id: "open-cash",
            description: "ouvrir la vue Caisse et Coffre",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Caisse et Coffre",
              },
            },
          },
          {
            id: "reopen",
            description: "réouvrir le comptage pour établir la session ouverte",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Réouvrir le comptage",
              },
            },
          },
          {
            id: "assert-open",
            description:
              "la session est ouverte, établie par l'étape précédente",
            action: { type: "assert", assertionId: "etabli-ouvert" },
          },
          {
            id: "close",
            description: "clôturer la session établie",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Clôturer la session",
              },
            },
          },
          {
            id: "assert-closed",
            description: "la vue passe à l'état clôturé",
            action: { type: "assert", assertionId: "etabli-cloture" },
          },
        ],
        requirements: witness,
        assertions: [
          {
            id: "etabli-ouvert",
            description:
              'Après l\u2019étape de réouverture, la vue porte l\u2019état ouvert et affiche "Session en cours".',
            kind: "visible",
            target: { by: "css", value: '[data-cash-state="ouvert"]' },
            afterStep: "reopen",
            verification: "state",
          },
          {
            id: "etabli-cloture",
            description:
              'Après la clôture, la vue porte l\u2019état clôturé et affiche "Session clôturée : le comptage est verrouillé."',
            kind: "visible",
            target: { by: "css", value: '[data-cash-state="cloture"]' },
            afterStep: "close",
            verification: "transition",
          },
        ],
      },
    ],
    skipped: [],
  };
}

/**
 * Le pendant du scénario précédent pour une entrée où la session est DÉJÀ
 * ouverte : il établit l'état clôturé par une étape observable, puis rétablit
 * l'état ouvert. Lui aussi n'affirme que des états qu'il a établis.
 */
function establishesClosedPlan(): Plan {
  return {
    summary: "La clôture verrouille la session puis la réouverture la débloque",
    scenarios: [
      {
        id: "cloture-puis-reouverture",
        title:
          "La clôture établit la session verrouillée, la réouverture la débloque",
        kind: "happy_path",
        rationale: "La clôture verrouille la vue et la réouverture la rouvre",
        sourceFiles: ["src/form.ts"],
        preconditions: [],
        steps: [
          {
            id: "goto",
            description: "ouvrir l'application",
            action: { type: "goto", path: "/" },
          },
          {
            id: "open-cash",
            description: "ouvrir la vue Caisse et Coffre",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Caisse et Coffre",
              },
            },
          },
          {
            id: "close",
            description: "clôturer la session pour établir l'état verrouillé",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Clôturer la session",
              },
            },
          },
          {
            id: "assert-closed",
            description:
              "la vue est verrouillée, établie par l'étape précédente",
            action: { type: "assert", assertionId: "etabli-cloture" },
          },
          {
            id: "reopen",
            description: "réouvrir le comptage",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Réouvrir le comptage",
              },
            },
          },
          {
            id: "assert-open",
            description: "la vue redevient ouverte",
            action: { type: "assert", assertionId: "etabli-ouvert" },
          },
        ],
        requirements: witness,
        assertions: [
          {
            id: "etabli-cloture",
            description:
              'Après la clôture, la vue porte l\u2019état clôturé et affiche "Session clôturée : le comptage est verrouillé."',
            kind: "visible",
            target: { by: "css", value: '[data-cash-state="cloture"]' },
            afterStep: "close",
            verification: "transition",
          },
          {
            id: "etabli-ouvert",
            description:
              'Après la réouverture, la vue porte l\u2019état ouvert et affiche "Session en cours".',
            kind: "visible",
            target: { by: "css", value: '[data-cash-state="ouvert"]' },
            afterStep: "reopen",
            verification: "state",
          },
        ],
      },
    ],
    skipped: [],
  };
}

/**
 * Scénario qui n'affirme RIEN de l'état de la session : il ne lit que le texte
 * que la vue affiche dans les deux états. C'est la forme qu'un plan doit prendre
 * quand la page n'offre aucun contrôle qui établit l'état voulu.
 */
function stateIndependentPlan(): Plan {
  return {
    summary:
      "La vue de caisse affiche son titre, quel que soit l'état de la session",
    scenarios: [
      {
        id: "vue-de-caisse-affichee",
        title: "La vue de caisse affiche ses coupures et pièces",
        kind: "regression",
        rationale: "La vue de caisse reste accessible dans les deux états",
        sourceFiles: ["src/form.ts"],
        preconditions: [],
        steps: [
          {
            id: "goto",
            description: "ouvrir l'application",
            action: { type: "goto", path: "/" },
          },
          {
            id: "open-cash",
            description: "ouvrir la vue Caisse et Coffre",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Caisse et Coffre",
              },
            },
          },
          {
            id: "assert-title",
            description: "le titre de la vue change",
            action: { type: "assert", assertionId: "titre-vue" },
          },
          {
            id: "assert-view",
            description: "la vue expose ses coupures et pièces",
            action: { type: "assert", assertionId: "vue-affichee" },
          },
        ],
        requirements: witness,
        assertions: [
          {
            id: "titre-vue",
            description: "Le titre passe de Pilotage à Caisse et Coffre",
            kind: "text",
            expected: "Caisse et Coffre",
            target: { by: "css", value: "#view-title" },
            afterStep: "open-cash",
            verification: "transition",
          },
          {
            id: "vue-affichee",
            description: "La vue de caisse affiche « Coupures et pièces »",
            kind: "text",
            expected: "Coupures et pièces",
            target: { by: "css", value: "[data-cash-state]" },
            afterStep: "open-cash",
            verification: "state",
          },
        ],
      },
    ],
    skipped: [],
  };
}

describe("valeur d'attribut visée par une assertion de texte", () => {
  const refusals = (plan: Plan) =>
    attributeValueRefusals(PlanSchema.parse(plan));

  it('refuse la forme mesurée du run 1b49d751 : text sur [data-cash-state] attendant "ouvert"', () => {
    const refused = refusals(assumedStatePlan());
    expect(refused).toHaveLength(1);
    const error = refused[0]?.error;
    expect(error?.code).toBe("PLAN_ATTRIBUTE_VALUE_READ_AS_TEXT");
    expect(error?.message).toContain("comptage-juste-cloture");
    expect(error?.message).toContain('reads [data-cash-state] for "ouvert"');
    expect(error?.message).toContain('reads [data-cash-state] for "cloture"');
    // Le remède est actionnable : la cible qui porte l'attribut, la voie de
    // lecture correcte, et l'étape qui établit l'état.
    expect(error?.hint).toContain('[data-state="open"]');
    expect(error?.hint).toContain('kind "visible"');
    expect(error?.hint).toContain("Réouvrir le comptage");
    expect(error?.hint).toContain("establish it first");
  });

  it("refuse aussi value sur le conteneur, la forme bloquée du run edb32e58", () => {
    const plan = assumedStatePlan();
    const scenario = plan.scenarios[0]!;
    plan.scenarios = [
      {
        ...scenario,
        assertions: [
          {
            ...scenario.assertions[0]!,
            id: "state-ouvert",
            kind: "value",
            expected: "ouvert",
          },
        ],
        steps: scenario.steps.filter((step) =>
          ["goto", "open-cash", "check-open"].includes(step.id)
        ),
      },
    ];
    const refused = refusals(plan);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error.message).toContain("kind value");
  });

  it("refuse la même lecture sur un sélecteur d'attribut avec valeur", () => {
    const plan = assumedStatePlan();
    const scenario = plan.scenarios[0]!;
    plan.scenarios = [
      {
        ...scenario,
        assertions: [
          {
            ...scenario.assertions[0]!,
            target: { by: "css", value: '[data-cash-state="cloture"]' },
          },
        ],
        steps: scenario.steps.filter((step) =>
          ["goto", "open-cash", "check-open"].includes(step.id)
        ),
      },
    ];
    expect(refusals(plan)).toHaveLength(1);
  });

  it("n'oppose aucun refus au texte visible de la vue, ni à la présence de l'attribut", () => {
    // Les 300+ assertions du corpus qui PASSENT avec ce sélecteur attendent un
    // texte visible, ou visent la valeur d'attribut par la présence.
    for (const assertion of [
      {
        description: "La vue affiche l'état en cours",
        kind: "text" as const,
        expected: "Session en cours",
        target: { by: "css" as const, value: "[data-cash-state]" },
        afterStep: "open-cash",
        verification: "state" as const,
      },
      {
        description: "La clôture est affichée",
        kind: "text" as const,
        expected: "Session clôturée : le comptage est verrouillé.",
        target: { by: "css" as const, value: "[data-cash-state]" },
        afterStep: "open-cash",
        verification: "state" as const,
      },
      {
        description: "Le total compté est affiché",
        kind: "text" as const,
        expected: "1 240,00 €",
        target: { by: "css" as const, value: "[data-cash-state]" },
        afterStep: "open-cash",
        verification: "state" as const,
      },
      {
        description: "La vue est ouverte",
        kind: "visible" as const,
        target: { by: "css" as const, value: '[data-cash-state="ouvert"]' },
        afterStep: "open-cash",
        verification: "state" as const,
      },
      {
        description: "La vue est fermée",
        kind: "count" as const,
        expected: 1,
        target: { by: "css" as const, value: '[data-cash-state="cloture"]' },
        afterStep: "open-cash",
        verification: "state" as const,
      },
    ]) {
      const plan = assumedStatePlan();
      plan.scenarios = [
        {
          ...plan.scenarios[0]!,
          assertions: [{ ...assertion, id: "state-ouvert" }],
          steps: plan.scenarios[0]!.steps.filter((step) =>
            ["goto", "open-cash", "check-open"].includes(step.id)
          ),
        },
      ];
      expect(refusals(plan)).toEqual([]);
    }
  });

  it('accepte [role="status"] attendant "ok" : le texte visible EST le contenu', () => {
    // La règle est restreinte aux attributs qui PORTENT un état : un sélecteur
    // de rôle est une cible légitime, et son texte visible est son contenu.
    const plan = assumedStatePlan();
    const scenario = plan.scenarios[0]!;
    plan.scenarios = [
      {
        ...scenario,
        assertions: [
          {
            id: "state-ouvert",
            description: "Le statut affiche ok",
            kind: "text",
            expected: "ok",
            target: { by: "css", value: '[role="status"]' },
            afterStep: "open-cash",
            verification: "state",
          },
        ],
        steps: scenario.steps.filter((step) =>
          ["goto", "open-cash", "check-open"].includes(step.id)
        ),
      },
    ];
    expect(refusals(plan)).toEqual([]);
  });

  it("refuse la même lecture sur un attribut ARIA d'état", () => {
    const plan = assumedStatePlan();
    const scenario = plan.scenarios[0]!;
    plan.scenarios = [
      {
        ...scenario,
        assertions: [
          {
            id: "state-ouvert",
            description: "Le panneau est déplié",
            kind: "text",
            expected: "true",
            target: { by: "css", value: "[aria-expanded]" },
            afterStep: "open-cash",
            verification: "state",
          },
        ],
        steps: scenario.steps.filter((step) =>
          ["goto", "open-cash", "check-open"].includes(step.id)
        ),
      },
    ];
    expect(refusals(plan)).toHaveLength(1);
    expect(refusals(plan)[0]?.error.message).toContain("[aria-expanded]");
  });

  it("accepte un champ sélectionné par son nom, son id ou son type : il lit SA valeur", () => {
    // `[name="state"]`, `[id="state"]`, `[type="text"]` sélectionnent
    // l'ÉLÉMENT : `kind "value"` y lit `inputValue` du champ visé, qui est
    // exactement l'attendu. Aucun de ces attributs ne porte un état, donc
    // aucun n'entre dans le champ du refus.
    for (const selector of [
      '[name="state"]',
      '[id="state"]',
      '[type="text"]',
    ]) {
      const plan = assumedStatePlan();
      const scenario = plan.scenarios[0]!;
      plan.scenarios = [
        {
          ...scenario,
          assertions: [
            {
              id: "state-ouvert",
              description: "Le champ d'état contient open",
              kind: "value",
              expected: "open",
              target: { by: "css", value: selector },
              afterStep: "open-cash",
              verification: "state",
            },
          ],
          steps: scenario.steps.filter((step) =>
            ["goto", "open-cash", "check-open"].includes(step.id)
          ),
        },
      ];
      expect(refusals(plan), selector).toEqual([]);
    }
  });

  it('accepte [data-testid="status"] attendant "ready" : un crochet de sélection nomme l’élément', () => {
    // `data-testid` est un `data-*`, mais il nomme l'élément au lieu de porter
    // l'état de l'application : l'attendu en jeton est le TEXTE affiché, lu par
    // `innerText` sur l'élément lui-même. Le refus ne vise que les attributs qui
    // portent réellement un état.
    const plan = assumedStatePlan();
    const scenario = plan.scenarios[0]!;
    plan.scenarios = [
      {
        ...scenario,
        assertions: [
          {
            id: "state-ouvert",
            description: "Le statut de la page affiche ready",
            kind: "text",
            expected: "ready",
            target: { by: "css", value: '[data-testid="status"]' },
            afterStep: "open-cash",
            verification: "state",
          },
        ],
        steps: scenario.steps.filter((step) =>
          ["goto", "open-cash", "check-open"].includes(step.id)
        ),
      },
    ];
    expect(refusals(plan)).toEqual([]);
  });

  it("refuse encore la lecture d'un crochet data- qui porte un état", () => {
    // Le pendant de l'acceptation ci-dessus : la même forme sur un attribut qui
    // porte l'état de la vue reste refusée, crochet de sélection ou non.
    const plan = assumedStatePlan();
    const scenario = plan.scenarios[0]!;
    plan.scenarios = [
      {
        ...scenario,
        assertions: [
          {
            id: "state-ouvert",
            description: "L'état de la caisse est ouvert",
            kind: "text",
            expected: "ouvert",
            target: { by: "css", value: "[data-state]" },
            afterStep: "open-cash",
            verification: "state",
          },
        ],
        steps: scenario.steps.filter((step) =>
          ["goto", "open-cash", "check-open"].includes(step.id)
        ),
      },
    ];
    expect(refusals(plan)).toHaveLength(1);
    expect(refusals(plan)[0]?.error.message).toContain("[data-state]");
  });

  /**
   * L'énumération fermée du refus, en `text` comme en `value` : seuls les
   * attributs d'état nommés sont refusés, et tout autre attribut est accepté —
   * c'est la règle, pas la forme du sélecteur, qui décide.
   */
  function planReading(selector: string, kind: "text" | "value"): Plan {
    const plan = assumedStatePlan();
    const scenario = plan.scenarios[0]!;
    plan.scenarios = [
      {
        ...scenario,
        assertions: [
          {
            id: "state-ouvert",
            description: "La cible sélectionnée rend un jeton",
            kind,
            expected: "open",
            target: { by: "css" as const, value: selector },
            afterStep: "open-cash",
            verification: "state" as const,
          },
        ],
        steps: scenario.steps.filter((step) =>
          ["goto", "open-cash", "check-open"].includes(step.id)
        ),
      },
    ];
    return plan;
  }

  it("refuse chacun des neuf attributs d'état nommés, quel que soit le kind", () => {
    for (const attribute of [
      "aria-checked",
      "aria-current",
      "aria-disabled",
      "aria-expanded",
      "aria-hidden",
      "aria-invalid",
      "aria-pressed",
      "aria-selected",
      "data-state",
    ]) {
      for (const kind of ["text", "value"] as const) {
        const refused = refusals(planReading(`[${attribute}]`, kind));
        expect(refused, `${attribute} ${kind}`).toHaveLength(1);
        expect(refused[0]?.error.message).toContain(`[${attribute}]`);
      }
    }
  });

  it("accepte tout attribut hors de l'énumération, en text comme en value", () => {
    // `data-whatever` est le cas qui tranche : avec une règle fondée sur le
    // préfixe `data-`, il serait refusé. Aucun attribut de cette liste ne porte
    // un état : ils nomment l'élément ou décrivent son type.
    for (const selector of [
      '[name="state"]',
      '[id="state"]',
      '[class="state"]',
      '[type="text"]',
      '[role="status"]',
      '[data-testid="status"]',
      '[data-whatever="x"]',
    ]) {
      for (const kind of ["text", "value"] as const) {
        expect(
          refusals(planReading(selector, kind)),
          `${selector} ${kind}`
        ).toEqual([]);
      }
    }
  });
});

/**
 * Le scénario `cash-balanced-closure` du run 76f7b2a9, recopié de l'artefact :
 * mêmes étapes, mêmes identifiants, mêmes attendus. Six étapes passent, puis
 * l'assertion `a1_message` lit le texte de `[data-cash-state="cloture"]`, un
 * élément qui n'existe que dans l'état clôturé, et le run bloque après
 * « Timeout 5000ms exceeded » sans avoir rien lu du texte.
 */
function pinnedStatePlan(): Plan {
  return {
    summary:
      "Comptage juste de 1 240,00 € : total, statut, puis clôture verrouillée",
    scenarios: [
      {
        id: "cash-balanced-closure",
        title: "Le comptage juste clôture la session",
        kind: "happy_path",
        rationale: "La clôture sans écart verrouille la session",
        sourceFiles: ["src/form.ts"],
        preconditions: [],
        steps: [
          {
            id: "open",
            description: "ouvrir l'application",
            action: { type: "goto", path: "/" },
          },
          {
            id: "nav-cash",
            description: "ouvrir la vue Caisse et Coffre",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Caisse et Coffre",
              },
            },
          },
          {
            id: "q20",
            description: "compter 2 pièces de 20 €",
            action: {
              type: "fill",
              locator: {
                by: "role",
                value: "textbox",
                name: "Quantité · Billet de 20 €",
              },
              value: "2",
            },
          },
          {
            id: "check-status",
            description: "vérifier le statut du comptage",
            action: { type: "assert", assertionId: "a1_status" },
          },
          {
            id: "close",
            description: "clôturer la session",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Clôturer la session",
              },
            },
          },
          {
            id: "check-closed",
            description: "la vue porte l'état clôturé",
            action: { type: "assert", assertionId: "a1_cloture" },
          },
          {
            id: "check-message",
            description: "le message de clôture annonce le verrouillage",
            action: { type: "assert", assertionId: "a1_message" },
          },
        ],
        requirements: witness,
        assertions: [
          {
            id: "a1_status",
            description:
              "L'écart compté − attendu vaut 0 : le statut devient « Comptage juste »",
            kind: "text",
            expected: "Comptage juste",
            target: { by: "css", value: "[data-cash-state]" },
            afterStep: "q20",
            verification: "transition",
          },
          {
            id: "a1_cloture",
            description:
              'La session est clôturée : la vue porte data-cash-state="cloture"',
            kind: "visible",
            target: { by: "css", value: '[data-cash-state="cloture"]' },
            afterStep: "close",
            verification: "state",
          },
          {
            id: "a1_message",
            description: "Le message de clôture annonce le verrouillage",
            kind: "text",
            expected: "Session clôturée : le comptage est verrouillé.",
            target: { by: "css", value: '[data-cash-state="cloture"]' },
            afterStep: "close",
            verification: "transition",
          },
        ],
      },
    ],
    skipped: [],
  };
}

describe("cible sélectionnée par une valeur d'état, lue comme du texte", () => {
  const refusals = (plan: Plan) =>
    stateTargetReadRefusals(PlanSchema.parse(plan));
  const withTarget = (plan: Plan, value: string): Plan => {
    const scenario = plan.scenarios[0]!;
    return {
      ...plan,
      scenarios: [
        {
          ...scenario,
          assertions: scenario.assertions.map((assertion) =>
            assertion.id === "a1_message"
              ? { ...assertion, target: { by: "css" as const, value } }
              : assertion
          ),
        },
      ],
    };
  };

  it("refuse l'assertion mesurée du run 76f7b2a9 et rend le message exact", () => {
    const refused = refusals(pinnedStatePlan());
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error.code).toBe("PLAN_STATE_TARGET_READ_AS_TEXT");
    expect(refused[0]?.error.message).toBe(
      'Scenario cash-balanced-closure reads an element selected by a state value as if it carried text: assertion a1_message (after close, kind text) reads [data-cash-state="cloture"], an element that exists only while that state holds and expects "Session clôturée : le comptage est verrouillé."'
    );
    // Le remède nomme les deux voies : la présence sur la valeur d'état, et le
    // texte de la vue sur le sélecteur qui le porte.
    expect(refused[0]?.error.hint).toContain('kind "visible"');
    expect(refused[0]?.error.hint).toContain('[role="status"]');
  });

  it("refuse la même lecture en kind value", () => {
    const plan = pinnedStatePlan();
    const scenario = plan.scenarios[0]!;
    plan.scenarios = [
      {
        ...scenario,
        assertions: scenario.assertions.map((assertion) =>
          assertion.id === "a1_message"
            ? {
                ...assertion,
                kind: "value" as const,
                expected: "Session clôturée : le comptage est verrouillé.",
              }
            : assertion
        ),
      },
    ];
    const refused = refusals(plan);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error.message).toContain("kind value");
  });

  it("ne double pas le refus d'un attendu qui EST la valeur de l'attribut", () => {
    // Un attendu en jeton sur la valeur épinglée est refusé par la règle de la
    // valeur d'attribut, plus précise : elle dit que `text` ne rend jamais la
    // valeur d'un attribut. Le refus n'est pas répété sous une seconde forme
    // dans le canal de correction du planificateur.
    const plan = pinnedStatePlan();
    const scenario = plan.scenarios[0]!;
    plan.scenarios = [
      {
        ...scenario,
        assertions: scenario.assertions.map((assertion) =>
          assertion.id === "a1_message"
            ? { ...assertion, kind: "value" as const, expected: "cloture" }
            : assertion
        ),
      },
    ];
    const parsed = PlanSchema.parse(plan);
    expect(stateTargetReadRefusals(parsed)).toEqual([]);
    expect(attributeValueRefusals(parsed)).toHaveLength(1);
  });

  it("refuse la valeur épinglée quelle que soit son écriture", () => {
    // Le guillemet, l'opérateur et la casse du nom ne changent pas le sens :
    // chacune de ces formes ne sélectionne l'élément que TANT QUE la valeur
    // tient, donc la lecture reste conditionnelle à l'état. La couverture des
    // combinateurs est le troisième cas mesuré par la vérification : lire `p`
    // dans le conteneur épinglé est aussi conditionnel que lire le conteneur.
    for (const value of [
      "[data-cash-state=cloture]",
      '[data-cash-state^="clot"]',
      '[data-cash-state$="ture"]',
      '[data-cash-state*="clot"]',
      '[data-cash-state~="cloture"]',
      '[data-cash-state|="cloture"]',
      '[DATA-CASH-STATE="cloture"]',
      '[data-cash-state="cloture"] p',
      'css=[data-cash-state="cloture"]',
    ]) {
      const refused = refusals(withTarget(pinnedStatePlan(), value));
      expect(refused, value).toHaveLength(1);
      expect(refused[0]?.error.code).toBe("PLAN_STATE_TARGET_READ_AS_TEXT");
      expect(refused[0]?.error.message).toContain(value);
    }
  });

  it("refuse encore la lecture de texte sur la valeur ouverte", () => {
    const refused = refusals(
      withTarget(pinnedStatePlan(), '[data-cash-state="ouvert"]')
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error.message).toContain('[data-cash-state="ouvert"]');
  });

  it("refuse une lecture dont la valeur épinglée se cache derrière une présence", () => {
    // Le sélecteur examine TOUS ses attributs d'état : s'arrêter au premier
    // test reconnu laisserait passer la forme du finding, où la présence
    // précède la valeur qui rend l'élément conditionnel.
    for (const value of [
      "[data-state] button[aria-expanded=true]",
      '[data-cash-state] p[aria-pressed="true"]',
      '[aria-hidden="false"] [data-state] p[aria-selected=true]',
    ]) {
      const refused = refusals(withTarget(pinnedStatePlan(), value));
      expect(refused, value).toHaveLength(1);
      expect(refused[0]?.error.code, value).toBe(
        "PLAN_STATE_TARGET_READ_AS_TEXT"
      );
      expect(refused[0]?.error.message, value).toContain(value);
    }
  });

  it("n'oppose aucun refus à la présence d'état suivie d'un attribut qui n'en porte pas", () => {
    // Non-régression de la mesure : la présence seule sélectionne le conteneur
    // dans tous les états, donc lire son texte lit le texte de la vue. Un
    // attribut valué qui ne porte pas d'état (`[aria-label="…"]`) ne change
    // rien à cette lecture.
    for (const value of [
      "[data-state] button",
      "[data-cash-state] aside p",
      '[data-cash-state] input[aria-label="Montant d’espèces attendu"]',
    ]) {
      expect(refusals(withTarget(pinnedStatePlan(), value)), value).toEqual([]);
    }
  });

  it("n'oppose aucun refus à une cible qui nomme son élément", () => {
    // 0 faux refus sur les formes qui nomment : la valeur épinglée est le seul
    // déclencheur, et la présence seule reste la voie de remède.
    for (const value of [
      "#saved",
      '[data-testid="status"]',
      '[name="state"]',
      '[role="status"]',
      "[data-cash-state]",
      "aside[data-cash-state] p",
    ]) {
      expect(refusals(withTarget(pinnedStatePlan(), value)), value).toEqual([]);
    }
    const base = pinnedStatePlan();
    const roleTarget: Plan = {
      ...base,
      scenarios: [
        {
          ...base.scenarios[0]!,
          assertions: base.scenarios[0]!.assertions.map((assertion) =>
            assertion.id === "a1_message"
              ? {
                  ...assertion,
                  target: {
                    by: "role" as const,
                    value: "status",
                    name: "État",
                  },
                }
              : assertion
          ),
        },
      ],
    };
    expect(refusals(roleTarget)).toEqual([]);
  });

  it("n'oppose aucun refus au texte de la vue, ni à une preuve de présence", () => {
    // Non-régression : la forme de seule présence `[data-cash-state]` sélectionne
    // le conteneur dans tous les états, donc lire son texte lit le texte de la
    // vue — 885 assertions passantes du corpus le font. La présence sur la
    // valeur épinglée est la preuve correcte de l'état.
    for (const assertion of [
      {
        kind: "text" as const,
        expected: "Session en cours",
        target: { by: "css" as const, value: "[data-cash-state]" },
      },
      {
        kind: "text" as const,
        expected: "1 240,00 €",
        target: { by: "css" as const, value: "[data-cash-state]" },
      },
      {
        kind: "visible" as const,
        target: { by: "css" as const, value: '[data-cash-state="cloture"]' },
      },
      {
        kind: "count" as const,
        expected: 1,
        target: { by: "css" as const, value: '[data-cash-state="ouvert"]' },
      },
      {
        kind: "text" as const,
        expected: "Session clôturée : le comptage est verrouillé.",
        target: { by: "css" as const, value: '[role="status"]' },
      },
      {
        kind: "text" as const,
        expected: "ready",
        target: { by: "css" as const, value: '[data-testid="status"]' },
      },
      {
        kind: "text" as const,
        expected: "Pilotage",
        target: { by: "role" as const, value: "heading", name: "Pilotage" },
      },
    ]) {
      const plan = pinnedStatePlan();
      const scenario = plan.scenarios[0]!;
      // `visible` ne porte pas d'attendu : celui de l'assertion de base ne doit
      // pas survivre à la fusion, et le schéma refuse la clé.
      const { expected: _expected, ...presence } = scenario.assertions[0]! as {
        expected?: unknown;
      };
      const named = {
        id: "a1_view",
        description: "La vue affiche l'état attendu",
        afterStep: "q20",
        ...assertion,
      };
      const merged = (
        "expected" in (assertion as Record<string, unknown>)
          ? { ...scenario.assertions[0]!, ...named }
          : { ...presence, ...named }
      ) as (typeof scenario.assertions)[number];
      plan.scenarios = [
        {
          ...scenario,
          steps: scenario.steps
            .filter((step) =>
              ["open", "nav-cash", "q20", "check-status"].includes(step.id)
            )
            .map((step) =>
              step.id === "check-status"
                ? {
                    ...step,
                    action: { type: "assert" as const, assertionId: "a1_view" },
                  }
                : step
            ),
          assertions: [merged],
        },
      ];
      expect(refusals(plan), JSON.stringify(assertion)).toEqual([]);
    }
  });

  it("rejoue l'ordre du run 76f7b2a9 et refuse AVANT toute étape navigateur", async () => {
    const f = await setup();
    cashPage("ouvert");
    scriptPlan(PlanSchema.parse(pinnedStatePlan()));
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    const scenario = result.scenarios[0]!;
    expect(scenario.diagnostic?.code).toBe("PLAN_STATE_TARGET_READ_AS_TEXT");
    expect(scenario.error).toContain("cash-balanced-closure");
    expect(scenario.error).toContain('[data-cash-state="cloture"]');
    // Le scénario refusé ne dépense aucune étape : les 6 étapes qui passaient
    // dans le run mesuré ne sont plus jouées, et le refus ne dépend pas de la
    // page.
    expect(scenario.steps).toEqual([]);
    expect(scenario.artifacts).toEqual([]);
  });

  it("rend au planificateur et au diagnostic la cible visible, pas seulement le risque", async () => {
    // Le refus du lot U expliquait le danger sans dire quoi cibler, et six
    // scénarios du run 210357d8 ont été bloqués d'un coup. Le canal de
    // correction et le diagnostic du run portent maintenant la cible
    // suggérée — le conteneur d'état sans sa valeur épinglée — et le libellé
    // attendu, qui est l'indice de l'élément qui le rend.
    // Le plan refusé revient une seconde fois : c'est la réponse de correction
    // que le planificateur reçoit, donc le message que le refus produit.
    const f = await setup({
      plans: [
        PlanSchema.parse(pinnedStatePlan()),
        PlanSchema.parse(pinnedStatePlan()),
      ],
    });
    cashPage("ouvert");
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const feedback = plannerFeedback(f).join(" ");
    expect(feedback).toContain("Visible target for this plan");
    expect(feedback).toContain(
      'assertion a1_message expecting "Session clôturée : le comptage est verrouillé." → read [data-cash-state]'
    );
    // Le diagnostic publié porte la même phrase : la personne qui relance le
    // test n'a pas besoin de lire le prompt pour savoir quoi corriger.
    const scenario = result.scenarios[0]!;
    expect(scenario.diagnostic?.hint).toContain("Visible target for this plan");
    expect(scenario.diagnostic?.hint).toContain(
      'expecting "Session clôturée : le comptage est verrouillé." → read [data-cash-state]'
    );
  });
});

describe("état de la caisse hérité d'un run antérieur", () => {
  it("rend le refus au planificateur, qui corrige et fait passer le scénario établi", async () => {
    const f = await setup({
      plans: [
        PlanSchema.parse(assumedStatePlan()),
        PlanSchema.parse(establishesOpenPlan()),
      ],
    });
    cashPage("cloture");
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const feedback = plannerFeedback(f);
    expect(feedback).toHaveLength(1);
    // Le canal de correction porte le message et son remède, comme les autres
    // refus rendus au planificateur.
    expect(feedback[0]).toContain("expects an attribute's value");
    expect(feedback[0]).toContain('[data-state="open"]');
    expect(feedback[0]).toContain("establish it first");
    expect(result.outcome, result.scenarios[0]?.error ?? "").toBe("passed");
    expect(result.plan?.scenarios[0]?.assertions[0]?.kind).toBe("visible");
  });

  it("rejoue l'ordre du run 1b49d751 sur une caisse DÉJÀ FERMÉE : le scénario est refusé proprement", async () => {
    const f = await setup();
    cashPage("cloture");
    scriptPlan(PlanSchema.parse(assumedStatePlan()));
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    const scenario = result.scenarios[0]!;
    // Refusé AVANT exécution : aucune étape navigateur, et le diagnostic nomme
    // la lecture fautive, pas un état de départ supposé.
    expect(scenario.steps).toEqual([]);
    expect(scenario.diagnostic?.code).toBe("PLAN_ATTRIBUTE_VALUE_READ_AS_TEXT");
    expect(scenario.error).toContain("comptage-juste-cloture");
    expect(scenario.error).toContain("[data-cash-state]");
  });

  it("donne le MÊME verdict sur une caisse déjà ouverte : le refus ne dépend pas de l'état", async () => {
    const closed = await setup();
    cashPage("cloture");
    scriptPlan(PlanSchema.parse(assumedStatePlan()));
    const closedRun = await runQa(
      { prUrl: PR_URL, previewUrl: closed.baseUrl },
      closed.config
    );
    vi.restoreAllMocks();
    const opened = await setup();
    cashPage("ouvert");
    scriptPlan(PlanSchema.parse(assumedStatePlan()));
    const openedRun = await runQa(
      { prUrl: PR_URL, previewUrl: opened.baseUrl },
      opened.config
    );
    expect(closedRun.outcome).toBe("blocked");
    expect(openedRun.outcome).toBe(closedRun.outcome);
    expect(openedRun.scenarios[0]?.diagnostic?.code).toBe(
      closedRun.scenarios[0]?.diagnostic?.code
    );
  });

  it("exécute et fait passer le scénario qui ÉTABLIT son état sur une caisse fermée", async () => {
    const f = await setup();
    cashPage("cloture");
    scriptPlan(PlanSchema.parse(establishesOpenPlan()));
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome, result.scenarios[0]?.error ?? "").toBe("passed");
    expect(result.scenarios[0]?.outcome).toBe("passed");
    // L'assertion « ouvert » vient après l'étape qui l'a établi.
    const opened = result.scenarios[0]?.assertions.find(
      (item) => item.id === "etabli-ouvert"
    );
    expect(opened?.passed).toBe(true);
    // L'assertion d'établissement est vérifiée en `state`, mais elle suit une
    // INTERACTION : sa valeur d'avant l'étape est désormais relevée, pour que le
    // rapport dise si l'état venait déjà de là (héritage) ou de l'étape.
    expect(opened?.baseline).toBe(false);
    expect(opened?.preMatched).toBeUndefined();
    expect(opened?.actual).toBe(true);
    // La transition est réservée à la clôture, qui déplace réellement la valeur.
    const closed = result.scenarios[0]?.assertions.find(
      (item) => item.id === "etabli-cloture"
    );
    expect(closed?.passed).toBe(true);
    expect(closed?.baseline).toBe(false);
    expect(closed?.actual).toBe(true);
  });

  it("donne le même verdict à deux exécutions consécutives sur la même preview", async () => {
    const f = await setup();
    cashPage("cloture");
    scriptPlan(PlanSchema.parse(establishesOpenPlan()));
    const first = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const second = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(first.outcome, first.scenarios[0]?.error ?? "").toBe("passed");
    expect(second.outcome).toBe(first.outcome);
    expect(second.scenarios[0]?.outcome).toBe(first.scenarios[0]?.outcome);
  });

  it("fait passer le scénario qui établit l'état clôturé quand la caisse est déjà ouverte", async () => {
    const f = await setup();
    cashPage("ouvert");
    scriptPlan(PlanSchema.parse(establishesClosedPlan()));
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome, result.scenarios[0]?.error ?? "").toBe("passed");
    expect(result.scenarios[0]?.outcome).toBe("passed");
  });

  it("fait passer un scénario sans hypothèse d'état dans les deux configurations", async () => {
    for (const state of ["ouvert", "cloture"] as const) {
      vi.restoreAllMocks();
      const f = await setup();
      cashPage(state);
      scriptPlan(PlanSchema.parse(stateIndependentPlan()));
      const result = await runQa(
        { prUrl: PR_URL, previewUrl: f.baseUrl },
        f.config
      );
      expect(
        result.outcome,
        `${state}: ${result.scenarios[0]?.error ?? ""}`
      ).toBe("passed");
      expect(result.scenarios[0]?.outcome, state).toBe("passed");
    }
  });

  it("reclasse en blocked une assertion d'état déjà satisfaite avant l'étape, comme transition", async () => {
    // L'étape d'établissement ne déplace la valeur que si l'état était l'autre.
    // Sur une caisse déjà ouverte, un clic nu sur « Réouvrir le comptage » ne
    // produit rien : l'assertion `state` constatait l'état initial, et le run
    // était vert sans avoir démontré l'établissement — le faux vert mesuré. Les
    // deux vérifications sont donc reclassées en `blocked`, jamais en `passed`,
    // avec un code distinct par vérification. La forme tolérante reste
    // exprimable et verte : `click(ifPresent)` dont l'étape sautée déclare le
    // no-op (voir « établissement d'état tolérant : click(ifPresent) »).
    const open = await setup();
    cashPage("ouvert");
    scriptPlan(PlanSchema.parse(establishesOpenPlan()));
    const openRun = await runQa(
      { prUrl: PR_URL, previewUrl: open.baseUrl },
      open.config
    );
    expect(openRun.outcome).toBe("blocked");
    expect(openRun.scenarios[0]?.outcome).toBe("blocked");
    expect(openRun.scenarios[0]?.diagnostic?.code).toBe(
      "STATE_ALREADY_SATISFIED"
    );

    vi.restoreAllMocks();
    const asTransition = establishesOpenPlan();
    asTransition.scenarios[0]!.assertions[0]!.verification = "transition";
    const strict = await setup();
    cashPage("ouvert");
    scriptPlan(PlanSchema.parse(asTransition));
    const strictRun = await runQa(
      { prUrl: PR_URL, previewUrl: strict.baseUrl },
      strict.config
    );
    expect(strictRun.outcome).toBe("blocked");
    expect(strictRun.scenarios[0]?.outcome).toBe("blocked");
    expect(strictRun.scenarios[0]?.diagnostic?.code).toBe(
      "TRANSITION_ON_INVARIANT"
    );
  });
});

/**
 * Page où le contrôle d'établissement n'existe QUE dans l'état qui le demande :
 * « Réouvrir le comptage » pendant que la caisse est fermée, « Clôturer la
 * session » pendant qu'elle est ouverte. C'est la forme mesurée dans les
 * artefacts du lot R et la seule qui rende l'établissement nécessaire : sur une
 * caisse déjà ouverte, le bouton de réouverture est absent et un `click` nu
 * bloquerait le scénario en TARGET_NOT_FOUND.
 */
function statefulPage(initial: CashState) {
  let state: CashState = initial;
  let view: "pilotage" | "cash" = "pilotage";
  const absent = (label: string) =>
    new Error(
      `Timeout 30000ms exceeded. Call log: - waiting for locator('role=button[name="${label}"]')`
    );
  const snapshot = () => {
    const stateControl =
      state === "ouvert"
        ? '\n    - button "Clôturer la session" [ref=e6]'
        : '\n    - button "Réouvrir le comptage" [ref=e7]';
    const controls =
      view === "pilotage"
        ? '    - button "Pilotage" [ref=e3]\n    - button "Caisse et Coffre" [ref=e4]'
        : `    - button "Caisse et Coffre" [ref=e4]${stateControl}`;
    const text =
      state === "ouvert"
        ? "Session en cours"
        : "Session clôturée : le comptage est verrouillé.";
    return `- main [ref=e1]:\n  - navigation [ref=e2]:\n${controls}\n  - heading "Caisse et Coffre" [ref=e5]\n  - status [ref=e8]: ${text}`;
  };
  const read = (script: string): unknown => {
    for (const wanted of ["ouvert", "cloture"] as const) {
      if (script.includes(`[data-cash-state="${wanted}"]`)) {
        return view === "cash" && state === wanted;
      }
    }
    if (script.includes("status")) {
      return state === "ouvert"
        ? "Session en cours"
        : "Session clôturée : le comptage est verrouillé.";
    }
    return "Caisse et Coffre";
  };
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("stateful-session");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_id: string, label: string, raw: string) => {
      const script = raw.replace(/\\/g, "");
      // Un clic d'établissement attend la cible avant de cliquer ; sa cible
      // absente est donc une étape sautée (`actual = false`), pas une erreur.
      const establishing = script.includes('waitFor({ state: "visible"');
      let actual: unknown =
        label === "discover-preview" ? undefined : read(script);
      if (script.includes("page.goto(")) {
        view = "pilotage";
      }
      if (script.includes("Caisse et Coffre")) {
        view = "cash";
      }
      if (view === "cash" && script.includes("Réouvrir le comptage")) {
        if (state === "ouvert") {
          if (!establishing) {
            throw absent("Réouvrir le comptage");
          }
          actual = false;
        } else {
          state = "ouvert";
          actual = establishing ? true : actual;
        }
      }
      if (view === "cash" && script.includes("Clôturer la session")) {
        if (state === "cloture") {
          throw absent("Clôturer la session");
        }
        state = "cloture";
      }
      return {
        url: "http://fixture/",
        snapshot: snapshot().slice(0, MODEL_SNAPSHOT_CHARS),
        evidence: label === "discover-preview" ? snapshot() : undefined,
        actual,
      };
    }
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([
    "video.webm",
    "trace.zip",
  ]);
}

/**
 * Le plan du correctif : l'étape de réouverture ÉTABLIT l'état ouvert et porte
 * `ifPresent`, l'assertion la suit avec `verification: state`, et la transition
 * est réservée à la clôture, qui déplace réellement la valeur.
 */
function statefulPlan(): Plan {
  return {
    summary:
      "La réouverture établit la session ouverte, la clôture la verrouille",
    scenarios: [
      {
        id: "etablit-puis-cloture",
        title:
          "La réouverture établit la session ouverte, la clôture la verrouille",
        kind: "happy_path",
        rationale:
          "La réouverture débloque la saisie, la clôture la reverrouille",
        sourceFiles: ["src/form.ts"],
        preconditions: [],
        steps: [
          {
            id: "goto",
            description: "ouvrir l'application",
            action: { type: "goto", path: "/" },
          },
          {
            id: "open-cash",
            description: "ouvrir la vue Caisse et Coffre",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Caisse et Coffre",
              },
            },
          },
          {
            id: "reopen",
            description: "réouvrir le comptage pour établir la session ouverte",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Réouvrir le comptage",
              },
              ifPresent: true,
            },
          },
          {
            id: "assert-open",
            description:
              "la session est ouverte, établie par l'étape précédente",
            action: { type: "assert", assertionId: "etabli-ouvert" },
          },
          {
            id: "close",
            description: "clôturer la session établie",
            action: {
              type: "click",
              locator: {
                by: "role",
                value: "button",
                name: "Clôturer la session",
              },
            },
          },
          {
            id: "assert-closed",
            description: "la vue passe à l'état clôturé",
            action: { type: "assert", assertionId: "etabli-cloture" },
          },
        ],
        requirements: witness,
        assertions: [
          {
            id: "etabli-ouvert",
            description: "La vue porte l\u2019état ouvert après la réouverture",
            kind: "visible",
            target: { by: "css", value: '[data-cash-state="ouvert"]' },
            afterStep: "reopen",
            verification: "state",
          },
          {
            id: "etabli-cloture",
            description: "La vue porte l\u2019état clôturé après la clôture",
            kind: "visible",
            target: { by: "css", value: '[data-cash-state="cloture"]' },
            afterStep: "close",
            verification: "transition",
          },
        ],
      },
    ],
    skipped: [],
  };
}

describe("établissement d'état tolérant : click(ifPresent)", () => {
  for (const state of ["cloture", "ouvert"] as const) {
    it(`donne passed depuis une caisse ${{ cloture: "fermée", ouvert: "déjà ouverte" }[state]}`, async () => {
      const f = await setup({ plans: [PlanSchema.parse(statefulPlan())] });
      statefulPage(state);
      const result = await runQa(
        { prUrl: PR_URL, previewUrl: f.baseUrl },
        f.config
      );
      expect(result.outcome, result.scenarios[0]?.error ?? "").toBe("passed");
      expect(result.scenarios[0]?.outcome).toBe("passed");
      const reopen = result.scenarios[0]?.steps.find(
        (step) => step.stepId === "reopen"
      );
      // Caisse fermée : le contrôle existe, l'étape l'a joué. Caisse ouverte :
      // le contrôle est absent, l'étape est sautée et le rapport le dit.
      expect(reopen?.skipped === true).toBe(state === "ouvert");
      const assertions = result.scenarios[0]?.assertions ?? [];
      expect(assertions.every((item) => item.passed)).toBe(true);
    });
  }

  it("donne le MÊME verdict à deux exécutions consécutives, quel que soit ce que la première laisse", async () => {
    // Le premier run laisse la caisse dans l'état où son scénario l'a mise : le
    // second démarre donc de l'autre côté, et l'étape d'établissement y est
    // jouée au lieu d'être sautée (ou l'inverse). Le verdict, lui, ne bouge pas
    // — c'est exactement ce que l'état hérité faisait varier avant le correctif.
    for (const state of ["cloture", "ouvert"] as const) {
      const f = await setup({ plans: [PlanSchema.parse(statefulPlan())] });
      statefulPage(state);
      const first = await runQa(
        { prUrl: PR_URL, previewUrl: f.baseUrl },
        f.config
      );
      const second = await runQa(
        { prUrl: PR_URL, previewUrl: f.baseUrl },
        f.config
      );
      expect(
        first.outcome,
        `${state}: ${first.scenarios[0]?.error ?? ""}`
      ).toBe("passed");
      expect(
        second.outcome,
        `${state}: ${second.scenarios[0]?.error ?? ""}`
      ).toBe("passed");
      expect(second.scenarios[0]?.outcome).toBe(first.scenarios[0]?.outcome);
    }
  });

  it("nomme l'étape sautée dans le rapport publié, sans la présenter comme jouée", async () => {
    const f = await setup({ plans: [PlanSchema.parse(statefulPlan())] });
    statefulPage("ouvert");
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome, result.scenarios[0]?.error ?? "").toBe("passed");
    const report = reportMarkdown(result);
    expect(report).toContain(
      "step `reopen` skipped — its target was absent, so the state it establishes was already in place"
    );
  });

  it("n'attribue aucune transition à une étape sautée : le plan est bloqué, pas l'application", async () => {
    // Une étape qui n'a pas eu lieu ne prouve aucun déplacement : sa baseline
    // vaut la valeur observée, et l'attendu déjà en place est celui qu'elle
    // affiche. Le scénario n'est donc pas vert — la transition n'est pas
    // démontrée — mais le blâme va au plan, qui a exigé un changement
    // impossible sur une invariance.
    const plan = statefulPlan();
    plan.scenarios[0]!.assertions[0]!.verification = "transition";
    const f = await setup({ plans: [PlanSchema.parse(plan)] });
    statefulPage("ouvert");
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.scenarios[0]?.outcome).toBe("blocked");
    expect(result.scenarios[0]?.diagnostic?.code).toBe(
      "TRANSITION_ON_INVARIANT"
    );
    expect(
      result.scenarios[0]?.steps.find((s) => s.stepId === "reopen")?.skipped
    ).toBe(true);
  });

  it("refuse ifPresent sur une action autre qu'un click", () => {
    expect(() =>
      ActionSchema.parse({
        type: "fill",
        locator: { by: "label", value: "Quantité · Billet de 500 €" },
        value: "2",
        ifPresent: true,
      })
    ).toThrow();
    expect(() =>
      ActionSchema.parse({
        type: "select",
        locator: { by: "label", value: "Devise" },
        value: "EUR",
        ifPresent: true,
      })
    ).toThrow();
    expect(
      ActionSchema.parse({
        type: "click",
        locator: { by: "role", value: "button", name: "Réouvrir le comptage" },
        ifPresent: true,
      })
    ).toEqual({
      type: "click",
      locator: { by: "role", value: "button", name: "Réouvrir le comptage" },
      ifPresent: true,
    });
  });
});

/**
 * Le scénario `comptage-juste-cloture` du run 1b49d751, recopié de l'artefact,
 * corrigé de la seule façon qui établit son état : le clic de réouverture porte
 * `ifPresent`, l'assertion « ouvert » le suit en `state`, et les deux assertions
 * du retour à l'ouvert sont dans la même forme. Les saisies, la clôture et les
 * messages sont ceux du plan mesuré.
 */
function correctedScenarioOne(): Plan {
  const base = assumedStatePlan();
  const scenario = base.scenarios[0]!;
  return {
    ...base,
    summary: "Le comptage juste clôture puis réouvre la session",
    scenarios: [
      {
        ...scenario,
        steps: scenario.steps.flatMap((step) =>
          step.id === "open-cash"
            ? [
                step,
                {
                  id: "etablir-ouvert",
                  description:
                    "réouvrir le comptage pour établir la session ouverte",
                  action: {
                    type: "click" as const,
                    locator: {
                      by: "role" as const,
                      value: "button",
                      name: "Réouvrir le comptage",
                    },
                    ifPresent: true,
                  },
                },
              ]
            : [step]
        ),
        assertions: scenario.assertions.map((assertion) => {
          const { expected: _expected, ...rest } =
            assertion as typeof assertion & {
              expected?: unknown;
            };
          if (assertion.id === "etat-cloture") {
            // La clôture déplace réellement la valeur depuis l'état ouvert que
            // la réouverture vient d'établir : elle garde sa transition, mais
            // vise la valeur de l'attribut par présence au lieu de la lire.
            return {
              ...rest,
              kind: "visible" as const,
              target: {
                by: "css" as const,
                value: '[data-cash-state="cloture"]',
              },
              afterStep: "close",
              verification: "transition" as const,
            };
          }
          if (assertion.id === "message-cloture") {
            return assertion;
          }
          return {
            ...rest,
            kind: "visible" as const,
            target: { by: "css" as const, value: '[data-cash-state="ouvert"]' },
            // L'assertion d'avant-saisie suit l'étape qui établit l'état ; celle
            // du retour à l'ouvert suit la réouverture du plan mesuré.
            afterStep:
              assertion.id === "retour-ouvert" ? "reopen" : "etablir-ouvert",
            verification: "state" as const,
          };
        }),
      },
    ],
  };
}

describe("rejeu du scénario 1 du run 1b49d751, corrigé", () => {
  for (const state of ["cloture", "ouvert"] as const) {
    it(`passe depuis une caisse ${{ cloture: "fermée", ouvert: "déjà ouverte" }[state]}`, async () => {
      const f = await setup({
        plans: [PlanSchema.parse(correctedScenarioOne())],
      });
      statefulPage(state);
      const result = await runQa(
        { prUrl: PR_URL, previewUrl: f.baseUrl },
        f.config
      );
      expect(result.outcome, result.scenarios[0]?.error ?? "").toBe("passed");
      expect(result.scenarios[0]?.outcome).toBe("passed");
      // Aucune assertion du scénario mesuré n'est perdue : les quatre sont là,
      // et celle de l'état ouvert vient après l'étape qui l'établit.
      expect(result.scenarios[0]?.assertions).toHaveLength(4);
      expect(
        result.scenarios[0]?.steps.find(
          (step) => step.stepId === "etablir-ouvert"
        )?.skipped === true
      ).toBe(state === "ouvert");
    });
  }
});

/**
 * Contrat de `click(ifPresent)` : le drapeau n'est permis que sur une étape
 * d'établissement, et cette qualité se vérifie sur la structure du scénario. Un
 * clic métier tolérant se sauterait en silence : c'est le faux vert que le
 * finding P1 du 2026-10-19 décrivait.
 */
function ifPresentPlan(stepId: string): Plan {
  const plan = correctedScenarioOne();
  const step = plan.scenarios[0]!.steps.find((item) => item.id === stepId)!;
  (step.action as { ifPresent?: boolean }).ifPresent = true;
  return plan;
}

describe("contrat exécutable de click(ifPresent)", () => {
  it("accepte le clic d'établissement placé avant la première action métier", () => {
    // Le correctif mesuré : `etablir-ouvert` suit l'ouverture de la vue, précède
    // les saisies, et l'assertion `avant-saisie` lui est rattachée.
    expect(() => PlanSchema.parse(correctedScenarioOne())).not.toThrow();
  });

  it("refuse ifPresent sur un clic métier, en nommant le scénario, l'étape et la raison", () => {
    // `close` vient APRÈS les saisies : il déplace la donnée du scénario. Une
    // cible absente y est un défaut, jamais un saut légitime.
    expect(() => PlanSchema.parse(ifPresentPlan("close"))).toThrow(
      /Scenario comptage-juste-cloture step close: ifPresent is only for an establishing step placed before the first business action, but this click comes after fill-500 \(fill\)/
    );
  });

  it("refuse ifPresent sans assertion rattachée à l'étape, et nomme l'étape", () => {
    const plan = statefulPlan();
    plan.scenarios[0]!.assertions[0]!.afterStep = "open-cash";
    expect(() => PlanSchema.parse(plan)).toThrow(
      /Scenario etablit-puis-cloture step reopen: ifPresent skips the step when its target is absent, so an assertion must verify the state it establishes: no assertion has afterStep reopen/
    );
  });

  it("rejoue le refus avant exécution, sans dépenser une étape navigateur", async () => {
    // Chemin de lecture : un plan qui contourne `PlanSchema` — rejoué, écrit à la
    // main — reçoit le même refus nommé avant la première étape.
    const plan = ifPresentPlan("close");
    const refused = ifPresentRefusals(plan);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error.code).toBe("PLAN_IF_PRESENT_NOT_ESTABLISHING");
    const f = await setup();
    cashPage("cloture");
    scriptPlan(plan);
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    const scenario = result.scenarios[0]!;
    expect(scenario.steps).toEqual([]);
    expect(scenario.diagnostic?.code).toBe("PLAN_IF_PRESENT_NOT_ESTABLISHING");
    expect(scenario.error).toContain("comptage-juste-cloture");
    expect(scenario.error).toContain("step close");
  });
});
