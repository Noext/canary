import { describe, expect, it } from "vitest";
import { nearestObservedTarget } from "../src/target-repair.js";

const FILL = {
  type: "fill",
  locator: { by: "label", value: "Quantité · Pièce de 20 €" },
  value: "1",
} as never;

const target = (name: string) => ({ name, role: "textbox" }) as never;

describe("remplacement déterministe d'une cible proche", () => {
  it("remplace quand un seul mot alphabétique diffère", () => {
    // Mesuré (lot QQ) : le plan écrivait « Pièce de 20 € », la page expose
    // « Billet de 20 € », et le modèle a refusé de réparer — cinq fois.
    const chosen = nearestObservedTarget(FILL, [
      target("Quantité · Billet de 500 €"),
      target("Quantité · Billet de 20 €"),
    ]);
    expect(chosen).toBeDefined();
    expect(chosen).toEqual({
      name: "Quantité · Billet de 20 €",
      role: "textbox",
    });
  });

  it("ne remplace jamais quand la différence est un nombre", () => {
    // Remplacer 5 € par 10 € changerait ce que le test prouve.
    expect(
      nearestObservedTarget(FILL, [target("Quantité · Pièce de 5 €")])
    ).toBeUndefined();
  });

  it("ne remplace pas quand plusieurs candidats correspondent", () => {
    expect(
      nearestObservedTarget(FILL, [
        target("Quantité · Billet de 20 €"),
        target("Quantité · Sachet de 20 €"),
      ])
    ).toBeUndefined();
  });

  it("ne remplace pas une action qui ne nomme aucun libellé", () => {
    expect(
      nearestObservedTarget({ type: "observe" } as never, [
        target("Billet de 20 €"),
      ])
    ).toBeUndefined();
  });
});
