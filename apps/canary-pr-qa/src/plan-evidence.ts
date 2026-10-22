import {
  foldTypography,
  PLAN_EVIDENCE_SNAPSHOT_CHARS,
  typographicCodepoints,
  typographicVariants,
} from "./canary.js";
import { QaError } from "./diagnostics.js";
import {
  bracketBlocks,
  cssSelectors,
  structuralSelectorReason,
  unstableSelectorReason,
} from "./plan-selector.js";
import {
  type EstablishingClickFault,
  establishingClickFault,
  type Locator,
  type Plan,
  type Scenario,
  type SourceLineMaterial,
} from "./schema.js";

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

/**
 * Rôles qu'un plan sait viser nommément. L'énumération d'une cible introuvable
 * s'y restreint : les nœuds de prose (`generic`, `paragraph`, `listitem`, `text`)
 * portent le contenu de la page, et un run ne publie pas le contenu de la page.
 * Un contrôle, un titre, un lien, un onglet ou une région d'état est exactement
 * ce qu'un plan adresse. Les enfants d'une liste — `option`, `menuitem`,
 * `treeitem`, `row` — en sont exclus : ils s'atteignent à travers leur liste, et
 * sur la page mesurée du run 5b888618 ils occupaient les huit places sans rien
 * apprendre sur la cible manquée.
 */
const TARGETABLE_ROLES = new Set([
  "alert",
  "button",
  "checkbox",
  "combobox",
  "dialog",
  "heading",
  "img",
  "link",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "status",
  "switch",
  "tab",
  "textbox",
]);

/** Nombre de cibles observées que le message d'une cible introuvable énumère. */
const OBSERVED_TARGETS_SHOWN = 8;

/**
 * Rang d'un nœud observé dans l'énumération : le rôle visé d'abord, les
 * contrôles de formulaire ensuite, le reste en dernier. Trois rangs, aucun
 * score : l'ordre ne dit pas qu'une cible vaut mieux qu'une autre.
 */
function observationRank(role: string, wanted: string | undefined): number {
  if (role === wanted) {
    return 0;
  }
  return FORM_CONTROL_ROLES.has(role) ? 1 : 2;
}

/**
 * Rôles qu'un `fill` ou un `select` adresse : les contrôles de formulaire. Ils
 * passent avant le reste de l'énumération, quel que soit l'ordre du DOM, parce
 * qu'une cible manquée est le plus souvent l'un d'eux — et sur la page mesurée
 * les sept boutons de navigation précédaient les quinze champs de comptage.
 */
const FORM_CONTROL_ROLES = new Set([
  "checkbox",
  "combobox",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "textbox",
]);

/**
 * Les cibles réellement présentes dans le DOM à l'instant de l'échec : rôle et
 * nom accessible, présentés comme OBSERVÉS, jamais comme la correction à
 * appliquer. C'est la vérité mesurable dont dispose un run quand une cible ne
 * résout pas, et elle était jetée : sur le run b7da97f1, la page exposait
 * « Quantité · Billet de 20 € » là où le plan avait inventé une pièce de 20 €,
 * et le message ne le disait pas. Sur le run 5b888618, le plan visait
 * `by:label "Pièce de 2 €"` alors que les champs de comptage s'appelaient
 * « Quantité · Pièce de 2 € » : le préfixe perdu ne se lisait nulle part.
 *
 * Le message d'un scénario part dans le commentaire de PR, donc dans un dépôt,
 * et le résumé de support promet de ne pas porter le DOM : un nom accessible
 * observé n'est publié que s'il est DÉJÀ dans le matériel source déclaré —
 * littéral, morceau de gabarit ou composition des deux. Un nom que la page
 * affiche et que le diff ne déclare pas (un compte, un patient, un libellé d'un
 * fichier hors hunk) reste dans l'artefact et hors du message : le filtre par
 * rôle ne prouve rien de la sensibilité d'un nom, le matériel si.
 *
 * L'énumération ne choisit rien, ne corrige rien et ne convertit aucun
 * TARGET_NOT_FOUND en succès : le scénario reste bloqué, il devient lisible.
 * L'ordre est mécanique, sans ressemblance ni score : le rôle visé d'abord, les
 * contrôles de formulaire ensuite, puis l'ordre du DOM ; huit au plus. Les noms
 * vides (un `main`, un `status` sans texte) ne disent rien d'une cible manquée
 * et sont écartés ; les doublons de couple rôle+nom aussi, puisqu'un locator
 * role+nom ne distingue pas deux éléments qui le portent.
 */
export function observedTargetsNote(
  nodes: AriaNameNode[],
  material: SourceLineMaterial[],
  role?: string,
  limit = OBSERVED_TARGETS_SHOWN
): string | undefined {
  const declared = declaredSourceNames(material);
  if (declared.fragments.size === 0) {
    // Sans matériel déclaré, aucun nom n'est publiable : mieux vaut le message
    // générique qu'un libellé de page dans un commentaire public.
    return;
  }
  const wanted = role === undefined ? undefined : ariaRole(role);
  const seen = new Set<string>();
  const observed: { rank: number; target: string }[] = [];
  for (const { role: nodeRole, name } of nodes) {
    const normalized = normalizeText(name);
    const target = `${nodeRole} ${JSON.stringify(normalized)}`;
    if (
      normalized === "" ||
      seen.has(target) ||
      !TARGETABLE_ROLES.has(nodeRole) ||
      !sourceDeclaresName(normalized, declared)
    ) {
      continue;
    }
    seen.add(target);
    observed.push({ rank: observationRank(nodeRole, wanted), target });
  }
  if (observed.length === 0) {
    return;
  }
  const ordered = observed
    .map((item, index) => ({ ...item, index }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((item) => item.target);
  const shown = ordered.slice(0, limit);
  const rest = ordered.length - shown.length;
  return `cibles observées dans le DOM à cet instant, rôle et nom accessible, toutes déclarées par la source : ${shown.join(" ; ")}${rest > 0 ? ` ; et ${rest} autres` : ""}`;
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

/** Vrai quand la vérification relit sa cible APRÈS l'étape qui la déplace. */
function readsAfterStep(assertion: Scenario["assertions"][number]): boolean {
  return ["transition", "persisted"].includes(assertion.verification);
}
/** Position de l'étape qui relit la cible d'une assertion. */
function assertionReadIndex(
  scenario: Scenario,
  assertion: Scenario["assertions"][number]
): number {
  // Une vérification transition/persisted relève sa référence avant
  // l'interaction : la cible doit donc déjà exister à l'entrée de `afterStep`.
  // Les autres vérifications lisent leur cible pendant leur propre étape.
  if (readsAfterStep(assertion)) {
    return stepIndex(
      scenario,
      (index) => scenario.steps[index]?.id === assertion.afterStep
    );
  }
  return stepIndex(scenario, (index) =>
    isAssertionStep(scenario, index, assertion.id)
  );
}
/**
 * L'étape dont la page doit encore être celle de la découverte pour que le
 * conseil nomme un nœud de l'instantané. `assertionReadIndex` désigne l'entrée
 * de `afterStep` pour `transition` et `persisted`, parce que c'est là que la
 * référence est relevée ; mais la cible est relue APRÈS cette étape, ou après
 * le rechargement, où un rôle tiré de la découverte peut avoir disparu. Le
 * conseil se place donc à la sortie de l'étape, et hors du scénario il ne
 * nomme rien : `pageUnchanged[...]` vaut alors `undefined`, donc pas de rôle.
 */
function advicePageIndex(
  scenario: Scenario,
  assertion: Scenario["assertions"][number]
): number {
  const index = assertionReadIndex(scenario, assertion);
  return readsAfterStep(assertion) ? index + 1 : index;
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
 * Refus rendus au planificateur pour une cible CSS construite sur une classe,
 * une couleur ou une position (`plan-selector.ts` porte les deux règles) : un
 * refus par scénario, qui nomme l'étape, la cible et ce qu'il faut viser à la
 * place. `runner.ts` les rejoue après l'appel modèle, pour qu'un plan non
 * corrigé soit bloqué avant exécution.
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
      const reason =
        unstableSelectorReason(target.locator) ??
        structuralSelectorReason(target.locator);
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
        'Target what the discovery snapshot shows instead: a role with its accessible name, an id, or a stable attribute the source defines. To prove an absence, use kind "hidden" or a count of 0 on a selector the page still carries. A class name or a color read in the source is not a stable target. A path built from combinators (">", a space, "+", "~") names a position instead of an element: it resolves several elements by construction as soon as two of them sit there, and Playwright then refuses the step in strict mode (a measured plan used aside > div, which resolved to 4 elements and blocked 4 scenarios of run 93cd4991). Name the element, or target the container the plan already names when the assertion only needs the text that container displays.'
      ),
    });
  }
  return refusals;
}

/**
 * Ponctuation de CODE : un fragment de texte déclaré n'en porte pas, et une
 * ligne de code en est pleine. Sans ce filtre, un gabarit mal découpé ou une
 * apostrophe prise pour un délimiteur produisait un faux nom (`} active`),
 * qu'un remplacement d'un mot pouvait ensuite présenter comme déclaré — donc
 * un refus prononcé contre une cible réelle (« Pharmacie active »).
 */
const CODE_PUNCTUATION = /[{}<>();=&|$`\\]/;

/**
 * Fragments de texte qu'une ligne source déclare : littéral entre guillemets
 * (`label: "Billet de 20 €"`), morceau de gabarit (le texte constant de
 * `` `Quantité · ${d.label}` ``, découpé sur ses interpolations) et texte JSX
 * entre `>` et `<`. Un fragment d'UN SEUL mot ne déclare aucune composition :
 * tous les libellés partagent des mots ordinaires (`de`, `€`), donc l'accepter
 * rendrait composable n'importe quel nom et le contrôle ne dirait plus rien.
 * Seuls les fragments de deux mots et plus, sans ponctuation de code, entrent
 * dans la composition.
 */
function declaredTextFragments(material: SourceLineMaterial[]): Set<string> {
  const fragments = new Set<string>();
  for (const file of material) {
    for (const { text } of file.lines) {
      for (const fragment of textFragmentsOfLine(text)) {
        fragments.add(fragment);
      }
    }
  }
  return new Set(
    [...fragments].filter((fragment) => words(fragment).length >= 2)
  );
}

/**
 * Fragments de texte d'UNE ligne, en deux familles que le filtre sépare :
 *
 * - ce qu'un guillemet DÉLIMITE est du texte par construction, et le garder tel
 *   quel est le seul moyen de ne pas jeter un libellé réel : `aria-label="Save &
 *   close"` porte une esperluette, `"Total (compté)"` une parenthèse, et le
 *   filtre de ponctuation les aurait écartés — donc un nom déclaré serait
 *   devenu un nom inventé, refusé à tort ;
 * - ce qu'un gabarit ou du JSX laisse entre ses bornes est du texte NOYÉ dans du
 *   code : c'est là que le découpage produit des fragments qui ne sont pas des
 *   noms (`} active`), et c'est là que le filtre s'applique.
 */
function textFragmentsOfLine(text: string): string[] {
  const quoted: string[] = [];
  for (const [, value] of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    quoted.push(value ?? "");
  }
  for (const [, value] of text.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
    quoted.push(value ?? "");
  }
  const embedded: string[] = [];
  for (const [, value] of text.matchAll(/`([^`]*)`/g)) {
    embedded.push(...(value ?? "").split(/\$\{[^}]*\}/));
  }
  for (const [, value] of text.matchAll(/>([^<>{}]+)</g)) {
    embedded.push(value ?? "");
  }
  return [
    ...quoted.map(normalizeText),
    ...embedded
      .map(normalizeText)
      .filter((fragment) => !CODE_PUNCTUATION.test(fragment)),
  ].filter((fragment) => fragment !== "");
}

/**
 * Le matériel source déclaré, tel que le gate statique le lit : les fragments
 * de texte que le diff déclare et le vocabulaire qu'ils portent.
 *
 * Une cible n'est déclarée que par ces fragments, jamais par une sous-chaîne
 * quelconque du code : dans du JSX minifié, une sous-chaîne comme `} active`
 * « existe » et n'est pas un nom. La conséquence est assumée et dite : un nom
 * que l'application compose sans que le diff le déclare (un libellé venu d'un
 * fichier hors diff) n'est pas reconnu comme déclaré, et le contrôle reste muet
 * tant qu'aucun nom déclaré n'en diffère qu'à un mot.
 */
interface DeclaredSourceNames {
  /** Fragments de deux mots et plus, seuls capables de composer un nom. */
  fragments: Set<string>;
  /** Mots qu'un fragment déclare : le vocabulaire des remplacements mesurés. */
  words: Set<string>;
}

function declaredSourceNames(
  material: SourceLineMaterial[]
): DeclaredSourceNames {
  const fragments = declaredTextFragments(material);
  const wordsOf = new Set<string>();
  for (const fragment of fragments) {
    for (const word of words(fragment)) {
      wordsOf.add(word);
    }
  }
  return { fragments, words: wordsOf };
}

/**
 * Le nom est-il déclaré par le matériel ? Une seule forme, jamais une
 * ressemblance : il est la concaténation de fragments que le diff déclare —
 * c'est exactement ce que fait un gabarit (`` `Quantité · ${d.label}` `` avec un
 * libellé déclaré), donc « Quantité · Billet de 100 € » est déclaré, et
 * « Quantité · Pièce de 20 € », qui demande une pièce de 20 € que le matériel
 * n'énumère nulle part, ne l'est pas. Un nom qu'aucun fragment ne porte — même
 * présent dans la prose du diff — n'est pas déclaré pour autant : c'est une
 * ligne de code qui passe, pas un nom que l'interface expose.
 */
function sourceDeclaresName(
  name: string,
  declared: DeclaredSourceNames
): boolean {
  const parts = words(name);
  const reachable: boolean[] = Array.from(
    { length: parts.length + 1 },
    () => false
  );
  reachable[0] = true;
  for (let start = 0; start < parts.length; start += 1) {
    if (!reachable[start]) {
      continue;
    }
    for (let end = start + 2; end <= parts.length; end += 1) {
      if (declared.fragments.has(parts.slice(start, end).join(" "))) {
        reachable[end] = true;
      }
    }
  }
  return reachable[parts.length] === true;
}

/**
 * Noms que le matériel déclare et qui ne diffèrent du nom visé qu'à UN mot, au
 * même rang. Les remplacements sont tirés du vocabulaire des fragments — donc
 * de valeurs réellement déclarées — et chaque candidat doit être déclaré à son
 * tour : aucune distance d'édition, aucun score de similarité, aucune
 * ressemblance floue n'entre ici. Un nom d'un seul mot n'a aucun candidat, et
 * c'est voulu : remplacer son unique mot ne partage plus rien avec lui.
 */
function declaredNeighbours(
  name: string,
  declared: DeclaredSourceNames
): string[] {
  const parts = words(name);
  if (parts.length < 2) {
    return [];
  }
  const candidates = new Set<string>();
  for (const [index, current] of parts.entries()) {
    for (const word of declared.words) {
      if (word === current) {
        continue;
      }
      const candidate = parts
        .map((part, position) => (position === index ? word : part))
        .join(" ");
      if (sourceDeclaresName(candidate, declared)) {
        candidates.add(candidate);
      }
    }
  }
  return [...candidates].sort();
}

/** Les noms candidats d'une cible, écrits comme la cible l'est : rôle + nom. */
function namedNeighbours(locator: Locator, neighbours: string[]): string {
  if (locator.by !== "role") {
    return "";
  }
  return neighbours
    .map(
      (neighbour) => `role=${locator.value} name=${JSON.stringify(neighbour)}`
    )
    .join(", ");
}

/**
 * Cible role+nom du scénario, avec le libellé qui la désigne dans le refus :
 * l'étape qui la porte, ou l'étape et l'assertion quand c'est une assertion.
 */
function scenarioTargets(
  scenario: Scenario
): { label: string; locator: Locator }[] {
  return [
    ...scenario.steps.flatMap((step) =>
      "locator" in step.action && step.action.locator
        ? [{ label: step.id, locator: step.action.locator }]
        : []
    ),
    ...scenario.assertions.flatMap((assertion) =>
      assertion.target
        ? [
            {
              label: `${assertion.afterStep ?? assertion.id} (assertion ${assertion.id})`,
              locator: assertion.target,
            },
          ]
        : []
    ),
  ];
}

/**
 * Les cibles du scénario que le matériel ne déclare pas et dont un nom déclaré
 * n'est distant que d'UN mot : celles qu'un refus peut nommer sans deviner.
 */
function undeclaredTargets(
  scenario: Scenario,
  declared: DeclaredSourceNames,
  pageNames: Map<string, Set<string>>
): { label: string; locator: Locator; neighbours: string[] }[] {
  const undeclared: {
    label: string;
    locator: Locator;
    neighbours: string[];
  }[] = [];
  for (const target of scenarioTargets(scenario)) {
    if (target.locator.by !== "role") {
      continue;
    }
    const name = normalizeText(target.locator.name);
    if (name === "" || sourceDeclaresName(name, declared)) {
      continue;
    }
    // La page de découverte nomme la cible : l'observation directe prime sur le
    // silence du matériel. Un libellé que le diff ne porte pas parce qu'il vit
    // dans un fichier hors hunk reste visible, donc vrai.
    if (pageNames.get(ariaRole(target.locator.value))?.has(name)) {
      continue;
    }
    const neighbours = declaredNeighbours(name, declared);
    if (neighbours.length > 0) {
      undeclared.push({ ...target, neighbours });
    }
  }
  return undeclared;
}

/**
 * Refus d'une cible role+nom qu'aucune source déclarée ne porte, alors qu'un nom
 * déclaré n'en diffère qu'à un mot : le plan a inventé la cible, et le refus le
 * dit AVANT toute étape navigateur, sur la seule foi du matériel.
 *
 * Ce contrôle ne dépend pas de la page, donc il tombe aussi sur les cibles qui
 * suivent une interaction — celles que l'instantané de découverte ne peut plus
 * trancher (21 des 27 cibles du plan du run b7da97f1). Mesuré sur le corpus du
 * 22 oct. 2026 (200 runs, 184 plans, 1 166 scénarios, 28 cibles role+nom
 * distinctes) : un seul refus, exactement l'invention « Quantité · Pièce de
 * 20 € » des deux scénarios du run b7da97f1 (le bundle de la preview 814b671 ne
 * déclare que « Billet de 20 € »), et aucun des 27 cibles réelles refusé. C'est
 * une base minuscule : elle montre que le refus tombe juste, pas une précision
 * démontrée.
 *
 * Le refus NOMME tous les noms déclarés à un mot, sans en privilégier un :
 * l'invention mesurée a quatre voisins (« Quantité · Billet de 20 € », « Pièce
 * de 1 € », « Pièce de 2 € », « Pièce de 20 c »), et choisir l'un d'eux à la
 * place du plan serait la devinette que ce relevé n'a pas le droit de faire.
 * Plusieurs voisins ne suppriment donc pas le refus ; ils interdisent seulement
 * d'en désigner un. Un nom absent sans aucun voisin n'est jamais refusé : le
 * matériel ne dit alors rien, et l'exécution reste le seul juge.
 *
 * Le matériel du diff n'est pas l'application entière : un libellé qui vit dans
 * un fichier hors hunk n'y est pas déclaré. L'observation directe tranche donc
 * avant le refus — une cible que l'instantané de découverte porte sous son
 * couple rôle+nom est réelle, quels que soient les voisins déclarés — et le
 * refus ne tombe que sur ce que ni le matériel ni la page ne nomment. Quand
 * l'instantané ne dit rien de la cible (vue ouverte par un clic), c'est le
 * matériel qui décide, et c'est ce silence-là que la limite mesurée documente.
 */
export function undeclaredTargetRefusals(
  plan: Plan,
  material: SourceLineMaterial[],
  evidence?: DiscoveryEvidence
): { error: QaError; scenario: Scenario }[] {
  const declared = declaredSourceNames(material);
  if (declared.fragments.size === 0) {
    // Aucun fragment déclaré : le matériel ne dit rien, donc aucun refus.
    return [];
  }
  const pageNames = evidence?.aria
    ? ariaRoleNames(evidence.aria)
    : new Map<string, Set<string>>();
  const refusals: { error: QaError; scenario: Scenario }[] = [];
  for (const scenario of plan.scenarios) {
    const targets = undeclaredTargets(scenario, declared, pageNames);
    if (targets.length === 0) {
      continue;
    }
    refusals.push({
      scenario,
      error: new QaError(
        "PLAN_TARGET_NOT_IN_SOURCE",
        `Scenario ${scenario.id} targets an accessible name the declared source material never contains: ${targets
          .map(
            (target) => `${target.label} → ${describeTarget(target.locator)}`
          )
          .join(
            " ; "
          )}. Names the material DOES declare, each one word away, all named and none chosen in the target's place: ${targets
          .map((target) => namedNeighbours(target.locator, target.neighbours))
          .join(" ; ")}`,
        "Target a name the source declares — a string literal, a template chunk, or a template filled with the values it declares — or drop the scenario. The candidates are what the material declares, not a repair: only the plan decides which name it meant, and none of them is accepted in the target's place. The gate reads the declared material alone, so a name the diff does not carry is refused only when at least one declared name differs by exactly one word; with no such neighbour it says nothing and execution decides. A name composed at runtime, from a value the diff never enumerates, falls in that same silence."
      ),
    });
  }
  return refusals;
}

/**
 * UN test d'attribut d'un sélecteur CSS : `[data-etat]`, `[data-etat="valeur"]`,
 * `[aria-expanded=true]`, `[data-etat^="clot"]`. En HTML le nom d'attribut est
 * insensible à la casse, l'opérateur peut être `=`, `^=`, `$=`, `*=`, `~=` ou
 * `|=`, et la valeur peut être écrite sans guillemets : reconnaître un attribut
 * d'état ne dépend donc ni du guillemet, ni de l'opérateur, ni de la casse du
 * nom. Le nom est capturé, et l'opérateur dit si une VALEUR est épinglée :
 * `[data-etat]` seul prouve une présence.
 */
const ATTRIBUTE_TEST =
  /^\[\s*([a-zA-Z_][-\w]*)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]$/;

/**
 * RÈGLE : la liste ci-dessous est l'ÉNUMÉRATION FERMÉE des attributs qui
 * portent un état — une valeur en jeton que l'élément n'affiche pas. Elle est
 * écrite en toutes lettres, sans préfixe ni motif : un attribut absent de cette
 * liste est accepté, y compris `name`, `id`, `class`, `type`, `role`,
 * `data-testid` et tout autre `data-*`. Aucune heuristique sur le nom ne décide
 * du sens d'un sélecteur.
 *
 * Les huit ARIA d'état portent `true`, `false`, `mixed`, `page` ou une valeur
 * courante ; `data-state` est le même contrat pour une vue qui n'utilise pas
 * ARIA. `data-cash-state` y figure parce que c'est la forme RÉELLE mesurée : sur
 * 157 runs et 992 scénarios du corpus, les 22 assertions `text`/`value` qui la
 * visent ne passent aucune (voir `attributeValueFault`). Un attribut de la
 * liste est donc refusé par son NOM explicite, pas parce qu'il commence par
 * `data-`.
 *
 * Mesuré, en `text` et en `value` : les huit ARIA d'état, `data-state` et
 * `data-cash-state` refusés ; `[name="state"]`, `[id="state"]`, `[class="state"]`,
 * `[type="text"]`, `[role="status"]`, `[data-testid="status"]` et
 * `[data-whatever="x"]` acceptés.
 */
const STATE_ATTRIBUTES = new Set([
  "aria-checked",
  "aria-current",
  "aria-disabled",
  "aria-expanded",
  "aria-hidden",
  "aria-invalid",
  "aria-pressed",
  "aria-selected",
  "data-cash-state",
  "data-state",
]);

/**
 * L'attribut fait-il partie de l'énumération fermée `STATE_ATTRIBUTES` ? C'est
 * la seule question posée : un attribut qui n'y est pas ne porte pas d'état, et
 * une assertion `text` ou `value` sur un sélecteur d'attribut hors liste n'est
 * jamais fautive par sa seule syntaxe.
 */
function carriesStateValue(name: string): boolean {
  return STATE_ATTRIBUTES.has(name.toLowerCase());
}

/**
 * Le test d'attribut d'ÉTAT qu'un sélecteur CSS porte, moteur et combinateurs
 * compris : `[data-cash-state="cloture"] p` et `css=[data-cash-state=cloture]`
 * en portent un, et l'élément que le test sélectionne n'existe alors que TANT
 * QUE la valeur épinglée tient. `value` est absente quand le test ne porte pas
 * de valeur — la forme de seule présence, qui sélectionne le conteneur dans
 * tous les états. `undefined` quand aucun test d'état n'apparaît, ou quand le
 * locator n'est pas CSS.
 *
 * TOUS les tests d'état du sélecteur sont examinés, et une valeur épinglée
 * l'emporte sur une présence : `[data-state] button[aria-expanded=true]`
 * sélectionne un bouton qui n'existe que déplié, si bien que s'arrêter au
 * premier test reconnu — la présence `[data-state]` — laisserait passer
 * exactement la lecture conditionnelle que la règle refuse. La présence n'est
 * rendue que si le sélecteur n'épingle aucune valeur.
 */
function stateAttributeTarget(
  locator: Locator
): { block: string; attribute: string; value?: string } | undefined {
  if (locator.by !== "css") {
    return;
  }
  let presence: { block: string; attribute: string } | undefined;
  for (const css of cssSelectors(locator.value)) {
    for (const block of bracketBlocks(css)) {
      const match = ATTRIBUTE_TEST.exec(block);
      const attribute = match?.[1];
      if (!(attribute && carriesStateValue(attribute))) {
        continue;
      }
      if (match[2] === undefined) {
        presence ??= { block, attribute };
        continue;
      }
      const value = match[3] ?? match[4] ?? match[5];
      return { block, attribute, value };
    }
  }
  return presence;
}

/**
 * La cible que le refus propose : celle que le plan sélectionne, privée de ses
 * SEULES valeurs d'état épinglées. `[data-cash-state="cloture"] p` devient
 * `[data-cash-state] p`, `[data-state] button[aria-expanded=true]` devient
 * `[data-state] button[aria-expanded]`, et un sélecteur qui épingle deux valeurs
 * les perd toutes les deux : la partie de la vue que le plan visait reste
 * visée. Remplacer tout le sélecteur par le conteneur perdrait ce ciblage, et
 * un conteneur plus large peut même satisfaire un `text` par un autre passage
 * de la vue.
 */
function presenceSelector(selector: string): string {
  let presence = selector;
  for (const block of bracketBlocks(selector)) {
    const match = ATTRIBUTE_TEST.exec(block);
    const attribute = match?.[1];
    if (
      !(attribute && carriesStateValue(attribute) && match[2] !== undefined)
    ) {
      continue;
    }
    presence = presence.split(block).join(`[${attribute}]`);
  }
  return normalizeText(presence);
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
 * Le refus est restreint à l'énumération FERMÉE `STATE_ATTRIBUTES`, jamais à la
 * forme syntaxique du sélecteur ni au préfixe du nom : `[role="status"]` est
 * une cible légitime dont le texte visible est le contenu, et une assertion
 * `text` y attendant `ok` est correcte. `[name="state"]`, `[id="state"]`,
 * `[class="state"]`, `[type="text"]`, `[data-testid="status"]` et tout autre
 * `data-*` hors liste nomment l'ÉLÉMENT : `kind "value"` y lit `inputValue` du
 * champ visé, et `kind "text"` le contenu de l'élément, si bien qu'aucun des
 * deux ne peut lire la valeur d'un attribut par accident.
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
  const state = stateAttributeTarget(target);
  if (!state) {
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
 * Une lecture fautive, telle que le refus la nomme : l'assertion, son kind, la
 * forme de présence du même attribut d'état et le libellé attendu — l'indice de
 * l'élément qui rend ce texte.
 */
interface StateTargetReadFault {
  assertion: string;
  expected: unknown;
  kind: string;
  /** Phrase du message : assertion, étape, sélecteur et libellé. */
  line: string;
  /** La cible du plan privée de sa seule valeur d'état épinglée. */
  presence: string;
  /** Vrai quand la page que la découverte a capturée est encore celle que la lecture lit. */
  unchangedFromDiscovery: boolean;
}
/**
 * Ce qu'une assertion de `text` ou `value` doit à un élément SÉLECTIONNÉ PAR UNE
 * VALEUR D'ÉTAT, `undefined` quand elle ne lit pas un tel élément.
 * `[data-cash-state="cloture"]` ne désigne un élément que TANT QUE la session
 * est clôturée : lire son texte rend la lecture conditionnelle à l'état, si
 * bien qu'un scénario qui n'a pas atteint l'état échoue sur un délai qui ne dit
 * rien du texte attendu. La reconnaissance est indépendante du guillemet, de
 * l'opérateur (`^=`, `$=`, `*=`, `~=`, `|=`) et de la casse du nom (voir
 * `stateAttributeTarget`), et couvre les combinateurs : lire `p` DANS
 * `[data-cash-state="cloture"]` est aussi conditionnel que lire le conteneur.
 * Un sélecteur qui MÊLE une présence et une valeur —
 * `[data-state] button[aria-expanded=true]` — est donc refusé : la présence
 * n'efface pas la valeur épinglée qui rend le bouton conditionnel.
 *
 * Forme mesurée du run 76f7b2a9 (`cash-balanced-closure`, 8 étapes, 6 passées) :
 * `text` attendant « Session clôturée : le comptage est verrouillé. » sur
 * `[data-cash-state="cloture"]`, bloqué après 5 000 ms à `innerText` sur un
 * sélecteur qui ne résolvait rien. Sur les artefacts de production conservés
 * (189 runs au plan conservé, 1 050 scénarios), 489 assertions `text`/`value`
 * visent un attribut d'état épinglé : 449 passent, 39 sont bloquées, 1 échoue.
 *
 * La règle ne vise PAS la forme de seule présence `[data-cash-state]`, qui
 * sélectionne le conteneur de la vue quel que soit l'état : lire son texte lit
 * le texte de la vue, ce que 924 assertions du même corpus font — 885 passent,
 * 9 échouent, 30 sont bloquées. Elle ne vise que la valeur épinglée, qui rend
 * l'existence de l'élément conditionnelle à l'état, et elle la vise PARTOUT
 * dans le sélecteur. Le remède est dans la règle ci-dessus : prouver l'état par
 * présence (`visible` ou `count`) et lire le texte de la vue sur le sélecteur
 * qui le porte.
 *
 * Le lot U montre le coût d'un refus qui ne nomme pas ce remède : les six
 * scénarios du run 210357d8 ont été bloqués d'un coup par cette règle, pour 17
 * assertions dont le libellé attendu (« 6 unités comptées », « Comptage
 * juste », « Comptage verrouillé ») désignait déjà l'élément à viser — le
 * conteneur sans sa valeur épinglée, que le corpus cité ci-dessus lit 924 fois
 * en `text`, dont 885 passent.
 */
function stateTargetReadFault(
  assertion: Scenario["assertions"][number]
): Omit<StateTargetReadFault, "unchangedFromDiscovery"> | undefined {
  const target = assertion.target;
  if (assertion.kind !== "text" && assertion.kind !== "value") {
    return;
  }
  if (!(target && target.by === "css")) {
    return;
  }
  // Une lecture d'attribut d'état avec un attendu en jeton a déjà son refus,
  // plus précis : il dit que `text` ne rend jamais la valeur d'un attribut. Le
  // message n'est pas répété au planificateur sous une seconde forme.
  if (attributeValueFault(assertion) !== undefined) {
    return;
  }
  const state = stateAttributeTarget(target);
  if (state?.value === undefined) {
    return;
  }
  const selector = target.value.trim();
  const expected = assertionExpected(assertion);
  const expectation =
    expected === undefined ? "" : ` and expects ${JSON.stringify(expected)}`;
  return {
    assertion: assertion.id,
    kind: assertion.kind,
    presence: presenceSelector(selector),
    expected,
    line: `assertion ${assertion.id} (after ${assertion.afterStep ?? "no step"}, kind ${assertion.kind}) reads ${selector}, an element that exists only while that state holds${expectation}`,
  };
}

/**
 * Rôles dont le contenu n'est pas un texte lisible : un champ de formulaire
 * expose sa VALEUR dans l'instantané et une image son nom accessible, si bien
 * qu'une assertion `text` n'y lit rien. Ces rôles ne sont donc jamais proposés
 * comme cible de lecture, même quand le libellé attendu est leur valeur.
 */
const NON_TEXT_ROLES = new Set([
  "checkbox",
  "combobox",
  "img",
  "meter",
  "progressbar",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "textbox",
]);
/** Un nœud de l'instantané : son rôle, son nom accessible et le texte qu'il rend. */
interface SnapshotTextNode {
  name: string;
  rendered: string;
  role: string;
}
/**
 * Nœuds de l'instantané de découverte qui RENDENT un texte : le contenu écrit
 * après les attributs (`- status [ref=e8]: Comptage juste`), seul texte qu'une
 * assertion `text` lit (`innerText`). Deux autres formes sont écartées, chacune
 * mesurée sur une page de référence : les nœuds texte (`- text: …`) ne sont pas
 * des rôles — `role=text` ne résout aucun élément (`0`, puis 5 s d'attente), et
 * le parseur voisin `ariaRoleNameNodes` les écarte déjà — et le nom accessible
 * n'est pas le contenu rendu : un bouton `aria-label="Enregistrer le comptage"`
 * rend « 💾 », dont l'`innerText` ne contient pas son nom. Un nom n'est donc
 * recopié dans le locator que lorsqu'il coïncide avec le contenu rendu, et un
 * nœud que seul son nom désigne n'est jamais proposé comme cible de lecture.
 * Les propriétés (`- /url: …`) ne rendent aucun texte et sont ignorées.
 */
function snapshotTextNodes(aria: string): SnapshotTextNode[] {
  const nodes: SnapshotTextNode[] = [];
  for (const line of aria.split("\n")) {
    const node = line.trim();
    if (!node.startsWith("- ") || /^- \/|^- text\b/.test(node)) {
      continue;
    }
    const body = node.slice(2);
    const role = /^[a-z]+/i.exec(body)?.[0];
    if (!role) {
      continue;
    }
    const rest = body.slice(role.length);
    const inline = /:\s+(.+)$/.exec(rest)?.[1];
    if (inline === undefined) {
      continue;
    }
    const rendered = normalizeText(readSpellingValue(inline));
    if (rendered === "") {
      continue;
    }
    const named = rest.trimStart();
    const name = named.startsWith('"') ? readQuoted(named) : "";
    if (name !== "" && normalizeText(name) !== rendered) {
      continue;
    }
    nodes.push({ role: role.toLowerCase(), name, rendered });
  }
  return nodes;
}
/**
 * Ce que l'instantané de découverte peut nommer pour un texte attendu : les
 * locators qu'il ne désigne qu'une fois, et les formes qu'il rend ambiguës,
 * dites par leur compteur. Un libellé que l'instantané ne rend pas ne produit
 * ni cible ni ambiguïté : le relevé ne choisit pas à la place du planificateur.
 */
interface RenderedTargetAdvice {
  /** Formes rendues par plusieurs nœuds : nommées par leur compte, jamais choisies. */
  ambiguous: string[];
  /** Formes de locator qui ne résolvent qu'un élément de la page, deux au plus. */
  targets: string[];
}
/**
 * Longueur maximale d'un nom accessible recopié dans un conseil : au-delà, ce
 * n'est plus l'étiquette d'un contrôle mais du texte de la page.
 */
const PUBLISHED_NAME_CHARS = 80;
/**
 * Forme de locator que le relevé propose pour un nœud qui rend le libellé,
 * `undefined` quand le nœud ne se désigne pas sans recopier un nom que la page
 * seule porte. Un nom vide ne dit rien, et un nom identique au libellé du plan
 * ne dit rien de plus que lui ; tout autre nom reste dehors.
 */
function offeredTarget(
  node: SnapshotTextNode,
  label: string
): string | undefined {
  const name = normalizeText(node.name);
  if (name === "") {
    return `role=${node.role} name=""`;
  }
  if (name !== label || name.length > PUBLISHED_NAME_CHARS) {
    return;
  }
  return `role=${node.role} name=${JSON.stringify(name)}`;
}
/**
 * La remarque qui accompagne la cible d'une assertion : ce que la découverte a
 * trouvé, dit par un compte et jamais par le texte de la page.
 */
function adviceNote(advice: RenderedTargetAdvice): string {
  if (advice.targets.length > 0) {
    return " (the discovery snapshot renders this label there)";
  }
  if (advice.ambiguous.length > 0) {
    return ` (the discovery snapshot cannot name a single element for it: ${advice.ambiguous.join(", ")})`;
  }
  return "";
}
/**
 * Cibles que l'instantané nomme pour un texte attendu, écrites comme le plan
 * écrit un locator (`role=status name=""`), et seulement quand cette forme ne
 * désigne qu'un élément de la page. Le compte porte sur TOUS les nœuds de
 * l'instantané, pas seulement sur ceux qui rendent un texte : `- status: Ready`
 * suivi d'un `- status` vide ne rend le libellé qu'une fois, mais
 * `role=status name=""` résout les deux, et le plan corrigé échouerait en
 * strict mode. Un compte supérieur à un ne choisit aucune cible : l'ambiguïté
 * est dite par son compteur.
 *
 * Le nom d'un locator n'est recopié que s'il ne dit RIEN de plus que le plan :
 * vide, ou exactement le libellé attendu et court. Un nom que la page seule
 * porte — un compte, une adresse — reste hors du conseil, donc hors du
 * diagnostic publié (voir `reportMarkdown`).
 */
function renderedTargets(
  nodes: SnapshotTextNode[],
  inventory: AriaNameNode[],
  expected: unknown
): RenderedTargetAdvice {
  const targets = new Set<string>();
  const ambiguous = new Map<string, number>();
  if (typeof expected !== "string") {
    return { targets: [], ambiguous: [] };
  }
  const label = normalizeText(expected);
  if (label === "") {
    return { targets: [], ambiguous: [] };
  }
  const roles = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const node of inventory) {
    roles.set(node.role, (roles.get(node.role) ?? 0) + 1);
    const pair = `${node.role}\u0000${normalizeText(node.name)}`;
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  for (const node of nodes) {
    if (!node.rendered.includes(label)) {
      continue;
    }
    const name = normalizeText(node.name);
    const matches = pairs.get(`${node.role}\u0000${name}`) ?? 0;
    if (matches !== 1) {
      ambiguous.set(`role=${node.role}`, matches);
      continue;
    }
    const shape = offeredTarget(node, label);
    const count = roles.get(node.role) ?? 0;
    if (shape !== undefined) {
      targets.add(shape);
    } else if (count === 1) {
      // Le rôle nu ne vaut que s'il ne résout qu'un élément : sinon la
      // suggestion désignerait plusieurs nœuds.
      targets.add(`role=${node.role}`);
    } else {
      ambiguous.set(`role=${node.role}`, count);
    }
    if (targets.size === 2) {
      break;
    }
  }
  return {
    targets: [...targets],
    ambiguous: [...ambiguous].map(
      ([shape, count]) => `${shape} (${count} nodes)`
    ),
  };
}
/**
 * La cible visible de chaque lecture fautive, dite à partir du matériel : la
 * cible du plan privée de sa seule valeur d'état épinglée — présente dans tous
 * les états, donc jamais conditionnelle — et, quand l'instantané de découverte
 * rend le libellé attendu sur un nœud qu'il ne désigne qu'une fois ET que la
 * page soit encore celle de la découverte, ce nœud nommé par son rôle et son
 * nom. Rien n'est deviné : sans instantané, ou après une étape qui a pu changer
 * la page, la phrase ne nomme que la cible qui se déduit du sélecteur lui-même
 * (voir `StateTargetReadFault.unchangedFromDiscovery`).
 */
function visibleTargetAdvice(
  faults: StateTargetReadFault[],
  aria: string | undefined
): string {
  // L'instantané est lu une fois pour tout le scénario, pas une fois par
  // assertion fautive.
  const inventory = aria === undefined ? [] : ariaRoleNameNodes(aria);
  const nodes =
    aria === undefined
      ? []
      : snapshotTextNodes(aria).filter(
          (node) => !NON_TEXT_ROLES.has(node.role)
        );
  const items = faults.map((fault) => {
    const label =
      typeof fault.expected === "string"
        ? ` expecting ${JSON.stringify(fault.expected)}`
        : "";
    // La découverte ne propose un rôle que sur la page qu'elle a capturée :
    // sinon le nœud qu'elle nomme peut avoir disparu.
    const advice = fault.unchangedFromDiscovery
      ? renderedTargets(nodes, inventory, fault.expected)
      : { targets: [], ambiguous: [] };
    // `value` lit un champ : la présence d'un attribut d'état ne désigne pas
    // un champ, donc elle n'est offerte que comme preuve de l'état, jamais
    // comme cible de lecture.
    if (fault.kind === "value") {
      return `assertion ${fault.assertion} reads a field${label} → target the input itself by its label or its role, and prove the state with ${fault.presence}`;
    }
    const targets = [fault.presence, ...advice.targets];
    return `assertion ${fault.assertion}${label} → read ${targets.join(" or ")}${adviceNote(advice)}`;
  });
  const presence = [...new Set(faults.map((fault) => fault.presence))].join(
    ", "
  );
  return `${presence} is the same selector without its pinned value, so it exists in every state and carries the text the view displays; removing a value can also widen it to several elements, so prove it selects one (kind "count" expecting 1) before reading a text, and fall back to the element that renders it when it does not: ${items.join(" ; ")}`;
}
/**
 * Refus des assertions qui lisent un élément sélectionné par une valeur d'état
 * (voir `stateTargetReadFault`). Même forme que les refus voisins : un refus par
 * scénario, nommant l'assertion, le sélecteur, l'attendu et la voie correcte, et
 * `runner.ts` le rejoue avant la première étape navigateur.
 *
 * Le second argument est le matériel de découverte déjà capturé pour la
 * validation d'évidence : le refus s'en sert pour nommer la cible visible que
 * la page expose, comme `planEvidenceDiagnostic` nomme la cible exposée à la
 * place d'une cible absente. Le rôle n'est nommé que sur une page que rien n'a
 * changée depuis la découverte ; sans matériel, le refus nomme la présence du
 * même attribut, qui se déduit du sélecteur.
 */
export function stateTargetReadRefusals(
  plan: Plan,
  evidence?: DiscoveryEvidence
): { error: QaError; scenario: Scenario }[] {
  const refusals: { error: QaError; scenario: Scenario }[] = [];
  for (const scenario of plan.scenarios) {
    // Le même gate que le contrôle d'évidence : `pageUnchangedByStep` dit, étape
    // par étape, si la page est encore celle de la découverte — une interaction
    // (`CONTAMINATING`) la rend inconnue pour tout ce qui suit, un `goto` qui la
    // recharge la laisse identique, un `goto` qui la quitte aussi — et
    // `assertionReadIndex` donne l'étape où l'assertion lit sa cible.
    const pageUnchanged =
      evidence === undefined ? [] : pageUnchangedByStep(scenario, evidence.url);
    const faults = scenario.assertions.flatMap((assertion) => {
      const fault = stateTargetReadFault(assertion);
      return fault === undefined
        ? []
        : [
            {
              ...fault,
              unchangedFromDiscovery:
                pageUnchanged[advicePageIndex(scenario, assertion)] ?? false,
            },
          ];
    });
    if (faults.length === 0) {
      continue;
    }
    refusals.push({
      scenario,
      error: new QaError(
        "PLAN_STATE_TARGET_READ_AS_TEXT",
        `Scenario ${scenario.id} reads an element selected by a state value as if it carried text: ${faults.map((fault) => fault.line).join(" ; ")}`,
        `An element selected by a state VALUE exists only while that value holds, so reading it makes the read conditional on the state: when the scenario did not reach the state, the step fails on a timeout that names no text at all (measured: run 76f7b2a9 waited 5000 ms for [data-cash-state="cloture"] at innerText). Prove the state by presence instead — [data-cash-state="cloture"] with kind "visible", or kind "count" expecting 1 — and read the text the view displays on the selector that carries it whatever the state: [data-cash-state], the container itself, with the exact text the view shows, or [role="status"] when the view exposes a status region, or the element that displays the text. Keep verification "state" with afterStep set to the step that established the state, and reserve "transition" for a step that genuinely moves the value. Visible target for this plan: ${visibleTargetAdvice(faults, evidence?.aria)}.`
      ),
    });
  }
  return refusals;
}

/**
 * Rejeu du contrat de `click.ifPresent` (voir `establishingClickFault` dans
 * `schema.ts` pour la règle et ses deux conditions). `PlanSchema` refuse déjà
 * ces formes, donc ce refus est surtout celui du chemin de LECTURE : un plan
 * rejoué, écrit à la main ou rendu par un modèle hors schéma reçoit le même
 * message nommé — scénario, étape, raison — au lieu d'être exécuté et de sauter
 * en silence un clic obligatoire. `runner.ts` le rejoue avant la première étape
 * navigateur, pour l'aperçu de tête comme pour la préversion de base.
 */
export function ifPresentRefusals(
  plan: Plan
): { error: QaError; scenario: Scenario }[] {
  const refusals: { error: QaError; scenario: Scenario }[] = [];
  for (const scenario of plan.scenarios) {
    const offenders = scenario.steps
      .map((_step, index) => establishingClickFault(scenario, index))
      .filter((fault): fault is EstablishingClickFault => fault !== undefined)
      .map((fault) => `step ${fault.stepId}: ${fault.reason}`);
    if (offenders.length === 0) {
      continue;
    }
    refusals.push({
      scenario,
      error: new QaError(
        "PLAN_IF_PRESENT_NOT_ESTABLISHING",
        `Scenario ${scenario.id} uses click(ifPresent) outside an establishing step: ${offenders.join(" ; ")}`,
        'Keep "ifPresent": true only on a click that establishes a state the scenario depends on: place it before the first business action (fill, select, check, press) and attach an assertion to that step (afterStep set to the click, verification "state"), so a skipped click cannot pass unnoticed. A business action keeps a plain click: an absent target there is a defect and has to stay a failure. If the scenario no longer needs the establishing step, remove the flag.'
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
