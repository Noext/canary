import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertionMatches,
  type Canary,
  compileAction,
  compileProbe,
  type Observation,
  PLAN_EVIDENCE_SNAPSHOT_CHARS,
} from "./canary.js";
import type { Config } from "./config.js";
import { type Diagnostic, diagnose, QaError } from "./diagnostics.js";
import { prepareScenario } from "./fixtures.js";
import {
  ariaRoleNameNodes,
  observedTargetsNote,
  typographicTargetNote,
} from "./plan-evidence.js";
import type { ProgressEvent } from "./progress.js";
import type {
  Assertion,
  Locator,
  Scenario,
  ScenarioResult,
  SourceLineMaterial,
} from "./schema.js";
import { compareVisual } from "./visual.js";

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
async function explainMissingTarget(
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
        }
      : { diagnostic };
  } catch {
    // Le relevé est un confort : une page qui ne répond plus garde le message
    // générique, et l'échec d'origine reste celui qui est rapporté.
    return { diagnostic };
  }
}

/**
 * Le contrat joué doit être EXACTEMENT le contrat planifié : mêmes identifiants,
 * même ordre. Comparer les longueurs laissait passer une étape jouée deux fois
 * compensant une étape sautée, et surtout ne disait pas laquelle manquait : le
 * hint nomme les étapes absentes du relevé.
 */
function finish(result: ScenarioResult) {
  const planned = result.scenario.steps.map((step) => step.id);
  const played = result.contract?.completedSteps ?? [];
  if (
    played.length !== planned.length ||
    played.some((id, index) => id !== planned[index])
  ) {
    const missing = planned.filter((id) => !played.includes(id));
    throw new QaError(
      "CONTRACT_INCOMPLETE",
      "AI attempted to finish before all planned assertions and required steps completed",
      `Execute the original ordered contract; do not omit actions or weaken assertions.${missing.length > 0 ? ` Missing steps: ${missing.join(", ")}.` : ""}`
    );
  }
  if (
    !result.scenario.assertions.every((a) =>
      result.assertions.some((item) => item.id === a.id && item.passed)
    )
  ) {
    throw new Error(
      "AI attempted to finish before all planned assertions passed"
    );
  }
  result.outcome = "passed";
}
async function performStep(
  sessionId: string,
  step: Scenario["steps"][number],
  index: number,
  result: ScenarioResult,
  preview: string,
  canary: Canary,
  baselines: Map<string, unknown>,
  config: Config,
  repo: string
) {
  const { action } = step;
  const assertion =
    action.type === "assert" ||
    action.type === "download" ||
    action.type === "popup"
      ? result.scenario.assertions.find(
          (item) => item.id === action.assertionId
        )
      : undefined;
  if (
    action.type === "assert" &&
    result.assertions.some((item) => item.id === action.assertionId)
  ) {
    throw new Error("Assertion has already been evaluated");
  }
  const observation = await canary.act(
    sessionId,
    `${index}-${action.type}`,
    compileAction(
      action.type === "assert"
        ? {
            type: "assert",
            assertionId: action.assertionId,
            ...(assertion?.target ? { locator: assertion.target } : {}),
          }
        : action,
      preview,
      assertion
    )
  );

  if (assertion) {
    await evaluateAssertion(
      sessionId,
      assertion,
      observation,
      result,
      preview,
      canary,
      baselines,
      config,
      repo
    );
  }
  // Un clic d'établissement dont la cible est absente n'a rien fait : l'état
  // qu'il visait était déjà en place. L'étape reste dans le contrat joué, elle
  // est marquée sautée pour que le rapport dise ce qui s'est réellement passé.
  const skipped =
    action.type === "click" &&
    action.ifPresent === true &&
    observation.actual === false;
  result.steps.push({
    index,
    stepId: step.id,
    reason: skipped
      ? `${step.description} — skipped: the target is absent, so the state it establishes is already in place`
      : step.description,
    action,
    ok: true,
    ...(skipped ? { skipped: true } : {}),
    observation: JSON.stringify(observation),
  });
}
/**
 * Relit la cible après le rechargement pour prouver une `persisted`. Une cible
 * qui disparaît entre la première lecture et cette relecture n'efface pas la
 * valeur déjà lue : c'est une régression réelle, enregistrée avec cette valeur
 * plutôt qu'annoncée comme une cible « jamais apparue ».
 *
 * Cette valeur ne remonte jamais dans `result.error` : le message est repris par
 * `reportMarkdown` et publié en commentaire de PR dès que la publication est
 * active, alors qu'une valeur lue dans la page peut venir d'une session
 * authentifiée. Elle reste dans l'assertion, c'est-à-dire dans l'artefact
 * d'assertion servi derrière l'autorisation du tableau de bord.
 */
async function readPersisted(
  sessionId: string,
  assertion: Assertion,
  observation: Observation,
  result: ScenarioResult,
  preview: string,
  canary: Canary,
  config: Config,
  baseline: unknown
): Promise<{ handled: true } | { handled: false; persisted: unknown }> {
  try {
    const persisted = (
      await canary.act(
        sessionId,
        `persistence-${assertion.id}`,
        compileProbe(assertion, preview, true)
      )
    ).actual;
    return { handled: false, persisted };
  } catch (error) {
    const diagnostic = diagnose(error, config);
    if (
      diagnostic.code !== "TARGET_NOT_FOUND" ||
      observation.actual === undefined
    ) {
      throw error;
    }
    result.assertions.push({
      id: assertion.id,
      passed: false,
      actual: observation.actual,
      baseline,
    });
    result.outcome = "failed";
    result.diagnostic = diagnostic;
    result.error = `Assertion ${assertion.id} failed: the value observed before the reload is no longer present in the target after it — persistence is not demonstrated — ${diagnostic.message}`;
    return { handled: true };
  }
}
async function evaluateAssertion(
  sessionId: string,
  assertion: Assertion,
  observation: Observation,
  result: ScenarioResult,
  preview: string,
  canary: Canary,
  baselines: Map<string, unknown>,
  config: Config,
  repo: string
) {
  const baseline = baselines.get(assertion.id);
  let persisted: unknown;
  if (assertion.verification === "persisted") {
    const probe = await readPersisted(
      sessionId,
      assertion,
      observation,
      result,
      preview,
      canary,
      config,
      baseline
    );
    if (probe.handled) {
      return;
    }
    persisted = probe.persisted;
  }
  const actual =
    assertion.kind === "visual"
      ? await compareVisual(
          observation.actual,
          assertion.expected,
          repo,
          config
        )
      : observation.actual;
  const verification = assertion.verification ?? "state";
  const passed =
    (assertion.kind === "visual"
      ? (actual as { passed: boolean }).passed
      : assertionMatches(assertion, actual)) &&
    (!["transition", "persisted"].includes(verification) ||
      (baselines.has(assertion.id) &&
        !isDeepStrictEqual(baseline, observation.actual))) &&
    (verification !== "persisted" || assertionMatches(assertion, persisted));
  // A transition whose value did not change proves nothing: the element may be
  // broken or invariant, and the identical baseline cannot tell the two apart.
  const unchanged =
    ["transition", "persisted"].includes(verification) &&
    baselines.has(assertion.id) &&
    isDeepStrictEqual(baseline, observation.actual);
  if (assertion.kind === "visual") {
    observation.actual = actual;
  }
  result.assertions.push({
    id: assertion.id,
    passed,
    actual,
    baseline,
    persisted,
  });
  if (!passed) {
    result.outcome = "failed";
    if (unchanged) {
      // Naming the missing transition, not recopying the assertion description:
      // "the element still shows X" reads as a regression while actual and
      // baseline agree, and sends the operator after an innocent element.
      result.diagnostic = diagnose(
        new QaError(
          "TRANSITION_NOT_OBSERVED",
          `Assertion ${assertion.id}: no change observed — the value after step ${assertion.afterStep ?? "the interaction"} is identical to the baseline probed before it, so the required ${verification} is not demonstrated`,
          `Require a change only from a value that must change. For an invariance after an interaction, use verification "state" with afterStep set to the interaction step (the element is still there after clicking X).`
        ),
        config
      );
      result.error = result.diagnostic.message;
    } else {
      result.error = `Assertion ${assertion.id} failed: ${assertion.description}`;
    }
  }
}
async function captureBaselines(
  sessionId: string,
  scenario: Scenario,
  stepId: string | undefined,
  baselines: Map<string, unknown>,
  preview: string,
  canary: Canary
) {
  for (const assertion of scenario.assertions) {
    if (
      assertion.afterStep === stepId &&
      ["transition", "persisted"].includes(assertion.verification) &&
      !baselines.has(assertion.id)
    ) {
      const observation = await canary.act(
        sessionId,
        `baseline-${assertion.id}`,
        compileProbe(assertion, preview)
      );
      baselines.set(assertion.id, observation.actual);
    }
  }
}
/**
 * Une cible qui n'apparaît jamais est une promesse non tenue, pas une panne :
 * un `assert` affirme qu'un élément existe, donc son échec est une assertion
 * fausse et le scénario échoue. Un clic dont la même cible ne résout jamais
 * reste une panne d'exécution (`false`) : l'action n'a pas atteint son but.
 */
function failAssertionOnMissingTarget(
  result: ScenarioResult,
  step: Scenario["steps"][number],
  diagnostic: Diagnostic,
  baselines: Map<string, unknown>
): boolean {
  if (step.action.type !== "assert" || diagnostic.code !== "TARGET_NOT_FOUND") {
    return false;
  }
  const { assertionId } = step.action;
  if (!result.assertions.some((item) => item.id === assertionId)) {
    result.assertions.push({
      id: assertionId,
      passed: false,
      actual: undefined,
      baseline: baselines.get(assertionId),
    });
  }
  result.outcome = "failed";
  result.diagnostic = diagnostic;
  result.error = `Assertion ${assertionId} failed: the target never appeared — ${diagnostic.message}`;
  return true;
}
async function driveScenario(
  sessionId: string,
  result: ScenarioResult,
  preview: string,
  config: Config,
  canary: Canary,
  record: (event: ProgressEvent) => Promise<void>,
  repo: string,
  material: SourceLineMaterial[]
) {
  await canary.act(
    sessionId,
    "open-preview",
    compileAction({ type: "goto", path: preview }, preview)
  );
  const baselines = new Map<string, unknown>();
  // Le plan est un contrat figé : l'hôte joue chaque étape dans l'ordre, sans
  // consulter le modèle. Une cible que l'IA choisirait autrement n'existe plus,
  // et aucun jeton d'exécution n'est dépensé pour recopier le plan.
  for (const [offset, step] of result.scenario.steps.entries()) {
    const index = offset + 1;
    const started = Date.now();
    await captureBaselines(
      sessionId,
      result.scenario,
      step.action.type === "observe" ? undefined : step.id,
      baselines,
      preview,
      canary
    );
    await record({
      phase: "execution",
      scenarioId: result.scenario.id,
      step: index,
      action: step.action.type,
    });
    try {
      await performStep(
        sessionId,
        step,
        index,
        result,
        preview,
        canary,
        baselines,
        config,
        repo
      );
      // Toute étape planifiée entre au contrat, `observe` compris. L'ancien
      // exécuteur excluait `observe` parce qu'il s'agissait alors d'un coup
      // d'œil libre du modèle, qui ne faisait pas avancer le contrat ; depuis
      // que l'hôte joue le plan figé, c'est une étape planifiée comme une
      // autre, et l'exclure faisait refuser par `finish()` un contrat pourtant
      // joué en entier (run 91fb1e35 : 6 scénarios sur 6, zéro étape en échec,
      // zéro assertion fausse).
      result.contract?.completedSteps.push(step.id);
      const played = result.steps.at(-1);
      let stepOutcome = "ok";
      if (result.outcome === "failed") {
        stepOutcome = "failed";
      }
      if (played?.skipped === true) {
        stepOutcome = "skipped";
      }
      await record({
        phase: "execution",
        scenarioId: result.scenario.id,
        step: index,
        action: step.action.type,
        outcome: stepOutcome,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      const explained = await explainMissingTarget(
        error,
        sessionId,
        step,
        result.scenario,
        preview,
        canary,
        config,
        material
      );
      result.steps.push({
        index,
        stepId: step.id,
        action: step.action,
        ok: false,
        reason: explained.diagnostic.message,
        observation: explained.diagnostic.message,
        // Les noms observés vivent ici, dans l'artefact du run, et nulle part
        // dans ce qui se publie : `reportMarkdown` ne lit pas ce champ.
        observedTargets: explained.observedTargets,
      });
      await record({
        phase: "execution",
        scenarioId: result.scenario.id,
        step: index,
        action: step.action.type,
        outcome: "error",
        diagnostic: explained.diagnostic,
      });
      // Le verdict et l'erreur nommée sont déjà posés : renvoyer ici évite que
      // le catch de `executeScenario` les remplace par le message brut.
      if (
        failAssertionOnMissingTarget(
          result,
          step,
          explained.diagnostic,
          baselines
        )
      ) {
        return;
      }
      if (explained.note) {
        // L'erreur publiée doit porter l'explication : `diagnose` reprend un
        // `QaError` tel quel, alors que l'erreur brute serait rendue sans elle.
        throw new QaError(
          explained.diagnostic.code,
          explained.diagnostic.message,
          explained.diagnostic.hint
        );
      }
      throw error;
    }
    if (result.outcome === "failed") {
      return;
    }
  }
  finish(result);
}
export async function executeScenario(
  scenario: Scenario,
  preview: string,
  root: string,
  config: Config,
  canary: Canary,
  record: (event: ProgressEvent) => Promise<void> = async () =>
    Promise.resolve(),
  repo = "",
  material: SourceLineMaterial[] = []
): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    scenario,
    outcome: "blocked",
    steps: [],
    assertions: [],
    artifacts: [],
    contract: {
      completedSteps: [],
      totalSteps: scenario.steps.length,
      hash: createHash("sha256").update(JSON.stringify(scenario)).digest("hex"),
    },
  };
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const prepared = await prepareScenario(scenario, repo, config);
    cleanup = prepared.cleanup;
    result.sessionId = await canary.start(scenario.title, prepared.auth);
    await driveScenario(
      result.sessionId,
      result,
      preview,
      config,
      canary,
      record,
      repo,
      material
    );
  } catch (error) {
    result.diagnostic = diagnose(error, config);
    result.error = result.diagnostic.message;
  } finally {
    if (result.sessionId) {
      try {
        await record({ phase: "evidence", scenarioId: scenario.id });
        result.artifacts = await canary.end(
          result.sessionId,
          join(root, scenario.id)
        );
      } catch (error) {
        result.outcome = "blocked";
        result.diagnostic = diagnose(error, config);
        result.error = `${result.error ?? ""} Evidence finalization: ${result.diagnostic.message}`;
        await canary.abort(result.sessionId);
      }
    }
  }
  try {
    await cleanup?.();
  } catch (error) {
    result.outcome = "blocked";
    result.diagnostic = diagnose(error, config);
    result.error = `Fixture cleanup failed: ${result.diagnostic.message}`;
  }
  await record({
    phase: "execution",
    scenarioId: scenario.id,
    outcome: result.outcome,
    diagnostic: result.diagnostic,
  });
  return result;
}
