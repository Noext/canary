import { describe, expect, it } from "vitest";
import type { Canary, Observation } from "../src/canary.js";
import {
  type ProbedView,
  probeAndReplan,
  probedViewsPayload,
} from "../src/canary.js";
import type { Plan } from "../src/schema.js";

/** Les bornes de la sonde, telles que `probeAndReplan` les applique. */
const MAX_VIEWS = 4;
const VIEW_CHARS = 6000;

/** Une application fictive : ouvrir, puis deux écrans derrière des clics. */
const SCENARIO = {
  steps: [
    { action: { path: "/", type: "goto" }, description: "open", id: "open" },
    {
      action: {
        locator: { by: "role", name: "Caisse", value: "button" },
        type: "click",
      },
      description: "open the drawer view",
      id: "open-drawer",
    },
    {
      action: {
        locator: { by: "role", name: "Historique", value: "button" },
        type: "click",
      },
      description: "open the history view",
      id: "open-history",
    },
    {
      action: {
        locator: { by: "role", name: "Note", value: "textbox" },
        type: "fill",
        value: "x",
      },
      description: "type a note",
      id: "fill-note",
    },
    {
      action: { assertionId: "note-visible", type: "assert" },
      description: "assert",
      id: "assert-note",
    },
  ],
} as never;

const PREVIEW = {
  evidence: "x",
  sha: "1".repeat(40),
  url: "https://preview.test/",
};

function fakeCanary(options: { failAt?: string } = {}) {
  const acts: string[] = [];
  const canary = {
    abort: () => Promise.resolve(),
    act: (_id: string, label: string): Promise<Observation> => {
      acts.push(label);
      if (options.failAt === label) {
        return Promise.reject(new Error("click failed"));
      }
      const snapshot = `snapshot of ${label}`;
      return Promise.resolve({
        snapshot,
        snapshotChars: snapshot.length,
        url: `https://preview.test/${label}`,
      });
    },
    end: () => Promise.resolve(),
    start: () => Promise.resolve("session-1"),
  };
  return { acts, canary: canary as unknown as Canary };
}

const PLAN = {
  scenarios: [SCENARIO],
  skipped: [],
  summary: "s",
} as unknown as Plan;

describe("sonde de navigation : observer les vues que le plan traverse", () => {
  it("rejoue la navigation du plan, jamais la saisie, puis fait réécrire le plan", async () => {
    const { acts, canary } = fakeCanary();
    const seen: ProbedView[][] = [];
    let settled: Plan | undefined;
    const refined = await probeAndReplan({
      askPlanner: (views) => {
        seen.push(views);
        return Promise.resolve(PLAN);
      },
      canary,
      label: "probe",
      plan: PLAN,
      preview: PREVIEW as never,
      root: "/tmp",
      settle: (plan) => {
        settled = plan;
      },
    });
    // `goto`, deux clics, puis l'arrêt : la saisie n'est JAMAIS rejouée.
    expect(acts).toEqual([
      "probe-open",
      "probe-open-drawer",
      "probe-open-history",
    ]);
    expect(seen[0]?.map((view) => view.afterStep)).toEqual([
      "open",
      "open-drawer",
      "open-history",
    ]);
    expect(refined).toBe(PLAN);
    expect(settled).toBe(PLAN);
  });

  it("ne sonde rien quand le plan n'atteint aucun écran par navigation", async () => {
    const { acts, canary } = fakeCanary();
    let asked = false;
    const result = await probeAndReplan({
      askPlanner: () => {
        asked = true;
        return Promise.resolve(PLAN);
      },
      canary,
      label: "probe",
      plan: {
        scenarios: [
          {
            steps: [
              {
                action: { path: "/", type: "goto" },
                description: "open",
                id: "open",
              },
              {
                action: {
                  locator: { by: "role", name: "Note", value: "textbox" },
                  type: "fill",
                  value: "x",
                },
                description: "type",
                id: "fill",
              },
            ],
          },
        ],
      } as unknown as Plan,
      preview: PREVIEW as never,
      root: "/tmp",
      settle: () => undefined,
    });
    expect(acts).toEqual([]);
    expect(asked).toBe(false);
    expect(result).toBeUndefined();
  });

  it("garde ce qu'elle a vu quand une étape échoue, et ferme la session", async () => {
    let ended = false;
    const { canary } = fakeCanary({ failAt: "probe-open-history" });
    const wrapped = {
      ...(canary as unknown as Record<string, unknown>),
      end: () => {
        ended = true;
        return Promise.resolve();
      },
    } as unknown as Canary;
    const seen: ProbedView[][] = [];
    await probeAndReplan({
      askPlanner: (views) => {
        seen.push(views);
        return Promise.resolve(PLAN);
      },
      canary: wrapped,
      label: "probe",
      plan: PLAN,
      preview: PREVIEW as never,
      root: "/tmp",
      settle: () => undefined,
    });
    expect(seen[0]?.map((view) => view.afterStep)).toEqual([
      "open",
      "open-drawer",
    ]);
    expect(ended).toBe(true);
  });

  it("borne le nombre de vues et la taille de ce qui part au modèle", () => {
    const views: ProbedView[] = Array.from(
      { length: MAX_VIEWS + 3 },
      (_u, i) => ({
        afterStep: `step-${i}`,
        chars: VIEW_CHARS * 2,
        snapshot: "s".repeat(VIEW_CHARS * 2),
        url: `https://preview.test/${i}`,
      })
    );
    const payload = probedViewsPayload(views);
    expect(payload).toHaveLength(MAX_VIEWS);
    expect(payload[0]?.snapshot).toHaveLength(VIEW_CHARS);
  });
});
