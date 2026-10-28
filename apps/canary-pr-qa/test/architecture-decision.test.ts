import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La décision d'architecture, telle qu'elle a été écrite avant le code.
 *
 * Le contrat de l'objectif exige que trois options soient comparées, que chaque
 * option dise ce qu'elle empêche *par construction*, que les invariants soient
 * nommés, et que l'hypothèse et ses seuils soient figés avant l'implémentation.
 * Ce test échoue si le document perd l'un de ces éléments — ou si le drapeau
 * annoncé arrive un jour avec un défaut contraire à la décision.
 */
const app = join(import.meta.dirname, "..");
const doc = readFileSync(
  join(app, "..", "..", "docs", "pr-qa-architecture-target.md"),
  "utf8"
).replace(/\s+/g, " ");

describe("architecture cible : décision écrite avant le code", () => {
  it("compare la boucle observe→act à deux alternatives, avec ce que chacune empêche", () => {
    for (const option of [
      "Option A — boucle observe→act complète",
      "Option B — plan figé + vérification de cible avant chaque action",
      "Option C — objectifs et preuves depuis le diff, actions résolues à l'exécution",
    ]) {
      expect(doc, option).toContain(option);
    }
    // Ce qui doit être impossible, un mécanisme par ligne.
    for (const danger of [
      "Cible DOM inventée",
      "Transition annoncée sans changement",
      "Précondition absente ou héritée d'un autre scénario",
      "Valeur attendue incohérente avec l'observation",
      "Scénario vert sans avoir vérifié son objectif",
      "Réparation qui rend le test plus permissif",
    ]) {
      expect(doc, danger).toContain(danger);
    }
    expect(doc).toContain("**Décision : option C.**");
  });

  it("nomme les quatre invariants que le moteur garantit", () => {
    for (const invariant of [
      "I1 — Isolation logique",
      "I2 — Provenance",
      "I3 — Preuve d'objectif",
      "I4 — Réparation non permissive",
    ]) {
      expect(doc, invariant).toContain(invariant);
    }
  });

  it("fige l'hypothèse, les seuils de dégradation et la réfutation", () => {
    expect(doc).toContain("**Hypothèse H1.**");
    expect(doc).toContain("au moins **20 points absolus**");
    expect(doc).toContain("pas d'augmentation de plus de 3 points");
    expect(doc).toContain("baisse de moins de 5 %");
    expect(doc).toContain("pas de hausse de plus de 25 %");
    expect(doc).toContain("**Réfutation.**");
    // La puissance est annoncée telle qu'elle est, y compris ce qu'elle ne peut pas
    // trancher : un écart réel de 15 points serait souvent manqué.
    expect(doc).toContain("15 points serait souvent manqué");
    expect(doc).toContain("amélioration non démontrée");
  });

  it("annonce le retrait derrière drapeau, sans rien supprimer avant mesure", () => {
    expect(doc).toContain("`QA_OBSERVE_ACT`");
    expect(doc).toContain("désactivé par défaut");
    expect(doc).toContain(
      "Aucun contrôle n'est supprimé avant que la campagne"
    );
  });

  it("si le drapeau existe dans le code, son défaut respecte la décision", () => {
    const config = readFileSync(join(app, "src", "config.ts"), "utf8");
    const declaration = config.slice(
      config.indexOf("QA_OBSERVE_ACT"),
      config.indexOf("QA_OBSERVE_ACT") + 400
    );
    if (!config.includes("QA_OBSERVE_ACT")) {
      // Pas encore implémenté : la décision est en avance sur le code, ce que le
      // document assume explicitement (PR 1).
      return;
    }
    expect(declaration).toContain(".default(false)");
  });
});
