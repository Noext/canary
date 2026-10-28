import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Les critères de la campagne, figés avant le premier run.
 *
 * Le contrat de l'objectif exige que la taille, la puissance, les seuils et la
 * règle d'arrêt soient écrits avant la campagne, et que la conclusion ne puisse
 * pas être renégociée après lecture. Ce test échoue si le document perd un seuil,
 * une puissance annoncée ou une des branches de décision.
 */
const doc = readFileSync(
  join(import.meta.dirname, "../../../docs/pr-qa-campaign-criteria.md"),
  "utf8"
).replace(/\s+/g, " ");

describe("critères de campagne figés", () => {
  it("fixe la taille et les deux bras", () => {
    expect(doc).toContain("2 × 50 runs");
    expect(doc).toContain("cinq lots par bras = 50 runs par bras");
    expect(doc).toContain("`8143ac9`");
    expect(doc).toContain("QA_OBSERVE_ACT=true");
    expect(doc).toContain("Lots alternés de dix runs");
  });

  it("annonce la puissance réelle, y compris ce qu'elle ne peut pas trancher", () => {
    expect(doc).toContain("+15 points | rarement");
    expect(doc).toContain("+20 points | souvent");
    expect(doc).toContain("+25 points | oui");
    expect(doc).toContain("amélioration non démontrée");
  });

  it("fixe les plafonds de dégradation et la règle d'arrêt", () => {
    for (const cap of [
      "Faux verts",
      "+3 points maximum",
      "Couverture des objectifs justifiés",
      "−5 % maximum",
      "Tokens par run",
      "+25 % maximum",
    ]) {
      expect(doc, cap).toContain(cap);
    }
    expect(doc).toContain("Arrêt anticipé pour succès");
    expect(doc).toContain("Arrêt anticipé pour échec");
    expect(doc).toContain("la campagne va au bout de ses 2 × 50 runs");
  });

  it("énonce les quatre conclusions possibles sans ambiguïté", () => {
    for (const verdict of [
      "solution validée",
      "amélioration non démontrée",
      "régression",
      "limite du modèle imposé",
    ]) {
      expect(doc, verdict).toContain(verdict);
    }
  });
});
