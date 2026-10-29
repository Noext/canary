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
    /** L'indice de l'exigence qui justifie l'attendu : la preuve, dans le rapport. */
    requirement?: number;
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
export interface RunResult {
  baseline?: { sha: string; url: string; scenarios: ScenarioResult[] };
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
