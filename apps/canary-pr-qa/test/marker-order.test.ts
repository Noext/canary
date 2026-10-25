import { describe, expect, it } from "vitest";
import {
  unverifiedPreconditions,
  unwitnessedPlanRefusals,
} from "../src/policy.js";
import type { Plan, SourceLineMaterial } from "../src/schema.js";

/** Le patch qui porte ces lignes : `postChangeHunks` en tire le matériel. */
function patchOf(lines: { text: string }[]): string {
  const header = `@@ -1,0 +1,${lines.length} @@`;
  return [header, ...lines.map((line) => `+${line.text}`)].join("\n");
}

function planWith(
  steps: Plan["scenarios"][number]["steps"],
  assertions: Plan["scenarios"][number]["assertions"]
): Plan {
  return {
    scenarios: [
      {
        assertions,
        id: "order-case",
        kind: "edge_case",
        rationale: "the marker is computed in a documented order",
        requirements: [
          {
            behavior: "the marker reports the missing note",
            line: 12,
            quote:
              'if (draft.note.trim().length === 0) { return "note-missing"; }',
            sourceFile: "src/view.tsx",
          },
        ],
        sourceFiles: ["src/view.tsx"],
        steps,
        title: "a long note is reported only once the kind is chosen",
      },
    ],
    skipped: [],
    summary: "one scenario",
  } as unknown as Plan;
}

const MARKER_ASSERTION = {
  afterStep: "write-long",
  description: "the view reports the over-long note",
  expected: 1,
  id: "problem-too-long",
  kind: "count" as const,
  target: { by: "css" as const, value: '[data-stage-problem="note-too-long"]' },
  verification: "state" as const,
};

/** Le contexte minimal : un fichier modifié, celui du matériel. */
const MATERIAL: SourceLineMaterial[] = [
  {
    lines: [
      { line: 8, text: "  const problem = computeProblem(draft);" },
      { line: 9, text: "  function computeProblem(draft: Draft): Problem {" },
      {
        line: 11,
        text: '  if (!draft.kind) { return "kind-missing"; }',
      },
      {
        line: 12,
        text: '  if (draft.note.trim().length === 0) { return "note-missing"; }',
      },
      {
        line: 13,
        text: '  if (draft.note.trim().length > MAX_NOTE) { return "note-too-long"; }',
      },
      { line: 14, text: "  return null;" },
      {
        line: 30,
        text: '  <div data-stage-problem={view.problem ?? "none"}>Details</div>',
      },
      {
        line: 40,
        text: '  <select value={draft.kind} aria-label="Kind of the note" />',
      },
      {
        line: 41,
        text: '  <textarea value={draft.note} aria-label="Note about the case" />',
      },
    ],
    path: "src/view.tsx",
  },
];

const CONTEXT = {
  baseSha: "0".repeat(40),
  body: "",
  context: [],
  contextWarnings: [],
  files: [
    {
      additions: 10,
      changes: 10,
      deletions: 0,
      filename: "src/view.tsx",
      patch: patchOf(MATERIAL[0]!.lines),
      status: "modified",
    },
  ],
  headRepo: "o/r",
  ref: { number: 1, owner: "o", repo: "r" },
  sha: "1".repeat(40),
  title: "t",
} as never;

const POLICY = {
  approvedSkips: [],
  criticalPaths: [],
  version: 1,
} as never;

/**
 * Le matériel d'une application QUELCONQUE : c'est le point du test. Aucun nom
 * d'arpilabe, aucun attribut de la PR mesurée — la règle doit sortir du diff
 * seul, sinon elle ne vaut que pour un dépôt.
 */
/** Le contexte qui porte un matériel donné (deux fichiers, ici). */
function CONTEXT_WITH(material: SourceLineMaterial[]) {
  return {
    ...(CONTEXT as Record<string, unknown>),
    files: material.map((source) => ({
      additions: source.lines.length,
      changes: source.lines.length,
      deletions: 0,
      filename: source.path,
      patch: patchOf(source.lines),
      status: "modified",
    })),
  } as never;
}

/** Les étapes d'un scénario qui remplit sans choisir le motif. */
const STEP_WITHOUT_SELECT: Plan["scenarios"][number]["steps"] = [
  { action: { path: "/", type: "goto" }, description: "open", id: "open" },
  {
    action: {
      type: "fill",
      locator: { by: "role", name: "Note", role: "textbox" },
      value: "x".repeat(281),
    },
    description: "fill a long note",
    id: "fill-too-long",
  } as never,
  {
    action: { assertionId: "too-long", type: "assert" },
    description: "assert the marker",
    id: "assert-too-long",
  },
];

const ASSERTION_TOO_LONG = {
  afterStep: "fill-too-long",
  description: "the marker reports the long note",
  expected: "note-too-long",
  id: "too-long",
  kind: "text",
  target: { by: "css", value: '[data-stage-problem="note-too-long"]' },
  verification: "state",
} as never;

/** Une application fictive à deux fichiers : la vue et l'état qu'elle importe. */
const CHAIN_MATERIAL: SourceLineMaterial[] = [
  {
    lines: [
      { line: 1, text: 'import { describeStage } from "./view-state";' },
      { line: 2, text: "export function View({ session }) {" },
      { line: 3, text: "  const view = describeStage(session);" },
      {
        line: 4,
        text: '<p data-stage-problem={view.problem ?? "none"}>stage</p>',
      },
      {
        line: 5,
        text: '<input value={session.expected} aria-label="Expected amount" />',
      },
      {
        line: 6,
        text: '<select value={draft.kind} aria-label="Kind of the note">',
      },
      {
        line: 7,
        text: '<textarea value={draft.note} aria-label="Note about the case">',
      },
      { line: 8, text: "}" },
    ],
    path: "src/view.tsx",
  },
  {
    lines: [
      { line: 1, text: "export function describeStage(session) {" },
      { line: 2, text: "  const total = Number(session.expected);" },
      { line: 3, text: "  const required = total !== 0;" },
      {
        line: 4,
        text: "  const problem = required ? problemOf(session.draft) : null;",
      },
      { line: 5, text: "  return { problem };" },
      { line: 6, text: "}" },
      { line: 7, text: "function problemOf(draft) {" },
      {
        line: 8,
        text: '  if (draft.kind.trim().length === 0) { return "kind-missing"; }',
      },
      {
        line: 9,
        text: '  if (draft.note.trim().length === 0) { return "note-missing"; }',
      },
      {
        line: 10,
        text: '  return "note-too-long";',
      },
      { line: 11, text: "}" },
    ],
    path: "src/view-state.ts",
  },
];

const EXPECTED_STEP = (value: string) => ({
  action: {
    by: "css",
    type: "fill",
    locator: { by: "css", value: 'input[aria-label="Expected amount"]' },
    value,
  },
  description: "type the expected amount",
  id: "fill-expected",
});

const ASSERTION_STAGE_TOO_LONG = {
  afterStep: "fill-note",
  description: "the stage marker reports the long note",
  expected: "note-too-long",
  id: "stage-too-long",
  kind: "text",
  target: { by: "css", value: '[data-stage-problem="note-too-long"]' },
  verification: "state",
} as never;

const STEP_WITHOUT_EXPECTED = [
  { action: { path: "/", type: "goto" }, description: "open", id: "open" },
  {
    action: {
      locator: { by: "role", name: "Kind of the note", role: "combobox" },
      type: "select",
      value: "autre",
    },
    description: "choose the kind",
    id: "select-kind",
  } as never,
  {
    action: {
      locator: { by: "role", name: "Note about the case", role: "textbox" },
      type: "fill",
      value: "x".repeat(281),
    },
    description: "type a long note",
    id: "fill-note",
  } as never,
  {
    action: { assertionId: "stage-too-long", type: "assert" },
    description: "assert the marker",
    id: "assert-stage",
  },
] as never;

const STEP_WITH_EXPECTED = [
  { action: { path: "/", type: "goto" }, description: "open", id: "open" },
  EXPECTED_STEP("1240") as never,
  ...(STEP_WITHOUT_EXPECTED as unknown[]).slice(1),
] as never;

const STEP_EXPECTED_ZERO = [
  { action: { path: "/", type: "goto" }, description: "open", id: "open" },
  EXPECTED_STEP("0") as never,
  ...(STEP_WITHOUT_EXPECTED as unknown[]).slice(1),
] as never;

/** L'assertion sur la valeur de repli du marqueur : le commentaire est acceptable. */
const ASSERTION_STAGE_ACCEPTABLE = {
  afterStep: "fill-note",
  description: "the stage marker reports no problem",
  expected: "none",
  id: "stage-ok",
  kind: "text",
  target: { by: "css", value: '[data-stage-problem="none"]' },
  verification: "state",
} as never;

/** Les étapes qui remplissent le commentaire ; la longueur est dans la chaîne. */
function NOTE_STEPS(value: string) {
  return [
    {
      action: {
        locator: { by: "role", name: "Note about the case", role: "textbox" },
        type: "fill",
        value,
      },
      description: "type the note",
      id: "fill-note",
    } as never,
    {
      action: { assertionId: "stage-ok", type: "assert" },
      description: "assert the marker",
      id: "assert-stage",
    } as never,
  ];
}

/** Le scénario complet : montant établi, motif choisi, commentaire saisi. */
function STEP_EXPECTED_AND_NOTE(note: string) {
  return [
    {
      action: { path: "/", type: "goto" },
      description: "open",
      id: "open",
    } as never,
    EXPECTED_STEP("1240") as never,
    {
      action: {
        locator: { by: "role", name: "Kind of the note", role: "combobox" },
        type: "select",
        value: "autre",
      },
      description: "choose the kind",
      id: "select-kind",
    } as never,
    ...NOTE_STEPS(note),
  ];
}

/**
 * Le même écran fictif, avec une condition de LONGUEUR dans la chaîne :
 * `if (draft.note.trim().length > MAX_NOTE) return "note-too-long";` et sa
 * constante résolue. Aucun nom du dépôt mesuré n'y figure.
 */
const LENGTH_MATERIAL: SourceLineMaterial[] = CHAIN_MATERIAL.map((source) =>
  source.path === "src/view-state.ts"
    ? {
        ...source,
        lines: source.lines.map((line) => {
          if (line.line === 10) {
            return {
              ...line,
              text: '  if (draft.note.trim().length > MAX_NOTE) { return "note-too-long"; }',
            };
          }
          return line.line === 11
            ? { ...line, text: "const MAX_NOTE = 280;" }
            : line;
        }),
      }
    : source
);

describe("l'ordre d'un marqueur se lit dans le diff, pas dans une convention", () => {
  it("ne dit rien d'une assertion qui ne vise pas un marqueur", () => {
    const plan = planWith(
      [
        {
          action: { type: "goto", path: "/" },
          description: "open",
          id: "open",
        },
        {
          action: { assertionId: "problem-too-long", type: "assert" },
          description: "assert a plain selector",
          id: "assert-long",
        },
      ],
      [
        {
          ...MARKER_ASSERTION,
          afterStep: "open",
          target: { by: "css" as const, value: "#total" },
        },
      ]
    );
    expect(
      unwitnessedPlanRefusals(plan, CONTEXT, POLICY).filter((line) =>
        line.includes("data-stage-problem")
      )
    ).toEqual([]);
  });

  it("refuse l'assertion d'une garde dont les précédentes ne sont pas établies", () => {
    const plan = planWith(
      [
        {
          action: { type: "goto", path: "/" },
          description: "open",
          id: "open",
        },
        {
          action: {
            type: "fill",
            locator: {
              by: "role",
              name: "Note about the case",
              value: "textbox",
            },
            value: "x".repeat(281),
          },
          description: "write an over-long note",
          id: "write-long",
        },
        {
          action: { assertionId: "problem-too-long", type: "assert" },
          description: "assert the marker",
          id: "assert-long",
        },
      ],
      [MARKER_ASSERTION]
    );
    const refusals = unwitnessedPlanRefusals(plan, CONTEXT, POLICY);
    const order = refusals.find((line) => line.includes("data-stage-problem"));
    expect(order).toBeDefined();
    expect(order).toContain('data-stage-problem="note-too-long"');
    expect(order).toContain("Kind of the note");
    expect(order).toContain("select");
  });

  it("ne refuse rien quand le scénario établit la garde antérieure d'abord", () => {
    const plan = planWith(
      [
        {
          action: { type: "goto", path: "/" },
          description: "open",
          id: "open",
        },
        {
          action: {
            type: "select",
            locator: {
              by: "role",
              name: "Kind of the note",
              value: "combobox",
            },
            value: "rendu",
          },
          description: "choose the kind",
          id: "choose",
        },
        {
          action: {
            type: "fill",
            locator: {
              by: "role",
              name: "Note about the case",
              value: "textbox",
            },
            value: "x".repeat(281),
          },
          description: "write an over-long note",
          id: "write-long",
        },
        {
          action: { assertionId: "problem-too-long", type: "assert" },
          description: "assert the marker",
          id: "assert-long",
        },
      ],
      [MARKER_ASSERTION]
    );
    expect(
      unwitnessedPlanRefusals(plan, CONTEXT, POLICY).filter((line) =>
        line.includes("data-stage-problem")
      )
    ).toEqual([]);
  });

  it("ne refuse rien quand l'assertion demande l'ABSENCE du marqueur", () => {
    // Une assertion d'absence décrit une valeur que la vue ne doit pas
    // montrer : exiger d'elle les gardes qui la produisent retournerait la
    // règle contre son sujet.
    for (const kind of ["hidden", "count"] as const) {
      const plan = planWith(STEP_WITHOUT_SELECT, [
        {
          afterStep: "fill-too-long",
          description: "the marker is absent",
          expected: kind === "count" ? "0" : "",
          id: "order-case",
          kind,
          target: { by: "css", value: '[data-stage-problem="note-too-long"]' },
          verification: "state",
        } as never,
      ]);
      expect(
        unwitnessedPlanRefusals(plan, CONTEXT, POLICY).filter((line) =>
          line.includes("data-stage-problem")
        )
      ).toEqual([]);
    }
  });

  it("ne refuse rien quand le code initialise déjà le champ de la garde", () => {
    // `useState({ kind: "normal" })` : la garde antérieure est satisfaite au
    // chargement, donc le scénario atteint la valeur attendue sans toucher au
    // contrôle, et exiger l'interaction refuserait un plan correct.
    const withDefault: SourceLineMaterial = {
      lines: [
        ...MATERIAL[0]!.lines,
        {
          line: 90,
          text: 'const [draft, setDraft] = useState({ kind: "normal" });',
        },
      ],
      path: "src/view.tsx",
    };
    const plan = planWith(STEP_WITHOUT_SELECT, [ASSERTION_TOO_LONG]);
    expect(
      unwitnessedPlanRefusals(plan, CONTEXT_WITH([withDefault]), POLICY).filter(
        (line) => line.includes("data-stage-problem")
      )
    ).toEqual([]);
  });

  it("lit les gardes du fichier qui porte l'expression, pas d'un homonyme", () => {
    // Les deux fichiers définissent `problem`. Le leurre vient en premier et sa
    // chaîne porte une garde antérieure ; la vue, elle, rend directement la
    // valeur attendue. Sans l'identité du fichier, la garde du leurre est lue et
    // l'assertion est refusée à tort.
    const decoy: SourceLineMaterial = {
      lines: [
        { line: 1, text: "function problem(draft) {" },
        {
          line: 2,
          text: '  if (draft.kind.trim().length === 0) { return "kind-missing"; }',
        },
        { line: 3, text: '  return "note-too-long";' },
        { line: 4, text: "}" },
      ],
      path: "src/decoy.tsx",
    };
    const view: SourceLineMaterial = {
      lines: [
        {
          line: 1,
          text: '<p data-stage-problem={view.problem ?? "none"}>here</p>',
        },
        { line: 2, text: "function problem() {" },
        { line: 3, text: '  return "note-too-long";' },
        { line: 4, text: "}" },
      ],
      path: "src/view.tsx",
    };
    const plan = planWith(STEP_WITHOUT_SELECT, [ASSERTION_TOO_LONG]);
    expect(
      unwitnessedPlanRefusals(plan, CONTEXT_WITH([decoy, view]), POLICY).filter(
        (line) => line.includes("data-stage-problem")
      )
    ).toEqual([]);
  });

  it("ne refuse pas sur une condition d'appelant, faute d'observation", () => {
    // `justificationRequired ? f(...) : null` dépend d'un état persisté (montant
    // attendu hérité, session déjà ouverte) que la porte ne peut pas observer :
    // refuser sans observation produisait des refus faux sur des plans réels.
    // La garde est enregistrée pour la phase de découverte, pas opposée au plan.
    const plan = planWith(STEP_WITHOUT_EXPECTED, [ASSERTION_STAGE_TOO_LONG]);
    expect(
      unwitnessedPlanRefusals(
        plan,
        CONTEXT_WITH(CHAIN_MATERIAL),
        POLICY
      ).filter((line) => line.includes("data-stage-problem"))
    ).toEqual([]);
  });

  it("accepte la même assertion quand le champ de la condition est rempli", () => {
    // La contre-direction : rien ne manque, donc rien n'est refusé.
    const plan = planWith(STEP_WITH_EXPECTED, [ASSERTION_STAGE_TOO_LONG]);
    expect(
      unwitnessedPlanRefusals(
        plan,
        CONTEXT_WITH(CHAIN_MATERIAL),
        POLICY
      ).filter((line) => line.includes("data-stage-problem"))
    ).toEqual([]);
  });

  it("ne conclut rien d'une saisie qui semble contredire la condition", () => {
    // `required = total !== 0` avec `total = Number(expected) - Number(counted)` :
    // une saisie « 0 » du seul montant attendu ne prouve rien. Refuser ici serait
    // un faux refus (revue), donc la règle se tait et le plan est joué.
    const plan = planWith(STEP_EXPECTED_ZERO, [ASSERTION_STAGE_TOO_LONG]);
    expect(
      unwitnessedPlanRefusals(
        plan,
        CONTEXT_WITH(CHAIN_MATERIAL),
        POLICY
      ).filter((line) => line.includes("data-stage-problem"))
    ).toEqual([]);
  });

  it("ne refuse pas un ternaire dont la valeur est sur la branche fausse", () => {
    // `const problem = session.optional ? null : problemOf(draft)` : la valeur
    // existe quand la condition est FAUSSE, donc elle n'est pas un prérequis.
    const inverted: SourceLineMaterial[] = CHAIN_MATERIAL.map((source) =>
      source.path === "src/view-state.ts"
        ? {
            ...source,
            lines: source.lines.map((line) =>
              line.line === 4
                ? {
                    ...line,
                    text: "  const problem = session.optional ? null : problemOf(session.draft);",
                  }
                : line
            ),
          }
        : source
    );
    const plan = planWith(STEP_WITHOUT_EXPECTED, [ASSERTION_STAGE_TOO_LONG]);
    expect(
      unwitnessedPlanRefusals(plan, CONTEXT_WITH(inverted), POLICY).filter(
        (line) => line.includes("data-stage-problem")
      )
    ).toEqual([]);
  });

  it("ne dit rien quand la dépendance n'est pas résoluble", () => {
    // Sans la définition de `required`, la piste s'arrête : la règle se tait
    // plutôt que d'inventer une condition.
    const unresolved: SourceLineMaterial[] = CHAIN_MATERIAL.filter(
      (source) => source.path !== "src/view-state.ts"
    );
    const plan = planWith(STEP_WITHOUT_EXPECTED, [ASSERTION_STAGE_TOO_LONG]);
    expect(
      unwitnessedPlanRefusals(plan, CONTEXT_WITH(unresolved), POLICY).filter(
        (line) => line.includes("data-stage-problem")
      )
    ).toEqual([]);
  });

  it("ne refuse pas une garde de retour dont la condition doit être fausse", () => {
    // `if (draft.kind !== "autre") return "kind-missing";` : pour atteindre la
    // valeur suivante la condition doit être FAUSSE, donc sélectionner « autre »
    // est exactement ce qu'il faut. Le refus ne vise que les gardes d'appelant.
    const polarity: SourceLineMaterial[] = CHAIN_MATERIAL.map((source) =>
      source.path === "src/view-state.ts"
        ? {
            ...source,
            lines: source.lines.map((line) =>
              line.line === 8
                ? {
                    ...line,
                    text: '  if (draft.kind !== "autre") { return "kind-missing"; }',
                  }
                : line
            ),
          }
        : source
    );
    const plan = planWith(STEP_WITH_EXPECTED, [ASSERTION_STAGE_TOO_LONG]);
    expect(
      unwitnessedPlanRefusals(plan, CONTEXT_WITH(polarity), POLICY).filter(
        (line) => line.includes("data-stage-problem")
      )
    ).toEqual([]);
  });

  it("ne refuse pas un conflit corrigé avant l'assertion", () => {
    // La saisie « 0 » est remplacée par « 1240 » avant l'assertion : seule la
    // dernière écriture décide de ce que la vue affiche.
    const plan = planWith(
      [
        {
          action: { path: "/", type: "goto" },
          description: "open",
          id: "open",
        },
        EXPECTED_STEP("0") as never,
        EXPECTED_STEP("1240") as never,
        ...(STEP_WITHOUT_EXPECTED as unknown[]).slice(1),
      ] as never,
      [ASSERTION_STAGE_TOO_LONG]
    );
    expect(
      unwitnessedPlanRefusals(
        plan,
        CONTEXT_WITH(CHAIN_MATERIAL),
        POLICY
      ).filter((line) => line.includes("data-stage-problem"))
    ).toEqual([]);
  });

  it("refuse une saisie trop longue là où une valeur acceptable est attendue", () => {
    // Le cas mesuré (b933cf08) : le plan écrit 284 caractères en visant 280, et
    // attend la valeur de repli. La contradiction est démontrable avant Chromium.
    const plan = planWith(STEP_EXPECTED_AND_NOTE("x".repeat(284)), [
      ASSERTION_STAGE_ACCEPTABLE,
    ]);
    const refusals = unwitnessedPlanRefusals(
      plan,
      CONTEXT_WITH(LENGTH_MATERIAL),
      POLICY
    ).filter((line) => line.includes("data-stage-problem"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("holds 284 characters");
    expect(refusals[0]).toContain("limit that decides this value is 280");
  });

  it("accepte exactement la borne, et une saisie au-delà quand le dépassement est attendu", () => {
    // 280 tient dans la limite, 281 la dépasse : les deux plans sont corrects,
    // chacun visant le côté de la borne qu'il annonce.
    const bounded = planWith(STEP_EXPECTED_AND_NOTE("x".repeat(280)), [
      ASSERTION_STAGE_ACCEPTABLE,
    ]);
    expect(
      unwitnessedPlanRefusals(
        bounded,
        CONTEXT_WITH(LENGTH_MATERIAL),
        POLICY
      ).filter((line) => line.includes("data-stage-problem"))
    ).toEqual([]);
    const over = planWith(STEP_EXPECTED_AND_NOTE("x".repeat(281)), [
      ASSERTION_STAGE_TOO_LONG,
    ]);
    expect(
      unwitnessedPlanRefusals(
        over,
        CONTEXT_WITH(LENGTH_MATERIAL),
        POLICY
      ).filter((line) => line.includes("data-stage-problem"))
    ).toEqual([]);
  });

  it("ne lit que la dernière saisie du champ", () => {
    // 284 puis 280 : c'est la seconde qui décide, donc aucune contradiction.
    const plan = planWith(
      [
        ...STEP_EXPECTED_AND_NOTE("x".repeat(284)),
        ...NOTE_STEPS("x".repeat(280)),
      ] as never,
      [ASSERTION_STAGE_ACCEPTABLE]
    );
    expect(
      unwitnessedPlanRefusals(
        plan,
        CONTEXT_WITH(LENGTH_MATERIAL),
        POLICY
      ).filter((line) => line.includes("data-stage-problem"))
    ).toEqual([]);
  });

  it("mesure en unités UTF-16, comme String.length", () => {
    // Un caractère hors BMP pèse 2 unités : 140 symboles font 280, 141 en font
    // 282 et dépassent la limite — une mesure en points de code se tromperait.
    const exact = planWith(STEP_EXPECTED_AND_NOTE("𝄞".repeat(140)), [
      ASSERTION_STAGE_ACCEPTABLE,
    ]);
    expect(
      unwitnessedPlanRefusals(
        exact,
        CONTEXT_WITH(LENGTH_MATERIAL),
        POLICY
      ).filter((line) => line.includes("data-stage-problem"))
    ).toEqual([]);
    const tooLong = planWith(STEP_EXPECTED_AND_NOTE("𝄞".repeat(141)), [
      ASSERTION_STAGE_ACCEPTABLE,
    ]);
    expect(
      unwitnessedPlanRefusals(
        tooLong,
        CONTEXT_WITH(LENGTH_MATERIAL),
        POLICY
      ).filter((line) => line.includes("data-stage-problem"))
    ).toHaveLength(1);
  });

  it("ne refuse rien quand la limite ou le champ ne sont pas établis", () => {
    // La constante n'est pas résoluble : la règle ne peut rien prouver, donc
    // elle ne refuse pas une saisie dont la longueur est inconnue du code.
    const LENGTH_UNRESOLVED = LENGTH_MATERIAL.map((source) => ({
      ...source,
      lines: source.lines.map((line) =>
        line.text === "const MAX_NOTE = 280;"
          ? { ...line, text: "const MAX_NOTE = UNKNOWN_LIMIT;" }
          : line
      ),
    }));
    const plan = planWith(STEP_EXPECTED_AND_NOTE("x".repeat(284)), [
      ASSERTION_STAGE_ACCEPTABLE,
    ]);
    expect(
      unwitnessedPlanRefusals(
        plan,
        CONTEXT_WITH(LENGTH_UNRESOLVED),
        POLICY
      ).filter((line) => line.includes("data-stage-problem"))
    ).toEqual([]);
  });

  it("ne conclut pas sur une longueur qui ne décide pas seule", () => {
    // `kind === "limited" && note.length > MAX` : un scénario qui choisit un
    // autre kind n'atteint pas cette garde, donc la longueur ne prouve rien.
    const compound: SourceLineMaterial[] = LENGTH_MATERIAL.map((source) => ({
      ...source,
      lines: source.lines.map((line) =>
        line.text.includes("draft.note.trim().length > MAX_NOTE")
          ? {
              ...line,
              text: '  if (draft.kind === "limited" && draft.note.trim().length > MAX_NOTE) { return "note-too-long"; }',
            }
          : line
      ),
    }));
    const plan = planWith(STEP_EXPECTED_AND_NOTE("x".repeat(284)), [
      ASSERTION_STAGE_ACCEPTABLE,
    ]);
    expect(
      unwitnessedPlanRefusals(plan, CONTEXT_WITH(compound), POLICY).filter(
        (line) => line.includes("data-stage-problem")
      )
    ).toEqual([]);
  });

  it("tient une garde d'appelant comme condition à satisfaire", () => {
    // `expected.length > 0 ? problemOf(...) : null` : la condition doit TENIR,
    // donc une saisie de 4 caractères ne la contredit pas.
    const caller: SourceLineMaterial[] = LENGTH_MATERIAL.map((source) =>
      source.path === "src/view-state.ts"
        ? {
            ...source,
            lines: source.lines.map((line) =>
              line.text.startsWith("  const problem =")
                ? {
                    ...line,
                    text: "  const problem = session.expected.trim().length > 0 ? problemOf(session.draft) : null;",
                  }
                : line
            ),
          }
        : source
    );
    const plan = planWith(STEP_EXPECTED_AND_NOTE("x".repeat(280)), [
      ASSERTION_STAGE_ACCEPTABLE,
    ]);
    expect(
      unwitnessedPlanRefusals(plan, CONTEXT_WITH(caller), POLICY).filter(
        (line) => line.includes("data-stage-problem")
      )
    ).toEqual([]);
  });

  it("publie la précondition que la porte ne peut pas trancher", () => {
    // `required ? f(...) : null` : la porte ne refuse pas (ce serait un faux
    // refus si l'état est déjà là), mais elle ne se tait pas non plus : la
    // condition, sa provenance et l'assertion concernée sont publiées.
    const plan = planWith(STEP_WITHOUT_EXPECTED, [ASSERTION_STAGE_TOO_LONG]);
    const unverified = unverifiedPreconditions(plan, CHAIN_MATERIAL);
    expect(unverified).toEqual([
      {
        assertionId: "stage-too-long",
        attribute: "data-stage-problem",
        condition: "required",
        scenarioId: "order-case",
        source: "src/view-state.ts:4",
      },
    ]);
  });

  it("ne publie rien quand la valeur ne dépend d'aucune condition d'appelant", () => {
    const plain: SourceLineMaterial[] = CHAIN_MATERIAL.map((source) =>
      source.path === "src/view-state.ts"
        ? {
            ...source,
            lines: source.lines.map((line) =>
              line.line === 4
                ? {
                    ...line,
                    text: "  const problem = problemOf(session.draft);",
                  }
                : line
            ),
          }
        : source
    );
    const plan = planWith(STEP_WITHOUT_EXPECTED, [ASSERTION_STAGE_TOO_LONG]);
    expect(unverifiedPreconditions(plan, plain)).toEqual([]);
  });

  it("fait lire la même représentation au refus et à la publication", () => {
    // Un seul marqueur, deux contrôles : le refus de longueur et la
    // précondition non tranchable doivent désigner le MÊME attribut, la MÊME
    // condition d'appelant et la MÊME provenance — sinon deux règles relisent
    // le code et peuvent diverger.
    const plan = planWith(STEP_EXPECTED_AND_NOTE("x".repeat(284)), [
      ASSERTION_STAGE_ACCEPTABLE,
    ]);
    const material = LENGTH_MATERIAL;
    const refusals = unwitnessedPlanRefusals(
      plan,
      CONTEXT_WITH(material),
      POLICY
    ).filter((line) => line.includes("data-stage-problem"));
    expect(refusals.join("\n")).toMatch(/holds 284 characters/);
    const published = unverifiedPreconditions(plan, material);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      attribute: "data-stage-problem",
      condition: "required",
      source: "src/view-state.ts:4",
    });
  });
});
