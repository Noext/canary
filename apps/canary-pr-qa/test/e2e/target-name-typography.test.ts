import { afterEach, expect, it, vi } from "vitest";
import {
  assertionMatches,
  Canary,
  compileAction,
  compileProbe,
} from "../../src/canary.js";
import { fixture } from "../fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

/**
 * Le cas réel f0f24722 : le plan recopie la ponctuation de sa source (U+0027),
 * l'application expose l'apostrophe typographique (U+2019), et Playwright
 * compare le nom accessible caractère par caractère avec `exact: true`. Le repli
 * ne vise l'autre graphie que si elle atteint exactement un élément, et le nom
 * réellement visé est publié avec l'observation.
 */
it("targets the exposed spelling in actual Chromium, and nothing when two compete", async () => {
  const f = await fixture();
  closers.push(f.close);
  const canary = new Canary(f.config);
  const id = await canary.start("Typographic accessible name");
  const planned = {
    by: "role" as const,
    value: "textbox",
    name: "Justification de l'écart",
  };
  try {
    await canary.act(
      id,
      "open",
      compileAction({ type: "goto", path: "/typographie" }, f.baseUrl)
    );
    const filled = await canary.act(
      id,
      "fill",
      compileAction(
        { type: "fill", locator: planned, value: "Écart constaté" },
        f.baseUrl
      )
    );
    expect(filled.targetName).toBe("Justification de l\u2019écart");
    const read = await canary.act(
      id,
      "read",
      compileProbe(
        {
          id: "justification",
          kind: "value",
          description: "la justification saisie est relue",
          expected: "Écart constaté",
          target: planned,
        },
        f.baseUrl
      )
    );
    expect(read.actual).toBe("Écart constaté");
    // `isVisible()` et `count()` ne lèvent jamais, même sur un locator vide :
    // sans résolution préalable du nom exposé, « hidden » passait sur une cible
    // visible et « visible »/« count » échouaient dessus. Les trois verdicts
    // doivent être justes, sur la graphie que la page expose.
    const visible = await canary.act(
      id,
      "visible",
      compileProbe(
        {
          id: "visible",
          kind: "visible",
          description: "la justification de l'écart est visible",
          target: planned,
        },
        f.baseUrl
      )
    );
    expect(visible.actual).toBe(true);
    expect(visible.targetName).toBe("Justification de l\u2019écart");
    const hidden = await canary.act(
      id,
      "hidden",
      compileProbe(
        {
          id: "hidden",
          kind: "hidden",
          description: "la justification de l'écart est cachée",
          target: planned,
        },
        f.baseUrl
      )
    );
    expect(hidden.actual).toBe(true);
    expect(hidden.targetName).toBe("Justification de l\u2019écart");
    expect(
      assertionMatches(
        {
          id: "hidden",
          kind: "hidden",
          description: "la justification de l'écart est cachée",
        },
        hidden.actual
      )
    ).toBe(false);
    const count = await canary.act(
      id,
      "count",
      compileProbe(
        {
          id: "count",
          kind: "count",
          description: "la justification de l'écart compte un élément",
          expected: 1,
          target: planned,
        },
        f.baseUrl
      )
    );
    expect(count.actual).toBe(1);
    expect(count.targetName).toBe("Justification de l\u2019écart");
    // Deux graphies concurrentes : la cible du plan ne résout toujours rien, et
    // l'échec d'origine remonte au lieu d'un contrôle choisi au hasard.
    await canary.act(
      id,
      "open-double",
      compileAction({ type: "goto", path: "/typographie-double" }, f.baseUrl)
    );
    await expect(
      canary.act(
        id,
        "ambiguous-fill",
        compileAction(
          { type: "fill", locator: planned, value: "Écart constaté" },
          f.baseUrl
        )
      )
    ).rejects.toThrow(/Timeout \d+ms exceeded/);
    // Une lecture qui mesure ne rend ni false ni 0 : elle nomme l'ambiguïté au
    // lieu de laisser « hidden » passer sur un locator vide.
    await expect(
      canary.act(
        id,
        "ambiguous-hidden",
        compileProbe(
          {
            id: "hidden",
            kind: "hidden",
            description: "la justification de l'écart est cachée",
            target: planned,
          },
          f.baseUrl
        )
      )
    ).rejects.toThrow(/Ambiguous accessible name/);
    // Un comptage ne choisit pas un élément : les deux graphies du même signe
    // s'additionnent, donc « count: 1 » est faux au lieu d'être une ambiguïté.
    const doubleCount = await canary.act(
      id,
      "count-double",
      compileProbe(
        {
          id: "count",
          kind: "count",
          description: "la justification de l'écart compte un élément",
          expected: 1,
          target: planned,
        },
        f.baseUrl
      )
    );
    expect(doubleCount.actual).toBe(2);
    expect(
      assertionMatches(
        {
          id: "count",
          kind: "count",
          description: "la justification de l'écart compte un élément",
          expected: 1,
        },
        doubleCount.actual
      )
    ).toBe(false);
    const doubleCountTwo = await canary.act(
      id,
      "count-double-two",
      compileProbe(
        {
          id: "count",
          kind: "count",
          description: "les deux graphies comptent deux éléments",
          expected: 2,
          target: planned,
        },
        f.baseUrl
      )
    );
    // Le total des deux graphies tombe juste : aucune unicité n'est exigée.
    expect(doubleCountTwo.actual).toBe(2);
    expect(
      assertionMatches(
        {
          id: "count",
          kind: "count",
          description: "les deux graphies comptent deux éléments",
          expected: 2,
        },
        doubleCountTwo.actual
      )
    ).toBe(true);
  } finally {
    await canary.abort(id).catch(() => undefined);
  }
}, 180_000);
