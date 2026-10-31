import type { Diagnostic } from "./diagnostics.js";
import type {
  Outcome,
  Plan,
  Preview,
  Publication,
  Scenario,
  StepResult,
} from "./schema.js";

export interface ScenarioResult {
  artifacts: string[];
  assertions: {
    id: string;
    passed: boolean;
    actual: unknown;
    baseline?: unknown;
    /**
     * Vrai quand la valeur observée APRÈS l'étape satisfaisait déjà l'attendu
     * AVANT elle. L'assertion ne prouve alors pas que l'étape a produit l'état :
     * il peut venir d'un scénario précédent ou d'un état persisté. Sur une
     * assertion `state` dont la valeur n'a pas bougé, ce champ est ce qui
     * distingue l'état initial de la preuve produite pendant l'exécution, et le
     * verdict n'est plus vert (`STATE_ALREADY_SATISFIED`) ; une étape `ifPresent`
     * sautée, elle, reste légitime parce qu'elle a déclaré son no-op.
     */
    preMatched?: boolean;
    persisted?: unknown;
    /**
     * Le type de vérification de l'assertion, tel que le plan l'a demandé. Sans
     * lui, un artefact ne permet pas de ventiler les assertions pré-satisfaites
     * par `state` / `transition` / `persisted` : la campagne ne pouvait donc
     * mesurer qu'un compteur global, jamais la règle qui produit le faux vert.
     */
    verification?: "state" | "transition" | "persisted";
    /**
     * L'intention DÉCLARÉE par le plan, quand elle existe. Absente sur les plans
     * antérieurs au champ : l'artefact dit alors « inconnue », jamais devinée.
     */
    assertionIntent?: "invariant" | "persistence";
    /**
     * La preuve produite PENDANT l'exécution : la valeur après l'étape diffère de
     * celle mesurée avant. Absent quand aucune valeur d'avant n'a pu être mesurée
     * (sonde en échec) — inconnu, jamais « rien n'a changé ».
     */
    changed?: boolean;
    /** L'indice de l'exigence qui justifie l'attendu : la preuve, dans le rapport. */
    requirement?: number;
    /**
     * Présent quand une `persisted` a été jugée à la RÉENTRÉE (aller-retour de
     * vue prouvé), sans rechargement : aucune ligne du diff n'écrit d'état
     * durable, donc la survie au rechargement n'est pas revendiquée — et pas
     * démontrée. Le rapport le publie (voir `reentry.ts`).
     */
    reloadPersistence?: "not-claimed";
    /**
     * Sur une assertion jugée à la réentrée : la relecture APRÈS rechargement,
     * faite en fin de scénario. Elle ne décide jamais l'issue de ce côté ; la
     * comparaison à la base la confronte à celle de la base
     * (`reload-oracle.ts`). `reloadPassed` absent : relecture impossible,
     * jamais « passée ».
     */
    reloadPassed?: boolean;
    reloadReading?: unknown;
  }[];
  /**
   * Le classement explicite du scénario : ce qui a été démontré, ce qui a échoué,
   * ce qui est un défaut du test, et ce qui n'a pas pu être établi. Un scénario
   * `indeterminate` n'est ni vert ni une régression produit.
   */
  classification?: "proven" | "failed" | "test-defect" | "indeterminate";
  contract?: { completedSteps: string[]; totalSteps: number; hash: string };
  diagnostic?: Diagnostic;
  error?: string;
  /**
   * Vrai quand l'assertion désignée comme objectif du scénario a passé. Faux ou
   * absent quand le plan n'en désigne aucune : la mesure est publiée pour que la
   * campagne compte les verts sans preuve d'objectif au lieu de les supposer
   * démontrés.
   */
  objectiveProven?: boolean;
  outcome: Outcome;
  scenario: Scenario;
  sessionId?: string;
  steps: StepResult[];
}
/**
 * Une assertion lue des deux côtés : la tête de la PR et la préversion de base.
 * Les valeurs observées viennent de la page, donc d'une session parfois
 * authentifiée : elles vivent ici et dans le rapport privé, jamais dans un
 * message publié.
 */
export interface BaselineAssertionDiff {
  assertionId: string;
  base?: { passed: boolean; actual?: unknown };
  /** L'attendu du plan : il vient de la source, pas de la page. */
  expected?: unknown;
  head?: { passed: boolean; actual?: unknown };
  /** Vrai quand cette assertion est l'objectif déclaré du scénario. */
  objective: boolean;
  /** Pourquoi la comparaison ne tranche pas (entrées non concluantes). */
  reason?: string;
  scenarioId: string;
}
/**
 * La base rejouée comme oracle indépendant, assertion par assertion. Une même
 * entrée peut figurer dans `changes` et `notDiscriminating` : la valeur a
 * changé, et l'assertion passe pourtant des deux côtés.
 */
export interface BaselineComparison {
  /** Tête verte, base en échec ou de valeur différente : à relire par un humain. */
  changes: BaselineAssertionDiff[];
  /** Pourquoi la comparaison est indisponible (`status: "unavailable"`). */
  diagnostic?: Diagnostic;
  /** Ni vert ni rouge : échec des deux côtés, base non exécutable. */
  inconclusive: BaselineAssertionDiff[];
  /** Verte des deux côtés : passerait sans la PR. */
  notDiscriminating: BaselineAssertionDiff[];
  /** Verte sur la base, en échec sur la tête : la PR casse ce qui marchait. */
  regressions: BaselineAssertionDiff[];
  sha: string;
  status: "compared" | "unavailable";
}
export interface RunResult {
  baseline?: {
    /** La préversion de base n'a pas pu servir d'oracle (SHA, accès). */
    diagnostic?: Diagnostic;
    sha: string;
    url: string;
    scenarios: ScenarioResult[];
  };
  /** Le verdict de la base, lu par le rapport, le statut et le commentaire. */
  baselineComparison?: BaselineComparison;
  coverage?: {
    covered: string[];
    skipped: Plan["skipped"];
    policyRef: string;
    gate: string;
  };
  diagnostic?: Diagnostic;
  endedAt?: string;
  error?: string;
  id: string;
  model?: string;
  outcome: Outcome;
  plan?: Plan;
  preview?: Preview;
  prUrl: string;
  publication?: Publication;
  /**
   * Les scénarios réécrits après que l'exécution a mesuré qu'une vérification ne
   * pouvait rien prouver. Le contrat révisé a repassé tous les refus et a été
   * réexécuté ; ce champ dit lesquels, il ne requalifie aucun verdict.
   */
  replannedScenarioIds?: string[];
  scenarios: ScenarioResult[];
  sha?: string;
  startedAt: string;
  /**
   * Les préconditions qu'aucune preuve ne tranche : la porte les publie au lieu
   * de les refuser à tort ou de les passer sous silence.
   */
  unverifiedPreconditions?: {
    assertionId: string;
    attribute: string;
    condition: string;
    scenarioId: string;
    source?: string;
  }[];
  usage?: {
    tokens: number;
    costUsd: number;
    /**
     * Cumul des réserves des tentatives perdues, chiffré à part des tokens que
     * l'endpoint a rapportés. Chaque réserve est créditée de ce que le transport
     * a réellement livré, plafonnée par le pire cas de la tentative perdue —
     * sauf un `total_tokens` déclaré au-delà de ce pire cas, repris tel quel ;
     * elle compte dans l'admission du run, donc une exposition qui dépasse
     * l'enveloppe y refuse toute admission suivante.
     */
    reservedTokens?: number;
    reservedCostUsd?: number;
    calls: number;
    model?: string;
    estimated?: boolean;
    pricingConfigured?: boolean;
    /** Reprises de transport effectuées pendant les appels modèle du run. */
    retries?: number;
  };
}
