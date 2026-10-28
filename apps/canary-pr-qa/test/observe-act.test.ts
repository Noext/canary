import { describe, expect, it, vi } from "vitest";
import { Canary } from "../src/canary.js";
import { runQa } from "../src/runner.js";
import { fixture, plan as fixturePlan, PR_URL } from "./fixture.js";

/**
 * Le chemin observe→act, testé hors ligne : un faux navigateur rend l'instantané
 * que je choisis, et le test vérifie ce qui a été joué — pas seulement le verdict.
 *
 * Invariants couverts : une action par tour, aucune cible hors de l'instantané
 * observé, un seul relevé par pas (budget), classement final explicite.
 */
describe("boucle observe→act, derrière le drapeau", () => {
  /**
   * Le plan du fixture, complété pour satisfaire l'invariant de provenance : le
   * scénario désigne l'assertion qui prouve son objectif, et l'assertion cite
   * l'exigence qui justifie sa valeur attendue. Sans ces deux champs, la porte
   * refuserait le plan avant même d'exécuter — ce que le test de provenance
   * vérifie séparément.
   */
  const planWithProvenance = () => {
    const cloned = structuredClone(fixturePlan);
    cloned.scenarios[0]!.objective = "saved";
    (
      cloned.scenarios[0]!.assertions[0] as { requirement?: number }
    ).requirement = 0;
    return cloned;
  };

  const drive = async (snapshot: string, observeAct: boolean) => {
    const f = await fixture({ plans: [planWithProvenance()] });
    const acts: string[] = [];
    vi.spyOn(Canary.prototype, "start").mockResolvedValue("session");
    vi.spyOn(Canary.prototype, "act").mockImplementation(
      async (_session, label) => {
        acts.push(label);
        return {
          url: "http://fixture/",
          snapshot,
          ...(label.endsWith("assert") ? { actual: "Welcome Ada" } : {}),
        } as never;
      }
    );
    vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
    try {
      const result = await runQa(
        { prUrl: PR_URL, previewUrl: f.baseUrl },
        { ...f.config, QA_OBSERVE_ACT: observeAct }
      );
      return { acts, result };
    } finally {
      await f.close();
    }
  };

  it("ne joue pas une cible absente de l'observation et se classe indéterminé", async () => {
    const { acts, result } = await drive('textbox "Name" [ref=e1]', true);
    const scenario = result.scenarios[0]!;
    expect(scenario.outcome).toBe("blocked");
    expect(scenario.classification).toBe("indeterminate");
    expect(scenario.diagnostic?.code).toBe("TARGET_NOT_FOUND");
    expect(scenario.diagnostic?.message).toContain(
      "which the current observation does not expose"
    );
    // Rien n'a été joué pour cette cible : la boucle s'arrête sur l'observation.
    expect(acts.filter((label) => label.includes("click"))).toEqual([]);
    // Le relevé après action : un par pas joué, pas un par tentative.
    const observes = acts.filter((label) => label.startsWith("observe-after-"));
    expect(observes.length).toBe(1);
  }, 60_000);

  it("joue la cible présente et classe le scénario comme démontré", async () => {
    const { acts, result } = await drive(
      'textbox "Name" [ref=e1]\nbutton "Save" [ref=e2]',
      true
    );
    const scenario = result.scenarios[0]!;
    expect(scenario.outcome).toBe("passed");
    expect(scenario.classification).toBe("proven");
    expect(acts.some((label) => label.includes("click"))).toBe(true);
  }, 60_000);

  it("n'applique aucune porte quand le drapeau est coupé", async () => {
    const { result } = await drive('textbox "Name" [ref=e1]', false);
    const scenario = result.scenarios[0]!;
    // Le chemin figé joue la cible et échoue sur l'instrumentation du faux
    // navigateur, mais il ne se classe jamais « indéterminé » : la porte
    // n'existe que sur le nouveau chemin.
    expect(scenario.classification).not.toBe("indeterminate");
  }, 60_000);
});
