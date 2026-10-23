import {
  type Canary,
  compileAction,
  PLAN_EVIDENCE_SNAPSHOT_CHARS,
} from "./canary.js";
import type { Config } from "./config.js";
import { type Diagnostic, diagnose } from "./diagnostics.js";
import {
  ariaRoleNameNodes,
  observedTargetsNote,
  typographicTargetNote,
} from "./plan-evidence.js";
import type { Locator, Scenario, SourceLineMaterial } from "./schema.js";
import type { ObservedTarget } from "./target-repair.js";

/**
 * Ce qu'un `TARGET_NOT_FOUND` dit d'une page, isolé de l'exécuteur : la cible
 * visée, le relevé des couples rôle+nom réellement exposés, et la phrase
 * publique qui reste constante. L'exécuteur ne garde que la décision — rejouer
 * l'étape sur une cible observée, ou laisser l'échec tel quel.
 */
/** Locator qui porte un nom accessible : le seul concerné par la graphie d'un signe. */
type NamedTarget = Extract<Locator, { by: "role" }>;

/**
 * Cible role+nom d'une étape ou de l'assertion qu'elle exécute. Les autres types
 * de locator ne portent pas de nom accessible.
 */
function roleNameTarget(
  scenario: Scenario,
  step: Scenario["steps"][number]
): NamedTarget | undefined {
  const { action } = step;
  const assertion =
    action.type === "assert"
      ? scenario.assertions.find((item) => item.id === action.assertionId)
      : undefined;
  const target =
    ("locator" in action ? action.locator : undefined) ?? assertion?.target;
  return target?.by === "role" ? target : undefined;
}

/**
 * Une cible restée introuvable est expliquée avec ce que la page expose : une
 * graphie jumelle quand il n'y en a qu'une (Playwright compare le nom accessible
 * caractère par caractère, `exact: true`, et le plan recopie souvent la
 * ponctuation de la source — U+0027 — là où l'application expose l'apostrophe
 * typographique — U+2019), et à défaut les cibles réellement observées dans le
 * DOM à cet instant, rôle et nom accessible, huit au plus. Le relevé n'a lieu
 * qu'après l'échec, n'énonce aucun refus, ne choisit aucune cible et ne bloque
 * aucun run qui réussissait : une page qui ne répond plus garde le message
 * générique. Sans cette énumération, une cible inventée et une cible mal
 * dérivée produisaient le même message, et la différence restait dans le
 * snapshot que personne ne lisait.
 *
 * Rien de ce que la page expose ne se publie : `note` est la phrase qui part
 * dans le message (donc dans le commentaire de PR et le résumé de support) et
 * elle est CONSTANTE — ni nom, ni compte, ni cardinalité, sinon le commentaire
 * répondrait à « ce libellé deviné existe-t-il ? » pour un auteur de PR qui
 * contrôle le diff. `observedTargets` porte le compte et les noms, et ne va que
 * dans l'artefact du run, sous `StepResult.observedTargets` (revue de sécurité
 * du 22 oct. 2026).
 */
export async function explainMissingTarget(
  failure: unknown,
  sessionId: string,
  step: Scenario["steps"][number],
  scenario: Scenario,
  preview: string,
  canary: Canary,
  config: Config,
  material: SourceLineMaterial[]
): Promise<{
  diagnostic: Diagnostic;
  note?: string;
  observedTargets?: string;
  targets?: ObservedTarget[];
}> {
  const diagnostic = diagnose(failure, config);
  if (diagnostic.code !== "TARGET_NOT_FOUND") {
    return { diagnostic };
  }
  const locator = roleNameTarget(scenario, step);
  try {
    const current = await canary.act(
      sessionId,
      "target-name-check",
      compileAction({ type: "observe" }, preview, undefined, {
        evidenceSnapshotChars: PLAN_EVIDENCE_SNAPSHOT_CHARS,
      })
    );
    const nodes = ariaRoleNameNodes(current.evidence ?? current.snapshot);
    const note = locator
      ? typographicTargetNote(locator.name, locator.value, nodes)
      : undefined;
    const observed = note
      ? undefined
      : observedTargetsNote(
          nodes,
          material,
          locator?.by === "role" ? locator.value : undefined
        );
    const explanation = note ?? observed?.published;
    return explanation
      ? {
          diagnostic: {
            ...diagnostic,
            message: `${diagnostic.message} — ${explanation}`,
          },
          note: explanation,
          observedTargets: observed?.detail,
          targets: observed?.targets,
        }
      : { diagnostic };
  } catch {
    // Le relevé est un confort : une page qui ne répond plus garde le message
    // générique, et l'échec d'origine reste celui qui est rapporté.
    return { diagnostic };
  }
}
