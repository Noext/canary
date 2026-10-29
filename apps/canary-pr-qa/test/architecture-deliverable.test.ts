import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Le livrable final, verrouillé.
 *
 * Il doit contenir les six sections attendues et une conclusion sans ambiguïté.
 * Ce test échoue si une section disparaît ou si la conclusion cesse d'être celle
 * que la campagne impose : « amélioration non démontrée », sans bascule.
 */
const doc = readFileSync(
  join(import.meta.dirname, "../../../docs/pr-qa-architecture-decision.md"),
  "utf8"
).replace(/\s+/g, " ");

describe("document de décision d'architecture", () => {
  it("porte les six sections du livrable", () => {
    for (const section of [
      "## 1. Cause racine retenue",
      "## 2. Architecture livrée",
      "## 3. Mécanismes supprimés ou remplacés",
      "## 4. Changements et tests ajoutés",
      "## 5. Résultats comparatifs complets",
      "## 6. Limites résiduelles",
      "## 7. Conclusion",
    ]) {
      expect(doc, section).toContain(section);
    }
  });

  it("cite les preuves de la cause racine, pas seulement la thèse", () => {
    expect(doc).toContain("64 (80 %)");
    expect(doc).toContain("17");
    expect(doc).toContain("51");
    expect(doc).toContain("contrat figé");
  });

  it("publie les résultats de la campagne avec leur incertitude", () => {
    expect(doc).toContain("29 (65,9 %)");
    expect(doc).toContain("30 (68,2 %)");
    expect(doc).toContain("−2,3 points");
    expect(doc).toContain("0,23 σ");
    expect(doc).toContain("50 / 44");
    expect(doc).toContain("15");
    expect(doc).toContain("319 / 343 (93,0 %)");
    expect(doc).toContain("Faux refus");
    expect(doc).toContain("5");
  });

  it("conclut sans ambiguïté, et refuse la bascule", () => {
    expect(doc).toContain("**Amélioration non démontrée.**");
    expect(doc).toContain("pas de bascule par défaut");
    expect(doc).toContain(
      "Aucun mécanisme n'a été supprimé, et c'est une décision"
    );
  });

  it("dit ce qui reste à faire, sans le maquiller", () => {
    expect(doc).toContain("ne produit pas la provenance de façon fiable");
    expect(doc).toContain("pas été mesurée séparément");
    expect(doc).toContain("HTTP_422");
    expect(doc).toContain("2 × 50 runs ne permet pas");
  });
});
