import { describe, expect, it } from "vitest";
import { unwitnessedPlanRefusals } from "../src/policy.js";
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

  it("refuse l'assertion dont la condition de l'appelant n'est pas établie", () => {
    // La valeur n'existe que si `required` tient, et `required` se décide à
    // travers trois définitions jusque dans un champ que l'écran commande :
    // `session.expected`. Le scénario ne le remplit pas, donc le marqueur reste
    // au repli `none` et l'assertion ne peut pas être vraie (run 3c51455f).
    const plan = planWith(STEP_WITHOUT_EXPECTED, [ASSERTION_STAGE_TOO_LONG]);
    const refusals = unwitnessedPlanRefusals(
      plan,
      CONTEXT_WITH(CHAIN_MATERIAL),
      POLICY
    ).filter((line) => line.includes("data-stage-problem"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("Expected amount");
    expect(refusals[0]).toContain("src/view-state.ts:");
    expect(refusals[0]).toContain("null");
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

  it("refuse une valeur que la condition rejette explicitement", () => {
    // La saisie est écrite mais vaut « 0 », que la condition `total !== 0`
    // rejette : l'étape existe, elle n'établit rien.
    const plan = planWith(STEP_EXPECTED_ZERO, [ASSERTION_STAGE_TOO_LONG]);
    const refusals = unwitnessedPlanRefusals(
      plan,
      CONTEXT_WITH(CHAIN_MATERIAL),
      POLICY
    ).filter((line) => line.includes("data-stage-problem"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('writes "0"');
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
});
