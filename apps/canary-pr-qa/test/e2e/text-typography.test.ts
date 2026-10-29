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
 * Le cas F1b : le texte ou le placeholder ne diffère du plan que par la graphie
 * de l'apostrophe, et `isVisible()`/`count()` ne lèvent jamais sur un locator
 * vide — sans résolution préalable, « hidden » passait sur un texte pourtant
 * affiché. Le comptage additionne les graphies du même signe, donc l'unicité n'y
 * a pas de sens, et deux graphies concurrentes restent un échec explicite.
 */
it("measures text and placeholder spellings in actual Chromium", async () => {
  const f = await fixture();
  closers.push(f.close);
  const canary = new Canary(f.config);
  const id = await canary.start("Typographic text and placeholder");
  const exposed = "Justification de l\u2019écart";
  const targets = [
    { by: "text" as const, value: "Justification de l'écart" },
    { by: "placeholder" as const, value: "Justification de l'écart" },
  ];
  const reading = (
    target: (typeof targets)[number],
    kind: "visible" | "hidden" | "count",
    expected = 1
  ) =>
    kind === "count"
      ? compileProbe(
          {
            id: "count",
            kind: "count",
            description: "la justification de l'écart compte des éléments",
            expected,
            target,
          },
          f.baseUrl
        )
      : compileProbe(
          {
            id: kind,
            kind,
            description: `la justification de l'écart est ${kind === "hidden" ? "cachée" : "affichée"}`,
            target,
          },
          f.baseUrl
        );
  try {
    for (const target of targets) {
      await canary.act(
        id,
        `open-${target.by}`,
        compileAction({ type: "goto", path: "/typographie-texte" }, f.baseUrl)
      );
      const visible = await canary.act(
        id,
        `visible-${target.by}`,
        reading(target, "visible")
      );
      expect(visible.actual, target.by).toBe(true);
      expect(visible.targetName, target.by).toBe(exposed);
      const hidden = await canary.act(
        id,
        `hidden-${target.by}`,
        reading(target, "hidden")
      );
      // Le texte est affiché : « hidden » est faux au lieu de passer sur un
      // locator vide.
      expect(hidden.actual, target.by).toBe(true);
      expect(
        assertionMatches(
          {
            id: "hidden",
            kind: "hidden",
            description: "la justification de l'écart est cachée",
          },
          hidden.actual
        ),
        target.by
      ).toBe(false);
      const count = await canary.act(
        id,
        `count-${target.by}`,
        reading(target, "count")
      );
      expect(count.actual, target.by).toBe(1);
      expect(count.targetName, target.by).toBe(exposed);
    }
    // Libellés français à trois puis quatre signes repliables (27 et 81
    // graphies) : au plafond historique de 16 la lecture retombait sur la
    // graphie brute, donc « hidden » passait sur un texte pourtant affiché. Les
    // verdicts doivent porter sur la graphie que Chromium expose.
    for (const [route, label] of [
      ["/typographie-texte-long", "l'écart d'espèces n'est pas justifié"],
      [
        "/typographie-texte-long-four",
        "l'écart d'espèces n'est pas justifié par l'opérateur",
      ],
    ] as const) {
      const longExposed = label.replace(/'/g, "\u2019");
      await canary.act(
        id,
        `open-${route}`,
        compileAction({ type: "goto", path: route }, f.baseUrl)
      );
      for (const target of [
        { by: "text" as const, value: label },
        { by: "placeholder" as const, value: label },
      ]) {
        const visible = await canary.act(
          id,
          `visible-${route}-${target.by}`,
          reading(target, "visible")
        );
        expect(visible.actual, `${route} ${target.by}`).toBe(true);
        expect(visible.targetName, `${route} ${target.by}`).toBe(longExposed);
        const hidden = await canary.act(
          id,
          `hidden-${route}-${target.by}`,
          reading(target, "hidden")
        );
        expect(hidden.actual, `${route} ${target.by}`).toBe(true);
        expect(
          assertionMatches(
            {
              id: "hidden",
              kind: "hidden",
              description: "l'écart d'espèces n'est pas justifié",
            },
            hidden.actual
          ),
          `${route} ${target.by}`
        ).toBe(false);
        const count = await canary.act(
          id,
          `count-${route}-${target.by}`,
          reading(target, "count")
        );
        expect(count.actual, `${route} ${target.by}`).toBe(1);
      }
    }
    // Un comptage honnête additionne les graphies décalées : deux éléments pour
    // un compte de deux est vrai, trois pour deux est faux, sans ambiguïté.
    await canary.act(
      id,
      "open-double",
      compileAction(
        { type: "goto", path: "/typographie-texte-double" },
        f.baseUrl
      )
    );
    const doubleText = await canary.act(
      id,
      "count-double-text",
      reading(targets[0]!, "count", 2)
    );
    expect(doubleText.actual).toBe(2);
    await canary.act(
      id,
      "open-triple",
      compileAction(
        { type: "goto", path: "/typographie-texte-triple" },
        f.baseUrl
      )
    );
    const triplePlaceholder = await canary.act(
      id,
      "count-triple-placeholder",
      reading(targets[1]!, "count", 2)
    );
    expect(triplePlaceholder.actual).toBe(3);
    // Deux graphies concurrentes : la mesure échoue explicitement au lieu de
    // rendre un verdict sur un locator vide.
    await canary.act(
      id,
      "open-double-again",
      compileAction(
        { type: "goto", path: "/typographie-texte-double" },
        f.baseUrl
      )
    );
    for (const target of targets) {
      await expect(
        canary.act(id, `ambiguous-${target.by}`, reading(target, "hidden")),
        target.by
      ).rejects.toThrow(new RegExp(`Ambiguous ${target.by}`));
    }
  } finally {
    await canary.abort(id).catch(() => undefined);
  }
}, 180_000);
