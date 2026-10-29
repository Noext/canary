import { QaError } from "./diagnostics.js";
import type { Plan } from "./schema.js";

/**
 * Une assertion qui se déclare `persistence` doit être LUE comme telle :
 * `verification: "persisted"` recharge la page et relit la valeur, ce qui est la
 * seule lecture qui démontre que la condition a survécu à l'événement. Déclarée
 * `persistence` mais vérifiée en `state` (ou `transition`), l'assertion est
 * satisfaite par l'état d'avant et ne prouve rien de ce qu'elle annonce.
 *
 * Le refus ne convertit jamais en silence : le plan doit décrire lui-même la
 * vérification de persistance. Une assertion sans `assertionIntent` reste
 * INCONNUE — les plans antérieurs ne portent pas ce champ — et n'est jamais
 * refusée sur cette seule ambiguïté : deviner l'intention depuis un nom d'action
 * ou un sélecteur serait l'heuristique que ce champ remplace.
 */
export function persistenceIntentRefusals(
  plan: Pick<Plan, "scenarios">
): { error: QaError; scenarioId: string }[] {
  return plan.scenarios.flatMap((scenario) => {
    const offending = (scenario.assertions ?? []).filter(
      (assertion) =>
        assertion.assertionIntent === "persistence" &&
        (assertion.verification ?? "state") !== "persisted"
    );
    if (offending.length === 0) {
      return [];
    }
    return [
      {
        error: new QaError(
          "PERSISTENCE_INTENT_MISMATCH",
          `Scenario ${scenario.id}: assertion(s) ${offending
            .map(
              (assertion) =>
                `${assertion.id} declare persistence but verify it with "${assertion.verification ?? "state"}"`
            )
            .join(
              ", "
            )} — a value read again after the event is satisfied by the state before it, so it proves nothing about what survived`,
          'Write the assertion as verification: "persisted" on the same target: it reloads the page and reads the value again, which is what proves survival. If the condition is not meant to survive a reload, declare assertionIntent: "invariant" and verify it on the step that produces it.'
        ),
        scenarioId: scenario.id,
      },
    ];
  });
}
