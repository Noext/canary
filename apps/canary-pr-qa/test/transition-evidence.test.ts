import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Canary, type Observation } from "../src/canary.js";
import { loadConfig } from "../src/config.js";
import { executeScenario } from "../src/executor.js";
import { PLANNER_PROMPT } from "../src/model.js";
import { type Scenario, ScenarioSchema } from "../src/schema.js";

/**
 * The banner assertion of pharmania/arpilabe-pilotage#9
 * (`preview-banner-after-view-change`): the plan asked for a `transition` on an
 * element that must not change, so the value probed before and after the click
 * was identical and the scenario failed while `actual` and `baseline` agreed.
 */
const BANNER = "Aperçu de PR · vérifié par Canary";
const DESCRIPTION =
  "le repère affiche toujours « Aperçu de PR · vérifié par Canary » après le changement de vue";

function bannerScenario(
  verification: "transition" | "persisted" = "transition"
): Scenario {
  return ScenarioSchema.parse({
    id: "preview-banner-after-view-change",
    title: "Le repère d'aperçu survit au changement de vue",
    rationale: "La PR change la vue sans toucher au repère de preview",
    kind: "regression",
    sourceFiles: ["src/view.ts"],
    preconditions: [],
    requirements: [
      {
        sourceFile: "src/view.ts",
        quote: "preview banner",
        behavior:
          "Le repère de preview reste affiché après le changement de vue",
      },
    ],
    steps: [
      {
        id: "go-pnl",
        description: "afficher la vue P&L",
        action: {
          type: "click",
          locator: { by: "text", value: "P&L" },
        },
      },
      {
        id: "banner-after",
        description: "relire le repère",
        action: { type: "assert", assertionId: "banner-text-after" },
      },
    ],
    assertions: [
      {
        id: "banner-text-after",
        description: DESCRIPTION,
        kind: "text",
        expected: BANNER,
        target: { by: "css", value: '[data-canary-preview="pr"]' },
        afterStep: "go-pnl",
        verification,
      },
    ],
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

interface Probes {
  actual: unknown;
  baseline: unknown;
  persisted?: unknown;
}

async function runScenario(scenario: Scenario, probes: Probes) {
  const dataDir = await mkdtemp(join(tmpdir(), "canary-transition-"));
  cleanups.push(() => rm(dataDir, { force: true, recursive: true }));
  const preview = "http://127.0.0.1:9/preview";
  const config = loadConfig({
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    OPENAI_MODEL: "fixture-scripted-model",
    QA_ALLOW_PRIVATE_PREVIEWS: "true",
    QA_API_TOKEN: "fixture-api-token-123456789012345",
    QA_DATA_DIR: dataDir,
  });
  const observation = (actual: unknown): Observation => ({
    actual,
    snapshot: `repère : ${String(actual)}`,
    url: preview,
  });
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("transition-evidence");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_session, label) => {
      if (label.startsWith("baseline-")) {
        return observation(probes.baseline);
      }
      if (label.startsWith("persistence-")) {
        return observation(probes.persisted ?? probes.actual);
      }
      return observation(probes.actual);
    }
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
  return executeScenario(
    scenario,
    preview,
    dataDir,
    config,
    new Canary(config)
  );
}

async function runBanner(
  verification: "transition" | "persisted",
  values: { actual: string; baseline: string; persisted?: string }
) {
  return runScenario(bannerScenario(verification), values);
}

it("reclassifies an unchanged transition that already shows the expected value", async () => {
  const result = await runBanner("transition", {
    actual: BANNER,
    baseline: BANNER,
  });
  // La valeur est celle que l'assertion attendait déjà : le plan a exigé un
  // changement sur un invariant, donc l'application n'a rien à se reprocher. Le
  // verdict reste non vert, et le relevé fautif reste enregistré.
  expect(result.outcome).toBe("blocked");
  expect(result.assertions[0]).toMatchObject({
    actual: BANNER,
    baseline: BANNER,
    passed: false,
    // L'état attendu était déjà là avant l'étape : l'assertion ne prouve pas que
    // l'étape l'a produit, et le run le publie au lieu de le laisser deviner.
    preMatched: true,
  });
  expect(result.diagnostic?.code).toBe("TRANSITION_ON_INVARIANT");
  expect(result.error).toBe(result.diagnostic?.message);
  expect(result.error).toMatch(/banner-text-after/);
  expect(result.error).toMatch(/go-pnl/);
  expect(result.error).toMatch(/identical to the baseline/);
  expect(result.error).toMatch(/the plan requires a change on a value/);
  expect(result.error).not.toContain(DESCRIPTION);
  expect(result.diagnostic?.hint).toMatch(/"state"/);
  expect(result.diagnostic?.hint).toMatch(/afterStep/);
});

it("ne signale aucune pré-satisfaction quand la valeur change vraiment", async () => {
  const result = await runBanner("transition", {
    actual: BANNER,
    baseline: "Aperçu de PR",
  });
  // La valeur d'arrivée n'était pas celle de départ : l'assertion prouve bien
  // quelque chose sur l'étape.
  expect(result.assertions[0]).not.toHaveProperty("preMatched");
  expect(result.assertions[0]?.passed).toBe(true);
});

it("keeps a failed change failed when the unchanged value misses the expectation", async () => {
  // Valeur qui devait changer et n'a pas bougé : l'attendu n'est pas atteint, et
  // ce n'est plus le plan qui est en cause. Le reclassement ne doit jamais
  // couvrir ce cas.
  const result = await runBanner("transition", {
    actual: "Aperçu de PR",
    baseline: "Aperçu de PR",
  });
  expect(result.outcome).toBe("failed");
  expect(result.assertions[0]).toMatchObject({
    actual: "Aperçu de PR",
    baseline: "Aperçu de PR",
    passed: false,
  });
  expect(result.diagnostic?.code).toBe("TRANSITION_NOT_OBSERVED");
  expect(result.error).toMatch(/no change observed/);
  expect(result.error).not.toContain(DESCRIPTION);
});

it("passes a transition whose value changed to the expected one", async () => {
  const result = await runBanner("transition", {
    actual: BANNER,
    baseline: "Aperçu de PR",
  });
  expect(result.outcome, result.error).toBe("passed");
  expect(result.assertions[0]).toMatchObject({
    actual: BANNER,
    baseline: "Aperçu de PR",
    passed: true,
  });
  expect(result.diagnostic).toBeUndefined();
  expect(result.error).toBeUndefined();
});

it("still fails a changed value that does not match the expected one", async () => {
  const result = await runBanner("transition", {
    actual: "Tableau P&L",
    baseline: BANNER,
  });
  expect(result.outcome).toBe("failed");
  expect(result.assertions[0]).toMatchObject({
    actual: "Tableau P&L",
    baseline: BANNER,
    passed: false,
  });
  expect(result.diagnostic).toBeUndefined();
  expect(result.error).toBe(
    `Assertion banner-text-after failed: ${DESCRIPTION}`
  );
});

it("explains an unchanged persisted value the same way after the reload", async () => {
  const result = await runBanner("persisted", {
    actual: BANNER,
    baseline: BANNER,
    persisted: BANNER,
  });
  // `persisted` garde la règle précédente : le reclassement mesuré porte sur
  // `transition`, et une persistence qui ne diffère pas du relevé d'avant ne
  // prouve pas la survie qu'elle promet.
  expect(result.outcome).toBe("failed");
  expect(result.assertions[0]).toMatchObject({
    actual: BANNER,
    baseline: BANNER,
    passed: false,
    persisted: BANNER,
  });
  expect(result.diagnostic?.code).toBe("TRANSITION_NOT_OBSERVED");
  expect(result.error).not.toContain(DESCRIPTION);
});

/**
 * Les deux assertions mesurées du lot AM (PR pharmania/arpilabe-pilotage#20, SHA
 * 5a48a466, déploiement 337be29) sont copiées de l'artefact du run sans
 * retouche : même identifiant, même cible, même `expected`, même `afterStep`.
 * Les étapes sont réduites à celles qui précèdent l'assertion — la suite du
 * scénario ne change pas son évaluation — et les valeurs de référence sont celles
 * que le run a relevées : `baseline === actual`, et cette valeur est déjà celle
 * que l'assertion attend.
 */
function measuredStatusScenario(): Scenario {
  return ScenarioSchema.parse({
    id: "cash-manque-justifie-cloture",
    title: "Manque de 40 € justifié par motif + commentaire puis clôturé",
    rationale:
      "2×500 € + 2×100 € = 120000 centimes contre 124000 attendus : l'écart est bloquant et la justification manque",
    kind: "happy_path",
    sourceFiles: ["apps/web/app/page.tsx"],
    preconditions: [],
    requirements: [
      {
        sourceFile: "apps/web/app/page.tsx",
        quote:
          'data-cash-justification-problem={view.justificationProblem??"aucun"}',
        behavior:
          "Le problème de justification courant est exposé dans data-cash-justification-problem.",
      },
    ],
    steps: [
      {
        id: "s3-open",
        description: "Ouvrir l'application",
        action: { type: "goto", path: "/" },
      },
      {
        id: "s3-cash",
        description: "Aller sur Caisse et Coffre",
        action: {
          type: "click",
          locator: { by: "role", value: "button", name: "Caisse et Coffre" },
        },
      },
      {
        id: "s3-fill-100",
        description: "Saisir 2 billets de 100 €",
        action: {
          type: "fill",
          locator: {
            by: "css",
            value: 'input[aria-label="Quantité · Billet de 100 €"]',
          },
          value: "2",
        },
      },
      {
        id: "s3-check-status",
        description: "Vérifier l'état d'écart à justifier",
        action: { type: "assert", assertionId: "s3-status" },
      },
    ],
    assertions: [
      {
        id: "s3-status",
        description:
          "Le libellé reste « Écart à justifier » tant que la justification manque",
        target: { by: "css", value: 'span[aria-live="polite"]' },
        afterStep: "s3-fill-100",
        verification: "transition",
        kind: "text",
        expected: "Écart à justifier",
      },
    ],
  });
}

function measuredStateScenario(): Scenario {
  return ScenarioSchema.parse({
    id: "caisse-manque-40-euros",
    title:
      "Manque de 40 € : écart −4 000, écart à justifier et clôture refusée",
    rationale:
      "Le domaine bloque un écart négatif non justifié et la composition d'écran expose la variance",
    kind: "edge_case",
    sourceFiles: ["apps/web/app/page.tsx"],
    preconditions: [],
    requirements: [
      {
        sourceFile: "apps/web/app/page.tsx",
        quote:
          'data-cash-variance-cents={view.varianceCents===null?"indisponible":String(view.varianceCents)}',
        behavior:
          "L'écart signé est exposé en centimes, ou « indisponible » quand il ne peut pas être calculé.",
      },
    ],
    steps: [
      {
        id: "open",
        description: "ouvrir l'application",
        action: { type: "goto", path: "/" },
      },
      {
        id: "go-caisse",
        description: "ouvrir la vue Caisse et Coffre",
        action: {
          type: "click",
          locator: { by: "role", value: "button", name: "Caisse et Coffre" },
        },
      },
      {
        id: "fill-100",
        description: "compter 2 billets de 100 € (total 1 200,00 €)",
        action: {
          type: "fill",
          locator: { by: "label", value: "Quantité · Billet de 100 €" },
          value: "2",
        },
      },
      {
        id: "verify-state",
        description: "l'état est écart à justifier",
        action: { type: "assert", assertionId: "s3-state" },
      },
    ],
    assertions: [
      {
        id: "s3-state",
        description:
          "data-cash-state porte ecart-a-justifier pour un manque non justifié",
        target: {
          by: "css",
          value: '[data-cash-state="ecart-a-justifier"]',
        },
        afterStep: "fill-100",
        verification: "transition",
        kind: "count",
        expected: 1,
      },
    ],
  });
}

it("names the plan, not the application, for assertion s3-status of run 59edcd21", async () => {
  const result = await runScenario(measuredStatusScenario(), {
    actual: "Écart à justifier",
    baseline: "Écart à justifier",
  });
  expect(result.outcome).toBe("blocked");
  expect(result.diagnostic?.code).toBe("TRANSITION_ON_INVARIANT");
  expect(result.error).toBe(result.diagnostic?.message);
  expect(result.error).toMatch(/s3-status/);
  expect(result.error).toMatch(/s3-fill-100/);
  expect(result.assertions[0]).toMatchObject({
    actual: "Écart à justifier",
    baseline: "Écart à justifier",
    passed: false,
  });
  // La valeur attendue reste dans l'artefact d'assertion, jamais dans le
  // commentaire publié.
  expect(result.error).not.toContain("Écart à justifier");
});

it("names the plan, not the application, for assertion s3-state of run 9599ccc1", async () => {
  const result = await runScenario(measuredStateScenario(), {
    actual: 1,
    baseline: 1,
  });
  expect(result.outcome).toBe("blocked");
  expect(result.diagnostic?.code).toBe("TRANSITION_ON_INVARIANT");
  expect(result.error).toBe(result.diagnostic?.message);
  expect(result.error).toMatch(/s3-state/);
  expect(result.error).toMatch(/fill-100/);
  expect(result.assertions[0]).toMatchObject({
    actual: 1,
    baseline: 1,
    passed: false,
  });
  expect(result.diagnostic?.hint).toMatch(/"state"/);
});

it("states the three verification semantics to the planner", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  expect(prompt).toMatch(/state means the value must match expected/i);
  expect(prompt).toMatch(
    /transition means the value must differ from the value probed before the step/i
  );
  expect(prompt).toMatch(
    /persisted means the value must survive the reload and differ from the baseline/i
  );
  expect(prompt).toMatch(
    /use state with afterStep set to the interaction step/i
  );
});

it("teaches that a text assertion never reads an attribute value", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // Défaut mesuré du run 1b49d751 : `text` sur `[data-cash-state]` attendant
  // « ouvert », alors que `innerText` de ce conteneur rend toute la vue et que
  // l'attribut n'y figure jamais. La consigne nomme la lecture réelle, la voie
  // correcte (présence sur la valeur de l'attribut, ou texte visible) et
  // l'établissement de l'état par une étape observable.
  expect(prompt).toMatch(
    /kind "text" reads the visible text INSIDE the target \(innerText\), never one of its attributes/i
  );
  expect(prompt).toMatch(
    /Never plan kind "value" on an element that is not an input/i
  );
  expect(prompt).toMatch(
    /\[data-cash-state="ouvert"\] with kind "visible", or kind "count" expecting 1/i
  );
  expect(prompt).toMatch(
    /must ESTABLISH that state with an observable step before asserting it/i
  );
  expect(prompt).toMatch(/put the "ouvert" assertion AFTER that step/i);
});

it("teaches the two readable forms and when a transition is provable", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // Sonde P3 : une étape d'établissement vérifiée en `transition` échoue en
  // TRANSITION_NOT_OBSERVED quand l'état est déjà le bon. Sonde P5 : la règle
  // ne doit pas confondre un sélecteur d'attribut d'état avec un rôle dont le
  // texte visible est le contenu.
  expect(prompt).toMatch(
    /put the "ouvert" assertion AFTER that step, with verification "state" on the step that established it/i
  );
  expect(prompt).toMatch(
    /verification "transition" is only for a step that genuinely moves the value/i
  );
  // Lot AM : deux assertions mesurées ont exigé une transition sur une valeur qui
  // reste. La consigne nomme les deux cas et la question qui tranche avant de
  // choisir `transition`.
  expect(prompt).toMatch(
    /assertion s3-status of scenario cash-manque-justifie-cloture/
  );
  expect(prompt).toMatch(
    /assertion s3-state of scenario caisse-manque-40-euros/
  );
  expect(prompt).toMatch(
    /when the value you expect is the one already read before the step, or the one the description says stays, the verification is state with afterStep set to the interaction/i
  );
  expect(prompt).toMatch(
    /\[role="status"\] is a region whose visible text IS its content, so kind "text" on it is fine/i
  );
});

it("limits ifPresent to an establishing step and names its two consequences", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // L'option rend un clic tolérant à l'absence, ce qui est vrai seulement pour
  // une étape qui établit un état : sur une action métier, elle masquerait un
  // vrai défaut. Son étape sautée ne démontre pas de transition.
  expect(prompt).toMatch(
    /Declare that establishing click with "ifPresent": true on the click action/i
  );
  expect(prompt).toMatch(
    /Use "ifPresent" ONLY on such an establishing step, never on a business action that must happen/i
  );
  expect(prompt).toMatch(
    /A skipped establishing step cannot demonstrate a transition/i
  );
});

it("teaches where to read a text the view shows, instead of the state it pins", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // Lot U : six scénarios du run 210357d8 bloqués par la règle née du run
  // 76f7b2a9, parce que le prompt interdisait la forme sans dire quelle cible
  // la remplace. Le contre-exemple mesuré et la cible positive sont donc dans
  // la consigne : le conteneur sans sa valeur épinglée, ou l'élément que
  // l'instantané nomme, et le libellé attendu comme indice de la cible.
  expect(prompt).toMatch(
    /Never read a target selected by a state VALUE either/i
  );
  expect(prompt).toMatch(/run 210357d8/);
  expect(prompt).toContain(
    'assertion units read [data-cash-state="ouvert"] while expecting "6 unités comptées"'
  );
  expect(prompt).toMatch(
    /The text you expect names the element that renders it/i
  );
  expect(prompt).toMatch(
    /the container with its presence form \[data-cash-state\] — no value, so it exists in every state/i
  );
  expect(prompt).toMatch(
    /named by its role and accessible name from the discovery snapshot/i
  );
  expect(prompt).toMatch(
    /Never read \[data-\*="value"\] on a state attribute/i
  );
  // La consigne ne bannit pas les crochets stables : [data-testid="total"] est
  // une cible mesurée, acceptée par le gate.
  expect(prompt).toMatch(
    /A data attribute the source defines as a stable hook stays a fine target/i
  );
});

it("teaches the effect of a blocking rule, not the mechanism it imagines", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // Lot AP : deux scénarios du run 8ebadbfe ont asserté que le bouton de
  // clôture portait `disabled` quand la justification manquait. L'application
  // ne le désactive jamais (`canAttemptClose` ignore la justification) et
  // refuse le clic — même règle documentée, mécanisme différent. La consigne
  // dit donc d'asserter l'EFFET, et nomme le contre-exemple mesuré.
  expect(prompt).toMatch(
    /A BLOCKING rule the PR states .* asserted by its EFFECT/i
  );
  expect(prompt).toContain("canAttemptClose");
  expect(prompt).toMatch(/never expect a disabled attribute/i);
});

it("sends a boundary case on the rejected side of the limit", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // Lot AP : le run f05cd773 a rempli exactement 280 caractères et attendu le
  // refus, alors que 280 est la borne acceptée. Le plan, pas l'application.
  expect(prompt).toMatch(/A BOUNDARY case sits on the REJECTED side/i);
  expect(prompt).toContain("L+1 are refused");
  expect(prompt).toContain("exactly 280 characters");
});

it("dit au planificateur qu'aucune précondition ne peut être vérifiée", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // Lot AQ : le run 720c0ba0 a perdu ses huit scénarios sur des préconditions
  // inventées alors que le catalogue ne déclare rien pour ce dépôt.
  expect(prompt).toContain("preconditionsAvailable");
  expect(prompt).toMatch(/declares NOTHING for this repository/i);
  expect(prompt).toContain("PRECONDITION_UNVERIFIED");
  expect(prompt).toContain("role:Administrateur démo 1");
});

it("établit les problèmes antérieurs avant d'asserter le suivant", () => {
  const prompt = PLANNER_PROMPT.replace(/\s+/g, " ");
  // Lot AS : deux runs ont attendu `commentaire-trop-long` après un simple
  // remplissage, alors que `cashJustificationProblem` teste le motif d'abord —
  // sans motif valide la vue reste sur `motif-manquant`.
  expect(prompt).toMatch(/documented PRIORITY ORDER/i);
  expect(prompt).toContain("cashJustificationProblem");
  expect(prompt).toMatch(
    /Establish every earlier condition with its own step/i
  );
});
