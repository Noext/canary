import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary, MODEL_SNAPSHOT_CHARS } from "../src/canary.js";
import { Model } from "../src/model.js";
import { attributeValueRefusals } from "../src/plan-evidence.js";
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
            verification: "transition",
          },
          {
            id: "etabli-cloture",
            description:
              'Après la clôture, la vue porte l\u2019état clôturé et affiche "Session clôturée : le comptage est verrouillé."',
            kind: "visible",
            target: { by: "css", value: '[data-cash-state="cloture"]' },
            afterStep: "close",
            verification: "state",
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
    expect(error?.hint).toContain('[data-cash-state="ouvert"]');
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
    expect(feedback[0]).toContain('[data-cash-state="ouvert"]');
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
    expect(opened?.baseline).toBe(false);
    expect(opened?.actual).toBe(true);
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
});
