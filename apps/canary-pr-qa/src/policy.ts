import { z } from "zod";
import {
  approvedSkipCovers,
  isDocumentationPath,
  isTestPath,
} from "./approved-skips.js";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import type { GitHub, PrContext } from "./github.js";
import { persistenceIntentRefusals } from "./persistence-intent.js";
import {
  normalizeQuoteText,
  type Plan,
  QUOTE_MAX_CHARS,
  QUOTE_MIN_TEXT_CHARS,
  QUOTE_MIN_WORD_CHARS,
  quoteCarriesContent,
  resolveLineReference,
  type Scenario,
  type SourceLineMaterial,
} from "./schema.js";

/**
 * Une exigence de scénario : le type que les refus de couverture et le canal de
 * correction échangent entre `policy.ts` et `runner.ts`.
 */
export type Requirement = Scenario["requirements"][number];

export const PolicySchema = z
  .object({
    version: z.literal(1),
    criticalPaths: z
      .array(z.string().min(1))
      .default(["src/", "app/", "apps/", "pages/", "routes/", "packages/"]),
    approvedSkips: z
      .array(
        z
          .object({ path: z.string().min(1), reason: z.string().min(8) })
          .strict()
      )
      .default([]),
    providerHosts: z.array(z.string()).default([]),
    requireWriteEvidence: z.boolean().default(true),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;
export async function trustedPolicy(
  github: GitHub,
  context: PrContext
): Promise<Policy> {
  const value = await github.optionalFile(
    context.ref.repo,
    ".canary/qa.json",
    context.baseSha
  );
  return value === undefined
    ? PolicySchema.parse({ version: 1 })
    : PolicySchema.parse(JSON.parse(value));
}
/**
 * Un fichier critique : le runtime, jamais de la documentation. Le gate de
 * couverture s'en sert pour refuser un skip (`criticalSkipRefused`), et le
 * contrat de citation pour exiger un témoin qui porte du contenu visible :
 * c'est le fichier qu'un diff hostile peut modifier en y plantant un fragment
 * sans contenu — ponctuation seule, invisibles —, alors qu'un fichier ordinaire
 * porte des citations exactes pauvres en alphanumériques qu'il serait injuste
 * de refuser.
 */
function isCriticalPath(policy: Policy, file: string): boolean {
  return (
    !(isDocumentationPath(file) || isTestPath(file)) &&
    policy.criticalPaths.some((prefix) => file.startsWith(prefix))
  );
}
/**
 * Un skip que le gate de couverture refuserait : chemin critique non
 * documenté, sans approbation sur la branche de base. Le remède « retirez le
 * fichier des sources et listez-le dans skipped » ne vaut donc que si ce
 * prédicat est faux, et le gate comme les remèdes rendus au planificateur
 * lisent la même règle.
 */
export function criticalSkipRefused(policy: Policy, file: string): boolean {
  return (
    isCriticalPath(policy, file) &&
    !policy.approvedSkips.some((skip) => approvedSkipCovers(skip.path, file))
  );
}
export interface ScenarioRefusal {
  error: QaError;
  scenario: Scenario;
}
/**
 * A scenario that interacts with the UI must prove the change the interaction
 * produces. These refusals are per scenario: the runner blocks the offender
 * alone, never executes it, and keeps the rest of the plan running.
 */
export function writeEvidenceRefusals(
  plan: Plan,
  policy: Policy
): ScenarioRefusal[] {
  if (!policy.requireWriteEvidence) {
    return [];
  }
  const refusals: ScenarioRefusal[] = [];
  for (const scenario of plan.scenarios) {
    const interacts = scenario.steps.some((step) =>
      ["click", "fill", "press", "select", "check"].includes(step.action.type)
    );
    const provesChange = scenario.assertions.some((assertion) =>
      ["transition", "persisted"].includes(assertion.verification)
    );
    if (interacts && !provesChange) {
      refusals.push({
        scenario,
        error: new QaError(
          "WRITE_EVIDENCE_MISSING",
          `Scenario ${scenario.id} interacts with UI without changed/persisted state evidence`,
          "Use a transition or persisted assertion on the actual changed output. Static visibility or matching decoy text cannot prove a write."
        ),
      });
    }
  }
  return refusals;
}
/**
 * Une ligne du contenu après changement : son numéro dans le nouveau fichier et
 * son texte, sans le préfixe du patch.
 */
interface PostChangeLine {
  line: number;
  text: string;
}
const PATCH_HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/**
 * Lignes du contenu après changement, hunk par hunk et numérotées dans le
 * nouveau fichier : les lignes de contexte et les lignes ajoutées, sans leur
 * préfixe. Les lignes supprimées et le marqueur « no newline at end of file »
 * n'appartiennent pas à ce contenu.
 */
function postChangeHunks(patch: string): PostChangeLine[][] {
  const hunks: PostChangeLine[][] = [];
  let line = 0;
  for (const raw of patch.split("\n")) {
    const header = PATCH_HUNK_HEADER.exec(raw);
    if (header) {
      hunks.push([]);
      line = Number(header[1]);
      continue;
    }
    const hunk = hunks.at(-1);
    const prefix = raw.slice(0, 1);
    if (!hunk || (prefix !== "+" && prefix !== " ")) {
      continue;
    }
    hunk.push({ line, text: raw.slice(1) });
    line += 1;
  }
  return hunks;
}
/**
 * Contenu APRÈS CHANGEMENT reconstruit depuis les hunks du patch : ce que la PR
 * produit, donc ce qu'une citation du nouveau contenu doit porter. Le patch brut
 * porte les préfixes `+` et `-`, qu'aucune citation recopiée du fichier n'a, et
 * le contenu de tête manque dès qu'un fichier dépasse le plafond de contexte.
 *
 * Un hunk est un segment témoin à part entière, jamais joint au suivant : deux
 * hunks ne sont pas une portion continue du fichier — les lignes qu'ils sautent
 * n'y sont pas — donc une citation fabriquée en recousant la fin du premier au
 * début du second ne doit avoir aucun témoin. Joindre les hunks en une chaîne,
 * même séparée par un caractère sentinelle, laissait cette garantie reposer sur
 * le choix du séparateur ; le découpage la rend structurelle. La liste est vide
 * quand aucun hunk n'apporte de ligne de contexte ou ajoutée : fichier supprimé,
 * diff binaire, ou patch sans en-tête `@@` où aucun hunk n'est identifiable.
 */
function postChangeSegments(patch: string): string[] {
  return postChangeHunks(patch)
    .map((hunk) => hunk.map((item) => item.text).join("\n"))
    .filter((block) => block.length > 0);
}
/**
 * Segments témoins d'une exigence : le patch du fichier dans la PR, chaque hunk
 * du contenu après changement pris séparément, puis chaque contenu contextuel
 * récupéré pour ce chemin. Chaque élément est un témoin à part entière, comparé
 * seul : une citation qui n'existe qu'en recousant la fin d'un segment au début
 * du suivant — jonction patch→contenu, contenu de tête → contenu de base, ou
 * hunk→hunk — n'a pas de témoin.
 */
export function requirementEvidence(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): string[] {
  const patch = context.files.find(
    (file) => file.filename === requirement.sourceFile
  )?.patch;
  return [
    ...(patch ? [patch] : []),
    ...(patch ? postChangeSegments(patch) : []),
    ...context.context
      .filter((item) => item.path === requirement.sourceFile)
      .map((item) => item.content),
  ];
}

/**
 * Vrai si la citation apparaît dans ce segment témoin, à l'espacement de mise
 * en forme près — sans jugement sur sa substance, que
 * {@link quoteCarriesContent} porte. Un repli de mise en forme ne départage pas
 * une citation de sa source — le planificateur recopie sur une ligne le bloc
 * que le fichier indente sur quatre — donc seule une suite de blancs qui
 * contient un saut de ligne se replie. Un blanc sans saut de ligne est
 * significatif : deux espaces dans un littéral de chaîne restent deux espaces.
 * Un caractère invisible à l'intérieur de la citation est significatif lui
 * aussi : il n'est rogné qu'aux bornes de la chaîne comparée, donc une citation
 * qui omet un invisible présent dans la source n'a pas de témoin.
 */
function quoteAppears(evidence: string, quote: string): boolean {
  return normalizeQuoteText(evidence).includes(normalizeQuoteText(quote));
}

/**
 * Vrai si la citation apparaît dans ce segment témoin et porte assez de contenu
 * pour lui servir de preuve. Une citation qui ne porte pas de contenu réel —
 * chaîne vide, blanc, caractères invisibles en bordure, ponctuation seule — n'a
 * jamais de témoin : `includes` d'un fragment que tout fichier contient ferait
 * passer pour preuve une citation qui ne prouve rien. La règle de repli et le
 * seuil de contenu vivent dans `normalizeQuoteText` et `quoteCarriesContent`
 * (schema.ts), avec le contrat de `quote`.
 */
export function quoteHasWitness(evidence: string, quote: string): boolean {
  return quoteCarriesContent(quote) && quoteAppears(evidence, quote);
}

/**
 * Vrai si la citation est contenue dans l'un des segments témoins du fichier
 * cité, jamais dans leur recousage. C'est le seul juge d'acceptation : il
 * applique à chaque segment la règle de contenu de `quoteCarriesContent`, qui ne
 * dépend pas du fichier cité — le seuil est le même partout, et le schéma Zod ne
 * garde que le plancher de longueur.
 */
export function requirementHasWitness(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): boolean {
  return requirementEvidence(requirement, context).some((segment) =>
    quoteHasWitness(segment, requirement.quote)
  );
}

/**
 * Vrai si la citation existe pourtant mot pour mot dans un segment témoin du
 * fichier cité, sans porter le contenu visible qu'exige une citation : le défaut
 * est la substance de la citation, pas sa présence. Les refus et leurs classes
 * fatales agrégées s'en servent pour distinguer les deux remèdes — citer un
 * fragment plus substantiel, ou faire approuver le skip — au lieu de demander
 * une citation déjà présente que le planificateur renverrait telle quelle.
 *
 * Le schéma Zod ne garde que le plancher de longueur, donc une citation réduite
 * à de la ponctuation arrive jusqu'ici : c'est ce diagnostic qui rend le refus
 * exact, là où « no source witness » ferait renvoyer la même citation au
 * planificateur.
 */
export function hasWeakWitness(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): boolean {
  return (
    !quoteCarriesContent(requirement.quote) &&
    requirementEvidence(requirement, context).some((segment) =>
      quoteAppears(segment, requirement.quote)
    )
  );
}

/**
 * Remède d'une citation absente : elle n'existe nulle part, mot pour mot. Le
 * refus par exigence et la classe fatale agrégée le partagent — sauf quand le
 * diagnostic de recousure ou le critère de recouvrement trouve du texte réel du
 * fichier à citer : la classe porte alors ce texte à sa place (voir
 * `ungroundedRemedy`, runner.ts) pour qu'il survive à la troncature, et le refus
 * par exigence le remet en tête de son conseil.
 */
export const UNGROUNDED_ABSENT_REMEDY =
  "Quote exact source or diff text; page content alone is not a requirement.";

/**
 * Remède d'un témoin exact mais trop pauvre, quand la classe fatale agrège
 * plusieurs fichiers : la citation est présente, c'est son contenu qui manque.
 * Le texte reste compact — la classe le partage avec dix autres dans un
 * préambule plafonné à `FATAL_PRELUDE_CHARS` (runner.ts).
 */
export const UNGROUNDED_WEAK_REMEDY =
  "The quote exists in the cited file but carries no visible code content: quote a substantial fragment, or get that file's skip approved in .canary/qa.json on the trusted base branch.";

/**
 * Une exigence dont la citation n'a pas de témoin acceptable : soit elle
 * n'apparaît nulle part, même à l'espacement près, soit elle apparaît mais ne
 * porte aucun contenu visible alors qu'elle est attribuée à un fichier
 * critique, où un diff hostile peut planter un fragment sans substance. Le
 * remède diffère — citer le texte réel, ou citer un fragment qui porte du
 * contenu — donc le refus les distingue, sinon le
 * planificateur renvoie la même citation exacte et tourne pour rien. Le remède
 * du cas faible ne propose jamais un skip que le gate refuserait : un chemin
 * critique s'écarte avec une approbation sur la branche de base, pas en
 * retirant le fichier.
 *
 * Le refus nomme l'exigence fautive — le scénario, le fichier déclaré, le rang
 * de l'exigence dans le scénario et sa citation en extrait — parce qu'un refus
 * qui ne nomme que le scénario et le fichier laisse le planificateur deviner
 * laquelle de ses exigences est fausse, et lui fait reconstruire la même
 * citation. Le cas absent y ajoute où la citation vit réellement, ou l'aveu
 * qu'aucun fichier que la PR change ne la porte (voir `witnessLocation`) ; le cas
 * faible y ajoute la ligne réelle qui porte l'identifiant (voir
 * `weakWitnessSuggestion`), sans quoi le conseil « cite un fragment
 * substantiel » ne nomme rien et le planificateur renvoie le même identifiant.
 */
export function ungroundedRequirement(
  scenarioId: string,
  requirement: Requirement,
  context: PrContext,
  policy: Policy,
  rank: number,
  scans: AmputationScans = amputationScans()
): QaError {
  const fault = `${scenarioId}: ${requirement.sourceFile} (requirement ${rank}). Rejected quote: ${JSON.stringify(quoteExcerpt(requirement.quote))}`;
  if (hasWeakWitness(requirement, context)) {
    return new QaError(
      "REQUIREMENT_UNGROUNDED",
      `Weak source witness for ${fault}`,
      `The quote exists in ${requirement.sourceFile} but carries no visible code content: a witness must carry at least ${QUOTE_MIN_WORD_CHARS} letter or digit and a code structure (an operator, a bracket, a double quote, the blank between two words, or a pair of apostrophes around a literal; neither an identifier's underscore, hyphen, dot, colon or slash nor the lone apostrophe of a lifetime such as 'dangerous counts), so a bare identifier, a punctuation fragment, a run of invisibles or a default-ignorable letter copied in passing cannot prove it. Quote a substantial fragment of ${requirement.sourceFile}${criticalSkipRefused(policy, requirement.sourceFile) ? ", or get the file's skip approved in .canary/qa.json on the trusted base branch" : ""}.${weakWitnessSuggestion(requirement, context)}`
    );
  }
  return new QaError(
    "REQUIREMENT_UNGROUNDED",
    `No source witness for ${fault}`,
    `${UNGROUNDED_ABSENT_REMEDY} ${witnessLocation(requirement, context, scans)}`
  );
}

/**
 * Fichiers dont le texte témoin contient la citation mot pour mot — à
 * l'espacement près — dans l'ordre où ils apparaîent : sert à dire au
 * planificateur où la citation existe réellement quand il l'a attribuée au
 * mauvais fichier.
 */
export function witnessFiles(quote: string, context: PrContext): string[] {
  const paths = [
    ...context.files.map((file) => file.filename),
    ...context.context.map((item) => item.path),
  ];
  return [...new Set(paths)].filter((path) =>
    requirementHasWitness({ quote, sourceFile: path }, context)
  );
}

/**
 * Répare une attribution fautive quand la citation existe, à l'espacement près,
 * dans un et un seul fichier que la PR change : la preuve reste réelle, seule la
 * mention du fichier était fausse.
 *
 * La réparation ne se limitait aux fichiers déjà déclarés par le scénario, ce qui
 * la rendait inopérante sur le cas mesuré (`dd1030c1`) : la citation vivait dans
 * `apps/web/lib/cash-session.ts`, absent de `sourceFiles`, et le plan restait
 * bloqué après son unique tour de correction. Le fichier qui porte le texte est
 * donc ajouté à `sourceFiles` — jamais retiré, l'ancien garde son obligation de
 * couverture — et le doute ne se répare pas : deux fichiers admissibles ou aucun,
 * et le plan repart au planificateur.
 */
export function repairRequirementAttribution(
  plan: Plan,
  context: PrContext
): { from: string; quote: string; scenarioId: string; to: string }[] {
  const repairs: {
    from: string;
    quote: string;
    scenarioId: string;
    to: string;
  }[] = [];
  for (const scenario of plan.scenarios) {
    for (const requirement of scenario.requirements) {
      if (requirementHasWitness(requirement, context)) {
        continue;
      }
      const candidates = context.files
        .map((file) => file.filename)
        .filter((sourceFile) =>
          requirementHasWitness(
            { quote: requirement.quote, sourceFile },
            context
          )
        );
      const [target] = candidates;
      if (candidates.length !== 1 || !target) {
        continue;
      }
      repairs.push({
        from: requirement.sourceFile,
        quote: requirement.quote,
        scenarioId: scenario.id,
        to: target,
      });
      requirement.sourceFile = target;
      // La couverture de l'ancien fichier reste obligatoire : on ajoute, on ne
      // remplace pas. Le fichier ajouté est celui dont on cite le texte, donc il
      // est couvert par cette exigence même.
      if (!scenario.sourceFiles.includes(target)) {
        scenario.sourceFiles.push(target);
      }
    }
  }
  return repairs;
}

/**
 * Où la citation se trouve réellement, en ne proposant que des fichiers que la
 * PR change : déclarer une source hors diff consommerait la tentative de
 * correction pour rien, puisque la validation la refuserait. La liste de chemins
 * est plafonnée : le remède finit dans un préambule fatal borné, où une
 * énumération de chemins sans fin écraserait les têtes des autres classes. Les
 * fichiers non montrés sont comptés, jamais perdus en silence.
 */
function witnessHint(found: string[], context: PrContext): string {
  const changed = context.files.map((file) => file.filename);
  const pr = found.filter((path) => changed.includes(path));
  if (pr.length > 0) {
    return ` The quote appears verbatim in ${boundedPaths(pr)}; declare that file and attribute the requirement to it.`;
  }
  const outside = found.filter((path) => !changed.includes(path));
  if (outside.length === 0) {
    return "";
  }
  return ` The quote only appears in ${boundedPaths(outside)}, which this PR does not change; quote the changed file instead.`;
}
/**
 * Où la citation se trouve réellement, ou le reproche qui explique son absence :
 * `witnessHint` nomme le fichier qui la porte — jamais un fichier hors diff, que
 * la validation refuserait — mais se tait quand la citation n'existe dans aucune
 * évidence du contexte. Ce silence laissait le planificateur recopier la même
 * citation ; le repli nomme alors la réparation : la ligne réelle dont la copie
 * est amputée — et ce qu'elle écrit là où elle en diffère — quand elle se
 * vérifie (voir `amputatedQuoteRemedy`), la ligne dont la copie s'écarte sans en
 * être une amputation quand c'est elle qui se vérifie (voir
 * `divergentQuoteRemedy`), sinon la seule réparation légale qui reste, citer une
 * ligne réelle du fichier déclaré.
 */
const NO_CHANGED_FILE_WITNESS =
  "The quote exists in no file this PR changes; quote a real line of the declared file instead.";
function witnessLocation(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext,
  scans: AmputationScans = amputationScans()
): string {
  const hint = witnessHint(
    witnessFiles(requirement.quote, context),
    context
  ).trim();
  if (hint !== "") {
    return hint;
  }
  // Le reproche précis de la copie passe avant l'aveu générique : il dit quelle
  // ligne citer, là où l'aveu laisse le planificateur recopier la même copie.
  return (
    amputatedQuoteRemedy(requirement, context, scans).trim() ||
    divergentQuoteRemedy(requirement, context, scans).trim() ||
    NO_CHANGED_FILE_WITNESS
  );
}
/**
 * Longueur maximale de la liste de chemins d'un remède de témoin. Le premier
 * chemin est toujours montré — un remède vide ne dirigerait le planificateur
 * nulle part — et les suivants tant que la liste tient dans la borne.
 */
const WITNESS_HINT_PATHS_CHARS = 120;
function boundedPaths(paths: string[]): string {
  const [first] = paths;
  if (!first) {
    return "";
  }
  const shown = [first];
  let used = first.length;
  for (const path of paths.slice(1)) {
    if (used + path.length + 2 > WITNESS_HINT_PATHS_CHARS) {
      break;
    }
    shown.push(path);
    used += path.length + 2;
  }
  const hidden = paths.length - shown.length;
  return `${shown.join(", ")}${hidden > 0 ? ` (+${hidden} more)` : ""}`;
}

/** Nombre minimal de jetons de la citation qu'une ligne candidate doit reprendre. */
const SUGGESTED_QUOTE_MIN_SHARED_TOKENS = 3;
/** Part minimale des jetons de la citation qu'une ligne candidate doit porter. */
const SUGGESTED_QUOTE_MIN_OVERLAP = 0.5;
/**
 * Longueur maximale d'une ligne candidate : le remède reste borné sans qu'aucun
 * fragment ne soit rogné, donc chaque candidat est recopiable d'un seul tenant.
 */
const SUGGESTED_QUOTE_MAX_CHARS = 120;
/** Nombre maximal de candidats : au-delà, la suggestion noie la correction. */
const SUGGESTED_QUOTE_LIMIT = 2;
function quoteTokenSet(value: string): Set<string> {
  // Découper sur les seuls blancs cachait le recouvrement réel : `expect(countCash({`
  // ne partage aucun jeton avec `countCash({`. Les jetons sont donc les suites
  // de lettres, chiffres et soulignés, en minuscules.
  return new Set(
    normalizeQuoteText(value)
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
  );
}
/**
 * Nombre maximal de lignes du fichier cité que les diagnostics de copie lisent
 * pour une citation — suggestion de ligne, recousure, amputation. Les lignes du
 * contenu après changement viennent en tête, donc la borne couvre d'abord la
 * région que la PR change. Au-delà, le diagnostic se tait : le refus est rendu
 * quand même, avec son conseil générique, qui reste exact. Sans elle, chaque
 * citation fautive d'un plan hostile faisait payer au worker le balayage du
 * fichier entier, alors que le lease d'exécution ne survit pas à ce travail ;
 * `AMPUTATION_QUOTES_EXAMINED` borne le nombre de citations qui paient ce
 * balayage dans une validation.
 */
const CITED_LINES_EXAMINED = 2000;
/**
 * Lignes réelles du fichier cité, avec leur numéro : le contenu après
 * changement reconstruit depuis le patch, et le contenu récupéré à la révision
 * de tête. Chaque révision est indexée par le chemin qui la porte, comme
 * `completeSource` (runner.ts) : le contenu de tête est celui du chemin de
 * tête — `filename`, que la PR renomme éventuellement — et le contenu de base
 * celui du `previous_filename`, lu seulement quand la PR supprime le fichier,
 * seule révision où il existe encore. Apparier `previous_filename` à la
 * révision de tête proposait des lignes du fichier d'avant le renommage, qui
 * n'existent pas dans le fichier cité.
 *
 * Les lignes rendues sont plafonnées à `CITED_LINES_EXAMINED`.
 */
function fileContentLines(
  requirement: Pick<Requirement, "sourceFile">,
  context: PrContext
): PostChangeLine[] {
  return allFileContentLines(requirement, context).slice(
    0,
    CITED_LINES_EXAMINED
  );
}
/**
 * Le chemin et les révisions dont `allFileContentLines` tire le fichier cité :
 * la révision de tête du chemin de tête, ou la révision de base du
 * `previous_filename` quand la PR supprime le fichier — la seule où il existe
 * encore.
 */
function citedSourceRevision(
  requirement: Pick<Requirement, "sourceFile">,
  context: PrContext
): { path: string; refs: string[] } {
  const file = context.files.find(
    (item) => item.filename === requirement.sourceFile
  );
  return file?.status === "removed"
    ? {
        path: file.previous_filename ?? requirement.sourceFile,
        refs: [context.baseSha],
      }
    : { path: requirement.sourceFile, refs: [context.sha] };
}
/** Toutes les lignes réelles du fichier cité, sans le plafond de lecture. */
function allFileContentLines(
  requirement: Pick<Requirement, "sourceFile">,
  context: PrContext
): PostChangeLine[] {
  const file = context.files.find(
    (item) => item.filename === requirement.sourceFile
  );
  const lines = file?.patch ? postChangeHunks(file.patch).flat() : [];
  const { path, refs } = citedSourceRevision(requirement, context);
  for (const item of context.context) {
    if (item.path !== path || !refs.includes(item.ref)) {
      continue;
    }
    lines.push(
      ...item.content
        .split("\n")
        .map((text, index) => ({ line: index + 1, text }))
    );
  }
  return lines;
}
/**
 * Le matériel numéroté COMPLET du diff : chaque fichier modifié avec les lignes
 * réelles de ses hunks, numérotées dans le nouveau fichier. C'est ce que le gate
 * lit pour résoudre une référence `line` (voir `resolveLineReference`,
 * schema.ts) : le numéro que les refus nomment — la ligne « 71: "..." » d'un
 * remède — se retrouve ici, donc une référence `line: 71` se résout sans que
 * rien ne soit recopié. Jamais de texte inventé : chaque ligne vient du patch,
 * sans son préfixe.
 *
 * C'est la SEULE numérotation. Le message en affiche la part que le budget
 * laisse (`sourceLines`, voir `numberedSourceLines`), mais les deux listes
 * sortent des mêmes hunks (`postChangeHunks`) et de la même base — l'en-tête
 * `@@ … +N` de chaque hunk — donc un numéro désigne la même ligne dans les deux,
 * et un fichier absent de l'affichage reste résoluble.
 */
export function sourceLineMaterial(context: PrContext): SourceLineMaterial[] {
  const files: SourceLineMaterial[] = [];
  for (const file of context.files) {
    if (!file.patch) {
      continue;
    }
    const lines = postChangeHunks(file.patch).flat();
    if (lines.length === 0) {
      continue;
    }
    files.push({ lines, path: file.filename });
  }
  return files;
}
/**
 * La part du matériel que le message AFFICHE : celle qui tient dans le budget
 * que l'appelant lui alloue, fichiers entiers, dans l'ordre du diff. Au-delà,
 * la ligne n'est pas montrée — elle reste néanmoins résoluble, le matériel de
 * résolution étant le diff entier (voir `sourceLineMaterial`) : la troncature
 * de l'affichage ne ferme aucune ligne au planificateur, elle l'oblige
 * seulement à désigner un numéro qu'il n'a pas lu ligne à ligne.
 *
 * Le coût d'une ligne est sa taille sérialisée plus `SOURCE_LINE_COST_CHARS`,
 * celui d'un fichier la taille SÉRIALISÉE de son chemin plus
 * `SOURCE_FILE_COST_CHARS` ; ces marges couvrent les accolades et les virgules,
 * donc le total sérialisé tient dans le budget reçu. Le chemin n'y échappe pas :
 * git accepte un guillemet ou un antislash dans un nom de fichier, que JSON
 * échappe, donc la longueur brute du nom sous-estime la place qu'il prend.
 * Compter la longueur brute laissait entrer une ligne de trop, et `planPayload`
 * rejetait alors un payload passé au-dessus de sa limite.
 */
export function numberedSourceLines(
  context: PrContext,
  budget: number
): SourceLineMaterial[] {
  const files: SourceLineMaterial[] = [];
  let used = 0;
  for (const file of sourceLineMaterial(context)) {
    const cost = JSON.stringify(file.path).length + SOURCE_FILE_COST_CHARS;
    if (used + cost > budget) {
      continue;
    }
    const lines: { line: number; text: string }[] = [];
    let taken = cost;
    for (const item of file.lines) {
      const entry =
        JSON.stringify({ line: item.line, text: item.text }).length +
        SOURCE_LINE_COST_CHARS;
      if (used + taken + entry > budget) {
        break;
      }
      taken += entry;
      lines.push(item);
    }
    if (lines.length === 0) {
      continue;
    }
    used += taken;
    files.push({ path: file.path, lines });
  }
  return files;
}
/**
 * Marge de coût d'une ligne numérotée, d'un fichier numéroté : la virgule qui
 * sépare deux entrées, les accolades du tableau, et pour un fichier la clé
 * `path` et son deux-points. Elle surestime volontairement, pour que le matériel
 * tienne toujours dans la place que `planPayload` lui alloue.
 */
const SOURCE_LINE_COST_CHARS = 24;
const SOURCE_FILE_COST_CHARS = 32;
/**
 * Lignes réelles du fichier cité à citer à la place d'une citation absente :
 * celles dont le recouvrement de jetons avec la citation est le plus élevé, au
 * plus deux, à un seuil qui écarte une ressemblance de hasard. Chaque candidat
 * est une ligne exacte du fichier avec son numéro, jamais un texte inventé ou
 * rogné, et le critère est déterministe. Une liste vide — aucune ligne ne
 * franchit le seuil — préfère l'absence de suggestion à une suggestion
 * trompeuse.
 */
export function suggestedQuoteLines(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): { line: number; text: string }[] {
  const quote = quoteTokenSet(requirement.quote);
  if (quote.size < SUGGESTED_QUOTE_MIN_SHARED_TOKENS) {
    return [];
  }
  const candidates = new Map<
    string,
    { line: number; ratio: number; shared: number; text: string }
  >();
  for (const { line, text } of fileContentLines(requirement, context)) {
    // Un candidat qui ne franchirait pas le contrat de citation serait un remède
    // que le gate refuserait : il n'est jamais proposé.
    if (text.length > SUGGESTED_QUOTE_MAX_CHARS || !quoteCarriesContent(text)) {
      continue;
    }
    const tokens = quoteTokenSet(text);
    const shared = [...quote].filter((token) => tokens.has(token)).length;
    const ratio = shared / quote.size;
    if (
      shared < SUGGESTED_QUOTE_MIN_SHARED_TOKENS ||
      ratio < SUGGESTED_QUOTE_MIN_OVERLAP
    ) {
      continue;
    }
    // La même ligne peut venir de deux révisions : la première occurrence, dans
    // le nouveau contenu d'abord, garde son numéro.
    const existing = candidates.get(text);
    if (!existing || existing.line > line) {
      candidates.set(text, { line, ratio, shared, text });
    }
  }
  return [...candidates.values()]
    .sort(
      (left, right) =>
        right.ratio - left.ratio ||
        right.shared - left.shared ||
        left.line - right.line
    )
    .slice(0, SUGGESTED_QUOTE_LIMIT)
    .map(({ line, text }) => ({ line, text }));
}
/**
 * Remède d'une citation absente : les lignes réelles du fichier cité que le
 * planificateur peut citer à la place, au plus deux. Jamais proposé quand la
 * citation existe ailleurs — le remède est alors l'attribution à l'autre
 * fichier, pas une autre ligne de celui-ci — ni quand aucune ligne ne franchit
 * le seuil de recouvrement. La classe fatale agrégée du canal de correction la
 * porte aussi (voir `ungroundedRemedy` dans runner.ts) : le préambule fatal la
 * protège de la troncature, là où le détail par exigence qui la portait
 * disparaissait sous des classes saturées.
 */
function quoteSuggestion(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): string {
  return lineSuggestion(
    suggestedQuoteLines(requirement, context),
    requirement.sourceFile
  );
}
/**
 * Les lignes réelles à citer à la place d'une citation refusée, sous la forme
 * que le planificateur reçoit : « 116: "…" ». Une liste vide rend une chaîne
 * vide, jamais un remède qui ne nomme rien.
 */
function lineSuggestion(
  lines: { line: number; text: string }[],
  sourceFile: string
): string {
  if (lines.length === 0) {
    return "";
  }
  const listed = lines
    .map(({ line, text }) => `${line}: ${JSON.stringify(text)}`)
    .join(", ");
  return ` Real lines of ${sourceFile} to quote instead: ${listed}.`;
}
/**
 * Lignes réelles du fichier cité qui PORTENT la citation refusée à l'identique :
 * le témoin évident d'une citation trop pauvre est la ligne qui la contient, et
 * elle porte forcément la structure de code qui manquait à l'identifiant nu.
 *
 * C'est la piste qui manquait au refus « Weak source witness ». Le remède de la
 * citation absente s'appuie sur le recouvrement de jetons
 * (`suggestedQuoteLines`), qui exige trois jetons partagés et une ligne de moins
 * de 120 caractères : `counted.totalUnits` (deux jetons) et `ecart-justifie`
 * n'obtenaient donc AUCUN candidat et AUCUNE piste — mesuré sur les runs
 * 9ee36233 et b132c982 —, et `ecart-a-justifier` n'en obtenait que par la grâce
 * de ses trois jetons. Ici le critère n'est pas une ressemblance de jetons mais
 * la présence EXACTE de la citation dans la ligne, et le candidat est la ligne
 * ENTIÈRE : il porte donc toujours le contenu et la structure que le gate
 * exige. La règle de témoin, elle, ne bouge pas — un identifiant nu reste
 * refusé ; seule la piste vers sa ligne réelle est nouvelle.
 *
 * Vide pour une citation qui porte déjà du contenu : ce diagnostic ne concerne
 * que le témoin trop pauvre, et sa liste n'élargit jamais l'acceptation.
 *
 * Vide aussi dès que la citation apparaît sur plus de lignes que la liste n'en
 * offre : un identifiant commun (`function`, `return`) vit sur des dizaines de
 * lignes sans rapport avec l'exigence, et la correction par indice écrirait
 * alors l'une d'elles dans le plan — le gate accepterait une ligne réelle comme
 * preuve d'un comportement qu'elle ne porte pas. La borne est donc
 * l'ambiguïté : au plus une ligne par candidat offert, sinon aucune piste et le
 * refus d'aujourd'hui, que le planificateur corrige en réécrivant.
 */
export function weakWitnessLines(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): { line: number; text: string }[] {
  if (quoteCarriesContent(requirement.quote)) {
    return [];
  }
  const found: { line: number; text: string }[] = [];
  const seen = new Set<string>();
  for (const { line, text } of fileContentLines(requirement, context)) {
    const key = normalizeQuoteText(text);
    // Une ligne que le gate refuserait comme citation — trop longue, ou sans
    // contenu visible — n'est jamais proposée : elle n'apprendrait rien au
    // planificateur, qui la verrait refusée au tour suivant.
    if (
      seen.has(key) ||
      text.length > QUOTE_MAX_CHARS ||
      !quoteCarriesContent(text) ||
      !quoteAppears(text, requirement.quote)
    ) {
      continue;
    }
    seen.add(key);
    found.push({ line, text });
  }
  return found.length > SUGGESTED_QUOTE_LIMIT
    ? []
    : found.slice(0, SUGGESTED_QUOTE_LIMIT);
}
/**
 * Remède d'un témoin trop pauvre : la ligne réelle qui porte la citation, au
 * plus deux, DÉSIGNÉE par son numéro et non recopiée. Il remplace, pour ce
 * défaut, la similitude de jetons du remède de citation absente — la citation
 * existe, seule sa substance manque, et la ligne qui la porte est la réponse
 * exacte.
 *
 * Mesuré au run d6679230 (pharmania/arpilabe-pilotage#17 @ 814b6713) :
 * `caisse-comptage-ecart` ne vit que sur la ligne 15 de `apps/web/AGENTS.md`,
 * une ligne de tableau de 442 caractères. Le refus la nommait déjà, mais en
 * demandant de la RECOPIER (« Real lines … to quote instead ») : le
 * planificateur devait retaper 442 caractères pour un témoin dont le numéro
 * suffisait, et sa manche de correction n'a pas convergé. Depuis la PR #71 une
 * exigence peut désigner `"line": N` et le gate lit le texte lui-même : le
 * remède nomme donc la référence, et ne retombe sur le texte à recopier que
 * quand aucune ligne n'est dans le matériel de résolution — en disant pourquoi
 * (`resolveLineReference` nomme la cause : hors du diff, ambiguë, sans contenu),
 * pour que le planificateur sache que la voie sûre lui est fermée.
 */
export function weakWitnessSuggestion(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): string {
  const lines = weakWitnessLines(requirement, context);
  if (lines.length === 0) {
    return "";
  }
  const material = sourceLineMaterial(context);
  const designable: number[] = [];
  let refusal = "";
  for (const { line, text } of lines) {
    const resolution = resolveLineReference(
      requirement.sourceFile,
      line,
      material
    );
    // Le texte rendu doit être CELUI du candidat : une ligne que le matériel
    // numérote autrement (contenu de tête vs contenu après changement) ne
    // désigne pas la même preuve, donc elle n'est pas offerte comme référence.
    if ("text" in resolution && resolution.text === text) {
      designable.push(line);
    } else if (refusal === "") {
      refusal =
        "refusal" in resolution
          ? resolution.refusal
          : `Line ${line} of ${requirement.sourceFile} carries other text in the numbered material, so the candidate is not what the gate would write.`;
    }
  }
  if (designable.length > 0) {
    const references = designable.map((line) => `"line": ${line}`).join(" or ");
    return ` Designate it instead of retyping it: send ${references} for ${requirement.sourceFile}, and the gate writes that line itself.`;
  }
  const listed = lines
    .map(({ line, text }) => `${line}: ${JSON.stringify(text)}`)
    .join(", ");
  return ` No "line" reference designates the real line that carries it: ${refusal} Quote its exact text instead: ${listed}.`;
}
/**
 * Un fragment d'une citation recousue, retrouvé tel quel sur une ligne réelle du
 * fichier cité : le fragment recopié de la citation, la ligne qui le porte, et
 * l'extrait de cette ligne que le planificateur peut citer à la place.
 */
export interface StitchedFragment {
  candidate: string;
  fragment: string;
  line: number;
}
/**
 * Longueur minimale d'un fragment nommé comme tel. En deçà, le fragment — une
 * accolade, un mot courant — existe à trop d'endroits pour désigner une ligne,
 * et le diagnostic nommerait deux fragments sans rapport avec la faute.
 */
const STITCH_FRAGMENT_MIN_CHARS = QUOTE_MIN_TEXT_CHARS;
const STITCH_FRAGMENT_WORD_CHARS = /[\p{L}\p{N}]/u;
function isStitchFragment(value: string): boolean {
  const normalized = normalizeQuoteText(value);
  return (
    normalized.length >= STITCH_FRAGMENT_MIN_CHARS &&
    STITCH_FRAGMENT_WORD_CHARS.test(normalized)
  );
}
/**
 * Nombre maximal de découpages examinés : chaque découpage coûte un balayage des
 * lignes du fichier cité par fragment, donc une citation anormalement longue ne
 * doit pas faire payer au gate un coût quadratique.
 */
const STITCH_SPLITS_EXAMINED = 32;
/**
 * Découpages de la citation à chaque suite de blancs : le fragment de gauche et
 * celui de droite, recopiés tels quels, sans le blanc qui les sépare. C'est la
 * forme mesurée d'une recousure — deux attributs d'une même expression, que le
 * fichier sépare par d'autres attributs et que la citation recolle par un
 * espace. Les découpages sont rendus du plus équilibré au moins équilibré,
 * c'est-à-dire dans l'ordre du critère de sélection : la borne ci-dessus
 * n'écarte donc jamais un découpage mieux noté que celui qu'elle garde. À
 * équilibre égal, l'ordre de la citation est conservé — le plus à gauche gagne.
 */
function whitespaceSplits(
  quote: string
): { head: string; shortest: number; tail: string }[] {
  const splits: { head: string; shortest: number; tail: string }[] = [];
  for (const match of quote.matchAll(/\s+/gu)) {
    const at = match.index ?? 0;
    const head = quote.slice(0, at);
    const tail = quote.slice(at + match[0].length);
    splits.push({ head, shortest: Math.min(head.length, tail.length), tail });
  }
  return splits
    .sort((left, right) => right.shortest - left.shortest)
    .slice(0, STITCH_SPLITS_EXAMINED);
}
/**
 * Lignes réelles du fichier cité qui portent ce fragment tel quel, une fois
 * chacune et dans l'ordre du fichier : la même ligne vient du contenu après
 * changement et du contenu de tête, et le fragment y est identique.
 */
function fragmentLines(
  lines: PostChangeLine[],
  fragment: string
): PostChangeLine[] {
  const found = new Map<number, PostChangeLine>();
  for (const line of lines) {
    if (!found.has(line.line) && line.text.includes(fragment)) {
      found.set(line.line, line);
    }
  }
  return [...found.values()].sort((left, right) => left.line - right.line);
}
/**
 * Première occurrence de chaque fragment dont les deux lignes diffèrent : deux
 * fragments portés par la même ligne ne sont jamais une recousure de deux
 * lignes, donc le diagnostic se tait plutôt que de nommer une ligne fausse.
 */
function distinctLinePair(
  left: PostChangeLine[],
  right: PostChangeLine[]
): [PostChangeLine, PostChangeLine] | undefined {
  const pairs: [PostChangeLine | undefined, PostChangeLine | undefined][] = [
    [left[0], right[0]],
    [left[0], right[1]],
    [left[1], right[0]],
  ];
  for (const [first, second] of pairs) {
    if (first && second && first.line !== second.line) {
      return [first, second];
    }
  }
}
/** Un jeton entier d'une ligne, avec ses bornes : jamais un jeton rogné. */
interface LineToken {
  end: number;
  start: number;
}
function lineTokens(line: string): LineToken[] {
  return [...line.matchAll(/\S+/gu)].map((match) => ({
    end: (match.index ?? 0) + match[0].length,
    start: match.index ?? 0,
  }));
}
/**
 * Bornes des jetons entiers qui portent la portion [from, to) de la ligne : le
 * premier jeton que la portion touche et le dernier. `undefined` quand la
 * portion n'en touche aucun.
 */
function coveringTokens(
  tokens: LineToken[],
  from: number,
  to: number
): [number, number] | undefined {
  const first = tokens.findIndex((token) => token.end > from);
  let last = -1;
  for (const [index, token] of tokens.entries()) {
    if (token.start < to) {
      last = index;
    }
  }
  return first < 0 || last < first ? undefined : [first, last];
}
/**
 * Fenêtre la plus large qui porte ces jetons sous la borne de suggestion : elle
 * s'étend d'abord à droite jusqu'à la borne, puis à gauche avec ce qu'il reste,
 * donc l'extrait porte le contexte réel du fragment — jamais un jeton rogné, et
 * toujours recopiable d'un seul tenant. Chaque extension est pesée AVANT d'être
 * retenue : un jeton n'est ajouté que si la fenêtre qu'il formerait tient encore
 * dans la borne. Peser la fenêtre courante à la place laissait le dernier jeton
 * la faire déborder, et `quoteableFragment` écartait alors un fragment citable —
 * le diagnostic disparaissait au lieu de nommer la ligne.
 */
function windowBounds(
  tokens: LineToken[],
  first: number,
  last: number
): [number, number] {
  let low = first;
  let high = last;
  const fits = (from: number, to: number): boolean =>
    (tokens[to] as LineToken).end - (tokens[from] as LineToken).start <=
    SUGGESTED_QUOTE_MAX_CHARS;
  while (high + 1 < tokens.length && fits(low, high + 1)) {
    high += 1;
  }
  while (low > 0 && fits(low - 1, high)) {
    low -= 1;
  }
  return [low, high];
}
/**
 * Extrait exact d'une ligne réelle à citer à la place d'un fragment : la ligne
 * entière quand elle tient dans la borne et que le contrat de `quote`
 * l'accepte, sinon la plus longue suite de jetons ENTIERS qui porte le
 * fragment (voir `windowBounds`). Jamais de texte inventé ni de jeton rogné : la
 * fenêtre est une portion exacte de la ligne. Vide quand aucune fenêtre ne
 * franchit le contrat — une suggestion que le gate refuserait ne dirigerait le
 * planificateur nulle part.
 */
function quoteableFragment(line: string, fragment: string): string {
  if (line.length <= SUGGESTED_QUOTE_MAX_CHARS && quoteCarriesContent(line)) {
    return line;
  }
  const at = line.indexOf(fragment);
  if (at < 0) {
    return "";
  }
  const tokens = lineTokens(line);
  const covering = coveringTokens(tokens, at, at + fragment.length);
  if (!covering) {
    return "";
  }
  const [low, high] = windowBounds(tokens, ...covering);
  const window = line.slice(
    (tokens[low] as LineToken).start,
    (tokens[high] as LineToken).end
  );
  return window.length <= SUGGESTED_QUOTE_MAX_CHARS &&
    quoteCarriesContent(window)
    ? window
    : "";
}
/**
 * Les deux fragments d'une citation recousue, chacun recopié tel quel sur une
 * ligne RÉELLE du fichier cité, quand ces deux lignes sont différentes : la
 * citation est introuvable, mais chacune de ses moitiés existe à un endroit
 * distinct, et c'est ce que le refus doit dire au planificateur — sinon il
 * reconstruit la même paire plausible. Déterministe et borné : au plus deux
 * fragments et deux lignes, choisis par le découpage dont le plus court
 * fragment est le plus long (à égalité, le plus à gauche), puis par la première
 * ligne de chaque fragment qui diffère de celle de l'autre. JAMAIS de texte
 * inventé : chaque fragment est recopié de la citation, et chaque candidat est
 * une portion exacte du fichier. Une liste vide dès qu'un fragment n'existe
 * nulle part, qu'un fragment ne désigne pas une ligne, que les seules
 * occurrences partagent la même ligne, ou qu'aucune fenêtre citable n'en sort :
 * l'absence de diagnostic vaut mieux qu'un diagnostic faux. Un découpage ne
 * voit que les recousures séparées par des blancs — une fusion de jetons
 * (lot F) garde le remède générique de `quoteSuggestion`. Chaque fragment doit
 * aussi tenir ENTIER sur une seule ligne réelle : une moitié coupée par un saut
 * de ligne n'appartient à aucune ligne, donc elle est introuvable et la
 * recousure garde le remède générique plutôt qu'une ligne nommée au hasard.
 */
export function stitchedQuoteFragments(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): StitchedFragment[] {
  const lines = fileContentLines(requirement, context);
  let best: { fragments: StitchedFragment[]; shortest: number } | undefined;
  for (const { head, tail, shortest } of whitespaceSplits(requirement.quote)) {
    if (!(isStitchFragment(head) && isStitchFragment(tail))) {
      continue;
    }
    const pair = distinctLinePair(
      fragmentLines(lines, head),
      fragmentLines(lines, tail)
    );
    if (!pair) {
      continue;
    }
    const [headLine, tailLine] = pair;
    const headCandidate = quoteableFragment(headLine.text, head);
    const tailCandidate = quoteableFragment(tailLine.text, tail);
    if (!(headCandidate && tailCandidate)) {
      continue;
    }
    if (best && best.shortest >= shortest) {
      continue;
    }
    best = {
      fragments: [
        { candidate: headCandidate, fragment: head, line: headLine.line },
        { candidate: tailCandidate, fragment: tail, line: tailLine.line },
      ],
      shortest,
    };
  }
  return best?.fragments ?? [];
}
/**
 * Remède d'une citation recousue : les deux fragments que la citation a
 * recollés, chacun avec la ligne réelle qui le porte, puis la portion exacte de
 * chacune de ces lignes à citer à la place. Le diagnostic nomme la faute — la
 * citation n'existe nulle part, ses moitiés existent à deux endroits — avant de
 * proposer les lignes : c'est le premier remède que le planificateur doit lire,
 * puisque le conseil générique ne lui a pas suffi. Vide quand aucun découpage
 * ne se vérifie, pour que l'appelant retombe sur le remède d'aujourd'hui.
 */
export function stitchedQuoteRemedy(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): string {
  const fragments = stitchedQuoteFragments(requirement, context);
  const [head, tail] = fragments;
  if (!(head && tail)) {
    return "";
  }
  const named = fragments
    .map((item) => `${JSON.stringify(item.fragment)} is line ${item.line}`)
    .join(", ");
  const candidates = fragments
    .map((item) => `${item.line}: ${JSON.stringify(item.candidate)}`)
    .join(", ");
  return `Your quote assembles fragments from different lines: ${named}. Quote one of these real fragments of ${requirement.sourceFile} instead: ${candidates}.`;
}
/**
 * Partie d'une ligne réelle qu'une copie amputée a laissée de côté : le début de
 * la ligne, sa fin, ou les deux à la fois quand la copie n'en est qu'un
 * fragment intérieur.
 */
export type QuoteAmputation = "end" | "middle" | "start";
/**
 * Une ligne réelle du fichier cité dont la citation refusée est une copie
 * amputée : la ligne, son numéro, et la portion exacte de cette ligne que le
 * planificateur peut citer à la place.
 */
export interface AmputatedQuote {
  candidate: string;
  kind: QuoteAmputation;
  line: number;
  /** Faux quand la ligne dépasse la borne de suggestion : le candidat est une fenêtre. */
  wholeLine: boolean;
}
/**
 * Ce que le refus dit de la partie perdue, et la lecture qui en découle. Le
 * défaut est séparé de la lecture parce qu'une copie ALTÉRÉE à l'intérieur garde
 * le défaut — sa fin manque toujours — sans la lecture, qui affirmerait qu'elle
 * n'est que le début de la ligne alors que le diagnostic de divergence nomme ce
 * qu'elle écrit à la place (voir `quoteDivergence`).
 */
const AMPUTATION_FAULT: Record<QuoteAmputation, string> = {
  end: "its end is missing",
  middle:
    "its beginning and its end are missing, so the copy is only a fragment taken inside that line",
  start: "its beginning is missing",
};
/** La lecture qui suit le défaut quand rien ne la contredit. */
const AMPUTATION_READING: Record<QuoteAmputation, string> = {
  end: "so the copy is only the beginning of that line",
  middle: "",
  start: "so the copy is only the end of that line",
};
/**
 * La portion exacte de la ligne réelle à citer à la place de la copie refusée,
 * et ce que le refus dit d'elle : la ligne entière quand elle tient dans la
 * borne de `quote`, sinon la fenêtre de jetons ENTIERS que `quoteableFragment`
 * en a extraite — nommée comme un fragment, jamais comme la ligne entière, pour
 * qu'une consigne ne demande pas de citer « cette ligne » en donnant un fragment
 * pris au milieu d'elle. Quand la ligne est désignable dans le matériel de
 * résolution, `designation` passe devant : le gate écrit le texte lui-même, donc
 * le remède n'a plus rien à faire recopier.
 */
function quoteRepair(
  line: number,
  candidate: string,
  wholeLine: boolean,
  designation: string
): string {
  if (designation !== "") {
    return designation;
  }
  return wholeLine
    ? `quote that whole line from its first character instead: ${line}: ${JSON.stringify(candidate)}.`
    : `that line is too long to quote whole, so quote this exact fragment of it instead: ${line}: ${JSON.stringify(candidate)}.`;
}
/**
 * La ligne que le planificateur peut DÉSIGNER au lieu de la recopier : quand le
 * matériel de résolution la porte, le remède ne rend aucun texte — il donne le
 * numéro, et le gate écrit lui-même la ligne du diff (voir
 * `resolveLineReference`). C'est la sortie du mode d'échec mesuré du run
 * 76249900 : le refus disait « quote that whole line from its first character
 * instead », le planificateur la recopiait, et un seul caractère dérivé — une
 * apostrophe typographique là où le fichier écrit `'` — suffisait à la refuser
 * de nouveau.
 *
 * Vide quand la ligne n'est pas dans le matériel — contenu de tête d'un fichier
 * que la PR ne change pas, contexte importé — ou quand le gate refuserait la
 * référence elle-même, parce qu'elle est trop longue ou vide de code : le remède
 * retombe alors sur la portion exacte à citer, seule voie qui reste pour cette
 * ligne.
 */
function designatedLineRemedy(
  sourceFile: string,
  line: number,
  context: PrContext
): string {
  const resolution = resolveLineReference(
    sourceFile,
    line,
    sourceLineMaterial(context)
  );
  if ("refusal" in resolution) {
    return "";
  }
  return `send "line": ${line} for ${sourceFile} and the gate writes that line itself.`;
}
/** Un bord d'un découpage : le fragment recopié et sa forme normalisée. */
interface AmputationEdge {
  fragment: string;
  normalized: string;
}
/**
 * Sonde d'amputation d'une citation : la copie normalisée, et les découpages de
 * la copie sur ses blancs dont les DEUX fragments désignent une ligne, chacun
 * avec ses bords déjà normalisés. Elle ne dépend que de la citation, donc elle
 * est calculée une fois pour tout le balayage du fichier cité : la calculer par
 * ligne — découper, trier, normaliser les bords à chaque ligne — faisait payer
 * au gate les lignes fois les découpages, pour une réponse qui ne bouge pas.
 */
interface AmputationProbe {
  copy: string;
  quote: string;
  splits: { head: AmputationEdge; tail: AmputationEdge }[];
}
function amputationProbe(quote: string): AmputationProbe {
  const splits: AmputationProbe["splits"] = [];
  for (const { head, tail } of whitespaceSplits(quote)) {
    if (!(isStitchFragment(head) && isStitchFragment(tail))) {
      continue;
    }
    splits.push({
      head: { fragment: head, normalized: normalizeQuoteText(head) },
      tail: { fragment: tail, normalized: normalizeQuoteText(tail) },
    });
  }
  return { copy: normalizeQuoteText(quote), quote, splits };
}
/**
 * Les deux verdicts d'un même balayage du fichier cité : la ligne dont la copie
 * est une amputation, et l'endroit où cette copie s'écarte de cette même ligne.
 * Les deux sont rendus ensemble parce qu'ils viennent du même parcours et du
 * même budget : un refus peut donc nommer la ligne ET ce qui diffère réellement
 * sans repayer le fichier.
 */
interface QuoteCopyScan {
  amputation: AmputatedQuote | undefined;
  divergence: QuoteDivergence | undefined;
}
/**
 * Citations dont la copie est examinée pour une même validation, et verdict
 * mémorisé de chacune : `remaining` compte les citations qui peuvent encore être
 * examinées, `found` porte ce que le balayage en a dit. Deux plafonds gouvernent
 * ce travail — `CITED_LINES_EXAMINED` lignes par citation,
 * `AMPUTATION_QUOTES_EXAMINED` citations par validation — parce qu'un plan
 * hostile aligne les citations fautives et que le worker tient un lease : hors
 * de ces bornes, le refus reste rendu, seul son remède détaillé se tait. Le
 * verdict est mémorisé parce que le remède d'une même citation est évalué deux
 * fois — le conseil de l'exigence, puis la ligne du refus — et qu'un plan peut
 * la répéter : chaque citation examinée ne paie qu'un balayage, pour ses deux
 * verdicts.
 *
 * Un seul budget est créé au point d'entrée du gate (voir `planRefusals`,
 * runner.ts) et traverse le chemin qui rend un remède détaillé — les deux
 * moitiés du gate le consomment : les classes fatales de couverture par
 * `coverageFatalClasses` puis les refus par scénario par
 * `ungroundedPlanRefusals`. Recréer un budget sur une moitié rendait à l'autre
 * le plafond entier, donc chaque citation fautive d'un plan hostile repaie son
 * balayage pour chaque exigence que le schéma autorise.
 */
export interface AmputationScans {
  found: Map<string, QuoteCopyScan | undefined>;
  remaining: number;
}
/** Citations examinées par validation : au-delà, le remède détaillé se tait. */
const AMPUTATION_QUOTES_EXAMINED = 32;
export function amputationScans(): AmputationScans {
  return { found: new Map(), remaining: AMPUTATION_QUOTES_EXAMINED };
}
/** Même citation, même balayage : son fichier et son texte cité l'identifient. */
function amputationScanKey(
  requirement: Pick<Requirement, "quote" | "sourceFile">
): string {
  return `${requirement.sourceFile}\u0000${requirement.quote}`;
}
/**
 * Vrai quand la copie de cette citation a été examinée, ou quand le budget de la
 * validation permet encore de l'examiner. Faux : le remède détaillé de cette
 * citation se tait, et le refus garde le conseil générique de son exigence, qui
 * reste exact.
 */
function amputationScanAllowed(
  scans: AmputationScans,
  requirement: Pick<Requirement, "quote" | "sourceFile">
): boolean {
  return scans.found.has(amputationScanKey(requirement)) || scans.remaining > 0;
}
/**
 * Copie amputée d'une ligne réelle : une copie qui commence au milieu d'une
 * ligne et s'arrête avant sa fin n'existe nulle part mot pour mot, donc le gate
 * la refuse à juste titre — mais elle est recopiée d'une ligne RÉELLE du fichier
 * cité, et c'est ce que le refus doit dire, sinon le planificateur reconstruit la
 * même copie.
 *
 * La relation est lue sur la copie entière quand elle est un fragment de la ligne
 * (fin → son début manque, début → sa fin manque, intérieur → les deux), et
 * sinon sur le bord EXACT que la copie partage encore avec la ligne : un
 * découpage sur ses blancs dont le fragment de droite est la fin de la ligne, ou
 * celui de gauche son début. Le fragment non recopié est alors celui que la copie
 * a laissé de côté — cas mesuré du run f328177b, où la copie commence à « unité »
 * au lieu du premier caractère de la ligne.
 *
 * Deux gardes écartent les diagnostics faux. Une copie plus longue que la ligne
 * qu'elle touche a inventé du texte au-delà d'elle : lui proposer cette ligne
 * nommerait une réparation qui ne répare pas son défaut. Et un découpage dont les
 * DEUX bords sont recopiés n'est pas une amputation — le texte sauté est au
 * milieu de la ligne — donc il ne reçoit aucun des trois diagnostics.
 *
 * Les découpages de la copie et leurs bords normalisés viennent de la sonde
 * (voir `amputationProbe`), calculée une fois pour tout le balayage : chaque
 * ligne ne paie que ses propres comparaisons.
 */
function lineAmputation(
  line: string,
  probe: AmputationProbe
): { fragment: string; kind: QuoteAmputation } | undefined {
  const text = normalizeQuoteText(line);
  const { copy, quote } = probe;
  if (copy.length === 0 || copy.length > text.length) {
    return;
  }
  if (text.endsWith(copy)) {
    return { fragment: quote, kind: "start" };
  }
  if (text.startsWith(copy)) {
    return { fragment: quote, kind: "end" };
  }
  if (text.includes(copy)) {
    return { fragment: quote, kind: "middle" };
  }
  let best: { fragment: string; kind: QuoteAmputation } | undefined;
  let longest = 0;
  for (const { head, tail } of probe.splits) {
    const headAt = text.startsWith(head.normalized);
    const tailAt = text.endsWith(tail.normalized);
    if (headAt === tailAt) {
      continue;
    }
    const fragment = headAt ? head.fragment : tail.fragment;
    if (fragment.length <= longest) {
      continue;
    }
    best = { fragment, kind: headAt ? "end" : "start" };
    longest = fragment.length;
  }
  return best;
}
/**
 * Une citation refusée recopiée d'une ligne réelle du fichier cité, amputée de
 * son début, de sa fin ou des deux : la ligne la plus explicative du fichier, au
 * plus. La citation la plus longue qui est un fragment de la ligne est choisie
 * seule, puis le bord le plus long qui s'y vérifie.
 *
 * Trois conditions écartent une ligne : la copie doit porter assez de contenu
 * pour être un témoin de ce fichier — une copie trop pauvre a un autre défaut,
 * que le refus faible dit déjà ; elle ne doit pas être une recousure de deux
 * lignes, qui a son propre diagnostic (voir `stitchedQuoteFragments`) ; et elle
 * doit rester recopiable d'un seul tenant, donc `quoteableFragment` en sort une
 * portion exacte. Jamais de texte inventé : le candidat est toujours une portion
 * de la ligne réelle, jamais la citation fautive.
 *
 * Le budget de la validation (`AmputationScans`) écarte aussi une citation sans
 * balayage : hors du budget, le refus garde son conseil générique, qui reste
 * exact.
 */
export function amputatedQuote(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext,
  scans: AmputationScans = amputationScans()
): AmputatedQuote | undefined {
  return quoteCopyScan(requirement, context, scans)?.amputation;
}
/**
 * L'endroit où la copie refusée s'écarte de la ligne réelle dont elle est
 * recopiée : la ligne, la portion exacte qu'elle reproduit encore, et TOUTES les
 * divergences qu'elle porte avec elle — ce que la ligne écrit là où la copie en
 * diffère, et ce que la copie écrit à la place. Une copie ALTÉRÉE à l'intérieur
 * n'est pas une amputation de bord : le gate la refuse, mais le remède
 * d'amputation nomme alors une cause fausse — sa fin ne manque pas, son texte
 * diffère. C'est ce que ce diagnostic dit à sa place, avec le fragment réel le
 * plus proche et la portion exacte de la ligne à citer à la place.
 *
 * Rendu par le même balayage et le même budget que l'amputation (voir
 * `quoteCopyScan`) : le refus qui nomme la ligne ne repaie pas le fichier cité.
 */
export function quoteDivergence(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext,
  scans: AmputationScans = amputationScans()
): QuoteDivergence | undefined {
  return quoteCopyScan(requirement, context, scans)?.divergence;
}
/**
 * Candidats réels d'une citation refusée : les portions EXACTES du fichier cité
 * que le planificateur peut citer à la place, avec leur numéro de ligne. C'est
 * le matériel de la correction contrainte (voir `quotePickCorrection`,
 * runner.ts) : le planificateur choisit un indice, le gate écrit le texte, donc
 * la boucle de correction ne peut plus reproduire l'altération qu'elle corrige.
 *
 * Cinq sources, dans cet ordre : l'endroit où la copie s'écarte de sa ligne
 * (`quoteDivergence`), la ligne dont elle est une amputation
 * (`amputatedQuote`), les lignes qui portent la citation à l'identique — le
 * remède propre au témoin trop pauvre (`weakWitnessLines`), que le recouvrement
 * de jetons ne trouve pas — puis les lignes qui recouvrent le plus ses jetons
 * (`suggestedQuoteLines`), et — seulement quand toutes les précédentes se
 * taisent — la ligne dont les mots sont exactement les siens
 * (`wordAlignedFragment`).
 * Chaque candidat est vérifié comme témoin du fichier cité avant d'être proposé
 * — un candidat que le gate refuserait ne dirigerait le planificateur nulle part
 * — et la liste est dédoublonnée sur son texte normalisé, donc deux diagnostics
 * qui nomment la même portion n'en font qu'un.
 */
export function quoteResolutionCandidates(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext,
  scans: AmputationScans = amputationScans()
): { line: number; text: string }[] {
  const scan = quoteCopyScan(requirement, context, scans);
  const found: { line: number; text: string }[] = [];
  const seen = new Set<string>();
  const offer = (line: number, text: string) => {
    const key = normalizeQuoteText(text);
    if (seen.has(key) || text.length > QUOTE_MAX_CHARS) {
      return;
    }
    if (
      !requirementHasWitness(
        { quote: text, sourceFile: requirement.sourceFile },
        context
      )
    ) {
      return;
    }
    seen.add(key);
    found.push({ line, text });
  };
  if (scan?.divergence) {
    offer(scan.divergence.line, scan.divergence.candidate);
  }
  if (scan?.amputation) {
    offer(scan.amputation.line, scan.amputation.candidate);
  }
  // Le témoin trop pauvre passe en tête : sa réponse est la ligne qui porte
  // l'identifiant, pas une ressemblance de jetons. Elle est offerte avant la
  // suggestion de recouvrement, qui pour `counted.totalUnits` ne propose rien
  // (deux jetons) et pour une ligne de plus de 120 caractères se taît aussi.
  for (const item of weakWitnessLines(requirement, context)) {
    offer(item.line, item.text);
  }
  for (const item of suggestedQuoteLines(requirement, context)) {
    offer(item.line, item.text);
  }
  if (found.length === 0) {
    // Dernier recours borné : la copie dont les MOTS sont ceux d'une ligne, et
    // où seule une ponctuation diffère. L'alignement de `quoteDivergence`
    // compare des mots, donc une parenthèse perdue ne s'y voit pas, et la ligne
    // peut dépasser la borne de suggestion — c'est le cas mesuré 7eef87d4, où
    // la copie perd une `)` finale. Le candidat reste une portion EXACTE de la
    // ligne, alignée sur ses jetons entiers, donc un témoin que le gate
    // acceptera.
    for (const item of fileContentLines(requirement, context)) {
      const fragment = wordAlignedFragment(item.text, requirement.quote);
      if (fragment !== "") {
        offer(item.line, fragment);
        break;
      }
    }
  }
  return found.slice(0, QUOTE_RESOLUTION_CANDIDATE_LIMIT);
}
/**
 * Nombre maximal de candidats par citation fautive : au-delà, le choix noie la
 * correction, et le message contraint — tronqué à 2000 caractères par
 * `model.ts` — n'a plus la place de les nommer tous.
 */
const QUOTE_RESOLUTION_CANDIDATE_LIMIT = 4;
/**
 * Le fragment réel qui porte TOUS les mots de la copie, aligné sur des jetons
 * entiers, quand seul un caractère de ponctuation les distingue : la copie
 * 7eef87d4 perd une `)`, donc ses mots sont exactement ceux de sa ligne et aucun
 * diagnostic par mots ne peut la situer. Vide dès qu'un mot de la copie manque
 * à la suite commune — le fragment ne couvrirait alors qu'une partie de ce que
 * la copie voulait dire — ou quand la fenêtre n'est pas citable.
 */
function wordAlignedFragment(line: string, quote: string): string {
  const copyWords = lineWords(quote);
  if (copyWords.length < SUGGESTED_QUOTE_MIN_SHARED_TOKENS) {
    return "";
  }
  const words = lineWords(line);
  const run = longestWordRun(copyWords, words);
  if (!run || run.length < copyWords.length) {
    return "";
  }
  const tokens = lineTokens(line);
  const covering = coveringTokens(
    tokens,
    (words[run.line] as LineWord).start,
    (words[run.line + run.length - 1] as LineWord).end
  );
  if (!covering) {
    return "";
  }
  const [low, high] = windowBounds(tokens, ...covering);
  const window = line.slice(
    (tokens[low] as LineToken).start,
    (tokens[high] as LineToken).end
  );
  return quoteCarriesContent(window) && window.length <= QUOTE_MAX_CHARS
    ? window
    : "";
}
/**
 * Le balayage partagé, payé une fois par citation examinée : ses deux verdicts
 * — l'amputation et la divergence — sortent du même parcours, donc `remaining`
 * ne décrémente qu'une fois et le verdict mémorisé sert les deux (voir
 * `AmputationScans`).
 */
function quoteCopyScan(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext,
  scans: AmputationScans
): QuoteCopyScan | undefined {
  if (!quoteCarriesContent(requirement.quote)) {
    return;
  }
  const key = amputationScanKey(requirement);
  if (scans.found.has(key)) {
    return scans.found.get(key);
  }
  if (scans.remaining <= 0) {
    return;
  }
  scans.remaining -= 1;
  const verdict = scanQuoteCopy(requirement, context);
  scans.found.set(key, verdict);
  return verdict;
}
/**
 * Le balayage lui-même : la ligne dont la copie est une amputation, puis — sur
 * cette ligne, ou sur la plus proche quand aucune amputation ne se vérifie —
 * l'endroit où la copie s'en écarte. Une amputation dont la revendication est
 * contredite par l'alignement des mots est écartée au profit de la divergence :
 * une copie qui atteint la fin de la ligne ne peut pas avoir sa fin manquante,
 * elle a un texte altéré (voir `amputationConfirmed`).
 */
function scanQuoteCopy(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext
): QuoteCopyScan | undefined {
  if (stitchedQuoteFragments(requirement, context).length > 0) {
    return;
  }
  const lines = fileContentLines(requirement, context);
  const copy = requirement.quote;
  const copyWords = lineWords(copy);
  const match = scanAmputation(lines, amputationProbe(copy));
  const words = match ? lineWords(match.line.text) : [];
  const run = match ? longestWordRun(copyWords, words) : undefined;
  const confirmed =
    match && amputationConfirmed(match.quote, run, words) ? match : undefined;
  const divergence = confirmed
    ? lineDivergence(copy, copyWords, confirmed.line.text, confirmed.line.line)
    : scanDivergence(lines, copy, copyWords);
  return confirmed || divergence
    ? { amputation: confirmed?.quote, divergence }
    : undefined;
}
/** La ligne réelle dont la copie est une amputation, avec son verdict. */
interface AmputationMatch {
  line: PostChangeLine;
  quote: AmputatedQuote;
}
/** Le balayage d'amputation, payé une fois par citation examinée. */
function scanAmputation(
  lines: PostChangeLine[],
  probe: AmputationProbe
): AmputationMatch | undefined {
  let best: AmputationMatch | undefined;
  let longest = 0;
  for (const item of lines) {
    const amputation = lineAmputation(item.text, probe);
    if (!amputation) {
      continue;
    }
    const score = normalizeQuoteText(amputation.fragment).length;
    if (best && longest >= score) {
      continue;
    }
    const candidate = quoteableFragment(item.text, amputation.fragment);
    if (candidate === "") {
      continue;
    }
    best = {
      line: item,
      quote: {
        candidate,
        kind: amputation.kind,
        line: item.line,
        wholeLine:
          normalizeQuoteText(candidate) === normalizeQuoteText(item.text),
      },
    };
    longest = score;
  }
  return best;
}
/**
 * Remède d'une copie amputée : la ligne réelle dont elle est recopiée, la partie
 * que la copie a laissée de côté, puis la réparation — le numéro à DÉSIGNER
 * quand le matériel de résolution porte la ligne (voir `designatedLineRemedy`),
 * la portion exacte à citer sinon.
 * Quand la copie est en plus ALTÉRÉE à l'intérieur de cette ligne, le refus
 * nomme aussi la divergence avant la partie perdue : c'est elle qui a fait
 * refuser la copie, et sans elle le planificateur recopie la même altération. La
 * lecture du défaut est alors écartée — une copie qui n'est pas le début fidèle
 * de la ligne ne peut pas être « seulement le début » de cette ligne. Vide quand
 * aucune ligne ne s'y vérifie, ou quand le budget de la validation ne permet
 * plus d'examiner cette citation, pour que l'appelant retombe sur le remède
 * d'aujourd'hui.
 */
export function amputatedQuoteRemedy(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext,
  scans: AmputationScans = amputationScans()
): string {
  const scan = quoteCopyScan(requirement, context, scans);
  const amputated = scan?.amputation;
  if (!amputated) {
    return "";
  }
  const divergence = scan?.divergence;
  const fault = divergence
    ? `${divergenceFault(divergence)}, and ${AMPUTATION_FAULT[amputated.kind]}`
    : `${AMPUTATION_FAULT[amputated.kind]}, ${AMPUTATION_READING[amputated.kind]}`;
  return `Your quote is copied from line ${amputated.line} of ${requirement.sourceFile} but ${fault}; ${quoteRepair(amputated.line, amputated.candidate, amputated.wholeLine, designatedLineRemedy(requirement.sourceFile, amputated.line, context))}`;
}
/** Le sens d'une divergence : des caractères inventés, ou seuls les blancs qui diffèrent. */
export type QuoteDivergenceKind = "invented" | "whitespace";
/**
 * Une divergence de la copie avec la ligne : les deux textes que le refus
 * compare — ce que la ligne écrit là, recopié d'elle, et ce que la copie porte à
 * la place, recopié d'elle — et son sens, lu sur ces deux textes : `whitespace`
 * quand ils ne diffèrent que par leurs blancs, `invented` sinon.
 */
interface DivergenceFault {
  copy: string;
  kind: QuoteDivergenceKind;
  real: string;
}
/**
 * Où une copie refusée s'écarte de la ligne réelle qu'elle recopie : la ligne, la
 * portion exacte qu'elle reproduit encore — le fragment réel le plus proche — et
 * TOUTES les divergences qu'elle porte avec cette ligne, lues dans l'ordre de la
 * copie. `kind` est le sens de l'ensemble : `whitespace` seulement quand aucune
 * des divergences n'invente de caractère. `candidate` est la portion exacte de la
 * ligne à citer à la place : la ligne entière quand elle tient dans la borne de
 * `quote`, sinon la plus longue fenêtre de jetons ENTIERS qui porte `closest`.
 * Jamais de texte inventé, jamais de jeton rogné.
 */
export interface QuoteDivergence {
  candidate: string;
  closest: string;
  faults: DivergenceFault[];
  kind: QuoteDivergenceKind;
  line: number;
  /** Faux quand la ligne dépasse la borne de suggestion : le candidat est une fenêtre. */
  wholeLine: boolean;
}
/** Un mot d'une ligne ou d'une copie : une suite de lettres, chiffres et soulignés. */
interface LineWord extends LineToken {
  text: string;
}
function lineWords(value: string): LineWord[] {
  return [...value.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => ({
    end: (match.index ?? 0) + match[0].length,
    start: match.index ?? 0,
    text: match[0],
  }));
}
/** Deux textes qui ne diffèrent que par leurs blancs : une copie reformatée. */
function sameWithoutWhitespace(left: string, right: string): boolean {
  return left.replace(/\s+/gu, "") === right.replace(/\s+/gu, "");
}
/** Une suite de mots communs : son premier mot dans la copie et dans la ligne, et sa longueur. */
interface WordRun {
  copy: number;
  length: number;
  line: number;
}
/** Longueur de la suite de mots égaux qui commence à ces deux positions. */
function wordRunLength(
  copy: LineWord[],
  line: LineWord[],
  copyIndex: number,
  lineIndex: number
): number {
  let length = 0;
  while (
    copyIndex + length < copy.length &&
    lineIndex + length < line.length &&
    (copy[copyIndex + length] as LineWord).text ===
      (line[lineIndex + length] as LineWord).text
  ) {
    length += 1;
  }
  return length;
}
/** La meilleure suite : la plus longue, à longueur égale celle qui commence le plus tôt. */
function bestWordRun(best: WordRun | undefined, candidate: WordRun): WordRun {
  if (
    best &&
    (candidate.length < best.length ||
      (candidate.length === best.length && candidate.copy > best.copy))
  ) {
    return best;
  }
  return candidate;
}
/**
 * Plus longue suite de mots que la copie et la ligne portent dans le même ordre,
 * sans autre condition : la base des deux lectures de `scanQuoteCopy` — la
 * divergence, qui exige en plus qu'elle touche un bord de la copie, et la
 * vérification d'une amputation, qui lit si elle atteint les bords de la ligne.
 * Les mots sont comparés comme `quoteTokenSet` les découpe, donc une suite
 * commune survit aux blancs, aux guillemets et aux opérateurs qui les séparent :
 * c'est exactement ce qu'une recopie ratée change. Un départ d'extension qui ne
 * peut plus battre la meilleure suite est écarté, donc le balayage reste borné.
 */
function longestWordRun(
  copy: LineWord[],
  line: LineWord[]
): WordRun | undefined {
  const at = new Map<string, number[]>();
  for (const [index, word] of line.entries()) {
    const found = at.get(word.text);
    if (found) {
      found.push(index);
    } else {
      at.set(word.text, [index]);
    }
  }
  let best: WordRun | undefined;
  for (const [copyIndex, word] of copy.entries()) {
    if (best && copy.length - copyIndex <= best.length) {
      break;
    }
    for (const lineIndex of at.get(word.text) ?? []) {
      if (best && line.length - lineIndex <= best.length) {
        continue;
      }
      const length = wordRunLength(copy, line, copyIndex, lineIndex);
      if (length > 0) {
        best = bestWordRun(best, { copy: copyIndex, length, line: lineIndex });
      }
    }
  }
  return best;
}
/**
 * Vrai quand l'amputation annoncée par le balayage est confirmée par les mots :
 * une fin « manquante » que la copie atteint pourtant, ou un début « manquant »
 * que la copie reprend pourtant, est une copie ALTÉRÉE et non une copie
 * tronquée — le diagnostic de divergence le dit alors à sa place, sinon le refus
 * nomme une cause fausse. Sans suite commune pour trancher, la revendication est
 * gardée : elle vient d'un bord EXACT de la ligne.
 */
function amputationConfirmed(
  amputation: AmputatedQuote,
  run: WordRun | undefined,
  words: LineWord[]
): boolean {
  if (!run) {
    return true;
  }
  if (amputation.kind === "end") {
    return run.line + run.length < words.length;
  }
  return amputation.kind === "start" ? run.line > 0 : true;
}
/**
 * TOUTES les divergences de la copie d'avec la ligne, lues dans l'ordre de la
 * copie : le texte d'avant la suite commune, puis chacun des écarts entre deux de
 * ses mots, puis le texte d'après. Chaque bord est comparé à celui de la ligne —
 * un début qui n'est pas la fin du début de la ligne, des blancs différents, une
 * fin qui n'est pas le début de la fin de la ligne — et chaque fenêtre rendue est
 * recopiée des deux textes : jamais de texte inventé. S'arrêter à la première
 * fenêtre faisait mentir le refus : une copie qui changeait à la fois un blanc et
 * un signe était annoncée comme ne différant que par ses blancs, la divergence
 * suivante n'étant jamais lue (P2 de la revue de la PR #52). Les deux ouvertures
 * sont donc comparées même quand la suite commune commence au premier mot des
 * deux côtés : la ponctuation d'avant ce mot — `(` pour `[` — n'était jamais lue
 * autrement, et le refus ne parlait que des blancs d'une copie qui changeait
 * aussi son délimiteur (P2 de la même revue). Vide quand aucun bord ne diffère.
 */
function divergenceWindows(
  copy: string,
  copyWords: LineWord[],
  text: string,
  words: LineWord[],
  run: WordRun
): DivergenceFault[] {
  const { copy: ci, length, line: li } = run;
  const faults: DivergenceFault[] = [];
  const add = (copyText: string, realText: string): void => {
    faults.push({
      copy: copyText,
      kind: sameWithoutWhitespace(copyText, realText)
        ? "whitespace"
        : "invented",
      real: realText,
    });
  };
  // La tête de la copie face à celle de la ligne, quand la suite commune ne
  // commence pas après un préfixe aligné mot pour mot : l'ouverture de la copie
  // (`(`, `let`) ne se comparait nulle part autrement, et le refus ne parlait
  // alors que des blancs de la suite commune (P2 de la revue de la PR #52, deux
  // derniers tours).
  const addHead = (): void => {
    const copyHead = copy.slice(0, (copyWords[ci] as LineWord).start);
    const realHead = text.slice(0, (words[li] as LineWord).start);
    if (!realHead.endsWith(copyHead)) {
      add(copyHead, realHead);
    }
  };
  if (ci === 0) {
    addHead();
  } else if (ci === li) {
    for (let index = 0; index < ci; index += 1) {
      const copyWord = copyWords[index] as LineWord;
      const realWord = words[index] as LineWord;
      if (copyWord.text === realWord.text) {
        continue;
      }
      const before = Math.max(0, index - 1);
      add(
        copy.slice((copyWords[before] as LineWord).start, copyWord.end),
        text.slice((words[before] as LineWord).start, realWord.end)
      );
    }
  } else if (li === 0) {
    add(
      copy.slice(
        (copyWords[0] as LineWord).start,
        (copyWords[ci] as LineWord).end
      ),
      text.slice(0, (words[0] as LineWord).end)
    );
  } else {
    addHead();
  }
  for (let offset = 0; offset + 1 < length; offset += 1) {
    const left = copyWords[ci + offset] as LineWord;
    const right = copyWords[ci + offset + 1] as LineWord;
    const realLeft = words[li + offset] as LineWord;
    const realRight = words[li + offset + 1] as LineWord;
    if (
      copy.slice(left.end, right.start) ===
      text.slice(realLeft.end, realRight.start)
    ) {
      continue;
    }
    add(
      copy.slice(left.start, right.end),
      text.slice(realLeft.start, realRight.end)
    );
  }
  const copyTail = copy.slice((copyWords[ci + length - 1] as LineWord).end);
  const realTail = text.slice((words[li + length - 1] as LineWord).end);
  if (!realTail.startsWith(copyTail)) {
    add(copyTail, realTail);
  }
  return faults;
}
/**
 * La divergence de la copie d'avec une ligne réelle : la suite de mots la plus
 * longue qui les rapproche — assez longue, et touchant un bord de la copie, pour
 * qu'elle désigne une copie de CETTE ligne plutôt qu'une recousure, qui a son
 * propre diagnostic (voir `stitchedQuoteFragments`) — puis TOUTES les fenêtres où
 * les deux textes diffèrent. `undefined` quand la copie existe mot pour mot dans
 * la ligne, quand aucun mot commun ne désigne la ligne, ou quand aucune fenêtre
 * n'en sort un candidat citable : l'absence de diagnostic vaut mieux qu'une ligne
 * nommée au hasard, et le refus garde alors son conseil générique, qui reste
 * exact.
 */
function lineDivergence(
  copy: string,
  copyWords: LineWord[],
  text: string,
  line: number
): QuoteDivergence | undefined {
  if (quoteAppears(text, copy)) {
    return;
  }
  const words = lineWords(text);
  const run = longestWordRun(copyWords, words);
  if (
    !run ||
    run.length < SUGGESTED_QUOTE_MIN_SHARED_TOKENS ||
    (run.copy > 0 && run.copy + run.length < copyWords.length)
  ) {
    return;
  }
  const faults = divergenceWindows(copy, copyWords, text, words, run);
  const [first] = faults;
  if (!first) {
    return;
  }
  const closest = text.slice(
    (words[run.line] as LineWord).start,
    (words[run.line + run.length - 1] as LineWord).end
  );
  // La copie doit être surtout CETTE ligne : quand la majeure partie de la copie
  // est du texte que la ligne ne porte pas, elle est une fabrication ou une
  // recousure, et le recouvrement de jetons la propose déjà comme ligne à citer
  // (voir `suggestedQuoteLines`). Le seuil est celui de ce recouvrement, appliqué
  // aux caractères : la part de la copie que la ligne porte réellement.
  if (
    closest.length <
    normalizeQuoteText(copy).length * SUGGESTED_QUOTE_MIN_OVERLAP
  ) {
    return;
  }
  const candidate =
    quoteableFragment(text, first.real) || quoteableFragment(text, closest);
  if (candidate === "") {
    return;
  }
  return {
    candidate,
    closest,
    faults,
    kind: faults.some((fault) => fault.kind === "invented")
      ? "invented"
      : "whitespace",
    line,
    wholeLine: normalizeQuoteText(candidate) === normalizeQuoteText(text),
  };
}
/**
 * La ligne réelle dont la copie s'écarte le plus : la portion qu'elle reproduit
 * encore est la plus longue, à égalité la première du fichier. `undefined` quand
 * aucune ligne ne franchit les conditions de `lineDivergence`.
 */
function scanDivergence(
  lines: PostChangeLine[],
  copy: string,
  copyWords: LineWord[]
): QuoteDivergence | undefined {
  let best: QuoteDivergence | undefined;
  let longest = 0;
  for (const { line, text } of lines) {
    const divergence = lineDivergence(copy, copyWords, text, line);
    if (!divergence) {
      continue;
    }
    const score = normalizeQuoteText(divergence.closest).length;
    if (best && longest >= score) {
      continue;
    }
    best = divergence;
    longest = score;
  }
  return best;
}
/** Une divergence dite comme elle se compare : ce que la ligne écrit, puis la copie. */
function faultClause(fault: DivergenceFault): string {
  return `the file writes ${JSON.stringify(fault.real)} where your copy has ${JSON.stringify(fault.copy)}`;
}
/** Les divergences dites à la suite, dans l'ordre de la copie. */
function faultClauses(faults: DivergenceFault[]): string {
  const clauses = faults.map(faultClause);
  const last = clauses.at(-1) ?? "";
  const head = clauses.slice(0, -1).join(", ");
  return head === "" ? last : `${head}, and ${last}`;
}
/**
 * Ce que le refus dit des divergences d'une copie avec la ligne qu'elle recopie :
 * leur sens, lu sur TOUTES les fenêtres — des blancs seulement quand aucune
 * n'invente de caractère — puis chacune d'elles, recopiée de la ligne et de la
 * copie. Le sens lu sur la première fenêtre seule annonçait « only in whitespace »
 * d'une copie qui changeait aussi un signe plus loin, et le planificateur ne
 * réparait que les blancs (P2 de la revue de la PR #52) : chaque divergence de la
 * copie est donc nommée, et le sens porte sur l'ensemble.
 */
function divergenceFault(divergence: QuoteDivergence): string {
  const whitespace = divergence.faults.some(
    (fault) => fault.kind === "whitespace"
  );
  let reading = "only in whitespace";
  if (divergence.kind === "invented") {
    reading = whitespace ? "in whitespace and in characters" : "in characters";
  }
  return `it differs from that line ${reading}: ${faultClauses(divergence.faults)}`;
}
/**
 * Remède d'une copie qui s'écarte d'une ligne réelle sans en être une amputation
 * de bord : la ligne, la première différence avec elle — ce que le fichier écrit
 * là où la copie a autre chose — puis la réparation : le numéro à DÉSIGNER quand
 * le matériel de résolution porte la ligne (voir `designatedLineRemedy`), la
 * portion exacte à citer sinon. C'est
 * le défaut que le remède générique ne nommait pas : une copie retapée caractère
 * par caractère, dont les blancs ou une expression diffèrent, est refusée à juste
 * titre, mais son remède doit dire CE QUI DIFFÈRE, sinon le planificateur
 * reconstruit la même copie. Vide quand aucune ligne ne se vérifie, ou quand le
 * budget de la validation ne permet plus d'examiner cette citation.
 */
function divergentQuoteRemedy(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext,
  scans: AmputationScans = amputationScans()
): string {
  const divergence = quoteDivergence(requirement, context, scans);
  if (!divergence) {
    return "";
  }
  return `Your quote is copied from line ${divergence.line} of ${requirement.sourceFile} but ${divergenceFault(divergence)}; ${quoteRepair(divergence.line, divergence.candidate, divergence.wholeLine, designatedLineRemedy(requirement.sourceFile, divergence.line, context))}`;
}
/**
 * Remède unique d'une exigence dont la citation n'a aucun témoin : quand la
 * citation existe mot pour mot — à l'espacement près — dans l'évidence d'un
 * autre fichier du contexte, le remède est la réattribution à ce fichier.
 * Proposer une autre ligne du fichier cité dans ce cas enverrait le
 * planificateur vers une preuve fausse : sa tentative de correction serait
 * consommée, et le fichier qui porte réellement le texte resterait non couvert.
 * Sinon le remède est le diagnostic de recousure quand il se vérifie (voir
 * `stitchedQuoteRemedy`), la ligne réelle dont la copie est amputée quand elle
 * se vérifie (voir `amputatedQuoteRemedy`, qui nomme aussi la divergence avec
 * cette ligne), la divergence seule quand la copie n'est l'amputation d'aucune
 * ligne (voir `divergentQuoteRemedy`), puis une ligne réelle du fichier cité
 * (voir `quoteSuggestion`). La recousure, l'amputation et la divergence passent
 * avant la similitude de jetons parce qu'elles nomment le défaut mesuré de la
 * copie, là où le recouvrement ne propose qu'une ligne plausible : c'est le cas
 * du lot G, où le recouvrement ne proposait rien, du lot J, où il proposait la
 * bonne ligne sans dire ce qui manquait, et du lot K, où la copie retapée était
 * refusée sans que le refus nomme ce qu'elle avait changé. Vide quand aucun des
 * cinq ne s'applique — ou quand le budget de la validation ne permet plus de
 * balayer le fichier cité — pour que l'appelant retombe sur le conseil générique
 * plutôt que sur un remède vide.
 * Les trois diagnostics détaillés balaient le fichier cité pour la même
 * citation, donc le budget les écarte tous les trois : c'est ce silence, partagé
 * par les deux moitiés du gate, qui borne le travail d'amputation.
 */
export function absentRequirementRemedy(
  requirement: Pick<Requirement, "quote" | "sourceFile">,
  context: PrContext,
  scans: AmputationScans = amputationScans()
): string {
  const found = witnessFiles(requirement.quote, context);
  if (found.length > 0) {
    return witnessHint(found, context).trim();
  }
  if (!amputationScanAllowed(scans, requirement)) {
    return "";
  }
  return (
    stitchedQuoteRemedy(requirement, context).trim() ||
    amputatedQuoteRemedy(requirement, context, scans).trim() ||
    divergentQuoteRemedy(requirement, context, scans).trim() ||
    quoteSuggestion(requirement, context).trim()
  );
}

/**
 * Exigences citées sans témoin textuel, même à l'espacement près, avec le
 * scénario qui les porte et le rang de l'exigence dans ce scénario : la classe
 * fatale `REQUIREMENT_UNGROUNDED` en est rendue une par entrée, et le canal de
 * correction peut aussi l'agréger en une seule ligne. Le rang est celui du plan
 * — une exigence nommée « requirement 2 » désigne la deuxième liste du scénario.
 */
export function ungroundedRequirements(
  plan: Plan,
  context: PrContext
): { rank: number; requirement: Requirement; scenarioId: string }[] {
  return plan.scenarios.flatMap((scenario) =>
    scenario.requirements.flatMap((requirement, index) =>
      requirementHasWitness(requirement, context)
        ? []
        : [{ rank: index + 1, requirement, scenarioId: scenario.id }]
    )
  );
}

/**
 * Forme courte de la citation fautive, qui fait partie de l'identité d'un refus
 * par exigence (voir `ungroundedRequirement`) : un refus qui ne nomme que le
 * scénario et le fichier laisse le planificateur deviner laquelle de ses
 * exigences est fausse. La ligne reste bornée — le préambule fatal et la
 * troncature de `model.ts` se partagent un budget de correction. L'extrait est
 * aussi le détail placé en tête de la ligne fatale, pour qu'une ligne rognée le
 * garde.
 */
const QUOTE_EXCERPT_CHARS = 120;
export function quoteExcerpt(quote: string): string {
  const compact = normalizeQuoteText(quote);
  return compact.length <= QUOTE_EXCERPT_CHARS
    ? compact
    : `${compact.slice(0, QUOTE_EXCERPT_CHARS - 1)}…`;
}

/**
 * Exigences sans témoin textuel, sous forme de refus rendus au planificateur.
 * Le planificateur dispose d'une tentative de correction (voir `runner.ts`),
 * comme pour `writeEvidenceRefusals` ; `validateCoverage` reste le contrôle
 * final et refuse le plan si la correction n'a pas suffi. Une citation recousue
 * reçoit le diagnostic de ses deux fragments AVANT le conseil générique : c'est
 * ce défaut précis qui a fait refuser sa citation, et c'est celui qu'il doit
 * corriger en premier. Un diagnostic de défaut précis remplace la suggestion de
 * lignes, jamais ne s'y ajoute : une seule suggestion par citation. Le budget de
 * la validation (`AmputationScans`) lui est remis par le point d'entrée du gate
 * et vaut pour toutes les exigences du plan comme pour la moitié fatale qui le
 * précède : passé le plafond, le remède détaillé se tait et les refus suivants
 * gardent le conseil générique de leur exigence, qui reste exact.
 */
export function ungroundedPlanRefusals(
  plan: Plan,
  context: PrContext,
  policy: Policy,
  scans: AmputationScans = amputationScans()
): string[] {
  return ungroundedRequirements(plan, context).map(
    ({ rank, requirement, scenarioId }) => {
      const error = ungroundedRequirement(
        scenarioId,
        requirement,
        context,
        policy,
        rank,
        scans
      );
      // La citation existe ailleurs : le remède est l'attribution à l'autre
      // fichier, déjà porté par le conseil de l'exigence, et proposer aussi une
      // ligne de ce fichier-ci serait du bruit.
      const found = witnessFiles(requirement.quote, context);
      // Le budget épuisé écarte aussi les deux autres remèdes détaillés : ils
      // balaient le fichier cité pour la même citation, et le refus générique
      // suffit à la nommer sans travailler plus loin.
      const detailed =
        found.length === 0 && amputationScanAllowed(scans, requirement);
      // La copie amputée est déjà nommée par le conseil de l'exigence (voir
      // `witnessLocation`), comme la divergence d'une copie qui n'est
      // l'amputation d'aucune ligne : la suggestion de ligne les répéterait mot
      // pour mot, et elle ne doit jamais masquer ce qui diffère réellement.
      const amputated = detailed
        ? amputatedQuoteRemedy(requirement, context, scans).trim()
        : "";
      const divergent =
        detailed && amputated === ""
          ? divergentQuoteRemedy(requirement, context, scans).trim()
          : "";
      const stitched =
        detailed && amputated === "" && divergent === ""
          ? stitchedQuoteRemedy(requirement, context).trim()
          : "";
      const suggestion =
        detailed && amputated === "" && divergent === "" && stitched === ""
          ? quoteSuggestion(requirement, context)
          : "";
      // Le conseil du témoin trop pauvre porte déjà sa ligne réelle (voir
      // `weakWitnessSuggestion`) : la similitude de jetons la répéterait mot
      // pour mot. Quand ce diagnostic ne trouve aucune ligne — la citation
      // n'existe alors que sur plusieurs lignes recousues — l'ancienne
      // suggestion reste le seul secours, donc elle est gardée.
      const weak = hasWeakWitness(requirement, context);
      const lead = weak && weakWitnessLines(requirement, context).length > 0;
      const remedy = stitched
        ? `${stitched} ${error.hint}`
        : `${error.hint}${lead ? "" : suggestion}`;
      return `${error.message}. ${remedy}`;
    }
  );
}

/**
 * Marque comme couverts les fichiers témoignés par les exigences d'un scénario,
 * et seulement ceux-là : une exigence dont la citation n'existe pas mot pour
 * mot, à l'espacement près, n'ajoute rien, comme `validateCoverage` l'aurait
 * refusée juste avant. Le couvert est cumulatif sur tout le plan, dans l'ordre
 * des scénarios.
 * `unwitnessedPlanRefusals` et `validateCoverage` partagent ce pas pour que le
 * refus rendu au planificateur nomme exactement le fichier que le gate
 * refuserait ensuite, et jamais un fichier que le gate accepterait.
 */
function coverWitnessedSourceFiles(
  covered: Set<string>,
  scenario: Scenario,
  context: PrContext
): void {
  for (const requirement of scenario.requirements) {
    if (requirementHasWitness(requirement, context)) {
      covered.add(requirement.sourceFile);
    }
  }
}

/**
 * Un fichier déclaré par un scénario qu'aucune exigence témoignée ne couvre :
 * sans témoin, le plan ne peut pas prouver la couverture qu'il annonce. Le
 * remède de repli — retirer le fichier des sources — n'est proposé que si le
 * gate accepterait le remède qui le complète : un fichier que la PR ne change
 * pas ne se liste jamais dans `skipped` (`PLAN_SKIP_OUTSIDE_DIFF`), et un chemin
 * critique du diff demande un skip approuvé (`CRITICAL_COVERAGE_MISSING`).
 * Proposer un skip que le gate refuse ferait tourner la tentative de correction
 * du planificateur pour rien.
 *
 * `weak` distingue le cas où une exigence cite déjà le fichier mais avec une
 * citation trop pauvre : le remède n'est plus d'ajouter une citation, déjà
 * présente, mais de la rendre substantielle — sinon le planificateur renvoie
 * la même citation exacte et le fichier reste sans témoin.
 */
function unwitnessedRequirement(
  scenarioId: string,
  file: string,
  policy: Policy,
  inDiff: boolean,
  weak = false
): QaError {
  let hint: string;
  if (!inDiff) {
    hint = `This PR does not change ${file}, so it cannot be listed in skipped: drop it from sourceFiles and quote a changed file instead.`;
  } else if (weak) {
    hint = `A requirement already cites ${file}, but its exact quote carries no visible code content to witness this file: quote a substantial fragment of ${file}${criticalSkipRefused(policy, file) ? ", or get the file's skip approved in .canary/qa.json on the trusted base branch" : ""}.`;
  } else if (criticalSkipRefused(policy, file)) {
    hint = `Add a requirement whose quote exists verbatim in ${file}; this critical file cannot be dropped from sourceFiles without an approved skip in .canary/qa.json on the trusted base branch.`;
  } else {
    hint = `Add a requirement whose quote exists verbatim in ${file}, or drop it from sourceFiles and list it in skipped.`;
  }
  return new QaError(
    "COVERAGE_WITNESS_MISSING",
    `Scenario ${scenarioId} declares ${file} without a source requirement witness`,
    hint
  );
}

/**
 * Vrai si le scénario déclare `file` sans le témoigner alors qu'une de ses
 * exigences vise ce fichier et y porte une citation exacte, trop pauvre pour
 * témoigner : le fichier reste sans témoin, mais le remède porte sur la
 * substance de la citation, pas sur son existence.
 */
function weakWitnessForFile(
  scenario: Scenario,
  file: string,
  context: PrContext
): boolean {
  return scenario.requirements.some(
    (requirement) =>
      requirement.sourceFile === file && hasWeakWitness(requirement, context)
  );
}

/**
 * Paires (scénario, fichier) des sources déclarées sans témoin, dans l'ordre du
 * plan : le couvert est cumulatif, exactement comme `validateCoverage`. `weak`
 * marque les fichiers qu'une exigence cite déjà avec une citation trop pauvre.
 */
export function unwitnessedSources(
  plan: Plan,
  context: PrContext
): { file: string; scenarioId: string; weak: boolean }[] {
  const covered = new Set<string>();
  const entries: { file: string; scenarioId: string; weak: boolean }[] = [];
  for (const scenario of plan.scenarios) {
    coverWitnessedSourceFiles(covered, scenario, context);
    for (const file of scenario.sourceFiles) {
      if (!covered.has(file)) {
        entries.push({
          file,
          scenarioId: scenario.id,
          weak: weakWitnessForFile(scenario, file, context),
        });
      }
    }
  }
  return entries;
}

/**
 * Clé d'une paire (scénario, fichier) de source déclarée. Le séparateur est un
 * saut de ligne : un chemin de fichier ni un identifiant de scénario n'en
 * portent, donc deux paires distinctes ne peuvent pas produire la même clé — ce
 * qu'un `:` ne garantit pas pour un scénario dont l'identifiant en contient un.
 */
export function witnessPairKey(scenarioId: string, file: string): string {
  return `${scenarioId}\n${file}`;
}

/**
 * Fichiers cités sans témoin, sous forme de refus rendus au planificateur : il
 * apprend la règle ici, dispose d'une tentative de correction, et
 * `validateCoverage` reste le contrôle final qui refuse un plan non corrigé.
 *
 * `resolved` écarte les paires qu'une correction en cours répare déjà : la
 * correction contrainte écrit dans le plan une ligne réelle qui témoigne du
 * fichier, donc le refus de couverture dérivé de la même citation faible tombe
 * avec elle (voir `quotePickCorrection`, runner.ts).
 */
export function unwitnessedPlanRefusals(
  plan: Plan,
  context: PrContext,
  policy: Policy,
  resolved: ReadonlySet<string> = new Set()
): string[] {
  // L'ordre des marqueurs passe avant l'absence de témoin : une assertion sur
  // une valeur que la vue n'atteint pas est un défaut de forme, et les autres
  // refus n'ont pas d'intérêt tant qu'il tient.
  const order = markerOrderFinding(plan, sourceLineMaterial(context)).refusals;
  const changed = new Set(context.files.map((file) => file.filename));
  const unwitnessed = unwitnessedSources(plan, context)
    .filter(
      ({ file, scenarioId }) => !resolved.has(witnessPairKey(scenarioId, file))
    )
    .map(({ file, scenarioId, weak }) => {
      const error = unwitnessedRequirement(
        scenarioId,
        file,
        policy,
        changed.has(file),
        weak
      );
      return `${error.message}. ${error.hint}`;
    });
  return [...order, ...((unwitnessed as string[]) ?? [])];
}

/**
 * Une exigence attribuée à un fichier que le scénario ne déclare pas : la
 * preuve citée n'appartient pas au scénario, donc elle ne couvre rien. Le refus
 * nomme le scénario et le fichier fautif, et ne propose de déclarer ce fichier
 * que si la PR le change : hors du diff, la validation de forme refuserait la
 * déclaration et la tentative de correction serait consommée pour rien.
 */
function undeclaredRequirementSource(
  scenarioId: string,
  file: string,
  declared: string[],
  inDiff: boolean
): QaError {
  const candidates = declared.length
    ? `one of the files the scenario declares (${declared.join(", ")})`
    : "a file the scenario declares";
  return new QaError(
    "COVERAGE_REQUIREMENT_SOURCE_MISSING",
    `Scenario ${scenarioId} attributes a requirement to ${file}, which it does not declare in sourceFiles`,
    inDiff
      ? `Declare ${file} in this scenario's sourceFiles, or attribute the requirement to ${candidates}.`
      : `This PR does not change ${file}, so it cannot be declared: attribute the requirement to ${candidates}.`
  );
}

/** Fichiers cités par les exigences d'un scénario qu'il ne déclare pas. */
function undeclaredFiles(scenario: Scenario): string[] {
  return scenario.requirements
    .map((requirement) => requirement.sourceFile)
    .filter((file) => !scenario.sourceFiles.includes(file));
}

/**
 * Paires (scénario, fichier) des exigences attribuées hors des sources
 * déclarées, dans l'ordre du plan.
 */
export function undeclaredSources(
  plan: Plan
): { file: string; scenarioId: string }[] {
  return plan.scenarios.flatMap((scenario) =>
    undeclaredFiles(scenario).map((file) => ({ file, scenarioId: scenario.id }))
  );
}

/**
 * Exigences attribuées à un fichier hors de `sourceFiles`, sous forme de refus
 * rendus au planificateur. Fatal comme `COVERAGE_WITNESS_MISSING` : il bloque
 * tout le run via `validateCoverage`, donc il passe avant les refus par
 * scénario, qui restent rapportés et bloqués individuellement.
 */
export function undeclaredSourcePlanRefusals(
  plan: Plan,
  context: PrContext
): string[] {
  const changed = new Set(context.files.map((file) => file.filename));
  const declared = new Map(
    plan.scenarios.map((scenario) => [scenario.id, scenario.sourceFiles])
  );
  return undeclaredSources(plan).map(({ file, scenarioId }) => {
    const error = undeclaredRequirementSource(
      scenarioId,
      file,
      declared.get(scenarioId) ?? [],
      changed.has(file)
    );
    return `${error.message}. ${error.hint}`;
  });
}

/**
 * Premier refus d'attribution d'exigence, sans aucune dépendance à l'évidence.
 * Le contrôle final (`validateCoverage`) et le règlement du plan le partagent,
 * et il passe avant les refus de forme : un fichier hors diff, qui rend le plan
 * inexécutable, ne doit jamais masquer ce refus nommé et réparable.
 */
export function requirementSourceRefusal(
  plan: Plan,
  context: PrContext
): QaError | undefined {
  const changed = new Set(context.files.map((file) => file.filename));
  for (const scenario of plan.scenarios) {
    const [file] = undeclaredFiles(scenario);
    if (file !== undefined) {
      return undeclaredRequirementSource(
        scenario.id,
        file,
        scenario.sourceFiles,
        changed.has(file)
      );
    }
  }
}

/**
 * Un scénario dont les étapes ne tiennent pas dans le budget d'actions : son
 * contrat ne peut pas être exécuté. Le refus est nommé, remonte au
 * planificateur comme le refus d'attribution, et le contrôle final lève le
 * premier de la liste.
 */
function contractBudgetRefusal(
  scenario: Scenario,
  config: Config
): QaError | undefined {
  return scenario.steps.length + 1 > config.QA_MAX_STEPS
    ? new QaError(
        "CONTRACT_BUDGET",
        `Scenario ${scenario.id} cannot complete within QA_MAX_STEPS`,
        "Increase the budget or split the scenario before execution."
      )
    : undefined;
}

/** Budgets de scénario refusés, dans l'ordre du plan. */
export function contractBudgetRefusals(plan: Plan, config: Config): QaError[] {
  return plan.scenarios
    .map((scenario) => contractBudgetRefusal(scenario, config))
    .filter((refusal): refusal is QaError => refusal !== undefined);
}

/**
 * Les refus qui ne concernent QU'UN scénario, rendus séparément pour que le run
 * puisse continuer (`QA_PER_SCENARIO_COVERAGE`).
 */
function scenarioCoverageRefusals(
  plan: Plan,
  context: PrContext,
  policy: Policy,
  config: Config
): { error: QaError; scenarioId: string }[] {
  const changed = new Set(context.files.map((file) => file.filename));
  const found: { error: QaError; scenarioId: string }[] = [];
  for (const scenario of plan.scenarios) {
    const [undeclared] = undeclaredFiles(scenario);
    if (undeclared !== undefined) {
      found.push({
        error: undeclaredRequirementSource(
          scenario.id,
          undeclared,
          scenario.sourceFiles,
          changed.has(undeclared)
        ),
        scenarioId: scenario.id,
      });
      continue;
    }
    const budget = contractBudgetRefusal(scenario, config);
    if (budget) {
      found.push({ error: budget, scenarioId: scenario.id });
      continue;
    }
    const index = scenario.requirements.findIndex(
      (requirement) => !requirementHasWitness(requirement, context)
    );
    const requirement = scenario.requirements[index];
    if (requirement) {
      found.push({
        error: ungroundedRequirement(
          scenario.id,
          requirement,
          context,
          policy,
          index + 1
        ),
        scenarioId: scenario.id,
      });
    }
  }
  return found;
}

export function validateCoverage(
  plan: Plan,
  context: PrContext,
  policy: Policy,
  config: Config
) {
  const covered = new Set<string>();
  const changed = new Set(context.files.map((file) => file.filename));
  validateProvider(policy, config);
  // Politique par défaut : le refus tue le run. Avec le drapeau, ces trois
  // défauts descendent au scénario (voir `scenarioCoverageRefusals`), et le
  // scénario fautif est bloqué par le runner sans être joué.
  const source = config.QA_PER_SCENARIO_COVERAGE
    ? undefined
    : requirementSourceRefusal(plan, context);
  if (source) {
    throw source;
  }
  for (const scenario of plan.scenarios) {
    const budget = config.QA_PER_SCENARIO_COVERAGE
      ? undefined
      : contractBudgetRefusal(scenario, config);
    if (budget) {
      throw budget;
    }
    if (!config.QA_PER_SCENARIO_COVERAGE) {
      for (const [index, requirement] of scenario.requirements.entries()) {
        if (!requirementHasWitness(requirement, context)) {
          throw ungroundedRequirement(
            scenario.id,
            requirement,
            context,
            policy,
            index + 1
          );
        }
      }
    }
    coverWitnessedSourceFiles(covered, scenario, context);
    const unwitnessed = scenario.sourceFiles.find((file) => !covered.has(file));
    if (unwitnessed !== undefined) {
      throw unwitnessedRequirement(
        scenario.id,
        unwitnessed,
        policy,
        changed.has(unwitnessed)
      );
    }
  }
  const denied = plan.skipped.filter((skip) =>
    criticalSkipRefused(policy, skip.sourceFile)
  );
  if (denied.length) {
    throw new QaError(
      "CRITICAL_COVERAGE_MISSING",
      `Critical changes skipped: ${denied.map((f) => f.sourceFile).join(", ")}`,
      "Add scenarios, or approve the exact skip with a reason in .canary/qa.json on the trusted base branch. A PR cannot approve its own skip."
    );
  }
  return {
    covered: [...covered],
    skipped: plan.skipped,
    policyRef: context.baseSha,
    gate: plan.scenarios.length ? "complete" : "no-browser-tests",
  };
}

export function validateProvider(policy: Policy, config: Config) {
  if (
    policy.providerHosts.length &&
    !policy.providerHosts.includes(new URL(config.OPENAI_BASE_URL).host)
  ) {
    throw new Error("Provider denied by trusted repository data policy");
  }
}

/**
 * L'ORDRE des états d'un marqueur, lu dans le diff de l'application.
 *
 * Un marqueur d'état — `[data-x="valeur"]` — ne prend pas ses valeurs au hasard :
 * la vue le calcule par une chaîne de gardes, et la première qui échoue décide.
 * Une assertion qui attend la TROISIÈME valeur sans avoir satisfait les deux
 * premières ne décrit donc pas un comportement : elle décrit un état que
 * l'application n'atteint pas. Mesuré sur le lot AU : cinq runs sur dix, tous
 * avec la même forme — le plan remplit un commentaire et attend la valeur
 * « commentaire-trop-long » alors que la garde du motif, plus haute, renvoie
 * encore « motif-manquant ».
 *
 * Rien ici ne connaît une application : le nom du marqueur, les valeurs, l'ordre
 * des gardes et les contrôles qui les commandent sont tous lus dans le matériel
 * du diff. L'analyse est CONSERVATRICE — dès qu'une pièce manque, elle ne dit
 * rien. Un refus qui ne peut pas nommer la garde et le contrôle à jouer serait
 * une devinette, et une devinette qui bloque un plan coûte plus qu'elle ne
 * rapporte.
 */
export interface MarkerGuard {
  /**
   * Renseigné quand la garde ne vient pas de la fonction qui rend la valeur,
   * mais d'un CONDITIONNEL qui l'appelle : `justificationRequired ? f(...) : null`.
   * La valeur n'existe alors que si cette condition tient, et elle est écrite
   * à un endroit du diff que le raisonnement doit nommer.
   */
  caller?: { fallback: string; source: string };
  /** Le texte de la condition, tel que le diff l'écrit. */
  condition: string;
  /** Les textes traversés pour résoudre les champs : la preuve d'une contradiction. */
  evidence?: string[];
  /** Les champs de l'état que cette garde consulte (`justification.reason`). */
  fields: string[];
  /** La valeur rendue quand cette garde échoue. */
  value: string;
}

export interface MissingInteraction {
  /** L'action que ce contrôle demande : `select`, `fill` ou `check`. */
  action: "fill" | "select" | "check";
  assertionId: string;
  attribute: string;
  /** Le contrôle à jouer avant l'assertion, nom accessible lu dans le diff. */
  control: string;
  expected: string;
  /** Le champ de la condition que ce contrôle commande. */
  field?: string;
  guard: MarkerGuard;
  /** La contradiction de LONGUEUR, quand elle est démontrable. */
  lengthConflict?: { limit: number; measured: number };
}

const MARKER_TARGET = /^\[(data-[a-z0-9-]+)="([^"]+)"\]$/i;
const LITERAL_RETURN = /return\s+"([^"]+)"\s*;/;
const FIELD = /\b([a-z][a-zA-Z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*)\b/g;

/**
 * Les fichiers qu'une piste peut traverser : celui qui porte l'expression, et
 * ceux qu'il importe. Un homonyme d'un fichier sans rapport reste hors de portée
 * — c'est ce qui a fait lire la mauvaise chaîne de gardes — mais une dépendance
 * réelle est suivie, parce qu'une condition écrite dans un module importé décide
 * bien de la valeur affichée.
 */
function reachableSources(
  material: SourceLineMaterial[],
  entryPath: string
): SourceLineMaterial[] {
  const entry = material.find((source) => source.path === entryPath);
  if (!entry) {
    return material;
  }
  const imported = new Set<string>();
  for (const line of entry.lines) {
    for (const match of line.text.matchAll(/from\s+["']([^"']+)["']/g)) {
      // Relatif (`../lib/x`) ou alias de configuration (`@/lib/x`) : on garde le
      // suffixe de chemin, qui identifie le fichier sans coder l'alias du projet.
      const raw = match[1] ?? "";
      for (const specifier of [
        raw,
        raw.replace(/^\.{1,2}\//, ""),
        raw.replace(/^(@[^/]*|~)\//, ""),
      ]) {
        if (specifier) {
          imported.add(specifier);
        }
      }
    }
  }
  const files = material.filter(
    (source) =>
      source.path === entryPath ||
      [...imported].some(
        (specifier) =>
          source.path.endsWith(specifier) ||
          source.path.endsWith(`${specifier}.ts`) ||
          source.path.endsWith(`${specifier}.tsx`) ||
          source.path.endsWith(`${specifier}/index.ts`)
      )
  );
  return files.length > 0 ? files : [entry];
}

/** Les valeurs d'un marqueur que l'assertion vise, quand la cible en nomme une. */
function markerOf(assertion: {
  target?: { by: string; value: string };
}): { attribute: string; value: string } | undefined {
  const css =
    assertion.target?.by === "css" ? assertion.target.value : undefined;
  const match = css ? MARKER_TARGET.exec(css.trim()) : null;
  return match
    ? { attribute: match[1] ?? "", value: match[2] ?? "" }
    : undefined;
}

/** Toutes les lignes du matériel, fichier par fichier, dans l'ordre du diff. */
function everyLine(material: SourceLineMaterial[]) {
  return material.flatMap((file) =>
    file.lines.map((entry) => ({ path: file.path, ...entry }))
  );
}

/**
 * L'expression que la vue écrit dans ce marqueur : `data-cash-state={view.status}`
 * rend `view.status`. Absent du matériel, la règle se tait.
 */
function markerExpression(
  material: SourceLineMaterial[],
  attribute: string
): { expression: string; path: string } | undefined {
  for (const source of material) {
    for (const line of source.lines) {
      const index = line.text.indexOf(`${attribute}={`);
      if (index === -1) {
        continue;
      }
      const rest = line.text.slice(index + attribute.length + 2);
      const match = /^(.+?)\}/.exec(rest);
      if (match?.[1]) {
        return { expression: match[1], path: source.path };
      }
    }
  }
  return;
}

/**
 * Les gardes qui décident des valeurs de ce marqueur, dans l'ordre du code.
 *
 * Deux formes sont lues, et seulement celles-là : la fonction qui rend les
 * littéraux (`if (...) return "x";`) et le ternaire enchaîné
 * (`cond ? "x" : cond2 ? "y" : "z"`). Toute autre forme rend une liste vide :
 * l'analyse préfère ne rien dire plutôt que d'inventer un ordre.
 */

/**
 * La conditionnelle qui décide si la fonction est appelée du tout :
 * `const problem = required ? compute(draft) : null` fait de `required` une garde
 * de premier rang, écrite ailleurs que dans la fonction qui rend la valeur.
 *
 * Sans elle, une assertion sur `compute` passait alors que rien n'établissait
 * `required` — le run 3c51455f remplissait motif et commentaire sans jamais créer
 * l'écart qui rend la justification obligatoire, et le marqueur restait au repli.
 */
function callerGuardOf(
  lines: { line: number; text: string }[],
  name: string
): { condition: string; fallback: string; line: number } | undefined {
  const index = lines.findIndex((line) =>
    new RegExp(`(?:const|let)\\s+${name}\\s*=`).test(line.text)
  );
  const definition = lines[index];
  if (!definition || index < 0) {
    return;
  }
  // Le formateur étale souvent le ternaire : `const x = cond` puis `? f(...)`
  // puis `: null;`. Lire la seule première ligne rendait la condition invisible.
  const statement = statementOf(lines, index);
  const value = statement.slice(statement.indexOf("=") + 1);
  const question = value.indexOf("?");
  const colon = value.lastIndexOf(":");
  if (question === -1 || colon <= question) {
    return;
  }
  // `cond ? null : f(...)` : la valeur existe quand la condition est FAUSSE.
  // La retenir comme prérequis positif inverserait la règle, donc on se tait.
  if (
    !value.slice(question, colon).includes("(") &&
    value.slice(colon + 1).includes("(")
  ) {
    return;
  }
  const condition = value.slice(0, question).trim();
  const fallback = value
    .slice(colon + 1)
    .replace(/[;,)\s]+$/, "")
    .trim();
  return condition ? { condition, fallback, line: definition.line } : undefined;
}

/** Le texte d'une déclaration, recollé jusqu'à son point-virgule. */
function statementOf(lines: { text: string }[], index: number): string {
  const parts: string[] = [];
  for (const line of lines.slice(index, index + 8)) {
    parts.push(line.text.trim());
    if (line.text.includes(";")) {
      break;
    }
  }
  return parts.join(" ");
}

/**
 * Les champs qu'une condition consulte vraiment : un identifiant nu cache sa
 * définition (`varianceCents` → `expectedCents` → `parseAmountFr(session.expected)`),
 * donc on suit la piste quelques sauts et on ne garde que les champs pointés, les
 * seuls qu'un contrôle du diff peut commander. Une piste qui s'arrête laisse la
 * liste telle quelle : la règle se taira plutôt que d'inventer.
 */
function resolveFields(
  lines: { line: number; text: string }[],
  condition: string,
  depth = 8
): { evidence: string[]; fields: string[] } {
  const evidence: string[] = [];
  const fields = new Set(fieldsOf(condition));
  const seen = new Set<string>();
  let frontier = [condition];
  for (let hop = 0; hop < depth; hop += 1) {
    const definitions = bareDefinitions(lines, frontier).filter(
      (definition) => !seen.has(definition)
    );
    if (definitions.length === 0) {
      break;
    }
    frontier = [];
    for (const definition of definitions) {
      seen.add(definition);
      const text = definition.slice(definition.indexOf("=") + 1);
      evidence.push(text);
      for (const field of fieldsOf(text)) {
        fields.add(field);
      }
      frontier.push(text);
    }
  }
  return { evidence, fields: [...fields].slice(0, 12) };
}

/** Les définitions des identifiants nus d'un texte, une par identifiant. */
function bareDefinitions(
  lines: { line: number; text: string }[],
  texts: string[]
): string[] {
  const bare = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(FIELD)) {
      const name = match[1] ?? "";
      if (NOT_A_FIELD.has(name.split(".")[0] ?? "")) {
        continue;
      }
      // Un identifiant nu cache sa définition ; la RACINE d'un champ pointé aussi
      // (`parsedExpected.ok` vient de `const parsedExpected = parseAmountFr(...)`),
      // et c'est elle qui mène au champ réellement commandé par l'écran.
      const candidate = name.includes(".") ? (name.split(".")[0] ?? "") : name;
      if (/^[A-Za-z_$][\w$]*$/.test(candidate)) {
        bare.add(candidate);
      }
    }
  }
  const found: string[] = [];
  for (const name of bare) {
    const index = lines.findIndex((line) =>
      new RegExp(`(?:const|let)\\s+${name}\\s*=`).test(line.text)
    );
    if (index >= 0) {
      // Une déclaration étalée (`const varianceCents =` puis la condition à la
      // ligne suivante) ne livrait rien : la piste s'arrêtait avant le champ.
      found.push(statementOf(lines, index));
    }
  }
  return found;
}

function markerGuards(
  material: SourceLineMaterial[],
  expression: string,
  entryPath: string
): MarkerGuard[] {
  const lines = everyLine(reachableSources(material, entryPath));
  const callers: MarkerGuard[] = [];
  /**
   * La valeur d'un marqueur descend d'un identifiant : `view.problem ?? "none"`
   * nomme `problem`, dont la définition peut elle-même appeler une fonction.
   * On suit donc la piste, trois sauts au plus, et on lit la chaîne de gardes
   * de la première fonction qui rend des littéraux. Un identifiant dont la
   * définition n'est pas dans le matériel arrête la piste : la règle se tait.
   */
  const tail = /[A-Za-z_$][\w$]*/.exec(
    (expression.split(".").at(-1) ?? expression).trim()
  )?.[0];
  if (!tail) {
    return [];
  }
  let name = tail;
  for (let hop = 0; hop < 3; hop += 1) {
    const definition = lines.find((line) =>
      new RegExp(
        `(?:const|let|function)\\s+${name}\\b|<\\w+[^>]*\\s${name}=|${name}\\s*=\\s*\\(`
      ).test(line.text)
    );
    if (!definition) {
      return callers;
    }
    // La conditionnelle qui décide de l'appel est une garde de premier rang :
    // elle est écrite avant la fonction, donc elle passe avant elle.
    const caller = callerGuardOf(lines, name);
    if (caller) {
      const resolved = resolveFields(lines, caller.condition);
      callers.push({
        caller: {
          fallback: caller.fallback,
          source: `${definition.path ?? entryPath}:${caller.line}`,
        },
        condition: caller.condition,
        evidence: resolved.evidence,
        fields: resolved.fields,
        value: "",
      });
    }
    const body = functionBody(lines, definition.line, definition.path);
    const literalReturns = body.filter((line) =>
      LITERAL_RETURN.test(line.text)
    );
    if (literalReturns.length > 0) {
      return [
        ...callers,
        ...literalReturns.slice(0, 8).map((line) => {
          const condition = conditionOf(line.text);
          return {
            condition,
            // Un champ local (`comment.length`) cache le champ réel de l'état
            // (`justification.comment`) : on résout la racine, sinon aucun
            // contrôle du diff ne peut être reconnu.
            fields: resolveFields(lines, condition).fields,
            value: LITERAL_RETURN.exec(line.text)?.[1] ?? "",
          };
        }),
      ];
    }
    // La déclaration peut être étalée : l'appel à suivre est dans le texte
    // recollé, sinon une condition ternaire multi-lignes coupe la piste.
    const statement = statementOf(lines, lines.indexOf(definition));
    const next = /[A-Za-z_$][\w$]*\s*\(/
      .exec(statement.replace(new RegExp(`^.*?${name}`), ""))?.[0]
      ?.replace(/\s*\($/, "");
    if (!next || next === name) {
      return callers;
    }
    name = next;
  }
  return callers;
}

/** Les lignes du corps qui suit une définition, jusqu'à la déclaration suivante. */
function functionBody(
  lines: { line: number; path?: string; text: string }[],
  from: number,
  path?: string
): { line: number; path?: string; text: string }[] {
  // L'identité d'un corps est (fichier, ligne) : deux fichiers ont chacun leur
  // ligne 4, et confondre les deux faisait lire un corps qui n'existe pas.
  const index = lines.findIndex(
    (line) => line.line === from && (path === undefined || line.path === path)
  );
  const body: { line: number; text: string }[] = [];
  for (const line of lines.slice(index, index + 40)) {
    if (
      body.length > 0 &&
      /^\s*(?:function\s|const\s+\w+\s*=\s*\()/.test(line.text)
    ) {
      break;
    }
    body.push(line);
  }
  return body;
}

function conditionOf(line: string): string {
  const trimmed = line.trim();
  const withoutReturn = trimmed.split("return")[0] ?? trimmed;
  return (
    withoutReturn
      .replace(/^if\s*\(/, "")
      // `) { …` ferme la condition quelle que soit la suite de la ligne : un `{`
      // suivi d'un espace laissait la condition sale et la comparaison illisible.
      .replace(/\)\s*\{.*$/, "")
      .replace(/\)\s*$/, "")
      .replace(/^}/, "")
      .trim()
  );
}

const NOT_A_FIELD = new Set([
  "and",
  "else",
  "false",
  "if",
  "length",
  "null",
  "or",
  "return",
  "some",
  "string",
  "then",
  "true",
  "undefined",
]);

function fieldsOf(condition: string): string[] {
  const fields = new Set<string>();
  for (const match of condition.matchAll(FIELD)) {
    const name = match[1] ?? "";
    const root = name.split(".")[0] ?? "";
    if (name.includes(".") && !NOT_A_FIELD.has(root)) {
      fields.add(name);
    }
  }
  return [...fields];
}

/**
 * Le contrôle qui commande ce champ et son libellé accessible : le diff écrit
 * `aria-label="…"` sur l'élément dont la valeur ou le changement touche le
 * champ. C'est la seule association dont nous disposons, et elle vient de la
 * source, jamais d'une convention de nommage.
 */
function controlFor(
  material: SourceLineMaterial[],
  field: string
): { action: "fill" | "select" | "check"; label: string } | undefined {
  for (const line of everyLine(material)) {
    if (!(line.text.includes(field) && /aria-label=/.test(line.text))) {
      continue;
    }
    const label = /aria-label="([^"]+)"/.exec(line.text)?.[1];
    if (!label) {
      continue;
    }
    if (/<select\b/.test(line.text)) {
      return { action: "select", label };
    }
    if (/type="checkbox"/.test(line.text)) {
      return { action: "check", label };
    }
    return { action: "fill", label };
  }
  return;
}

/**
 * Les interactions manquantes d'un scénario : pour chaque assertion qui vise une
 * valeur d'un marqueur, toutes les gardes qui la précèdent doivent avoir été
 * satisfaites par une étape jouée AVANT l'assertion. La garde est satisfaite si
 * le scénario a joué le contrôle qui porte l'un de ses champs.
 */

function missingForScenario(
  scenario: Plan["scenarios"][number],
  material: SourceLineMaterial[]
): MissingInteraction[] {
  const stepIndex = new Map(
    scenario.steps.map((step, index) => [step.id, index] as const)
  );
  return scenario.assertions.flatMap((assertion) =>
    missingForAssertion(assertion, scenario, stepIndex, material)
  );
}

/**
 * L'état d'un marqueur, lu UNE fois : son expression, son repli, les gardes
 * ordonnées qui décident de sa valeur, les conditions d'appelant qui décident
 * qu'il en ait une, et la provenance de chaque pièce.
 *
 * C'est la représentation que consomment tous les contrôles de plan. Avant elle,
 * chaque règle relisait le code pour son compte : une garde écrite sur deux
 * lignes échappait à l'une et pas à l'autre, et deux règles pouvaient conclure
 * des choses différentes sur le même plan.
 */
interface MarkerState {
  attribute: string;
  /** Les conditions qui décident que le marqueur ait une valeur du tout. */
  callers: MarkerGuard[];
  fallback?: string;
  /** Les gardes qui décident de la valeur, dans l'ordre du code. */
  ordered: MarkerGuard[];
  path: string;
  value: string;
}

function markerStateOf(
  assertion: Plan["scenarios"][number]["assertions"][number],
  material: SourceLineMaterial[]
): MarkerState | undefined {
  // Une assertion d'ABSENCE décrit une valeur que la vue ne doit pas montrer :
  // exiger d'elle les gardes qui la produisent serait l'inverse de son sujet.
  if (assertsAbsence(assertion)) {
    return;
  }
  const marker = markerOf(assertion);
  if (!marker) {
    return;
  }
  const found = markerExpression(material, marker.attribute);
  if (!found) {
    return;
  }
  const guards = markerGuards(material, found.expression, found.path);
  return {
    attribute: marker.attribute,
    callers: guards.filter((guard) => guard.caller !== undefined),
    fallback: fallbackLiteral(found.expression),
    ordered: guards.filter((guard) => guard.caller === undefined),
    path: found.path,
    value: marker.value,
  };
}

function missingForAssertion(
  assertion: Plan["scenarios"][number]["assertions"][number],
  scenario: Plan["scenarios"][number],
  stepIndex: Map<string, number>,
  material: SourceLineMaterial[]
): MissingInteraction[] {
  const assertAt = stepIndex.get(assertion.afterStep ?? "");
  const state = markerStateOf(assertion, material);
  if (!state || assertAt === undefined) {
    return [];
  }
  const target = state.ordered.findIndex(
    (guard) => guard.value === state.value
  );
  // La valeur assertée est le repli du marqueur : plus aucune garde ne doit
  // tenir, et c'est justement ce qu'une longueur peut démentir.
  const assertsFallback =
    state.fallback !== undefined && state.value === state.fallback;
  if (target <= 0 && !assertsFallback) {
    return [];
  }
  const played = scenario.steps.slice(0, assertAt + 1);
  const conflict = lengthRefusal({
    assertAt,
    assertsFallback,
    assertion,
    callers: state.callers,
    marker: state,
    material,
    ordered: state.ordered,
    played,
    target,
  });
  if (conflict) {
    return [conflict];
  }
  for (const guard of state.ordered.slice(0, Math.max(target, 0))) {
    const unmet = unmetControl(guard, played, material);
    if (unmet) {
      return [
        {
          action: unmet.action,
          assertionId: assertion.id,
          attribute: state.attribute,
          control: unmet.label,
          expected: state.value,
          field: unmet.field,
          guard,
        },
      ];
    }
  }
  return [];
}

/** Le repli d'un marqueur : `view.problem ?? "aucun"` rend `aucun`. */
function fallbackLiteral(expression: string): string | undefined {
  return /\?\?\s*"([^"]+)"/.exec(expression)?.[1];
}

/**
 * La contradiction de longueur, quand elle est démontrable : la dernière saisie
 * du champ commandé contredit la comparaison que la garde exige. Les gardes
 * antérieures doivent être fausses, celle qui produit la valeur assertée doit
 * tenir ; tout le reste — pas de contrôle, pas de saisie, constante non résolue —
 * rend `undefined` et la règle se tait.
 */
function lengthRefusal(input: {
  assertAt: number;
  assertsFallback: boolean;
  assertion: Plan["scenarios"][number]["assertions"][number];
  callers: MarkerGuard[];
  marker: { attribute: string; value: string };
  material: SourceLineMaterial[];
  ordered: MarkerGuard[];
  played: Plan["scenarios"][number]["steps"];
  target: number;
}): MissingInteraction | undefined {
  // Une condition d'appelant doit TENIR pour que le marqueur ait une valeur.
  for (const guard of input.callers) {
    const hit = lengthConflictOf(guard, true, input.played, input.material);
    if (hit) {
      return lengthInteraction(input, hit, guard);
    }
  }
  // Une garde de `return` antérieure doit être FAUSSE pour atteindre la valeur
  // assertée ; quand l'assertion vise le repli, aucune ne doit tenir.
  const earlier = input.assertsFallback
    ? input.ordered
    : input.ordered.slice(0, Math.max(input.target, 0));
  for (const guard of earlier) {
    const hit = lengthConflictOf(guard, false, input.played, input.material);
    if (hit) {
      return lengthInteraction(input, hit, guard);
    }
  }
  if (input.assertsFallback) {
    return;
  }
  // La garde qui produit la valeur assertée doit tenir.
  const producing = input.ordered[input.target];
  if (!producing) {
    return;
  }
  const hit = lengthConflictOf(producing, true, input.played, input.material);
  return hit ? lengthInteraction(input, hit, producing) : undefined;
}

function lengthInteraction(
  input: {
    assertion: Plan["scenarios"][number]["assertions"][number];
    marker: { attribute: string; value: string };
  },
  hit: { field: string; limit: number; measured: number },
  guard: MarkerGuard
): MissingInteraction {
  return {
    action: "fill",
    assertionId: input.assertion.id,
    attribute: input.marker.attribute,
    control: hit.field,
    expected: input.marker.value,
    field: hit.field,
    guard,
    lengthConflict: { limit: hit.limit, measured: hit.measured },
  };
}

/**
 * Vrai quand le diff donne à ce champ une valeur littérale NON VIDE à
 * l'initialisation de l'état (`useState({ kind: "normal" })`).
 *
 * La règle se limitait à « le champ est assigné quelque part dans le diff », ce
 * qui prenait pour un état initial une ligne SUPPRIMÉE du patch et une valeur
 * d'exemple dans un fichier de test : elle en concluait qu'aucune interaction
 * n'était nécessaire, et laissait passer le plan `3c51455f`. Une valeur vide ne
 * compte pas non plus : c'est exactement l'état que la garde refuse.
 */
function hasInitialValue(
  material: SourceLineMaterial[],
  field: string
): boolean {
  const key = field.split(".").pop() ?? field;
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
    return false;
  }
  const assigned = new RegExp(`\\b${key}\\s*:\\s*"(?!")`);
  return material.some(
    (source) =>
      !isTestPath(source.path) &&
      source.lines.some(
        (line) =>
          assigned.test(line.text) &&
          /use(?:State|Reducer)\s*\(/.test(line.text)
      )
  );
}

/** La valeur littérale qu'une action écrit, quand elle en écrit une. */
function actionValue(action: object): string {
  const value = (action as { value?: unknown }).value;
  return typeof value === "string" ? value : "";
}

/** La comparaison de longueur d'une condition, une fois la constante résolue. */
interface LengthCondition {
  field: string;
  limit: number;
  operator: ">" | ">=" | "<" | "<=";
  trimmed: boolean;
}

/** Le texte de la définition d'un identifiant, après son `=` s'il y en a un. */
function definitionText(
  lines: { path?: string; text: string }[],
  name: string
): string | undefined {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    return;
  }
  const line = lines.find((entry) =>
    new RegExp(`(?:const|let)\\s+${name}\\s*=`).test(entry.text)
  );
  return line?.text.slice(line.text.indexOf("=") + 1);
}

/**
 * La condition de longueur d'une garde, telle que le code la calcule :
 * `comment.length > CASH_JUSTIFICATION_MAX_LENGTH`, avec `comment` défini plus
 * haut comme `justification.comment.trim()`. Le champ réel, la transformation et
 * la constante viennent tous du code ; si l'un manque, la règle se tait.
 */
function lengthConditionOf(
  lines: { path?: string; text: string }[],
  condition: string
): LengthCondition | undefined {
  // La comparaison doit être TOUTE la condition : dans
  // `kind === "limited" && note.length > MAX`, la longueur ne décide pas seule,
  // et conclure sur elle refuserait un scénario qui prend l'autre branche.
  const match =
    /^\(?\s*((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)(\s*\.trim\(\))?\.length\s*(>=|<=|>|<)\s*([A-Za-z_$][\w$]*|\d+)\s*\)?$/.exec(
      condition.trim()
    );
  if (!match) {
    return;
  }
  const [, name = "", inlineTrim = "", operator = "", right = ""] = match;
  // Deux formes : le champ est lu directement (`draft.note.trim().length`), ou
  // par un identifiant qui cache sa définition (`comment.length` avec
  // `const comment = justification.comment.trim()`). La seconde porte la
  // transformation, la première la porte dans la condition elle-même.
  const definition = name.includes(".")
    ? undefined
    : definitionText(lines, name);
  // `justification.comment.trim()` : la transformation n'est pas un champ, on
  // ne garde que le chemin de l'état, sinon aucun contrôle ne correspond.
  const field = (
    definition ? /^\s*([A-Za-z_$][\w$.]*)/.exec(definition)?.[1] : name
  )?.replace(/\.(?:trim|trimEnd|trimStart|toString|normalize)$/, "");
  if (!field?.includes(".")) {
    return;
  }
  const limit = /^\d+$/.test(right)
    ? Number(right)
    : Number(
        (/^\s*(\d+)\s*;/.exec(definitionText(lines, right) ?? "") ?? [])[1] ??
          Number.NaN
      );
  if (!Number.isFinite(limit)) {
    return;
  }
  return {
    field,
    limit,
    operator: operator as LengthCondition["operator"],
    trimmed: inlineTrim !== "" || /\.trim\(\)/.test(definition ?? ""),
  };
}

/** Vrai quand la comparaison est satisfaite par cette longueur. */
function lengthHolds(
  measured: number,
  operator: LengthCondition["operator"],
  limit: number
): boolean {
  if (operator === ">") {
    return measured > limit;
  }
  if (operator === ">=") {
    return measured >= limit;
  }
  if (operator === "<") {
    return measured < limit;
  }
  return measured <= limit;
}

/**
 * La contradiction de longueur d'une garde, quand elle est démontrable : la
 * dernière saisie du champ commandé contredit la comparaison que la garde exige.
 * Aucun contrôle, aucune saisie, aucune constante résolue : la règle se tait.
 */
function lengthConflictOf(
  guard: MarkerGuard,
  shouldHold: boolean,
  played: Plan["scenarios"][number]["steps"],
  material: SourceLineMaterial[]
):
  | { field: string; limit: number; measured: number; written: string }
  | undefined {
  const lines = everyLine(material);
  const length = lengthConditionOf(lines, guard.condition);
  if (!length) {
    return;
  }
  const control = controlFor(material, length.field);
  if (!control) {
    return;
  }
  const steps = played.filter(
    (step) =>
      step.action.type === control.action &&
      namesControl(step.action, control.label)
  );
  const last = steps.at(-1);
  const written = actionValue(last?.action ?? {});
  if (written === "") {
    return;
  }
  // Même sémantique que le code testé : `.trim()` s'il est appliqué là-bas, et
  // `String.length` (unités UTF-16) pour la mesure.
  const measured = (length.trimmed ? written.trim() : written).length;
  if (lengthHolds(measured, length.operator, length.limit) === shouldHold) {
    return;
  }
  return { field: length.field, limit: length.limit, measured, written };
}

function assertsAbsence(assertion: {
  expected?: unknown;
  kind?: string;
}): boolean {
  if (assertion.kind === "hidden") {
    return true;
  }
  return assertion.kind === "count" && String(assertion.expected) === "0";
}

/**
 * La longueur exacte qui satisfait la comparaison de la garde : `> n` demande
 * n + 1, `>= n` demande n, `< n` demande n - 1, `<= n` demande n. Un message qui
 * dit « une valeur dont la longueur satisfait la condition » laisse le modèle
 * recompter — et il s'est trompé trois fois de suite dans le lot EE (241, 251 et
 * 284 caractères pour la même borne). Nommer le nombre supprime le comptage.
 */
function wantedLength(condition: string, limit: number): number {
  if (condition.includes("> ") || condition.includes(">=")) {
    return condition.includes(">=") ? limit : limit + 1;
  }
  return condition.includes("<=") ? limit : Math.max(0, limit - 1);
}

/** Le premier contrôle d'une garde que le scénario n'a pas joué avant l'assertion. */
function unmetControl(
  guard: MarkerGuard,
  played: Plan["scenarios"][number]["steps"],
  material: SourceLineMaterial[]
):
  | {
      action: "fill" | "select" | "check";
      field: string;
      label: string;
      valueConflict?: string;
    }
  | undefined {
  for (const field of guard.fields) {
    const control = controlFor(material, field);
    // Un champ que le code initialise à une valeur littérale non vide est déjà
    // établi au chargement : exiger son interaction refuserait un scénario qui
    // atteint la valeur attendue sans y toucher.
    if (!control || hasInitialValue(material, field)) {
      continue;
    }
    const steps = played.filter(
      (step) =>
        step.action.type === control.action &&
        namesControl(step.action, control.label)
    );
    if (steps.length === 0) {
      return { ...control, field };
    }
    // La présence de l'interaction suffit. Aucune valeur incompatible n'est
    // conclue : `required = total !== 0` avec
    // `total = Number(expected) - Number(counted)` n'autorise rien sur une saisie
    // « 0 » du seul montant attendu, et une garde de `return` antérieur doit au
    // contraire être fausse. Le plan est joué, l'exécution juge la valeur.
  }
  return;
}

function namesControl(
  action: { locator?: { by: string; value: string; name?: string } },
  label: string
): boolean {
  const locator = action.locator;
  if (!locator) {
    return false;
  }
  const name = locator.by === "role" ? (locator.name ?? "") : locator.value;
  if (name === label) {
    return true;
  }
  // Un contrôle opéré par un sélecteur brut (`#kind`, `[name="kind"]`) reste le
  // même contrôle : on compare alors le dernier segment du sélecteur à l'un des
  // mots du libellé, sans quoi la règle refuserait un scénario qui l'a joué.
  return label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2)
    .some((word) => name.toLowerCase().includes(word));
}

/** Le refus rendu au planificateur, borné et sans jargon d'application. */
function missingInteractionRefusal(
  missing: MissingInteraction[],
  scenarioId: string
): string | undefined {
  const first = missing[0];
  if (!first) {
    return;
  }
  if (first.lengthConflict) {
    const { limit, measured } = first.lengthConflict;
    const wanted = wantedLength(first.guard.condition, limit);
    return `Scenario ${scenarioId}: assertion ${first.assertionId} expects ${first.attribute}="${first.expected}", but the last write in "${first.control}" holds ${measured} characters and the limit that decides this value is ${limit}. Write exactly ${wanted} characters so that ${first.guard.condition} holds, then assert the marker.`;
  }
  if (first.guard.caller) {
    return `Scenario ${scenarioId}: assertion ${first.assertionId} expects ${first.attribute}="${first.expected}", but the view returns NO value for it until a condition written at ${first.guard.caller.source} holds: ${first.guard.condition}. Nothing in the scenario commands "${first.control}", which sets ${first.field ?? "a field of that condition"}; without it the marker stays at its fallback "${first.guard.caller.fallback}". Add a step that ${first.action}s "${first.control}" BEFORE the assertion step.`;
  }
  return `Scenario ${scenarioId}: assertion ${first.assertionId} expects ${first.attribute}="${first.expected}", but the view only returns that value after its earlier condition holds: ${first.guard.condition}. Add a step that ${first.action}s "${first.control}" BEFORE the assertion step, then assert the marker. Assertions on a computed marker are only reachable through the order the diff computes.`;
}

/**
 * Le point d'entrée unique : les refus à rendre au planificateur (un par
 * scénario fautif) et, quand le plan est arrêté après acceptation, le premier
 * refus fatal. Une seule fonction exportée garde le module lisible depuis la
 * politique sans ajouter deux symboles à sa surface publique.
 */
/** Une précondition que la porte ne peut pas trancher faute d'observation. */
export interface UnverifiedPrecondition {
  assertionId: string;
  attribute: string;
  /** La condition qui décide de l'existence de la valeur assertée. */
  condition: string;
  scenarioId: string;
  /** Où le code l'écrit : `chemin:ligne`. */
  source?: string;
}

/**
 * Les préconditions qu'aucune preuve ne tranche : une garde d'**appelant**
 * (`required ? f(...) : null`) dépend d'un état que le diff ne montre pas — le
 * montant attendu d'une caisse, une session déjà ouverte. La porte ne les refuse
 * pas (ce serait un refus faux sur un plan réel) et ne les ignore pas : elle les
 * publie, pour qu'un run ne puisse plus passer pour vérifié alors qu'il repose
 * sur un état supposé.
 */
function unverifiedPreconditions(
  plan: Pick<Plan, "scenarios">,
  material: SourceLineMaterial[]
): UnverifiedPrecondition[] {
  const found: UnverifiedPrecondition[] = [];
  for (const scenario of plan.scenarios) {
    for (const assertion of scenario.assertions) {
      const state = markerStateOf(assertion, material);
      const caller = state?.callers[0];
      if (!(state && caller?.caller)) {
        continue;
      }
      found.push({
        assertionId: assertion.id,
        attribute: state.attribute,
        condition: caller.condition,
        scenarioId: scenario.id,
        source: caller.caller.source,
      });
    }
  }
  return found;
}

/**
 * Les scénarios dont l'ordre des marqueurs est impossible, **un refus par
 * scénario**.
 *
 * Le refus était fatal : une seule assertion impossible arrêtait le run entier,
 * donc perdait les scénarios valides du même plan (mesuré au lot CC : un run à
 * zéro scénario joué pour une assertion dont la saisie faisait 261 caractères au
 * lieu de 281). Un défaut de plan qui ne concerne qu'un scénario doit coûter ce
 * scénario, pas le run.
 */
function markerOrderScenarioRefusals(
  plan: Pick<Plan, "scenarios">,
  material: SourceLineMaterial[]
): { error: QaError; scenarioId: string }[] {
  return plan.scenarios.flatMap((scenario) => {
    const message = missingInteractionRefusal(
      missingForScenario(scenario, material),
      scenario.id
    );
    return message
      ? [
          {
            error: new QaError(
              "MARKER_ORDER_UNREACHABLE",
              message,
              "Establish every earlier condition of the marker with its own step, in the order the diff computes them, before asserting the value."
            ),
            scenarioId: scenario.id,
          },
        ]
      : [];
  });
}

function markerOrderFinding(
  plan: Pick<Plan, "scenarios">,
  material: SourceLineMaterial[]
): { fatal?: MissingInteraction; refusals: string[] } {
  const refusals: string[] = [];
  let fatal: MissingInteraction | undefined;
  for (const scenario of plan.scenarios) {
    const missing = missingForScenario(scenario, material);
    const message = missingInteractionRefusal(missing, scenario.id);
    if (message) {
      refusals.push(message);
      fatal ??= missing[0];
    }
  }
  return { fatal, refusals };
}

/**
 * Les constats de la porte sur un plan, en une seule lecture : les scénarios
 * dont l'assertion est impossible (un refus par scénario, jamais fatal) et les
 * préconditions qu'aucune preuve ne tranche. Une seule entrée, pour que le plan
 * soit jugé une fois et que deux contrôles ne puissent pas lire différemment le
 * même marqueur.
 */
export function planFindings(
  plan: Plan,
  material: SourceLineMaterial[],
  coverage?: { config: Config; context: PrContext; policy: Policy }
): {
  coverageRefusals: { error: QaError; scenarioId: string }[];
  refusals: { error: QaError; scenarioId: string }[];
  unverified: UnverifiedPrecondition[];
} {
  return {
    coverageRefusals:
      coverage === undefined || !coverage.config.QA_PER_SCENARIO_COVERAGE
        ? []
        : scenarioCoverageRefusals(
            plan,
            coverage.context,
            coverage.policy,
            coverage.config
          ),
    refusals: [
      ...markerOrderScenarioRefusals(plan, material),
      ...persistenceIntentRefusals(plan),
    ],
    unverified: unverifiedPreconditions(plan, material),
  };
}
