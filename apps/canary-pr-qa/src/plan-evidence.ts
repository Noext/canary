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
 * de profondeur, et les types de locator css/label/testId lisent le DOM, pas
 * l'arbre d'accessibilité. Un texte ou un placeholder n'y est lu que lorsque
 * l'instantané le porte ; le reste est rapporté « non concluant » (jamais un
 * refus), pour ne pas remplacer un contrôle réel par un faux contrôle. Une
 * ambiguïté réellement exposée, elle, est refusée : deux graphies concurrentes
 * rendent la cible inexécutable, comme pour role+nom.
 *
 * Une assertion de comptage échappe à l'exigence d'unicité : l'exécution
 * additionne les graphies du même signe, donc une seule graphie présente suffit
 * à rendre le plan exécutable, et un total qui ne tombe pas juste reste une
 * assertion fausse jugée à l'exécution.
 *
 * Un refus nomme la cible réelle quand la proximité est mesurable : le même nom
 * replié sous un autre rôle (`spinbutton` visé comme `textbox`), ou un nom du
 * rôle visé qui ne diffère que par un mot (`Billet de 20 €` pour
 * `Pièce de 20 €`, l'écart du lot L). Deux candidats et plus se nomment tous, et
 * un couple rôle+nom porté par plusieurs éléments se compte au lieu d'être lu
 * comme un candidat unique : choisir l'un d'eux serait une décision que le relevé
 * n'a pas à prendre, et aucun candidat ne rend jamais la cible acceptable — le
 * refus reste un refus.
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
  /** Valeurs de `placeholder` de l'instantané, pour un locator `by:"placeholder"`. */
  placeholders: string[];
  roles: Map<string, Set<string>>;
  /** Contenus texte de l'instantané, seuls visibles d'un locator `by:"text"`. */
  texts: string[];
}

/**
 * Candidat mesuré par le relevé : le couple rôle+nom qu'un refus peut nommer, et
 * le nombre d'éléments de l'instantané qui le portent. Deux éléments du même
 * couple ne font pas une cible : le refus les compte au lieu d'en désigner un.
 */
export interface PlanEvidenceNear {
  /** Éléments qui exposent ce couple : plus d'un rend la cible non unique. */
  elements: number;
  target: string;
}
export interface PlanEvidenceRefusal {
  /**
   * Cibles de l'instantané dont la proximité avec la cible visée est mesurable :
   * le même nom replié sous un autre rôle, ou un nom du rôle visé qui ne diffère
   * que par un mot. Nommées pour rendre le refus réparable, jamais acceptées :
   * la décision reste le refus.
   */
  near?: PlanEvidenceNear[];
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

/** Valeur littérale d'une ligne de l'instantané : entre guillemets ou brute. */
function readSpellingValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    return readQuoted(trimmed);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1) {
    return trimmed.slice(1, -1).replace(/\\'/g, "'");
  }
  return trimmed;
}

/**
 * Textes littéraux que l'instantané porte, séparés par famille de locator :
 * contenu texte d'un nœud (`- text: …`, `- paragraph: …`) et valeur d'un
 * `placeholder` (`- /placeholder: …`). `getByText` lit le contenu et jamais le
 * nom, `getByPlaceholder` la valeur du contrôle ; l'absence de l'un ou de
 * l'autre ne prouve donc rien, seule leur présence instruit le contrôle.
 */
export function ariaLiteralSpellings(aria: string): {
  texts: string[];
  placeholders: string[];
} {
  const texts: string[] = [];
  const placeholders: string[] = [];
  for (const line of aria.split("\n")) {
    const node = line.trim();
    if (!node.startsWith("- ")) {
      continue;
    }
    const body = node.slice(2);
    if (body.startsWith("/")) {
      const property = /^\/placeholder:\s*(.+)$/.exec(body);
      if (property?.[1]) {
        placeholders.push(readSpellingValue(property[1]));
      }
      continue;
    }
    const role = /^[a-z]+/i.exec(body)?.[0];
    if (!role) {
      continue;
    }
    // Le nom accessible entre guillemets n'est pas du texte ; le contenu texte
    // suit les attributs d'un `: `, ou ouvre directement la ligne.
    const rest = body.slice(role.length).replace(/^\s*"(?:[^"\\]|\\.)*"/, "");
    const inline = /:\s+(.+)$/.exec(rest)?.[1];
    if (inline) {
      texts.push(readSpellingValue(inline));
    }
  }
  return { texts, placeholders };
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

/** Mots d'un nom normalisé : la comparaison des libellés se fait mot à mot. */
function words(value: string): string[] {
  return normalizeText(value).split(" ").filter(Boolean);
}

/**
 * Deux libellés ne diffèrent que par un mot, au même rang, et en partagent au
 * moins un autre. C'est l'écart mesuré du lot L : le plan vise
 * « Quantité · Pièce de 20 € » là où la page expose « Quantité · Billet de
 * 20 € ». Rien de flou n'y entre : même nombre de mots, exactement un rang
 * différent, tout le reste identique. Un libellé d'un seul mot n'a aucun mot
 * partagé, donc aucun voisin : « P&L » ne se rapproche pas de « Pilotage ».
 */
function oneWordApart(planned: string, exposed: string): boolean {
  const left = words(planned);
  const right = words(exposed);
  if (left.length < 2 || left.length !== right.length) {
    return false;
  }
  return left.filter((word, index) => word !== right[index]).length === 1;
}

/**
 * Cibles de la page dont la proximité avec la cible visée est mesurable, jamais
 * devinée : le même nom replié — casse comprise — porté par un autre rôle, ou un
 * nom du rôle visé qui ne diffère que par un mot. Le relevé ne décide rien : il
 * enrichit le refus, qui reste un refus prononcé avant toute dépense.
 *
 * Chaque cible est comptée par élément : deux boutons « SAVE » pour un plan
 * visant « save » sont une ambiguïté, jamais un candidat unique.
 */
function nearTargets(
  locator: Locator & { by: "role" },
  role: string,
  nodes: AriaNameNode[]
): PlanEvidenceNear[] {
  const planned = normalizeText(locator.name);
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const exposed = normalizeText(node.name);
    if (!exposed || (node.role === role && exposed === planned)) {
      continue;
    }
    const folded = foldTypography(exposed) === foldTypography(planned);
    const candidate =
      folded || (node.role === role && oneWordApart(planned, exposed));
    if (!candidate) {
      continue;
    }
    const target = `role=${node.role} name=${JSON.stringify(node.name)}`;
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return [...counts].map(([target, elements]) => ({ elements, target }));
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
        report,
        // Une action vise un contrôle à manipuler, jamais un compte : seule une
        // assertion de comptage accepte plusieurs graphies du même signe.
        undefined
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
      report,
      assertion.kind === "count" ? assertion.expected : undefined
    );
  }
}

function checkTarget(
  scenario: Scenario,
  stepId: string,
  locator: Locator,
  pageUnchanged: boolean,
  names: AriaNames,
  report: PlanEvidenceReport,
  counting: number | undefined
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
  if (locator.by === "text" || locator.by === "placeholder") {
    checkLiteralTarget(scenario, stepId, locator, names, report, counting);
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
  // Le repli d'exécution vise ces mêmes variantes (`canary.ts` les compile), mais
  // il n'en retient une que si elle atteint exactement un élément. Une page qui
  // expose deux graphies du même nom n'est donc pas exécutable : l'accepter ici
  // échangerait un refus propre contre un run perdu sans explication.
  const variants = typographicVariants(locator.name).names;
  const folded = names.nodes.filter(
    (node) => node.role === role && variants.includes(node.name)
  );
  // Une assertion de comptage ne choisit pas un élément : l'exécution additionne
  // les graphies du même signe et compare le total au compte attendu. Dès qu'une
  // graphie porte la cible, le plan est exécutable et le verdict reste un
  // comptage honnête ; exiger l'unicité ici remplacerait une assertion juste
  // (« count: 2 » sur deux éléments) par un refus qui n'a pas de sens pour un
  // compte.
  if (counting === undefined ? folded.length === 1 : folded.length > 0) {
    return;
  }
  report.refusals.push({
    scenarioId: scenario.id,
    stepId,
    target: describeTarget(locator),
    // Un refus muet sur l'écart réel laisse le planificateur recopier la même
    // cible : le relevé nomme donc ce que la page expose à la place quand un seul
    // candidat porté par un seul élément est mesurable, et l'ambiguïté — plusieurs
    // candidats, ou un couple porté par plusieurs éléments — quand elle l'est.
    near: nearTargets(locator, role, names.nodes),
  });
}

/**
 * Cible littérale (texte, placeholder) : l'instantané ne la porte que lorsqu'il
 * l'expose, donc une absence de preuve reste non concluante. En revanche, dès
 * qu'il l'expose, la même exigence d'unicité que pour role+nom s'applique : deux
 * graphies concurrentes rendent la cible inexécutable — le repli d'exécution
 * lève sur l'ambiguïté — et sont refusées avant toute dépense, au lieu de
 * laisser le run se perdre.
 *
 * L'évidence littérale compte des graphies, pas des éléments : le nom accessible
 * d'un contrôle peut répéter sa valeur de `placeholder`, et un texte apparaît
 * dans un nœud comme dans son descendant. L'unicité d'élément reste donc jugée à
 * l'exécution ; ici, seule une ambiguïté réellement exposée est refusée.
 */
function checkLiteralTarget(
  scenario: Scenario,
  stepId: string,
  locator: Locator & { by: "text" | "placeholder" },
  names: AriaNames,
  report: PlanEvidenceReport,
  counting: number | undefined
) {
  const exposed = (
    locator.by === "text"
      ? names.texts
      : [...names.nodes.map((node) => node.name), ...names.placeholders]
  ).map(normalizeText);
  const planned = normalizeText(locator.value);
  if (exposed.includes(planned)) {
    return;
  }
  const inconclusive = (reason: string) =>
    report.inconclusive.push({
      scenarioId: scenario.id,
      stepId,
      target: describeTarget(locator),
      reason,
    });
  const spelling = typographicVariants(locator.value);
  if (spelling.overflow) {
    // Aucune graphie n'est énumérable : l'exécution lève dès que la page n'expose
    // pas la graphie du plan. Un jumeau typographique exposé le prouve ; sans lui
    // la graphie du plan peut être celle de la page, et la preuve manque.
    const twin = exposed.some(
      (item) =>
        item !== planned && foldTypography(item) === foldTypography(planned)
    );
    if (!twin) {
      inconclusive(
        "graphies de la cible non énumérables au plafond du repli, et aucune n'est exposée"
      );
      return;
    }
    report.refusals.push({
      scenarioId: scenario.id,
      stepId,
      target: describeTarget(locator),
    });
    return;
  }
  const variants = spelling.names.map(normalizeText);
  const folded = new Set(exposed.filter((item) => variants.includes(item)));
  if (counting === undefined ? folded.size === 1 : folded.size > 0) {
    return;
  }
  if (folded.size === 0) {
    inconclusive("aucune graphie de la cible dans l'instantané de découverte");
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

/**
 * Sélecteur CSS réduit à UN test d'attribut : `[data-etat]`,
 * `[data-etat="valeur"]`, `[aria-expanded="true"]`. C'est la forme que prend un
 * état exposé par un attribut, et donc la cible d'une assertion qui vise une
 * VALEUR d'attribut. Le nom de l'attribut est capturé : toutes les formes ne
 * portent pas un état (voir `carriesStateValue`).
 */
const ATTRIBUTE_SELECTOR =
  /^\[\s*([a-zA-Z_][-\w]*)\s*(?:=\s*(?:"[^"]*"|'[^']*'))?\s*\]$/;

/**
 * Attributs ARIA dont la valeur est un ÉTAT fermé de l'élément (`true`,
 * `false`, `mixed`, `page`). Les autres attributs nomment ou décrivent
 * l'élément : `[role="status"]` est une cible dont le texte visible EST le
 * contenu, et `text` y lit `ok` correctement ; `[aria-label="next"]` porte un
 * nom, pas un état.
 */
const ARIA_STATE_ATTRIBUTES = new Set([
  "aria-busy",
  "aria-checked",
  "aria-current",
  "aria-disabled",
  "aria-expanded",
  "aria-hidden",
  "aria-invalid",
  "aria-pressed",
  "aria-selected",
]);

/**
 * Crochets de SÉLECTION écrits en `data-*` : ils nomment l'élément pour le
 * désigner dans un test, ils ne portent aucun état de l'application. L'assertion
 * qui les vise lit le contenu de l'élément, comme pour `[name]`, `[id]`, `[class]`
 * ou `[role]` : `[data-testid="status"]` attendant `ready` est correct et ne doit
 * pas être refusé, alors que ce même `data-` préfixe porte l'état ailleurs.
 */
const SELECTOR_HOOK_ATTRIBUTES = new Set([
  "data-automation-id",
  "data-cy",
  "data-qa",
  "data-test",
  "data-test-id",
  "data-testid",
]);

/**
 * L'attribut porte-t-il un état, c'est-à-dire une valeur en jeton que l'élément
 * n'affiche pas ? `data-*` : l'application y met l'état qu'elle expose, sauf les
 * crochets de sélection qui ne font que nommer l'élément. Une assertion `text`
 * sur un sélecteur d'attribut qui ne porte pas d'état n'est donc jamais fautive
 * par sa seule syntaxe.
 */
function carriesStateValue(name: string): boolean {
  const attribute = name.toLowerCase();
  if (SELECTOR_HOOK_ATTRIBUTES.has(attribute)) {
    return false;
  }
  return attribute.startsWith("data-") || ARIA_STATE_ATTRIBUTES.has(attribute);
}

/**
 * Forme d'un JETON d'identifiant : un seul mot, minuscules ASCII, chiffres,
 * `_` ou `-`. Une valeur d'attribut est écrite ainsi (`ouvert`, `cloture`,
 * `pr`). Un libellé visible, lui, est de la prose : espaces, accents,
 * majuscules, montants et ponctuation. Les deux ne se confondent donc pas, et
 * c'est cette distinction que le refus ci-dessous exploite.
 */
const IDENTIFIER_TOKEN = /^[a-z][a-z0-9_-]*$/;

/**
 * Refus d'une assertion qui lit un sélecteur d'attribut comme s'il rendait la
 * valeur de l'attribut. `text` lit `innerText` et `value` lit `inputValue` de
 * l'ÉLÉMENT visé : sur `[data-etat]`, l'élément est le conteneur de la vue, donc
 * `innerText` rend toute la vue et jamais `ouvert` ; `inputValue` lève sur un
 * conteneur. Un attendu en jeton d'identifiant est exactement la valeur qu'un
 * attribut porte, jamais le texte qu'un conteneur affiche.
 *
 * Forme mesurée, sur 157 runs et 992 scénarios conservés du corpus (13 au 19
 * oct. 2026) : 22 assertions de cette forme, dont AUCUNE ne passe — les 3 rouges
 * du run 1b49d751 (`text` sur `[data-cash-state]` attendant `ouvert`/`cloture`,
 * mesurés sur une page qui affichait « Session en cours »), 4 autres du même run
 * interceptées par la première assertion fautive, et 15 `value` du run edb32e58
 * bloqué sur `inputValue` ("Node is not an <input>"). Aucune des assertions qui passent avec ce sélecteur
 * ne porte un attendu en jeton : elles attendent le texte visible de la vue
 * (« Session en cours », « Comptage verrouillé », « 1 240,00 € »). Le refus ne
 * retire donc rien à ce qui passe, et il remplace un échec d'assertion — ou un
 * `inputValue` qui lève — par un message qui nomme la voie correcte.
 *
 * Le refus est restreint aux attributs qui PORTENT un état (`data-*` et les
 * attributs ARIA d'état), pas à la forme syntaxique du sélecteur : `[role="\
 * status"]` est une cible légitime dont le texte visible est le contenu, et
 * une assertion `text` y attendant `ok` est correcte. `[name="state"]`,
 * `[id="state"]` et `[data-testid="status"]` nomment l'ÉLÉMENT : `kind "value"`
 * y lit `inputValue` du champ visé, et `kind "text"` le contenu de l'élément, si
 * bien qu'aucun des deux ne peut lire la valeur d'un attribut par accident.
 *
 * La voie correcte existe déjà et n'exige aucune extension du schéma : viser
 * `[data-etat="ouvert"]` avec kind `visible` (ou `count` valant 1) prouve
 * l'attribut, et viser le conteneur avec le texte qu'il affiche le prouve aussi.
 */
function attributeValueFault(
  assertion: Scenario["assertions"][number]
): string | undefined {
  const target = assertion.target;
  if (assertion.kind !== "text" && assertion.kind !== "value") {
    return;
  }
  if (!(target && target.by === "css")) {
    return;
  }
  const selector = target.value.trim();
  const attribute = ATTRIBUTE_SELECTOR.exec(selector)?.[1];
  if (!(attribute && carriesStateValue(attribute))) {
    return;
  }
  const expected = assertionExpected(assertion);
  if (!(typeof expected === "string" && IDENTIFIER_TOKEN.test(expected))) {
    return;
  }
  return `assertion ${assertion.id} (after ${assertion.afterStep ?? "no step"}, kind ${assertion.kind}) reads ${selector} for ${JSON.stringify(expected)}`;
}

export function attributeValueRefusals(
  plan: Plan
): { error: QaError; scenario: Scenario }[] {
  const refusals: { error: QaError; scenario: Scenario }[] = [];
  for (const scenario of plan.scenarios) {
    const offenders = scenario.assertions
      .map((assertion) => attributeValueFault(assertion))
      .filter((fault): fault is string => fault !== undefined);
    if (offenders.length === 0) {
      continue;
    }
    refusals.push({
      scenario,
      error: new QaError(
        "PLAN_ATTRIBUTE_VALUE_READ_AS_TEXT",
        `Scenario ${scenario.id} expects an attribute's value from a selector that renders text: ${offenders.join(" ; ")}`,
        'kind "text" reads the visible text INSIDE the target and kind "value" the content of an input: an element carrying a data attribute is the container of the view, so neither returns the attribute value. To prove an attribute value, target it with presence, for instance [data-cash-state="ouvert"] with kind "visible" (or kind "count" expecting 1) and keep verification "state" with afterStep set to the step that established it; "transition" fails whenever the state was already the expected one, because the baseline and the observed value are then identical. Reserve "transition" for a step that genuinely moves the value, such as closing a session that was open. To prove the state the view displays, target the region and expect its visible text, for instance "Session en cours" or "Session clôturée : le comptage est verrouillé.". If the scenario needs an open session to start, establish it first with an observable step (click the "Réouvrir le comptage" button when the view offers it), then assert state after that step.'
      ),
    });
  }
  return refusals;
}

/**
 * Les kinds dont la décision passe par `expected` : `text` lit un texte,
 * `value` le contenu d'un champ, `url` l'URL courante, `count` un nombre
 * d'éléments, `download` un nom de fichier, `popup` l'URL de la fenêtre
 * ouverte (comparée par `actual === assertion.expected`, comme `url`), et
 * `visual` le NOM de la baseline de confiance, que `compareVisual` cherche dans
 * le catalogue de fixtures. Seuls `visible` et `hidden` lisent une simple
 * présence (`actual === true|false`) et se passent donc d'attendu.
 */
const VALUE_ASSERTION_KINDS = new Set([
  "text",
  "value",
  "url",
  "count",
  "download",
  "popup",
  "visual",
]);

/**
 * Un `expected` absent ne peut pas être satisfait : `assertionMatches` compare
 * alors à `undefined` pour `value`, `url`, `popup`, `count` et `download`
 * (`actual === undefined`, toujours faux) et à la chaîne `"undefined"` pour
 * `text`. `visual` ne compare pas à l'attendu mais le passe comme nom de
 * baseline à `compareVisual`, qui lève « Trusted visual baseline undefined is
 * not configured ». Le scénario échoue donc à coup sûr, après avoir dépensé
 * toutes ses étapes navigateur : un plan qui compare à rien ne peut que rater.
 *
 * `PlanSchema` exige déjà `expected` pour chaque kind, mais un plan qui
 * contourne la validation d'entrée — plan rejoué, plan écrit à la main, test,
 * appel direct à `executeScenario` — n'a pas cette garantie. La règle est donc
 * posée ici, sur le chemin de LECTURE, et `runner.ts` la rejoue avant la
 * première étape pour l'aperçu de tête comme pour la préversion de base.
 *
 * Deux formes vides ne disent pas la même chose :
 *
 * - `text`, `url`, `download`, `popup` et `visual` exigent un contenu non vide.
 *   La comparaison `text` normalise et rogne l'attendu, donc un attendu de
 *   blancs se réduit à `""` et `includes("")` accepte n'importe quel texte :
 *   une assertion qui ne prouve rien. Une URL, un nom de fichier, une URL de
 *   popup ou un nom de baseline vide n'existe pas. `count` exige un entier dans
 *   les bornes du schéma, et `0` est une valeur, pas un vide.
 * - `value` n'exige que la PRÉSENCE. `expected: ""` y est la forme mesurée de
 *   « le champ est vide » : dans le corpus de 193 runs, 27 assertions de kind
 *   `value` portent `expected: ""` sur 26 runs, 25 passent, et toutes
 *   décrivent un champ vierge (comptage d'une pharmacie non hérité d'une
 *   autre). `actual === ""` compare à quelque chose de précis : refuser le vide
 *   casserait ces plans réels sans fermer aucun trou.
 */
export function missingExpectationRefusals(
  plan: Plan
): { error: QaError; scenario: Scenario }[] {
  const refusals: { error: QaError; scenario: Scenario }[] = [];
  for (const scenario of plan.scenarios) {
    const offenders: string[] = [];
    for (const assertion of scenario.assertions) {
      if (!VALUE_ASSERTION_KINDS.has(assertion.kind)) {
        continue;
      }
      const fault = expectationFault(
        assertion.kind,
        assertionExpected(assertion)
      );
      if (fault) {
        offenders.push(
          `assertion ${assertion.id} (kind ${assertion.kind}) ${fault}`
        );
      }
    }
    if (offenders.length === 0) {
      continue;
    }
    refusals.push({
      scenario,
      error: new QaError(
        "PLAN_EXPECTED_MISSING",
        `Scenario ${scenario.id} compares to nothing: ${offenders.join(" ; ")}`,
        'Give each of these assertions the value its requirement produces: text the exact text to match, value the field\'s exact content, url the exact URL, count an integer between 0 and 10000, download the exact filename, popup the exact popup URL, visual the name of a trusted baseline from the fixture catalog. kind "value" may keep expected: "" to assert an empty field; for text, url, count, download, popup and visual a missing or blank expected can never be satisfied.'
      ),
    });
  }
  return refusals;
}
/**
 * Le `expected` tel qu'il est réellement porté par l'assertion, sans supposer
 * que le schéma l'ait validé : une assertion écrite à la main peut l'omettre.
 */
function assertionExpected(assertion: Scenario["assertions"][number]): unknown {
  return "expected" in assertion ? assertion.expected : undefined;
}
/**
 * Ce qui rend un `expected` inutilisable pour un kind à valeur requise, dit en
 * une phrase lisible par le planificateur, ou `undefined` quand il est utilisable.
 */
function expectationFault(
  kind: Scenario["assertions"][number]["kind"],
  expected: unknown
): string | undefined {
  if (kind === "count") {
    if (expected === undefined) {
      return "has no expected";
    }
    return typeof expected === "number" &&
      Number.isInteger(expected) &&
      expected >= 0 &&
      expected <= 10_000
      ? undefined
      : `has an expected that is not an integer between 0 and 10000 (${JSON.stringify(expected)})`;
  }
  if (typeof expected !== "string") {
    return expected === undefined
      ? "has no expected"
      : `has an expected that is not a string (${JSON.stringify(expected)})`;
  }
  if (kind === "value") {
    return;
  }
  return expected.trim() === "" ? "has an empty expected" : undefined;
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
  const names: AriaNames = {
    nodes,
    roles: roleNameSets(nodes),
    ...ariaLiteralSpellings(evidence.aria),
  };
  for (const scenario of plan.scenarios) {
    inspectScenario(scenario, evidence, names, report);
  }
  return report;
}

/** Candidat listé dans un refus : son couple rôle+nom, compté dès qu'il atteint plus d'un élément. */
function countedNear(candidate: PlanEvidenceNear): string {
  return candidate.elements > 1
    ? `${candidate.target} (porté par ${candidate.elements} éléments)`
    : candidate.target;
}

/**
 * Ce que la page expose à la place de la cible absente. Un candidat unique porté
 * par un seul élément est la cible à recopier ; plusieurs candidats se nomment
 * tous, et un couple porté par plusieurs éléments se compte, parce qu'aucun de
 * ces éléments ne peut alors être désigné comme la cible réelle.
 */
function exposedInstead(near: PlanEvidenceNear[]): string {
  const [first] = near;
  if (!first) {
    return "";
  }
  if (near.length > 1) {
    return `la page expose plusieurs cibles approchantes : ${near.map(countedNear).join(" ; ")}`;
  }
  return first.elements > 1
    ? `la page expose ${first.target} sur ${first.elements} éléments : aucune cible unique n'est atteignable`
    : `la page expose à la place ${first.target}`;
}

/** Message et aide du refus : ils nomment le scénario, l'étape, la cible introuvable et,
 * quand un candidat de la page est mesurable, la cible réelle à recopier — ou
 * l'ambiguïté quand plusieurs éléments la portent. */
export function planEvidenceDiagnostic(
  scenario: Scenario,
  refusals: PlanEvidenceRefusal[],
  inconclusiveCount: number
): { hint: string; message: string } {
  // Les candidats restent rattachés au refus qui les a mesurés : agrégés au
  // niveau du scénario, le candidat unique d'une cible se lisait comme le
  // remplacement d'une autre, et deux refus à un candidat chacun annonçaient une
  // ambiguïté qu'aucune des deux cibles ne porte.
  const targets = refusals
    .map((item) => {
      // Un candidat unique porté par un seul élément se recopie tel quel ;
      // plusieurs candidats — ou un couple porté par plusieurs éléments — se
      // nomment et se comptent, parce que choisir à la place du planificateur,
      // ou présenter un doublon comme une cible unique, serait une décision que
      // le relevé n'a pas le droit de prendre.
      const exposed = exposedInstead(item.near ?? []);
      return exposed
        ? `${item.stepId} → ${item.target} (${exposed})`
        : `${item.stepId} → ${item.target}`;
    })
    .join(" ; ");
  // Le conseil de recopie ne vaut que pour un candidat qu'un seul élément porte :
  // recopier un couple atteint deux fois ne lèverait pas l'ambiguïté, et le
  // message ne doit pas désigner cet élément comme la cible réelle.
  const copyable = refusals.some((item) =>
    (item.near ?? []).some((candidate) => candidate.elements === 1)
  );
  const unresolved = inconclusiveCount
    ? ` ${inconclusiveCount} autre(s) cible(s) restent non concluantes (voir la timeline du run).`
    : "";
  return {
    message: `Scénario ${scenario.id} non exécuté : cible absente de l'instantané de la page de découverte (${targets})`,
    hint: `Le plan visait un élément que la page de découverte ne contient pas ; aucune étape navigateur n'a été dépensée. Corrige la cible dans le plan${copyable ? " en recopiant la cible exposée" : ""}, ou déclare la vue explicitement non testable. L'instantané d'accessibilité est limité à 12 niveaux de profondeur, ne couvre pas les types css/label/testId, et ne lit un texte ou un placeholder que lorsqu'il le porte.${unresolved}`,
  };
}
