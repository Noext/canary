import {
  foldTypography,
  PLAN_EVIDENCE_SNAPSHOT_CHARS,
  typographicCodepoints,
  typographicVariants,
} from "./canary.js";
import { QaError } from "./diagnostics.js";
import { unstableSelectorReason } from "./plan-selector.js";
import type { Locator, Plan, Scenario } from "./schema.js";

/**
 * Contrôle d'évidence du plan : juste après la planification, l'instantané
 * d'accessibilité de la page de découverte est la seule preuve disponible sur ce
 * qui existe réellement dans l'interface. Une cible role+nom absente de cet
 * instantané — ses graphies typographiques comprises, que le repli d'exécution
 * vise — ne peut pas être résolue par Canary : le scénario est refusé avant
 * toute exécution au lieu d'échouer en plein run sur un élément inventé.
 *
 * L'évidence reste incomplète par nature : l'instantané est limité à 12 niveaux
 * de profondeur et les types de locator css/text/label/placeholder/testId lisent
 * le DOM, pas l'arbre d'accessibilité. Ces cas sont rapportés « non concluant »
 * (jamais un refus) pour ne pas remplacer un contrôle réel par un faux contrôle.
 */

/** Seul alias de rôle accepté par getByRole qui diffère du rôle imprimé par l'instantané. */
const ROLE_ALIASES: Record<string, string> = { image: "img" };

/** Rôle de l'instantané correspondant au rôle d'un locator. */
function ariaRole(value: string): string {
  return ROLE_ALIASES[value.toLowerCase()] ?? value.toLowerCase();
}

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

interface AriaNames {
  nodes: AriaNameNode[];
  roles: Map<string, Set<string>>;
}

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

export interface AriaNameNode {
  name: string;
  role: string;
}

/**
 * Inventaire des noms accessibles par rôle, lu depuis l'arbre d'accessibilité :
 * une ligne « - role "nom" [attributs] » par nœud. Les nœuds texte
 * (« - text: … ») et les propriétés (« - /url: … ») sont ignorés, comme le fait
 * un locator role : seul le nom accessible compte.
 */
export function ariaRoleNameNodes(aria: string): AriaNameNode[] {
  const nodes: AriaNameNode[] = [];
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
    nodes.push({
      role: role.toLowerCase(),
      name: rest.startsWith('"') ? readQuoted(rest) : "",
    });
  }
  return nodes;
}

/** Noms accessibles par rôle, normalisés comme avant la comparaison exacte. */
export function ariaRoleNames(aria: string): Map<string, Set<string>> {
  return roleNameSets(ariaRoleNameNodes(aria));
}

function roleNameSets(nodes: AriaNameNode[]): Map<string, Set<string>> {
  const roles = new Map<string, Set<string>>();
  for (const { role, name } of nodes) {
    const names = roles.get(role) ?? new Set<string>();
    names.add(normalizeText(name));
    roles.set(role, names);
  }
  return roles;
}

/**
 * Explication d'un nom accessible resté introuvable : le plan vise une graphie,
 * la page en expose une autre, et les deux noms se replient l'un sur l'autre
 * (`’` U+2019 contre `'` U+0027, espace insécable contre espace). Le relevé ne
 * décide rien : il n'est produit qu'après un échec déjà constaté, et un
 * candidat ambigu ou absent laisse le message générique. Le repli d'exécution
 * est plus étroit (il n'essaie pas l'espace ordinaire) ; ce message décrit donc
 * aussi les écarts qu'il n'essaie pas.
 */
export function typographicTargetNote(
  planned: string,
  role: string,
  nodes: AriaNameNode[]
): string | undefined {
  const matches = nodes
    .filter((node) => node.role === ariaRole(role))
    .map((node) => node.name)
    .filter(
      (name) =>
        name !== planned && foldTypography(name) === foldTypography(planned)
    );
  if (matches.length !== 1) {
    return;
  }
  const exposed = matches[0] as string;
  return `le plan vise ${planned} (${typographicCodepoints(planned, exposed)}) ; la page expose ${exposed} (${typographicCodepoints(exposed, planned)})`;
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
  names: AriaNames,
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
        names,
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
      names,
      report
    );
  }
}

function checkTarget(
  scenario: Scenario,
  stepId: string,
  locator: Locator,
  pageUnchanged: boolean,
  names: AriaNames,
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
  const role = ariaRole(locator.value);
  if (names.roles.get(role)?.has(normalizeText(locator.name))) {
    return;
  }
  // Le repli d'exécution vise ces mêmes variantes (`canary.ts` les compile) :
  // refuser ici un nom que le run saurait résoudre remplacerait un contrôle réel
  // par un faux refus.
  const variants = typographicVariants(locator.name);
  if (
    names.nodes.some(
      (node) => node.role === role && variants.includes(node.name)
    )
  ) {
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

/**
 * Refus rendus au planificateur pour une cible CSS construite sur une classe ou
 * une couleur (`plan-selector.ts` porte la règle) : un refus par scénario, qui
 * nomme l'étape, la cible et ce qu'il faut viser à la place. `runner.ts` les
 * rejoue après l'appel modèle, pour qu'un plan non corrigé soit bloqué avant
 * exécution.
 */
export function unstableSelectorRefusals(
  plan: Plan
): { error: QaError; scenario: Scenario }[] {
  const refusals: { error: QaError; scenario: Scenario }[] = [];
  for (const scenario of plan.scenarios) {
    const targets = [
      ...scenario.steps.flatMap((step) =>
        "locator" in step.action && step.action.locator
          ? [{ locator: step.action.locator, label: step.id }]
          : []
      ),
      ...scenario.assertions.flatMap((assertion) =>
        assertion.target
          ? [
              {
                locator: assertion.target,
                // L'assertion est nommée avec son étape : deux assertions
                // partageant la même étape seraient sinon indistinguables.
                label: `${assertion.afterStep ?? assertion.id} (assertion ${assertion.id})`,
              },
            ]
          : []
      ),
    ].flatMap((target) => {
      const reason = unstableSelectorReason(target.locator);
      return reason === undefined ? [] : [{ ...target, reason }];
    });
    if (targets.length === 0) {
      continue;
    }
    refusals.push({
      scenario,
      error: new QaError(
        "PLAN_SELECTOR_UNSTABLE",
        `Scenario ${scenario.id} targets an element with a CSS selector built from ${targets
          .map(
            (target) =>
              `${target.reason}: ${target.label} → ${describeTarget(target.locator)}`
          )
          .join(" ; ")}`,
        'Target what the discovery snapshot shows instead: a role with its accessible name, an id, or a stable attribute the source defines. To prove an absence, use kind "hidden" or a count of 0 on a selector the page still carries. A class name or a color read in the source is not a stable target.'
      ),
    });
  }
  return refusals;
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
  const nodes = ariaRoleNameNodes(evidence.aria);
  const names: AriaNames = { nodes, roles: roleNameSets(nodes) };
  for (const scenario of plan.scenarios) {
    inspectScenario(scenario, evidence, names, report);
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
