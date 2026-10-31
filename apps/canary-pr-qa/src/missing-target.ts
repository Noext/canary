import {
  type Canary,
  compileAction,
  foldTypography,
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

/** Rôles d'un champ de saisie : la seule cible qu'une reprise par inclusion vise. */
const FIELD_ROLES = new Set(["textbox", "combobox", "spinbutton", "listbox"]);
const nameWords = (value: string) =>
  foldTypography(value.replace(/[\u200b\u00ad]/g, ""))
    .split(/\s+/)
    .filter(Boolean);
const numbersOf = (words: string[]) =>
  words.filter((word) => /\d/.test(word)).join(" ");

/** Vrai quand `wanted` figure dans `offered`, mot pour mot et à la suite. */
function containsWords(offered: string[], wanted: string[]): boolean {
  return offered.some((_word, start) =>
    wanted.every((word, offset) => offered[start + offset] === word)
  );
}

/**
 * La reprise DÉTERMINISTE d'un `fill` ou d'un `select` dont le libellé est
 * introuvable : le champ UNIQUE dont le nom accessible CONTIENT ce libellé, mot
 * pour mot et à la suite, avec exactement les mêmes nombres. C'est le gabarit
 * `Quantité · ${d.label}` : le plan lit « Billet de 100 € » dans le catalogue,
 * la page expose « Quantité · Billet de 100 € » (banc f3, runs 1 et 3 : cinq
 * scénarios bloqués). Rien n'est deviné : deux candidats, ou un nombre ajouté
 * ou changé, et il n'y a pas de reprise — le comptage testé reste celui du
 * plan. Deux éléments du même nom comptent pour deux : le locator rejoué
 * serait ambigu.
 */
function containingField(
  step: Scenario["steps"][number],
  nodes: { name: string; role: string }[]
): { step: Scenario["steps"][number]; target: ObservedTarget } | undefined {
  const { action } = step;
  if (action.type !== "fill" && action.type !== "select") {
    return;
  }
  const { locator } = action;
  if (locator.by === "role" && !FIELD_ROLES.has(locator.value)) {
    return;
  }
  // Seuls un libellé et un nom de rôle désignent un champ par son nom.
  let label = "";
  if (locator.by === "label") {
    label = locator.value;
  } else if (locator.by === "role") {
    label = locator.name;
  }
  const wanted = nameWords(label);
  if (wanted.length < 2) {
    return;
  }
  const found = nodes.filter((node) => {
    const offered = nameWords(node.name);
    return (
      FIELD_ROLES.has(node.role) &&
      offered.length > wanted.length &&
      containsWords(offered, wanted) &&
      numbersOf(offered) === numbersOf(wanted)
    );
  });
  const [only] = found;
  if (found.length !== 1 || only === undefined) {
    return;
  }
  const target = {
    role: only.role,
    name: only.name.replace(/\s+/g, " ").trim(),
  };
  // La tentative rejouée porte sa propre copie de l'action : le plan partagé et
  // son hash de contrat gardent la cible que le planificateur avait écrite.
  return {
    step: {
      ...step,
      action: {
        ...action,
        locator: { by: "role", value: target.role, name: target.name },
      },
    },
    target,
  };
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
 * du 22 oct. 2026). `contained` est la reprise par inclusion d'un champ
 * (`containingField`), que l'exécuteur rejoue avant toute reprise par modèle.
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
  contained?: ReturnType<typeof containingField>;
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
    const contained = containingField(step, nodes);
    return explanation
      ? {
          contained,
          diagnostic: {
            ...diagnostic,
            message: `${diagnostic.message} — ${explanation}`,
          },
          note: explanation,
          observedTargets: observed?.detail,
          targets: observed?.targets,
        }
      : { contained, diagnostic };
  } catch {
    // Le relevé est un confort : une page qui ne répond plus garde le message
    // générique, et l'échec d'origine reste celui qui est rapporté.
    return { diagnostic };
  }
}
