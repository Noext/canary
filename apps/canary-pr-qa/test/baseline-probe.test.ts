import { describe, expect, it } from "vitest";
import type { Canary } from "../src/canary.js";
import type { Scenario } from "../src/schema.js";
import { captureBaselines } from "../src/step-outcome.js";

/** Un scénario dont l'assertion d'état suit une interaction. */
const SCENARIO = {
  assertions: [
    {
      afterStep: "open",
      description: "le marqueur apparaît",
      expected: "1",
      id: "marker",
      kind: "text",
      target: { by: "css", value: '[data-state="open"]' },
      verification: "state",
    },
  ],
  id: "s1",
  steps: [
    {
      action: { path: "/", type: "goto" },
      description: "ouvrir",
      id: "load",
    },
    {
      action: {
        locator: { by: "role", name: "Open", value: "button" },
        type: "click",
      },
      description: "cliquer",
      id: "open",
    },
  ],
} as unknown as Scenario;

function canaryThatFails(): Canary {
  return {
    act: (_id: string, label: string) =>
      label.startsWith("baseline-")
        ? Promise.reject(new Error("Timeout 5000ms exceeded"))
        : Promise.resolve({ actual: "1", snapshot: "", url: "https://x/" }),
  } as unknown as Canary;
}

describe("la sonde de valeur d'avant ne casse jamais un scénario", () => {
  it("garde le scénario entier quand la cible n'existe pas encore", async () => {
    // Mesuré : depuis que la valeur d'avant est relevée pour toutes les
    // assertions d'interaction, une cible absente avant le clic faisait tomber
    // le scénario en TARGET_NOT_FOUND (lot KK : 11 contre 3 au lot de référence).
    const baselines = new Map<string, unknown>();
    await expect(
      captureBaselines(
        "session",
        SCENARIO,
        "open",
        baselines,
        "https://preview.test/",
        canaryThatFails()
      )
    ).resolves.toBeUndefined();
    // Aucune mesure : `preMatched` restera absent, donc « inconnu » — jamais
    // « pas hérité » par défaut.
    expect(baselines.size).toBe(0);
  });

  it("enregistre la valeur quand la sonde répond", async () => {
    const baselines = new Map<string, unknown>();
    const canary = {
      act: () => Promise.resolve({ actual: "0" }),
    } as unknown as Canary;
    await captureBaselines(
      "s",
      SCENARIO,
      "open",
      baselines,
      "https://p/",
      canary
    );
    expect(baselines.get("marker")).toBe("0");
  });
});
