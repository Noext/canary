import { PLAN_EVIDENCE_SNAPSHOT_CHARS } from "./canary.js";
import type { Locator, Plan, Scenario } from "./schema.js";

/**
 * Contrôle d'évidence du plan : juste après la planification, l'instantané
 * d'accessibilité de la page de découverte est la seule preuve disponible sur ce
 * qui existe réellement dans l'interface. Une cible role+nom absente de cet
 * instantané ne peut pas être résolue par Canary : le scénario est refusé avant
 * toute exécution au lieu d'échouer en plein run sur un élément inventé.
 *
 * L'évidence reste incomplète par nature : l'instantané est limité à 12 niveaux
 * de profondeur et les types de locator css/text/label/placeholder/testId lisent
 * le DOM, pas l'arbre d'accessibilité. Ces cas sont rapportés « non concluant »
 * (jamais un refus) pour ne pas remplacer un contrôle réel par un faux contrôle.
 */

/** Seul alias de rôle accepté par getByRole qui diffère du rôle imprimé par l'instantané. */
const ROLE_ALIASES: Record<string, string> = { image: "img" };

/** Actions qui modifient la page : tout ce qui les suit n'est plus équivalent à la page de découverte. */
const CONTAMINATING = new Set([
  "click",
  "fill",
  "press",
  "select",
  "check",
  "download",
  "popup",
]);

export interface PlanEvidenceRefusal {
  scenarioId: string;
  stepId: string;
  target: string;
}
export interface PlanEvidenceGap {
  reason: string;
  scenarioId: string;
  stepId: string;
  target: string;
}
export interface PlanEvidenceReport {
  /** Contrôle impossible sur tout le plan (instantané absent ou coupé au plafond). */
  incomplete?: string;
  /** Cibles que l'instantané ne permet pas de trancher : jamais un refus, mais dit explicitement. */
  inconclusive: PlanEvidenceGap[];
  /** Cibles prouvées absentes de la page de découverte : refus avant exécution. */
  refusals: PlanEvidenceRefusal[];
}
export interface DiscoveryEvidence {
  /** Arbre d'accessibilité complet capturé pendant la découverte. */
  aria: string;
  /** URL de la page de découverte, référence des `goto` qui ne la quittent pas. */
  url: string;
}

function normalizeText(value: string): string {
  // Même normalisation que les noms accessibles : espaces insécables et retours
  // à la ligne neutralisés avant comparaison exacte.
  return value
    .replace(/[\u200b\u00ad]/g, "")
    .replace(/[\r\n\s\t]+/g, " ")
    .trim();
}

/** Lit la chaîne entre guillemets d'un nœud de l'instantané, échappements compris. */
function readQuoted(value: string): string {
  let result = "";
  let escaped = false;
  for (const char of value.slice(1)) {
    if (escaped) {
      result += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return result;
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Inventaire des noms accessibles par rôle, lu depuis l'arbre d'accessibilité :
 * une ligne « - role "nom" [attributs] » par nœud. Les nœuds texte
 * (« - text: … ») et les propriétés (« - /url: … ») sont ignorés, comme le fait
 * un locator role : seul le nom accessible compte.
 */
export function ariaRoleNames(aria: string): Map<string, Set<string>> {
  const roles = new Map<string, Set<string>>();
  for (const line of aria.split("\n")) {
    const node = line.trim();
    if (!node.startsWith("- ") || /^- \/|^- text\b/.test(node)) {
      continue;
    }
    const role = /^[a-z]+/i.exec(node.slice(2))?.[0];
    if (!role) {
      continue;
    }
    const rest = node.slice(2 + role.length).trimStart();
    const names = roles.get(role.toLowerCase()) ?? new Set<string>();
    names.add(normalizeText(rest.startsWith('"') ? readQuoted(rest) : ""));
    roles.set(role.toLowerCase(), names);
  }
  return roles;
}

function describeTarget(locator: Locator): string {
  return locator.by === "role"
    ? `${locator.by}=${locator.value} name=${JSON.stringify(locator.name)}`
    : `${locator.by}=${JSON.stringify(locator.value)}`;
}

/** Un `goto` vers la page de découverte recharge la même page : l'équivalence tient (fragment ignoré). */
function staysOnDiscoveryPage(path: string, discoveryUrl: string): boolean {
  try {
    const target = new URL(path, discoveryUrl);
    const discovery = new URL(discoveryUrl);
    return (
      target.origin === discovery.origin &&
      target.pathname === discovery.pathname &&
      target.search === discovery.search
    );
  } catch {
    return false;
  }
}

function stepIndex(scenario: Scenario, predicate: (index: number) => boolean) {
  return scenario.steps.findIndex((_step, index) => predicate(index));
}

/** Pour chaque étape, la page est-elle encore celle de la découverte à son entrée ? */
function pageUnchangedByStep(
  scenario: Scenario,
  discoveryUrl: string
): boolean[] {
  // Une interaction ou une route différente rend la page inconnue pour toutes
  // les étapes suivantes, sans retour arrière possible.
  const pageUnchanged: boolean[] = [];
  let unchanged = true;
  for (const step of scenario.steps) {
    pageUnchanged.push(unchanged);
    if (step.action.type === "goto") {
      if (unchanged && !staysOnDiscoveryPage(step.action.path, discoveryUrl)) {
        unchanged = false;
      }
    } else if (CONTAMINATING.has(step.action.type)) {
      unchanged = false;
    }
  }
  return pageUnchanged;
}

/** Position de l'étape qui relit la cible d'une assertion. */
function assertionReadIndex(
  scenario: Scenario,
  assertion: Scenario["assertions"][number]
): number {
  // Une vérification transition/persisted relève sa référence avant
  // l'interaction : la cible doit donc déjà exister à l'entrée de `afterStep`.
  // Les autres vérifications lisent leur cible pendant leur propre étape.
  if (["transition", "persisted"].includes(assertion.verification)) {
    return stepIndex(
      scenario,
      (index) => scenario.steps[index]?.id === assertion.afterStep
    );
  }
  return stepIndex(scenario, (index) =>
    isAssertionStep(scenario, index, assertion.id)
  );
}

function inspectScenario(
  scenario: Scenario,
  evidence: DiscoveryEvidence,
  roles: Map<string, Set<string>>,
  report: PlanEvidenceReport
) {
  const pageUnchanged = pageUnchangedByStep(scenario, evidence.url);
  for (const [index, step] of scenario.steps.entries()) {
    const locator = "locator" in step.action ? step.action.locator : undefined;
    if (locator) {
      checkTarget(
        scenario,
        step.id,
        locator,
        pageUnchanged[index] ?? false,
        roles,
        report
      );
    }
  }
  for (const assertion of scenario.assertions) {
    if (!assertion.target) {
      continue;
    }
    const readIndex = assertionReadIndex(scenario, assertion);
    if (readIndex < 0) {
      report.inconclusive.push({
        scenarioId: scenario.id,
        stepId: assertion.afterStep ?? assertion.id,
        target: describeTarget(assertion.target),
        reason: "étape de lecture introuvable dans le contrat",
      });
      continue;
    }
    checkTarget(
      scenario,
      scenario.steps[readIndex]?.id ?? assertion.id,
      assertion.target,
      pageUnchanged[readIndex] ?? false,
      roles,
      report
    );
  }
}

function checkTarget(
  scenario: Scenario,
  stepId: string,
  locator: Locator,
  pageUnchanged: boolean,
  roles: Map<string, Set<string>>,
  report: PlanEvidenceReport
) {
  if (!pageUnchanged) {
    report.inconclusive.push({
      scenarioId: scenario.id,
      stepId,
      target: describeTarget(locator),
      reason:
        "une étape antérieure a interagi avec la page ou en a changé la route",
    });
    return;
  }
  if (locator.by !== "role") {
    report.inconclusive.push({
      scenarioId: scenario.id,
      stepId,
      target: describeTarget(locator),
      reason: `type de locator ${locator.by} absent de l'arbre d'accessibilité`,
    });
    return;
  }
  const role =
    ROLE_ALIASES[locator.value.toLowerCase()] ?? locator.value.toLowerCase();
  if (roles.get(role)?.has(normalizeText(locator.name))) {
    return;
  }
  report.refusals.push({
    scenarioId: scenario.id,
    stepId,
    target: describeTarget(locator),
  });
}

function isAssertionStep(
  scenario: Scenario,
  index: number,
  assertionId: string
): boolean {
  const action = scenario.steps[index]?.action;
  return Boolean(
    action &&
      ["assert", "download", "popup"].includes(action.type) &&
      "assertionId" in action &&
      action.assertionId === assertionId
  );
}

/** Une assertion d'absence attend une cible absente : la sonder n'a pas de sens. */
function expectsAbsence(assertion: Scenario["assertions"][number]): boolean {
  if (assertion.kind === "hidden") {
    return true;
  }
  return assertion.kind === "count" && assertion.expected === 0;
}

/**
 * Les cibles qu'une sonde navigateur peut vérifier sans mentir : celles dont la
 * lecture a lieu alors que la page est encore celle de la découverte. Une cible
 * qui n'apparaît qu'après une navigation, une interaction ou un login ne peut
 * pas être jugée depuis cette page — la refuser ferait refuser des plans
 * valides.
 */
export function probeableTargets(
  plan: Plan,
  discoveryUrl: string
): { assertionId: string; locator: Locator }[] {
  return plan.scenarios.flatMap((scenario) => {
    const unchanged = pageUnchangedByStep(scenario, discoveryUrl);
    return scenario.assertions
      .filter((assertion) => {
        if (!assertion.target || expectsAbsence(assertion)) {
          return false;
        }
        const readIndex = assertionReadIndex(scenario, assertion);
        return readIndex >= 0 && unchanged[readIndex] === true;
      })
      .map((assertion) => ({
        assertionId: `${scenario.id}/${assertion.id}`,
        locator: assertion.target as Locator,
      }));
  });
}

export function validatePlanEvidence(
  plan: Plan,
  evidence: DiscoveryEvidence
): PlanEvidenceReport {
  const report: PlanEvidenceReport = { refusals: [], inconclusive: [] };
  if (!evidence.aria.trim()) {
    report.incomplete =
      "aucun instantané de découverte n'a été capturé pour valider le plan";
    return report;
  }
  if (evidence.aria.length >= PLAN_EVIDENCE_SNAPSHOT_CHARS) {
    report.incomplete = `instantané de découverte coupé au plafond de ${PLAN_EVIDENCE_SNAPSHOT_CHARS} caractères`;
    return report;
  }
  const roles = ariaRoleNames(evidence.aria);
  for (const scenario of plan.scenarios) {
    inspectScenario(scenario, evidence, roles, report);
  }
  return report;
}

/** Message et aide du refus : ils nomment le scénario, l'étape et la cible introuvable. */
export function planEvidenceDiagnostic(
  scenario: Scenario,
  refusals: PlanEvidenceRefusal[],
  inconclusiveCount: number
): { hint: string; message: string } {
  const targets = refusals
    .map((item) => `${item.stepId} → ${item.target}`)
    .join(" ; ");
  const unresolved = inconclusiveCount
    ? ` ${inconclusiveCount} autre(s) cible(s) restent non concluantes (voir la timeline du run).`
    : "";
  return {
    message: `Scénario ${scenario.id} non exécuté : cible absente de l'instantané de la page de découverte (${targets})`,
    hint: `Le plan visait un élément que la page de découverte ne contient pas ; aucune étape navigateur n'a été dépensée. Corrige la cible dans le plan, ou déclare la vue explicitement non testable. L'instantané d'accessibilité est limité à 12 niveaux de profondeur et ne couvre pas les types css/text/label/placeholder/testId.${unresolved}`,
  };
}
