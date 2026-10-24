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
});
