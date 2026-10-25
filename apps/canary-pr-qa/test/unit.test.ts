import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertionMatches,
  Canary,
  compileAction,
  compileProbe,
  foldTypography,
  locatorCall,
  locatorCount,
  locatorExpression,
  type Observation,
  typographicCodepoints,
  typographicVariants,
} from "../src/canary.js";
import {
  loadConfig,
  MAX_OUTPUT_TOKENS_PER_CALL,
  MIN_OUTPUT_TOKENS_PER_CALL,
  validatePreviewUrl,
} from "../src/config.js";
import { diagnose, QaError } from "../src/diagnostics.js";
import { GitHub, type PrContext, parsePrUrl } from "../src/github.js";
import { mayRetry, PLANNER_PROMPT, transportCode } from "../src/model.js";
import { planPayload } from "../src/plan-evidence.js";
import {
  PolicySchema,
  quoteExcerpt,
  repairRequirementAttribution,
  UNGROUNDED_ABSENT_REMEDY,
  UNGROUNDED_WEAK_REMEDY,
  ungroundedPlanRefusals,
} from "../src/policy.js";
import { resolvePreview, verifyPreviewUrl } from "../src/preview.js";
import type { Progress } from "../src/progress.js";
import { saveReport } from "../src/report.js";
import { type RunScope, runScope } from "../src/run-scope.js";
import {
  FATAL_PRELUDE_CHARS,
  relayModelRetries,
  runQa,
} from "../src/runner.js";
import {
  ActionSchema,
  type Assertion,
  type Locator,
  type Plan,
  PlanSchema,
  type ScenarioResult,
} from "../src/schema.js";
import { repairStepTarget } from "../src/target-repair.js";
import {
  BASE_SHA,
  fixture,
  PR_URL,
  plan,
  SECOND_FILE_QUOTE,
  SHA,
} from "./fixture.js";
import { LOT_W_PRECONDITIONS } from "./lot-w-preconditions.js";

const close: (() => Promise<void>)[] = [];
/** Politique par défaut : `src/` est critique, aucun skip n'est approuvé. */
const policyFor = () => PolicySchema.parse({ version: 1 });
/**
 * Enveloppe d'un appel volontairement énorme. Les tests qui mesurent la réserve
 * d'un seul envoi, et non le plafond par appel, relèvent explicitement
 * `QA_CALL_MAX_TOKENS` : la constante du produit est un défaut, jamais un
 * maximum.
 */
const WIDE_CALL = { QA_CALL_MAX_TOKENS: "400000" } as const;

/**
 * Les réservations budgétaires déposées avant chaque tentative modèle : le
 * wrapper réel est conservé, seul l'appel est observé.
 */
const budget = vi.hoisted(() => ({ reserves: [] as number[] }));
vi.mock("../src/run-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/run-scope.js")>();
  return {
    ...actual,
    checkBudget: (tokens = 0, costUsd = 0) => {
      if (tokens > 0) {
        budget.reserves.push(tokens);
      }
      return actual.checkBudget(tokens, costUsd);
    },
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(close.splice(0).map((fn) => fn()));
});
async function setup(options?: Parameters<typeof fixture>[0]) {
  const f = await fixture(options);
  close.push(f.close);
  return f;
}
function fakeBrowser() {
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("fixture-session");
  vi.spyOn(Canary.prototype, "act").mockImplementation(async (_id, label) => ({
    url: "http://fixture/",
    snapshot: "textbox Name, button Save",
    ...(label.endsWith("assert") ? { actual: "Welcome Ada" } : {}),
  }));
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([
    "video.webm",
    "trace.zip",
  ]);
}
/**
 * La borne qu'une réservation doit couvrir pour l'envoi qu'elle précède : la
 * même mesure que `Model.inputTokenBound` — un demi-token par octet du corps
 * transmis, plus les marqueurs de rôle du gabarit de chat — et la sortie
 * maximale autorisée. Le prompt du fixture tient en un seul champ `content` par
 * message, donc le corps enregistré est exactement ce qui a été sérialisé.
 */
function sentReservation(request: Record<string, unknown>): number {
  const messages = request.messages as { content: string; role: string }[];
  return (
    (request.max_tokens as number) +
    Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 2) +
    64 * (messages.length + 1)
  );
}

/**
 * Exécute un script compilé contre un faux Playwright, comme le fait le daemon :
 * l'observation publiée par le script est relue depuis sa sortie, et son échec
 * éventuel remonte tel quel.
 */
async function runCompiledScript(
  script: string,
  page: Record<string, unknown>
): Promise<{
  failure: unknown;
  observation: { actual?: unknown; targetName?: string } | undefined;
}> {
  const logs: string[] = [];
  const context = {
    browser: { getPage: async () => page },
    console: { log: (line: string) => logs.push(line) },
  };
  let failure: unknown;
  try {
    await new Script(`(async () => { ${script} })()`, {
      filename: "compiled.js",
    }).runInNewContext(context);
  } catch (error) {
    failure = error;
  }
  const marker = logs.find((line) =>
    line.startsWith("CANARY_PR_QA_OBSERVATION:")
  );
  return {
    failure,
    observation: marker
      ? JSON.parse(marker.slice("CANARY_PR_QA_OBSERVATION:".length))
      : undefined,
  };
}

/**
 * Exécute le script compilé contre un faux Playwright, comme le fait le daemon :
 * seules les graphies listées existent, et leur méthode d'action échoue avec le
 * délai d'une cible introuvable, jamais avec un autre message.
 */
async function runTypographicAction(
  exposed: string[],
  name = "Justification de l'écart"
): Promise<{
  acted: string[];
  failure: unknown;
  observation: { targetName?: string } | undefined;
}> {
  const acted: string[] = [];
  const locator = (target: string) => ({
    count: async () => (exposed.includes(target) ? 1 : 0),
    fill: async () => {
      if (!exposed.includes(target)) {
        throw new Error(
          `Timeout 10000ms exceeded.\n  - waiting for getByRole("textbox", { name: ${JSON.stringify(target)} })`
        );
      }
      acted.push(target);
    },
  });
  const { failure, observation } = await runCompiledScript(
    compileAction(
      {
        type: "fill",
        locator: {
          by: "role",
          value: "textbox",
          name,
        },
        value: "Écart constaté",
      },
      "https://preview.test"
    ),
    {
      getByRole: (_role: string, options: { name: string }) =>
        locator(options.name),
      url: () => "https://preview.test/caisse",
      snapshotForAI: async () => ({ full: "" }),
    }
  );
  return { acted, failure, observation };
}

/**
 * Faux Playwright d'une page qui n'expose que les graphies listées : chaque
 * famille de locator (rôle, texte, placeholder) est indexée par la chaîne
 * exacte visée, et `isVisible()`/`count()` ne lèvent jamais, pas même sur un
 * locator vide — c'est ce silence que le repli doit devancer.
 */
function spellingPage(exposed: string[]) {
  const locator = (name: string) => ({
    count: async () => exposed.filter((item) => item === name).length,
    isVisible: async () => exposed.includes(name),
  });
  return {
    getByRole: (_role: string, options: { name: string }) =>
      locator(options.name),
    getByText: (value: string) => locator(value),
    getByPlaceholder: (value: string) => locator(value),
    url: () => "https://preview.test/caisse",
    snapshotForAI: async () => ({ full: "" }),
  };
}

/**
 * Faux Playwright d'un clic d'établissement. Chaque élément exposé est nommé ;
 * `waitFor` ne rend la main que si le délai DEMANDÉ couvre son apparition, et
 * lève sinon le délai Playwright d'une cible introuvable. Deux éléments
 * correspondants lèvent la violation de mode strict, comme la page réelle, dont
 * `locator.waitFor` est compilé avec `strict: true`. `getByLabel` ne résout rien :
 * le contrôle n'est atteignable que par son nom accessible.
 */
function establishingPage(elements: EstablishingElement[]) {
  const clicked: string[] = [];
  const locator = (targets: EstablishingElement[]): EstablishingLocator => ({
    targets,
    count: async () => targets.length,
    or: (other) => locator([...new Set([...targets, ...other.targets])]),
    waitFor: async ({ timeout }) => {
      if (targets.length !== 1) {
        throw targets.length === 0
          ? new Error(`Timeout ${timeout}ms exceeded.`)
          : new Error(
              `strict mode violation: locator resolved to ${targets.length} elements`
            );
      }
      if ((targets[0]!.appearsAfterMs ?? 0) > timeout) {
        throw new Error(`Timeout ${timeout}ms exceeded.`);
      }
    },
    click: async () => {
      if (targets.length !== 1) {
        throw new Error(
          `strict mode violation: locator resolved to ${targets.length} elements`
        );
      }
      clicked.push(targets[0]!.name);
    },
  });
  return {
    clicked,
    page: {
      getByLabel: () => locator([]),
      getByRole: (_role: string, options: { name: string }) =>
        locator(elements.filter((element) => element.name === options.name)),
      url: () => "https://preview.test/caisse",
      snapshotForAI: async () => ({ full: "" }),
    },
  };
}

/** Élément exposé par la page du faux Playwright, avec son délai d'apparition. */
interface EstablishingElement {
  appearsAfterMs?: number;
  name: string;
}

/** Locator du faux Playwright : ce que le script compilé appelle réellement. */
interface EstablishingLocator {
  click: (options: { timeout: number }) => Promise<void>;
  count: () => Promise<number>;
  or: (other: EstablishingLocator) => EstablishingLocator;
  targets: EstablishingElement[];
  waitFor: (options: { state: string; timeout: number }) => Promise<void>;
}

/**
 * Lecture compilée d'une assertion `visible`, `hidden` ou `count` contre une
 * page qui expose les graphies listées. Le verdict (`passed`) est celui que
 * l'exécuteur applique au `actual` lu, jamais un verdict recopié à la main.
 */
async function readSpelling(
  kind: "visible" | "hidden" | "count",
  target: Locator,
  exposed: string[],
  expected = 1
) {
  const assertion: Assertion =
    kind === "count"
      ? {
          id: "justification",
          kind: "count",
          description: "la justification de l'écart compte des éléments",
          expected,
          target,
        }
      : {
          id: "justification",
          kind,
          description: "la justification de l'écart est visible",
          target,
        };
  const { failure, observation } = await runCompiledScript(
    compileProbe(assertion, "https://preview.test"),
    spellingPage(exposed)
  );
  return {
    failure,
    observation,
    actual: observation?.actual,
    passed: assertionMatches(assertion, observation?.actual),
  };
}

/** Cible role+nom des lectures qui mesurent, partagée par les tests de graphie. */
const plannedTarget = {
  by: "role" as const,
  value: "textbox",
  name: "Justification de l'écart",
};

/**
 * Libellés français réels à trois puis quatre signes repliables : leur produit
 * (27 puis 81 graphies) dépassait l'ancien plafond de 16, donc la lecture
 * retombait sur la graphie brute en croyant mesurer.
 */
const THREE_SIGN_LABEL = "l'écart d'espèces n'est pas justifié";
const FOUR_SIGN_LABEL = "l'écart d'espèces n'est pas justifié par l'opérateur";

/** Même libellé écrit avec la graphie d'apostrophe indiquée (`’` par défaut). */
function spelled(label: string, apostrophe = "\u2019"): string {
  return label.replace(/'/g, apostrophe);
}

/** Même lecture, sur la cible role+nom historique. */
function runTypographicRead(
  kind: "visible" | "hidden" | "count",
  exposed: string[]
) {
  return readSpelling(kind, plannedTarget, exposed);
}

/**
 * Plan fautif du run 0cf58b5a : un clic `ifPresent` qui établit l'état de
 * départ, et aucune assertion rattachée à cette étape. Le run vivait l'état
 * ouvert sans jamais le prouver après un clic qui pouvait être sauté.
 */
function planWithoutEstablishingAssertion(): Plan {
  const faulty = structuredClone(plan);
  faulty.scenarios[0]!.steps.unshift({
    id: "ensure-open",
    description: "Reopen the counting session when it is closed",
    action: {
      type: "click",
      locator: { by: "role", value: "button", name: "Reopen the count" },
      ifPresent: true,
    },
  });
  return faulty;
}

/**
 * Plan fautif du run 1620bcfd : une étape `assert` qui cite un identifiant
 * d'assertion inexistant. Le gate refuse le plan, à juste titre.
 */
function planWithUnknownAssertion(): Plan {
  const faulty = structuredClone(plan);
  faulty.scenarios[0]!.steps.push({
    id: "verify-justification",
    description: "Verify the written justification",
    action: { type: "assert", assertionId: "justification-ecrite" },
  });
  return faulty;
}
/** La règle violée par `planWithoutEstablishingAssertion`, scénario et étape nommés. */
const IF_PRESENT_RULE =
  /Scenario welcome step ensure-open: ifPresent skips the step when its target is absent, so an assertion must verify the state it establishes: no assertion has afterStep ensure-open/;
/** La règle violée par `planWithUnknownAssertion`, scénario et étape nommés. */
const UNKNOWN_ASSERTION_RULE =
  /Scenario welcome step verify-justification: Unknown contract assertion/;
/**
 * Le même plan fautif servi à chaque appel : le JSON est lisible, c'est le PLAN
 * qui viole le contrat. Le run ne peut donc jamais obtenir un plan acceptable,
 * et ce qu'il en dit est exactement ce que l'opérateur lit.
 */
async function contractRefusal(faulty: () => Plan) {
  const f = await setup({ plans: [faulty(), faulty(), faulty()] });
  fakeBrowser();
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(result.outcome).toBe("blocked");
  // Le plan fautif n'est jamais exécuté : aucun scénario ne paie une étape.
  expect(result.scenarios).toEqual([]);
  return { f, result };
}
/**
 * Trois envois, comme aujourd'hui, mais aucun rejeu aveugle : chaque appel qui
 * suit un refus porte une correction qui nomme la règle et l'étape fautives.
 */
function expectCallsWithTargetedCorrection(
  f: Awaited<ReturnType<typeof fixture>>,
  result: Awaited<ReturnType<typeof runQa>>,
  rule: RegExp
) {
  expect(f.modelRequests).toHaveLength(3);
  expect(result.usage?.retries).toBe(0);
  const sent = (index: number) =>
    (f.modelRequests[index]!.messages as { content: string; role: string }[])
      .filter((item) => item.role === "user")
      .at(-1)!.content;
  expect(sent(1)).toContain("violates the contract");
  expect(sent(1)).not.toContain("last correction round");
  expect(sent(2)).toContain("violates the contract");
  expect(sent(2)).toMatch(rule);
  // Le dernier tour dit qu'il est le dernier : le troisième appel n'annonce
  // plus la même chose que le deuxième.
  expect(sent(2)).toContain("last correction round");
}

describe("exécution autoritaire : la reprise ne touche jamais un contrat", () => {
  it("n'essaie jamais de réparer une assertion, un observe ou un goto", async () => {
    // Une assertion est le contrat lui-même : la « réparer » changerait ce que le
    // test prouve. Seules les actions qui visent un élément peuvent être
    // rejouées, et seulement vers une cible réellement observée.
    for (const type of ["assert", "observe", "goto"] as const) {
      const actions = {
        assert: { assertionId: "a1", type: "assert" },
        goto: { path: "/", type: "goto" },
        observe: { type: "observe" },
      } as const;
      const step = { action: actions[type], description: type, id: "s1" };
      const repaired = await repairStepTarget({
        model: undefined,
        preview: "https://preview.test/",
        scenario: "s",
        step: step as never,
        targets: [{ label: "Save", role: "button" } as never],
      });
      expect(repaired).toBeUndefined();
    }
  });
});

describe("découverte : voir la page rendue, et le dire", () => {
  const URL_PREVIEW = "https://preview.example.test/";

  it("attend le travail de la page quand la découverte le demande", () => {
    const script = compileAction(
      { type: "goto", path: "/" },
      URL_PREVIEW,
      undefined,
      { hydrate: true }
    );
    expect(script).toContain('waitUntil: "load"');
    expect(script).toContain('waitForLoadState("networkidle"');
    expect(script).toContain("hydrated: true");
  });

  it("garde la navigation simple pour une étape de scénario", () => {
    const script = compileAction({ type: "goto", path: "/" }, URL_PREVIEW);
    expect(script).toContain('waitUntil: "domcontentloaded"');
    expect(script).not.toContain("networkidle");
    expect(script).toContain("hydrated: false");
  });

  it("publie la taille réelle de l'instantané et sa troncature", () => {
    // Sans ces deux nombres, un run ne peut pas distinguer « le contrôle n'existe
    // pas » de « le contrôle est au-delà des 14 000 caractères envoyés ».
    const script = compileAction({ type: "goto", path: "/" }, URL_PREVIEW);
    expect(script).toContain("snapshotChars: ariaSnapshot.length");
    expect(script).toContain("snapshotTruncated: ariaSnapshot.length > ");
  });
});

describe("validation and deterministic assertions", () => {
  it("supports an unnamed status role with its frozen assertion target", () => {
    const target = { by: "role" as const, value: "status", name: "" };
    const contract = structuredClone(plan);
    contract.scenarios[0]!.assertions[0]!.target = target;
    expect(
      PlanSchema.parse(contract).scenarios[0]!.assertions[0]!.target
    ).toEqual(target);
    expect(locatorExpression(target)).toContain('name: ""');
  });
  it("accepts only canonical GitHub PR URLs", () => {
    expect(parsePrUrl(PR_URL).repo).toBe("fixture/app");
    for (const url of [
      "https://github.com.evil.com/o/r/pull/1",
      "https://github.com/o/r/pull/0",
      `${PR_URL}?x=1`,
      "https://github.com/o/r/issues/1",
    ]) {
      expect(() => parsePrUrl(url)).toThrow();
    }
  });
  it("requires an explicit preview host allowlist and no credentials", () => {
    const config = loadConfig({ PREVIEW_ALLOWED_HOSTS: "preview.test" });
    expect(validatePreviewUrl("https://preview.test", config).hostname).toBe(
      "preview.test"
    );
    expect(() =>
      validatePreviewUrl("http://169.254.169.254", config)
    ).toThrow();
    expect(() =>
      validatePreviewUrl("https://user:pass@preview.test", config)
    ).toThrow();
  });
  it("defaults automatic runs to on with a 1800 s preview wait, and keeps the manual wait", () => {
    const config = loadConfig({ PREVIEW_ALLOWED_HOSTS: "preview.test" });
    expect(config.autoRuns).toBe(true);
    expect(config.QA_AUTO_PREVIEW_WAIT_SECONDS).toBe(1800);
    expect(config.QA_PREVIEW_WAIT_SECONDS).toBe(900);
    // Only the managed App connection sets `automaticRepos`; legacy mode leaves it unset.
    expect("automaticRepos" in config).toBe(false);
    const disabled = loadConfig({
      PREVIEW_ALLOWED_HOSTS: "preview.test",
      QA_AUTO_PREVIEW_WAIT_SECONDS: "60",
      QA_AUTO_RUNS: "false",
    });
    expect(disabled.autoRuns).toBe(false);
    expect(disabled.QA_AUTO_PREVIEW_WAIT_SECONDS).toBe(60);
    for (const wait of ["59", "86401"]) {
      expect(() =>
        loadConfig({
          PREVIEW_ALLOWED_HOSTS: "preview.test",
          QA_AUTO_PREVIEW_WAIT_SECONDS: wait,
        })
      ).toThrow();
    }
  });
  it("rejects arbitrary code, duplicate assertions, zero-assertion scenarios", () => {
    expect(() =>
      ActionSchema.parse({ type: "script", code: "process.exit()" })
    ).toThrow();
    const scenario = plan.scenarios[0]!;
    expect(() =>
      PlanSchema.parse({
        ...plan,
        scenarios: [{ ...scenario, assertions: [] }],
      })
    ).toThrow();
    expect(() =>
      PlanSchema.parse({
        ...plan,
        scenarios: [
          {
            ...scenario,
            assertions: [
              {
                id: "empty",
                description: "invalid oracle",
                kind: "text",
                expected: "  ",
              },
            ],
          },
        ],
      })
    ).toThrow();
    expect(() =>
      PlanSchema.parse({
        ...plan,
        scenarios: [
          {
            ...scenario,
            assertions: [scenario.assertions[0], scenario.assertions[0]],
          },
        ],
      })
    ).toThrow();
  });
  it("escapes model arguments as data, never executable JS", () => {
    const malicious = '"); throw new Error("pwned"); //';
    const expression = locatorExpression({ by: "css", value: malicious });
    expect(expression).toBe(`page.locator(${JSON.stringify(malicious)})`);
    expect(
      compileAction(
        {
          type: "fill",
          locator: { by: "css", value: "input" },
          value: malicious,
        },
        "https://preview.test"
      )
    ).toContain(`.fill(${JSON.stringify(malicious)}`);
    expect(() =>
      compileAction(
        { type: "goto", path: "https://elsewhere.test" },
        "https://preview.test"
      )
    ).toThrow();
    expect(() =>
      compileAction(
        { type: "assert", assertionId: "unknown" },
        "https://preview.test"
      )
    ).toThrow();
  });
  it("keeps the exact label as the target and retries it on the accessible name", () => {
    const target = { by: "label" as const, value: "Pharmacie active" };
    const strict = 'page.getByLabel("Pharmacie active", { exact: true })';
    // Le libellé exact reste la cible, avec son attente automatique complète.
    expect(locatorExpression(target)).toBe(strict);
    const call = locatorCall(
      target,
      'selectOption("DEMO18", { timeout: 10000 })'
    );
    // Le repli est un appel rejoué, jamais une décision prise sur un `count()`
    // immédiat : un contrôle homonyme déjà monté ne peut pas gagner contre le
    // contrôle visé qui n'est pas encore monté.
    expect(call).toContain(`resolveLabel(${strict}, ${strict}.or(`);
    expect(call).toMatch(
      /, \(locator\) => locator\.selectOption\("DEMO18", \{ timeout: 10000 \}\)\)$/
    );
    expect(call).not.toContain("count()");
    // Le libellé englobant d'un `<select>` inclut le texte de ses options :
    // l'union par nom accessible rattrape les cas pollués, `<select multiple>`
    // (rôle implicite `listbox`) compris.
    expect(call).toContain(
      'page.getByRole("combobox", { name: "Pharmacie active", exact: true })'
    );
    expect(call).toContain(
      'page.getByRole("listbox", { name: "Pharmacie active", exact: true })'
    );
    expect(call).toContain(
      'page.getByRole("textbox", { name: "Pharmacie active", exact: true })'
    );
    // Jamais de correspondance par sous-chaîne, et jamais un libellé sans
    // exactitude : un libellé qui contient la valeur ne doit pas être choisi.
    expect(call).not.toMatch(/getByLabel\("[^"]+"\)/);
    // Un locator d'un autre type n'est pas enveloppé.
    expect(
      locatorCall({ by: "css", value: "#nom" }, "click({ timeout: 10000 })")
    ).toBe('page.locator("#nom").click({ timeout: 10000 })');
    const command = compileAction(
      { type: "select", locator: target, value: "DEMO18" },
      "https://preview.test"
    );
    // Le repli n'est tenté qu'après un échec de résolution du libellé exact.
    expect(command).toContain("if (await strict.count()) throw error;");
    expect(command).toContain(`await ${call};`);
  });
  it("compiles every action into a syntactically valid script", () => {
    const label = { by: "label" as const, value: "Pharmacie active" };
    const css = { by: "css" as const, value: "#caisse" };
    // Un nom accessible avec apostrophe compile le repli typographique : sa
    // syntaxe est validée avec celle de toutes les autres actions.
    const named = {
      by: "role" as const,
      value: "textbox",
      name: "Justification de l'écart",
    };
    const assertion = plan.scenarios[0]!.assertions[0]!;
    const actions: Parameters<typeof compileAction>[0][] = [
      { type: "goto", path: "/" },
      { type: "observe" },
      { type: "click", locator: label, description: "cliquer" },
      { type: "click", locator: css, description: "cliquer" },
      { type: "click", locator: named, description: "cliquer" },
      { type: "fill", locator: label, value: "2", description: "saisir" },
      { type: "press", locator: label, key: "Enter", description: "valider" },
      {
        type: "select",
        locator: label,
        value: "DEMO18",
        description: "choisir",
      },
      { type: "check", locator: css, checked: true, description: "cocher" },
      { type: "download", locator: label, description: "télécharger" },
      { type: "popup", locator: label, description: "ouvrir" },
      { type: "popup", locator: named, description: "ouvrir" },
      { type: "assert", assertionId: assertion.id, locator: label },
      { type: "assert", assertionId: assertion.id, locator: css },
      { type: "assert", assertionId: assertion.id, locator: named },
    ] as Parameters<typeof compileAction>[0][];
    for (const action of actions) {
      const command = compileAction(action, "https://preview.test", assertion);
      const source = `(async () => {\n${command}\n})`;
      expect(() => new Script(source), action.type).not.toThrow();
    }
  });
  it("runs a label-targeted probe without reading the helper too early", async () => {
    // `compileProbe` remplace `let actual;` : la lecture du libellé s'exécute
    // avant la déclaration du helper, qui doit donc être hissé.
    const command = compileProbe(
      {
        id: "a",
        kind: "text",
        description: "comptage juste",
        expected: "Comptage juste",
        target: { by: "label", value: "Comptage juste" },
      },
      "https://preview.test"
    );
    let reads = 0;
    let snapshots = 0;
    const locator = {
      or: () => locator,
      count: async () => 1,
      innerText: async () => {
        reads += 1;
        return "Comptage juste";
      },
      inputValue: async () => "",
      isVisible: async () => true,
      screenshot: async () => new Uint8Array(),
    };
    const page = {
      getByLabel: () => locator,
      getByRole: () => locator,
      locator: () => locator,
      url: () => "https://preview.test/comptage",
      snapshotForAI: async () => {
        snapshots += 1;
        return { full: "" };
      },
    };
    const context = {
      browser: { getPage: async () => page },
      console: { log: () => undefined },
    };
    await new Script(`(async () => { ${command} })()`, {
      filename: "probe.js",
    }).runInNewContext(context);
    // Le probe a lu le libellé puis est allé au bout : aucune zone morte
    // temporelle, contrairement à une déclaration `const` du helper.
    expect(reads).toBe(1);
    expect(snapshots).toBe(1);
  });

  it("replie les graphies d'un signe, jamais le sens du nom", () => {
    const planned = "Justification de l'écart";
    expect(foldTypography("Justification de l’écart")).toBe(
      foldTypography(planned)
    );
    expect(foldTypography("Montant d’espèces\u00a0attendu")).toBe(
      foldTypography("Montant d'espèces attendu")
    );
    // La casse se replie comme les graphies : le relevé d'un nom introuvable la
    // nomme (`typographicCodepoints`), sinon il afficherait une parenthèse vide.
    expect(foldTypography("Quantité · Pièce de 20 €")).toBe(
      foldTypography("QUANTITÉ ⋅ PIÈCE de 20 €")
    );
    expect(typographicVariants(planned)).toEqual({
      planned,
      names: [
        "Justification de l‘écart",
        "Justification de l’écart",
        "justification de l'écart",
        "JUSTIFICATION DE L'ÉCART",
        "justification de l‘écart",
        "JUSTIFICATION DE L‘ÉCART",
        "justification de l’écart",
        "JUSTIFICATION DE L’ÉCART",
      ],
    });
    // Le point médian d'un libellé réel : le plan peut en recopier une autre
    // graphie, le repli les essaie toutes.
    expect(typographicVariants("Quantité · Pièce de 20 €").names).toContain(
      "Quantité ⋅ Pièce de 20 €"
    );
    expect(typographicVariants("Quantité · Pièce de 20 €").names).toContain(
      "QUANTITÉ · PIÈCE DE 20 €"
    );
    // Casse et signe portent chacun une équivalence : leur produit est le repli
    // exact d'un libellé qui diffère des deux à la fois.
    expect(typographicVariants("Quantité · Pièce de 20 €").names).toContain(
      "QUANTITÉ ⋅ PIÈCE DE 20 €"
    );
    expect(typographicVariants("Quantité · Pièce de 20 €").names).toContain(
      "quantité ⋅ pièce de 20 €"
    );
    expect(typographicCodepoints(planned, "Justification de l’écart")).toBe(
      "U+0027"
    );
    expect(typographicCodepoints("Justification de l’écart", planned)).toBe(
      "U+2019"
    );
    expect(
      typographicCodepoints(
        "Montant d'espèces attendu",
        "Montant d'espèces\u00a0attendu"
      )
    ).toBe("U+0020");
    expect(typographicCodepoints("Save", "save")).toBe("U+0053");
    // Un libellé sans lettre ni signe repliable garde son appel direct : la liste
    // vide dit « rien à replier », jamais « le repli a échoué ».
    expect(typographicVariants("12")).toEqual({
      planned: "12",
      names: [],
    });
  });

  it("borne le repli : espace ordinaire intact, plafond déclaré au lieu d'une liste vide", () => {
    // L'espace insécable revient à l'espace ordinaire, l'inverse n'est pas
    // énuméré : un nom compte plusieurs espaces et le produit exploserait.
    const variants = typographicVariants(
      "Montant d'espèces\u00a0attendu"
    ).names;
    expect(variants).toContain("Montant d'espèces attendu");
    expect(variants).toContain("Montant d’espèces attendu");
    expect(variants).not.toContain("Montant\u00a0d’espèces attendu");
    // Huit graphies de signes sous la casse du plan, plus les deux casses
    // uniformes de chacune : les deux apostrophes ne changent pas la casse des
    // lettres, et les minuscules se confondent avec la graphie du plan.
    expect(typographicVariants("l'l'").names).toHaveLength(17);
    // Trois signes repliables tiennent désormais dans le plafond : un libellé
    // français ordinaire n'est plus replié en silence.
    expect(typographicVariants("l'l'l'").names).toHaveLength(53);
    // Au-delà, l'énumération s'arrête et le déclare : une liste vide ne peut plus
    // se confondre avec « aucun signe repliable ».
    const saturated = typographicVariants("l'l'l'l'l'l'");
    expect(saturated.names).toEqual([]);
    expect(saturated.overflow).toEqual({
      signs: 6,
      variants: 729,
      ceiling: 256,
    });
  });

  it("vise l'élément réel quand la page n'expose qu'une autre graphie", async () => {
    const { acted, failure, observation } = await runTypographicAction([
      "Justification de l’écart",
    ]);
    // Le nom exact n'a rien résolu : le repli vise ce que la page expose, et le
    // nom réellement utilisé reste dans l'observation.
    expect(failure).toBeUndefined();
    expect(acted).toEqual(["Justification de l’écart"]);
    expect(observation?.targetName).toBe("Justification de l’écart");
  });

  it("vise la graphie exposée quand la casse et le signe diffèrent ensemble", async () => {
    // Un libellé réel de la caisse : le plan recopie le point médian du clavier
    // en minuscules mixtes, la page expose un opérateur mathématique tout en
    // majuscules. Ne combiner la casse qu'avec la graphie du plan laisse cette
    // cible sans repli, alors que chaque écart est déclaré équivalent.
    const { acted, failure, observation } = await runTypographicAction(
      ["QUANTITÉ ⋅ PIÈCE"],
      "Quantité · Pièce"
    );
    expect(failure).toBeUndefined();
    expect(acted).toEqual(["QUANTITÉ ⋅ PIÈCE"]);
    expect(observation?.targetName).toBe("QUANTITÉ ⋅ PIÈCE");
  });

  it("ne vise rien quand deux graphies concurrentes existent", async () => {
    const { acted, failure, observation } = await runTypographicAction([
      "Justification de l’écart",
      "Justification de l‘écart",
    ]);
    expect(String(failure)).toContain("Timeout 10000ms exceeded");
    expect(acted).toEqual([]);
    expect(observation).toBeUndefined();
  });

  it("n'essaie aucun repli quand le nom exact existe", async () => {
    const { acted, failure, observation } = await runTypographicAction([
      "Justification de l'écart",
    ]);
    expect(failure).toBeUndefined();
    expect(acted).toEqual(["Justification de l'écart"]);
    expect(observation?.targetName).toBeUndefined();
  });

  it("compile la lecture qui mesure sur la résolution du nom, jamais sur l'appel direct", () => {
    const target = {
      by: "role" as const,
      value: "textbox",
      name: "Justification de l'écart",
    };
    // `isVisible()` rend false sans lever et `count()` se lit sur le total des
    // graphies : la mesure doit passer par la résolution de la graphie exposée,
    // quand l'action attend l'échec de la graphie exacte.
    expect(locatorCall(target, "isVisible()", "measure")).toContain(
      "readSpelling("
    );
    expect(locatorCount(target)).toContain("countSpelling(");
    expect(locatorCall(target, "isVisible()")).toContain("resolveName(");
    expect(locatorCall(target, "click({ timeout: 10000 })")).toContain(
      "resolveName("
    );
    // Un texte et un placeholder exposent la même graphie décalée : leur mesure
    // résout elle aussi la graphie exposée, sans passer par le nom accessible.
    expect(
      locatorCall(
        { by: "text", value: "Justification de l'écart" },
        "isVisible()",
        "measure"
      )
    ).toContain("readSpelling(");
    expect(
      locatorCount({ by: "placeholder", value: "Justification de l'écart" })
    ).toContain("countSpelling(");
  });

  it("vise la graphie exposée avant de lire visibilité et compte", async () => {
    const exposed = ["Justification de l’écart"];
    const visible = await runTypographicRead("visible", exposed);
    expect(visible.failure).toBeUndefined();
    expect(visible.actual).toBe(true);
    expect(visible.passed).toBe(true);
    expect(visible.observation?.targetName).toBe(exposed[0]);
    const hidden = await runTypographicRead("hidden", exposed);
    // `actual` est la visibilité lue, `passed` le verdict de l'assertion :
    // l'élément est visible, donc « hidden » est faux au lieu de passer sur un
    // locator vide.
    expect(hidden.actual).toBe(true);
    expect(hidden.passed).toBe(false);
    expect(hidden.observation?.targetName).toBe(exposed[0]);
    const count = await runTypographicRead("count", exposed);
    expect(count.actual).toBe(1);
    expect(count.passed).toBe(true);
  });

  it("garde la lecture du nom exact quand il existe, sans repli", async () => {
    const exact = ["Justification de l'écart"];
    const visible = await runTypographicRead("visible", exact);
    expect(visible.actual).toBe(true);
    expect(visible.observation?.targetName).toBeUndefined();
    const hidden = await runTypographicRead("hidden", exact);
    expect(hidden.actual).toBe(true);
    expect(hidden.observation?.targetName).toBeUndefined();
    const count = await runTypographicRead("count", exact);
    expect(count.actual).toBe(1);
    expect(count.observation?.targetName).toBeUndefined();
  });

  it("garde la lecture honnête d'une cible réellement absente", async () => {
    // `hidden` et `count: 0` restent exprimables : sans repli possible, la
    // lecture du nom exact (0/false) est le verdict, pas une approximation.
    const visible = await runTypographicRead("visible", []);
    expect(visible.actual).toBe(false);
    expect(visible.passed).toBe(false);
    const hidden = await runTypographicRead("hidden", []);
    expect(hidden.actual).toBe(false);
    expect(hidden.passed).toBe(true);
    const count = await runTypographicRead("count", []);
    expect(count.actual).toBe(0);
    expect(count.passed).toBe(false);
  });

  it("refuse deux graphies concurrentes au lieu de mesurer un locator vide", async () => {
    for (const kind of ["visible", "hidden"] as const) {
      const read = await runTypographicRead(kind, [
        "Justification de l’écart",
        "Justification de l‘écart",
      ]);
      // L'ambiguïté est jetée sous forme d'objet : le bac à sable QuickJS perd
      // le message d'un `Error`, et le daemon lit `.message` sur ce qui remonte.
      const failure = read.failure as { message?: string; name?: string };
      expect(failure?.name, kind).toBe("AmbiguousTargetError");
      expect(String(failure?.message), kind).toContain(
        "Ambiguous accessible name"
      );
      expect(String(failure?.message), kind).toContain(
        '"Justification de l‘écart" (1) and "Justification de l’écart" (1)'
      );
      // Aucune lecture n'a eu lieu : rien n'est publié, donc aucun verdict
      // rendu sur un locator vide.
      expect(read.observation, kind).toBeUndefined();
    }
  });

  it("vise la graphie exposée d'un texte et d'un placeholder avant toute mesure", async () => {
    const exposed = "Justification de l’écart";
    for (const target of [
      { by: "text" as const, value: "Justification de l'écart" },
      { by: "placeholder" as const, value: "Justification de l'écart" },
    ]) {
      // Sans repli, `isVisible()` rendait false et `count()` 0 sur un locator
      // vide : « hidden » passait sur un texte pourtant affiché, et « visible »
      // échouait dessus. Les trois verdicts portent sur la graphie exposée.
      const visible = await readSpelling("visible", target, [exposed]);
      expect(visible.failure, target.by).toBeUndefined();
      expect(visible.actual, target.by).toBe(true);
      expect(visible.passed, target.by).toBe(true);
      expect(visible.observation?.targetName, target.by).toBe(exposed);
      const hidden = await readSpelling("hidden", target, [exposed]);
      expect(hidden.failure, target.by).toBeUndefined();
      expect(hidden.actual, target.by).toBe(true);
      expect(hidden.passed, target.by).toBe(false);
      expect(hidden.observation?.targetName, target.by).toBe(exposed);
      const count = await readSpelling("count", target, [exposed], 1);
      expect(count.failure, target.by).toBeUndefined();
      expect(count.actual, target.by).toBe(1);
      expect(count.passed, target.by).toBe(true);
      expect(count.observation?.targetName, target.by).toBe(exposed);
      // Un compte qui exige zéro ne passe pas sur un texte affiché.
      const zero = await readSpelling("count", target, [exposed], 0);
      expect(zero.actual, target.by).toBe(1);
      expect(zero.passed, target.by).toBe(false);
    }
  });

  it("compte les graphies d'un même signe sans exiger l'unicité", async () => {
    const shifted = ["Justification de l’écart", "Justification de l’écart"];
    for (const target of [
      plannedTarget,
      { by: "text" as const, value: "Justification de l'écart" },
      { by: "placeholder" as const, value: "Justification de l'écart" },
    ]) {
      // Deux éléments portant la graphie décalée : « count: 2 » est vrai, et
      // aucune ambiguïté n'est jetée — l'unicité n'a pas de sens pour un compte.
      const two = await readSpelling("count", target, shifted, 2);
      expect(two.failure, target.by).toBeUndefined();
      expect(two.actual, target.by).toBe(2);
      expect(two.passed, target.by).toBe(true);
      const three = await readSpelling(
        "count",
        target,
        [...shifted, "Justification de l‘écart"],
        2
      );
      // Un compte faux reste faux : trois éléments pour un compte de deux est
      // une assertion fausse, jamais une erreur d'ambiguïté.
      expect(three.failure, target.by).toBeUndefined();
      expect(three.actual, target.by).toBe(3);
      expect(three.passed, target.by).toBe(false);
    }
  });

  it("refuse deux graphies concurrentes d'un texte et d'un placeholder", async () => {
    for (const target of [
      { by: "text" as const, value: "Justification de l'écart" },
      { by: "placeholder" as const, value: "Justification de l'écart" },
    ]) {
      for (const kind of ["visible", "hidden"] as const) {
        const read = await readSpelling(kind, target, [
          "Justification de l’écart",
          "Justification de l‘écart",
        ]);
        const failure = read.failure as { message?: string; name?: string };
        expect(failure?.name, `${target.by} ${kind}`).toBe(
          "AmbiguousTargetError"
        );
        expect(String(failure?.message), `${target.by} ${kind}`).toContain(
          `Ambiguous ${target.by}`
        );
        expect(read.observation, `${target.by} ${kind}`).toBeUndefined();
      }
    }
  });

  it("mesure un libellé à deux, trois et quatre signes repliables sur la graphie exposée", async () => {
    // Le défaut mesuré : au-delà de deux apostrophes, le produit des graphies
    // dépassait l'ancien plafond de 16, `typographicVariants` rendait une liste
    // vide, et la lecture retombait sur la graphie brute — « hidden » passait
    // sur un texte affiché, « visible » et « count » échouaient dessus. Les trois
    // verdicts doivent porter sur la graphie que la page expose, pour chacun des
    // libellés ci-dessous.
    for (const label of [
      "l'écart d'espèces",
      THREE_SIGN_LABEL,
      FOUR_SIGN_LABEL,
    ]) {
      const exposed = spelled(label, "\u2019");
      for (const target of [
        { by: "role" as const, value: "textbox", name: label },
        { by: "text" as const, value: label },
        { by: "placeholder" as const, value: label },
      ]) {
        // La mesure passe bien par la résolution de la graphie, pas par l'appel
        // direct qui aurait rendu le verdict de la graphie brute.
        expect(locatorCall(target, "isVisible()", "measure"), label).toContain(
          "readSpelling("
        );
        expect(locatorCount(target), label).toContain("countSpelling(");
        const visible = await readSpelling("visible", target, [exposed]);
        expect(visible.failure, `${label} ${target.by}`).toBeUndefined();
        expect(visible.actual, `${label} ${target.by}`).toBe(true);
        expect(visible.passed, `${label} ${target.by}`).toBe(true);
        expect(visible.observation?.targetName, `${label} ${target.by}`).toBe(
          exposed
        );
        const hidden = await readSpelling("hidden", target, [exposed]);
        // Le texte est affiché : « hidden » est faux, jamais vrai sur un locator
        // vide.
        expect(hidden.actual, `${label} ${target.by}`).toBe(true);
        expect(hidden.passed, `${label} ${target.by}`).toBe(false);
        const count = await readSpelling("count", target, [exposed], 1);
        expect(count.actual, `${label} ${target.by}`).toBe(1);
        expect(count.passed, `${label} ${target.by}`).toBe(true);
      }
    }
  });

  it("refuse deux graphies concurrentes d'un libellé à trois signes, sans lire", async () => {
    // Deux graphies concurrentes : l'échec est explicite et aucune observation
    // n'est publiée, donc aucun verdict rendu sur un locator vide. La cible
    // role+nom suit la même règle.
    const targets = [
      { by: "role" as const, value: "textbox", name: THREE_SIGN_LABEL },
      { by: "text" as const, value: THREE_SIGN_LABEL },
      { by: "placeholder" as const, value: THREE_SIGN_LABEL },
    ];
    for (const target of targets) {
      const read = await readSpelling("hidden", target, [
        spelled(THREE_SIGN_LABEL, "\u2019"),
        spelled(THREE_SIGN_LABEL, "\u2018"),
      ]);
      const failure = read.failure as { message?: string; name?: string };
      expect(failure?.name, target.by).toBe("AmbiguousTargetError");
      expect(String(failure?.message), target.by).toContain("Ambiguous");
      expect(read.observation, target.by).toBeUndefined();
    }
  });

  it("lève au plafond de graphies au lieu de mesurer la graphie brute", async () => {
    // Six signes repliables dépassent le plafond : les graphies ne sont pas
    // énumérables, et la lecture le dit au lieu de rendre le verdict de la
    // graphie brute (qui aurait fait passer « hidden » sur la cible exposée).
    const saturated = "l'l'l'l'l'l'";
    const exposed = spelled(saturated, "\u2019");
    for (const kind of ["visible", "hidden"] as const) {
      for (const target of [
        { by: "text" as const, value: saturated },
        { by: "role" as const, value: "textbox", name: saturated },
      ]) {
        const read = await readSpelling(kind, target, [exposed]);
        const failure = read.failure as { message?: string; name?: string };
        expect(failure?.name, `${target.by} ${kind}`).toBe(
          "SpellingLimitError"
        );
        expect(String(failure?.message), `${target.by} ${kind}`).toContain(
          "6 foldable signs produce 729 competing spellings"
        );
        expect(String(failure?.message), `${target.by} ${kind}`).toContain(
          "ceiling of 256"
        );
        expect(read.observation, `${target.by} ${kind}`).toBeUndefined();
      }
    }
    // La graphie exacte reste lisible sans repli : le plafond ne condamne pas un
    // plan qui vise la graphie réellement exposée.
    const exact = await readSpelling(
      "visible",
      { by: "text", value: saturated },
      [saturated]
    );
    expect(exact.failure).toBeUndefined();
    expect(exact.actual).toBe(true);
    expect(exact.passed).toBe(true);
    // Un comptage ne peut pas prétendre à un total sans énumérer toutes les
    // graphies : il lève, au lieu d'un total tronqué qui aurait l'air mesuré.
    const count = await readSpelling(
      "count",
      { by: "text", value: saturated },
      [saturated],
      1
    );
    expect((count.failure as { name?: string })?.name).toBe(
      "SpellingLimitError"
    );
  });

  it("suit l'union du libellé avant de lire, au lieu d'un libellé exact vide", async () => {
    const union = {
      count: async () => 1,
      isVisible: async () => true,
      or() {
        return union;
      },
    };
    const strict = {
      count: async () => 0,
      isVisible: async () => false,
      or: () => union,
    };
    const { failure, observation } = await runCompiledScript(
      compileProbe(
        {
          id: "pharmacie",
          kind: "visible",
          description: "la pharmacie active est visible",
          target: { by: "label", value: "Pharmacie active" },
        },
        "https://preview.test"
      ),
      {
        getByLabel: () => strict,
        getByRole: () => union,
        url: () => "https://preview.test/caisse",
        snapshotForAI: async () => ({ full: "" }),
      }
    );
    expect(failure).toBeUndefined();
    expect(observation?.actual).toBe(true);
  });
  it("checks values, visibility, counts and text without model judgement", () => {
    expect(
      assertionMatches(
        {
          id: "a",
          kind: "text",
          description: "welcome",
          expected: "Welcome Ada",
        },
        " Welcome\nAda "
      )
    ).toBe(true);
    expect(
      assertionMatches(
        { id: "a", kind: "value", description: "exact", expected: "Ada" },
        "Adam"
      )
    ).toBe(false);
    expect(
      assertionMatches(
        { id: "a", kind: "visible", description: "exists" },
        "true"
      )
    ).toBe(false);
    expect(
      assertionMatches(
        { id: "a", kind: "count", description: "count", expected: 1 },
        2
      )
    ).toBe(false);
  });
});

describe("preview and PR provenance", () => {
  it("validates both header and JSON live SHA proofs", async () => {
    const f = await setup();
    expect((await verifyPreviewUrl(f.baseUrl, SHA, f.config)).sha).toBe(SHA);
    expect(
      (
        await verifyPreviewUrl(f.baseUrl, SHA, {
          ...f.config,
          PREVIEW_SHA_PATH: "/version.json",
        })
      ).sha
    ).toBe(SHA);
    await expect(
      verifyPreviewUrl(f.baseUrl, BASE_SHA, f.config)
    ).rejects.toThrow("mismatch");
  });
  it("rejects missing live proof and inactive GitHub deployments", async () => {
    const f = await setup({ noSha: true });
    await expect(verifyPreviewUrl(f.baseUrl, SHA, f.config)).rejects.toThrow(
      "missing provenance"
    );
    const gh = new GitHub(f.config);
    await expect(
      resolvePreview(await gh.context(PR_URL), gh, f.config)
    ).rejects.toThrow("No successful");
  });
  it("retrieves immutable head/base repository context", async () => {
    const f = await setup();
    const context = await new GitHub(f.config).context(PR_URL);
    expect(context.sha).toBe(SHA);
    expect(context.context.some((file) => file.ref === BASE_SHA)).toBe(true);
    expect(context.files[0]?.patch).toContain("Welcome");
  });
});

describe("runner false-green regressions", () => {
  it("blocks a scenario with no readable diff or source versions", async () => {
    const f = await setup({ missingDiffAndContext: true });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("CONTEXT_INCOMPLETE");
    // Le refus nommé atteint le planificateur avec les classes de couverture :
    // sans diff ni source, c'est lui qui explique l'impasse, et non le remède
    // inapplicable d'une classe de couverture.
    expect(JSON.stringify(f.modelRequests.at(-1))).toContain(
      "CONTEXT_INCOMPLETE"
    );
    expect(f.modelRequests).toHaveLength(2);
    expect(
      f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
        .state
    ).toBe("error");
    expect(result.scenarios).toEqual([]);
  }, 60_000);
  /** Ce que le fixture renvoie pour un commentaire réellement écrit. */
  const commentUrl = `${PR_URL}#issuecomment-1`;
  /**
   * Chaque forme de publication observée en production : le champ dit si le
   * rapport est sur la PR, `commitStatus` dit ce qui a réellement été écrit sur
   * le commit, et les états reçus par le fixture le confirment séparément. Un
   * échec du verdict de commit status ne fait donc jamais passer un rapport
   * publié pour « failed », et aucune forme d'échec ne laisse le champ absent.
   */
  const shapes: {
    /** Refus du fixture : le run se bloque avant de publier son rapport. */
    blockedFixture?: boolean;
    /** Écritures de commentaire qui échouent, par tour (1 = premier essai). */
    commentFails?: number[];
    /** URL du commentaire publié, absent quand le rapport n'est pas passé. */
    commentUrl?: string;
    commitStatus: string;
    /** Échec réel qui doit rester lisible dans `result.error`. */
    error?: string;
    /** Le post échoue après avoir écrit : c'est la réponse perdue. */
    lostResponse?: boolean;
    name: string;
    outcome: "blocked" | "passed";
    postedStates: string[];
    status: "published" | "failed";
    /** Écritures de commit status qui échouent, par état visé. */
    statusFails?: string[];
  }[] = [
    {
      blockedFixture: true,
      commitStatus: "error",
      commentUrl,
      name: "run bloqué, publication normale",
      outcome: "blocked",
      postedStates: ["pending", "error"],
      status: "published",
    },
    {
      commitStatus: "success",
      commentUrl,
      name: "run réussi, publication normale",
      outcome: "passed",
      postedStates: ["pending", "success"],
      status: "published",
    },
    {
      commentFails: [1],
      commitStatus: "error",
      commentUrl,
      lostResponse: true,
      name: "réponse du commentaire perdue",
      outcome: "blocked",
      postedStates: ["pending", "success", "error"],
      status: "published",
    },
    {
      commitStatus: "error",
      error: "GitHub publication failed",
      name: "le post de statut échoue avant tout commentaire",
      outcome: "blocked",
      postedStates: ["pending", "error"],
      status: "failed",
      statusFails: ["success"],
    },
    {
      commentFails: [1, 2],
      commitStatus: "error",
      error: "Blocked comment update failed",
      name: "les deux posts de commentaire échouent",
      outcome: "blocked",
      postedStates: ["pending", "success", "error"],
      status: "failed",
    },
    {
      commentFails: [1],
      commitStatus: "success",
      error: "Blocked status update failed",
      commentUrl,
      name: "le statut de reprise échoue, le commentaire est réparé",
      outcome: "blocked",
      postedStates: ["pending", "success"],
      status: "published",
      statusFails: ["error"],
    },
  ];
  it("records the publication issue apart from the commit status in every shape", async () => {
    const original = {
      comment: GitHub.prototype.comment,
      status: GitHub.prototype.status,
    };
    const script = {
      commentFails: [] as number[],
      lostResponse: false,
      statusFails: [] as string[],
    };
    let comments = 0;
    vi.spyOn(GitHub.prototype, "status").mockImplementation(async function (
      this: GitHub,
      ...args
    ) {
      if (script.statusFails.includes(String(args[1]))) {
        throw new Error(`Status ${args[1]} unavailable`);
      }
      return await original.status.apply(this, args);
    });
    vi.spyOn(GitHub.prototype, "comment").mockImplementation(async function (
      this: GitHub,
      ...args
    ) {
      comments += 1;
      if (script.commentFails.includes(comments)) {
        // Une réponse perdue suit une écriture réussie : le commentaire est sur
        // la PR, seul son accusé de réception manque.
        if (script.lostResponse) {
          await original.comment.apply(this, args);
        }
        throw new Error("Comment unavailable");
      }
      return await original.comment.apply(this, args);
    });
    fakeBrowser();
    for (const shape of shapes) {
      script.commentFails = shape.commentFails ?? [];
      script.lostResponse = shape.lostResponse ?? false;
      script.statusFails = shape.statusFails ?? [];
      comments = 0;
      const f = await setup(
        shape.blockedFixture ? { missingDiffAndContext: true } : undefined
      );
      const result = await runQa(
        { prUrl: PR_URL, previewUrl: f.baseUrl },
        f.config
      );
      expect(result.outcome, shape.name).toBe(shape.outcome);
      expect(result.publication?.status, shape.name).toBe(shape.status);
      expect(result.publication?.commentUrl, shape.name).toBe(shape.commentUrl);
      expect(result.publication?.commitStatus, shape.name).toBe(
        shape.commitStatus
      );
      expect(
        f.outgoing.map((request) => request.payload.state).filter(Boolean),
        shape.name
      ).toEqual(shape.postedStates);
      if (shape.error) {
        expect(result.error, shape.name).toContain(shape.error);
      }
    }
  }, 120_000);
  it("returns an ungrounded requirement to the planner before failing", async () => {
    const ungrounded = structuredClone(plan);
    ungrounded.scenarios[0]!.requirements[0]!.quote = "show('Welcome '+nom)";
    const f = await setup({ plans: [ungrounded, plan] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    // Le refus part au planificateur, qui dispose d'une tentative de correction
    // au lieu de faire échouer le run sur une citation recopiée de mémoire.
    const correction = JSON.stringify(f.modelRequests.at(-1));
    expect(correction).toContain("No source witness for welcome: src/form.ts");
    expect(correction).toContain(
      "Quote exact source or diff text; page content alone is not a requirement."
    );
    // La citation fautive est nommée : le planificateur sait laquelle de ses
    // exigences corriger, et la ligne survit à la troncature de `model.ts`.
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const rejected = "show('Welcome '+nom)";
    expect(messages.at(-1)!.content).toContain(
      `Rejected quote: ${JSON.stringify(rejected)}`
    );
    expect(f.modelRequests).toHaveLength(2);
    // Le plan corrigé passe le contrôle final et le contrat est joué.
    expect(result.outcome).toBe("passed");
    expect(result.scenarios[0]?.contract?.completedSteps).toEqual([
      "enter",
      "save",
      "verify",
    ]);
  });
  /**
   * Le refus d'une citation absente porte, en plus du remède, les lignes réelles
   * du fichier cité que le planificateur peut citer à la place : au plus deux,
   * chacune recopiée du fichier avec son numéro. Mesure du budget : la
   * correction complète, suggestion comprise, tient sous la troncature de
   * `model.ts` (2000) sur ce cas réel d'une citation absente.
   */
  it("returns real lines to quote instead of an absent quote", async () => {
    const invented = structuredClone(plan);
    invented.scenarios[0]!.requirements[0]!.quote =
      "show('Welcome '+nom) and save";
    const f = await setup({ plans: [invented, plan] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    expect(correction).toContain("No source witness for welcome: src/form.ts");
    // La ligne 1 du contenu de tête, fragment exact du fichier, est proposée avec
    // son numéro, et rien d'inventé n'y entre.
    expect(correction).toContain(
      `Real lines of src/form.ts to quote instead: 1: ${JSON.stringify("Use the Name textbox and Save button; status displays Welcome <name>")}`
    );
    // La correction n'est pas tronquée : le préambule fatal d'une citation
    // absente laisse la place à la suggestion.
    expect(correction.length).toBeLessThan(2000);
    expect(result.outcome).toBe("passed");
  }, 60_000);
  /**
   * Lot G, cas réel (run 925abf20, PR pharmania/arpilabe-pilotage#17) : le
   * planificateur a recollé deux attributs d'une même expression JSX en
   * supprimant ce qui les séparait. La citation n'existe nulle part, mais ses
   * deux fragments existent chacun sur une ligne réelle différente, et ces
   * lignes dépassent la borne d'une suggestion de ligne (120) : le recouvrement
   * de jetons ne proposait rien, et le planificateur ne recevait que le conseil
   * générique — qu'il a reproduit. Le refus doit nommer les deux fragments, leurs
   * deux lignes réelles et le texte exact à citer à leur place.
   */
  const STITCH_FRAGMENT_A = 'inputMode="decimal"';
  const STITCH_FRAGMENT_B = "aria-invalid={expected.ok?undefined:true}";
  const STITCHED_JSX_QUOTE = `${STITCH_FRAGMENT_A} ${STITCH_FRAGMENT_B}`;
  /** Les deux lignes réelles du fichier, chacune plus longue que 120 caractères. */
  const STITCH_FORM_PATCH = [
    "@@ -1,1 +1,3 @@",
    `+ <input value={e=>onChange({expected:e.target.value})} disabled={closed} ${STITCH_FRAGMENT_A} aria-label="Montant d'espèces attendu" />`,
    `+ <input value={expected.input} inputMode="numeric" aria-label="Total attendu" ${STITCH_FRAGMENT_B} />`,
    " show('Welcome '+name)",
  ].join("\n");
  it("names the stitched fragments and the real lines to quote instead", async () => {
    const stitched = structuredClone(plan);
    stitched.scenarios[0]!.requirements[0]!.quote = STITCHED_JSX_QUOTE;
    // Le plan corrigé cite un fragment EXACT de la première ligne réelle.
    const corrected = structuredClone(plan);
    corrected.scenarios[0]!.requirements[0]!.quote =
      `disabled={closed} ${STITCH_FRAGMENT_A}`;
    const f = await setup({
      formPatch: STITCH_FORM_PATCH,
      plans: [stitched, corrected],
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    expect(STITCHED_JSX_QUOTE).toHaveLength(61);
    expect(correction).toContain("No source witness for welcome: src/form.ts");
    // Le diagnostic nomme les DEUX fragments et la ligne réelle de chacun.
    expect(correction).toContain(
      `Your quote assembles fragments from different lines: ${JSON.stringify(STITCH_FRAGMENT_A)} is line 1, ${JSON.stringify(STITCH_FRAGMENT_B)} is line 2.`
    );
    // Et il propose les deux lignes réelles, recopiées du patch avec leur numéro.
    expect(correction).toContain(
      `1: ${JSON.stringify(`disabled={closed} ${STITCH_FRAGMENT_A} aria-label="Montant d'espèces attendu" />`)}`
    );
    expect(correction).toContain(
      `2: ${JSON.stringify(`value={expected.input} inputMode="numeric" aria-label="Total attendu" ${STITCH_FRAGMENT_B} />`)}`
    );
    // Il passe avant le conseil générique, et la correction n'est pas tronquée :
    // le planificateur lit le diagnostic entier dans sa tentative de réparation.
    expect(
      correction.indexOf("assembles fragments from different lines")
    ).toBeLessThan(correction.indexOf(UNGROUNDED_ABSENT_REMEDY));
    expect(correction.length).toBeLessThan(2000);
    // Le gate ne bouge pas : la citation recousue reste refusée, et le plan
    // corrigé — un fragment exact d'une ligne réelle — passe.
    expect(f.modelRequests).toHaveLength(2);
    expect(result.outcome).toBe("passed");
  }, 60_000);
  it("refuses the run when the corrected plan still cites without a witness", async () => {
    const ungrounded = structuredClone(plan);
    ungrounded.scenarios[0]!.requirements[0]!.quote = "show('Welcome '+nom)";
    const f = await setup({ plans: [ungrounded, ungrounded] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("REQUIREMENT_UNGROUNDED");
    expect(result.error).toBe(
      `No source witness for welcome: src/form.ts (requirement 1). Rejected quote: ${JSON.stringify("show('Welcome '+nom)")}`
    );
    expect(result.scenarios).toEqual([]);
    expect(
      f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
        .state
    ).toBe("error");
  });
  /**
   * Le plan du run 985c3de7, réduit à ce que son refus mesuré portait : six
   * identifiants et leurs préconditions réelles, sur le témoin du fixture.
   */
  function measuredPreconditionPlan() {
    const base = structuredClone(plan.scenarios[0]!);
    return {
      scenarios: LOT_W_PRECONDITIONS.map(({ id, preconditions }) => ({
        ...base,
        id,
        preconditions,
      })),
      skipped: [],
      summary: "rejeu du run 985c3de7",
    };
  }
  /**
   * Rejeu du run 985c3de7 : le plan a déclaré `role:Administrateur démo 1` et
   * `role:Pharmacie DEMO17 active`, deux bascules de profil visibles dans la page
   * de découverte, alors que le catalogue de confiance ne déclare rien. Le refus
   * d'alors — `Role Administrateur démo 1 missing` — arrivait à l'EXÉCUTION, une
   * fois le run payé, et ne nommait ni le catalogue vide ni la forme correcte.
   * Le planificateur reçoit maintenant ce refus pendant la planification et
   * dispose de sa tentative de correction.
   */
  it("returns an undeclared precondition to the planner before blocking", async () => {
    const invented = measuredPreconditionPlan();
    const corrected = structuredClone(invented);
    for (const scenario of corrected.scenarios) {
      scenario.preconditions = [];
    }
    const f = await setup({ plans: [invented, corrected] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    expect(correction).toContain("Preconditions no scenario can satisfy");
    for (const entry of LOT_W_PRECONDITIONS) {
      expect(correction).toContain(entry.id);
    }
    expect(correction).toContain("role:Pharmacie DEMO17 active");
    expect(correction).toContain(
      "The trusted catalog declares nothing for fixture/app"
    );
    // La voie de correction : la valeur observée dans la page se conduit par une
    // étape, pas par une précondition.
    expect(correction).toContain("is a step, not a precondition");
    expect(correction.length).toBeLessThan(2000);
    expect(f.modelRequests).toHaveLength(2);
    // Le run mesuré s'arrêtait sur six scénarios bloqués ; corrigé, il les joue.
    expect(result.outcome).toBe("passed");
    expect(result.scenarios).toHaveLength(LOT_W_PRECONDITIONS.length);
    for (const scenario of result.scenarios) {
      expect(scenario.outcome, scenario.error).toBe("passed");
    }
  });
  it("blocks an uncorrected precondition with the catalog it looked for", async () => {
    const invented = measuredPreconditionPlan();
    const f = await setup({ plans: [invented, invented] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    // Chaque scénario est arrêté avant toute étape navigateur, avec un diagnostic
    // nommé qui cite le catalogue consulté.
    expect(result.scenarios).toHaveLength(LOT_W_PRECONDITIONS.length);
    for (const scenario of result.scenarios) {
      expect(scenario.steps).toEqual([]);
      expect(scenario.diagnostic?.code).toBe("PRECONDITION_UNVERIFIED");
      expect(scenario.diagnostic?.message).toContain(
        "The trusted catalog declares nothing for fixture/app"
      );
      expect(scenario.diagnostic?.message).toContain(
        "role:Administrateur démo 1"
      );
      expect(scenario.diagnostic?.message).not.toContain(
        "Role Administrateur démo 1 missing"
      );
    }
  });
  /**
   * Défaut signalé par la revue interne : sur un fichier critique, une citation
   * exacte mais sans contenu visible bloquait le run en demandant de citer le
   * texte réel — que le planificateur renvoyait tel quel, gaspillant sa
   * tentative. La branche « Weak source witness » n'était couverte nulle part :
   * ce test l'exerce jusqu'à `runQa`, et la partie du message qui survit à la
   * troncature doit porter le remède juste.
   */
  const WEAK_WITNESS_QUOTE = "// ------ --";
  /**
   * Le patch de `src/form.ts` porte la citation faible et la citation témoin :
   * le plan faible est refusé pour la première, le plan corrigé passe avec la
   * seconde.
   */
  const WEAK_WITNESS_PATCH = `+ ${WEAK_WITNESS_QUOTE}\n+ show('Welcome '+name)`;
  it("returns a weak critical witness to the planner before failing", async () => {
    const weak = structuredClone(plan);
    weak.scenarios[0]!.requirements[0]!.quote = WEAK_WITNESS_QUOTE;
    const f = await setup({
      plans: [weak, weak],
      formPatch: WEAK_WITNESS_PATCH,
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    // Le contrôle final refuse le plan non corrigé, et aucun scénario ne part.
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("REQUIREMENT_UNGROUNDED");
    expect(result.scenarios).toEqual([]);
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    // Le remède juste vit dans le préambule fatal : la ligne dit que la
    // citation existe et demande une substance, jamais de citer le texte réel.
    expect(correction).toContain(UNGROUNDED_WEAK_REMEDY);
    expect(correction).not.toContain(UNGROUNDED_ABSENT_REMEDY);
    expect(correction).toContain(
      "Weak source witness for welcome: src/form.ts"
    );
    // Et la classe de couverture ne demande plus une citation déjà présente.
    expect(correction).not.toContain(
      "Add a requirement whose quote exists verbatim in each listed file."
    );
    const preludeEnd = correction.indexOf("Scenario welcome declares");
    expect(preludeEnd).toBeGreaterThan(0);
    expect(preludeEnd).toBeLessThanOrEqual(FATAL_PRELUDE_CHARS);
  }, 60_000);
  /**
   * La ligne du préambule est ce qui survivrait seul si les onze classes fatales
   * saturaient : mêlée aux autres, la classe `REQUIREMENT_UNGROUNDED` doit
   * encore porter le remède du témoin faible, entier, dans la partie non
   * tronquée.
   */
  it("keeps the weak witness remedy inside the saturated fatal prelude", async () => {
    const saturated = saturatedFatalCandidate();
    const [first] = saturated.scenarios;
    first!.sourceFiles.push("src/form.ts");
    first!.requirements[0] = {
      behavior: "The weak requirement is reviewed",
      quote: WEAK_WITNESS_QUOTE,
      sourceFile: "src/form.ts",
    };
    const f = await setup({
      plans: [saturated, plan],
      formPatch: WEAK_WITNESS_PATCH,
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    // Le message est tronqué à la fenêtre de `model.ts` : seule la tête survit.
    expect(correction).toHaveLength(2000);
    // Le remède du témoin faible, entier, passe avant la troncature.
    const lineEnd =
      correction.indexOf(UNGROUNDED_WEAK_REMEDY) +
      UNGROUNDED_WEAK_REMEDY.length;
    expect(correction).toContain(UNGROUNDED_WEAK_REMEDY);
    expect(lineEnd).toBeLessThan(2000);
  }, 60_000);
  /**
   * Défaut signalé par la vérification interne : sous onze classes fatales
   * saturées, le préambule borné repoussait le détail par exigence au-delà de la
   * troncature à 2000 de `model.ts`, donc la suggestion de ligne disparaissait
   * et le planificateur ne recevait plus que le conseil générique — exactement
   * ce que la suggestion devait éviter. Elle remplace ce conseil sur la ligne de
   * sa classe, que le préambule protège : elle survit, entière, dans le message
   * reçu.
   */
  it("keeps the suggested real line inside the saturated fatal prelude", async () => {
    const saturated = saturatedFatalCandidate();
    const [first] = saturated.scenarios;
    first!.sourceFiles.push("src/form.ts");
    first!.requirements[0] = {
      behavior: "The absent quote is replaced by a real line",
      quote: "show('Welcome '+nom) and save",
      sourceFile: "src/form.ts",
    };
    const f = await setup({ plans: [saturated, plan] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    const suggestion = `Real lines of src/form.ts to quote instead: 1: ${JSON.stringify("Use the Name textbox and Save button; status displays Welcome <name>")}.`;
    // Onze classes saturées : la correction est bien tronquée à la fenêtre de
    // `model.ts`.
    expect(correction).toHaveLength(2000);
    // La suggestion survit entière sur la ligne de sa classe, avant la
    // troncature, là où le détail par exigence qui la portait a disparu — et
    // elle y est appariée à sa citation, jamais posée à côté d'une autre.
    expect(correction).toContain(
      `REQUIREMENT_UNGROUNDED: ${JSON.stringify(quoteExcerpt("show('Welcome '+nom) and save"))} → ${suggestion}`
    );
    expect(correction.indexOf(suggestion) + suggestion.length).toBeLessThan(
      2000
    );
    // Elle a remplacé le conseil générique *pour cette citation* : le
    // planificateur ne reçoit plus le conseil generique à la place des lignes
    // réelles à citer de la citation qui en a.
    expect(correction).not.toContain(
      `${JSON.stringify(quoteExcerpt("show('Welcome '+nom) and save"))} → ${UNGROUNDED_ABSENT_REMEDY}`
    );
    // Le préambule complet tient sous son plafond mesuré : la suggestion comme
    // les dix autres lignes de classe survivent à la troncature.
    const preludeEnd = correction.indexOf("Scenario welcome declares");
    expect(preludeEnd).toBeGreaterThan(0);
    const preludeLength = preludeEnd - "Plan rejected: ".length - 1;
    expect(preludeLength).toBeLessThanOrEqual(FATAL_PRELUDE_CHARS);
    expect(FATAL_PRELUDE_CHARS - preludeLength).toBeGreaterThan(0);
  }, 60_000);
  /**
   * Pire cas mesuré avec le diagnostic de recousure : onze classes fatales
   * saturées et une citation recousue dont les deux fragments vivent sur deux
   * lignes réelles de plus de 120 caractères — deux candidats à la borne de la
   * suggestion (120 chacun). Le préambule fatal reste borné par
   * `FATAL_PRELUDE_CHARS` : le couplage citation/remède omet le segment qui ne
   * tient pas au lieu de dépasser le plafond, et aucune classe ne perd sa tête.
   */
  it("bounds the fatal prelude on the worst stitched quote", async () => {
    const saturated = saturatedFatalCandidate(STITCHED_JSX_QUOTE);
    const [first] = saturated.scenarios;
    first!.requirements[0] = {
      behavior: "The stitched quote is replaced by one real fragment",
      quote: STITCHED_JSX_QUOTE,
      sourceFile: "src/form.ts",
    };
    const f = await setup({
      formPatch: STITCH_FORM_PATCH,
      plans: [saturated, plan],
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    const preludeEnd = correction.indexOf("Scenario welcome declares");
    expect(preludeEnd).toBeGreaterThan(0);
    const preludeLength = preludeEnd - "Plan rejected: ".length - 1;
    expect(preludeLength).toBeLessThanOrEqual(FATAL_PRELUDE_CHARS);
    // Toutes les classes gardent leur tête sous onze classes saturées, y compris
    // la dernière : le diagnostic de recousure, long de deux candidats — deux
    // lignes réelles de plus de 120 caractères — ne tient pas dans la réserve
    // qui reste, donc sa classe retombe sur sa tête minimale, sans dépasser le
    // plafond ni pousser un message plus long que lui. C'est la même mesure que
    // pour le remède générique au plafond de ses deux lignes (`keeps every fatal
    // head when the first coupled remedy does not fit`) : 1756 caractères mesurés
    // ici, contre les 1860 de `FATAL_PRELUDE_CHARS`.
    expect(correction.slice(0, preludeLength)).not.toContain(
      "assembles fragments"
    );
    expect(correction).toContain(
      `REQUIREMENT_UNGROUNDED: Rejected quotes: ${JSON.stringify(quoteExcerpt(STITCHED_JSX_QUOTE))}`
    );
    for (const code of [
      "COVERAGE_WITNESS_MISSING",
      "COVERAGE_REQUIREMENT_SOURCE_MISSING",
      "REQUIREMENT_UNGROUNDED",
      "CRITICAL_COVERAGE_MISSING",
      "CONTEXT_INCOMPLETE",
      "CONTRACT_BUDGET",
      "PLAN_TOO_MANY_SCENARIOS",
      "PLAN_SCENARIO_ID_RESERVED",
      "PLAN_SOURCE_OUTSIDE_DIFF",
      "PLAN_SKIP_OUTSIDE_DIFF",
      "PLAN_CHANGED_FILE_UNCOVERED",
    ]) {
      expect(correction).toContain(`${code}: `);
    }
  }, 60_000);
  /**
   * Plan corrigé : le second fichier changé est déclaré et témoigné.
   */
  function secondFilePlan(): Plan {
    const corrected = structuredClone(plan);
    corrected.scenarios[0]!.sourceFiles.push("src/second.ts");
    corrected.scenarios[0]!.requirements.push({
      behavior: "The second changed file is reviewed",
      quote: SECOND_FILE_QUOTE,
      sourceFile: "src/second.ts",
    });
    return corrected;
  }
  /**
   * Finding de revue : quand la citation déclarée est absente du fichier cité
   * mais existe MOT POUR MOT dans un autre fichier du contexte, la ligne de
   * classe qui survit à la troncature doit proposer la réattribution, jamais une
   * autre ligne du fichier cité. Le patch de `src/form.ts` porte pourtant une
   * ligne qui recouvre la citation : l'envoyer consommerait la tentative de
   * correction du planificateur pour une preuve fausse.
   */
  it("reassigns a quote that lives in another file instead of proposing a line", async () => {
    const elsewhere = 'const witness = "second changed file witness value";';
    const saturated = saturatedFatalCandidate();
    const [first] = saturated.scenarios;
    first!.sourceFiles.push("src/form.ts");
    first!.requirements[0] = {
      behavior: "The quote exists in the other changed file",
      quote: elsewhere,
      sourceFile: "src/form.ts",
    };
    const f = await setup({
      plans: [saturated, secondFilePlan()],
      secondChangedFile: "src/second.ts",
      formPatch: `@@ -1,1 +1,2 @@\n+const witness = "other changed file witness value";\n+show('Welcome '+name)`,
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    // La réattribution remplace la ligne du fichier cité, jamais ajoutée à côté,
    // et elle reste appariée à la citation qu'elle répare : aucune autre
    // citation ne peut hériter du remède de celle-ci.
    expect(correction).toContain(
      `REQUIREMENT_UNGROUNDED: ${JSON.stringify(quoteExcerpt(elsewhere))} → The quote appears verbatim in src/second.ts; declare that file and attribute the requirement to it.`
    );
    expect(correction).not.toContain(
      `${JSON.stringify(quoteExcerpt(elsewhere))} → Real lines`
    );
    expect(correction).not.toContain("to quote instead");
  }, 60_000);
  /**
   * Résidu de vérification interne : chaque exigence fautive reçoit son remède
   * quand la place le permet. Deux citations absentes, chacune avec une ligne
   * réelle à citer : les deux suggestions survivent entières dans le préambule,
   * qui reste sous son plafond.
   */
  it("keeps one suggestion per faulty quote when the fatal prelude has room", async () => {
    const suggestionLine =
      "Use the Name textbox and Save button; status displays Welcome <name>";
    const saturated = saturatedFatalCandidate();
    const [first] = saturated.scenarios;
    first!.sourceFiles.push("src/form.ts", "src/second.ts");
    first!.requirements[0] = {
      behavior: "The absent quote is replaced by a real line",
      quote: "show('Welcome '+nom) and save",
      sourceFile: "src/form.ts",
    };
    first!.requirements.push({
      behavior: "The second absent quote is replaced by a real line",
      quote: "Use the Save button and textbox",
      sourceFile: "src/second.ts",
    });
    const f = await setup({
      plans: [saturated, secondFilePlan()],
      secondChangedFile: "src/second.ts",
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    const formSuggestion = `Real lines of src/form.ts to quote instead: 1: ${JSON.stringify(suggestionLine)}.`;
    const secondSuggestion = `Real lines of src/second.ts to quote instead: 1: ${JSON.stringify(suggestionLine)}.`;
    expect(correction).toContain(formSuggestion);
    expect(correction).toContain(secondSuggestion);
    // Les deux remèdes tiennent : aucun n'est annoncé par un compteur.
    expect(correction).not.toContain("more faulty quote");
    expect(correction).toHaveLength(2000);
    const preludeLength =
      correction.indexOf("Scenario welcome declares") -
      "Plan rejected: ".length -
      1;
    expect(preludeLength).toBeLessThanOrEqual(FATAL_PRELUDE_CHARS);
  }, 60_000);
  /**
   * Quand la place ne porte pas tous les remèdes, les fautes non montrées sont
   * annoncées par leur nombre : onze classes fatales saturées ne laissent tenir
   * qu'une suggestion, jamais un silence qui ferait croire qu'une seule
   * citation est fautive.
   */
  it("announces the faulty quotes whose remedy the fatal prelude cannot show", async () => {
    const suggestionLine =
      "Use the Name textbox and Save button; status displays Welcome <name>";
    const saturated = saturatedFatalCandidate();
    const [first] = saturated.scenarios;
    first!.sourceFiles.push("src/form.ts");
    first!.requirements[0] = {
      behavior: "The absent quote is replaced by a real line",
      quote: "show('Welcome '+nom) and save",
      sourceFile: "src/form.ts",
    };
    first!.requirements.push({
      behavior: "The second absent quote is replaced by a real line",
      quote: "Use the Save button and textbox",
      sourceFile: "src/second.ts",
    });
    const f = await setup({
      plans: [saturated, secondFilePlan()],
      secondChangedFile: "src/second.ts",
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    const formSuggestion = `Real lines of src/form.ts to quote instead: 1: ${JSON.stringify(suggestionLine)}.`;
    // La première suggestion survit, appariée à sa citation ; les fautes
    // suivantes sont comptées, pas perdues : la deuxième suggestion ne peut pas
    // se retrouver collée à la première citation.
    expect(correction).toContain(
      `REQUIREMENT_UNGROUNDED: ${JSON.stringify(quoteExcerpt("show('Welcome '+nom) and save"))} → ${formSuggestion} (+2 more faulty quotes)`
    );
    expect(correction).not.toContain(
      `REQUIREMENT_UNGROUNDED: ${JSON.stringify(quoteExcerpt("show('Welcome '+nom) and save"))} → Real lines of src/second.ts`
    );
    expect(correction).toHaveLength(2000);
    const preludeLength =
      correction.indexOf("Scenario welcome declares") -
      "Plan rejected: ".length -
      1;
    expect(preludeLength).toBeLessThanOrEqual(FATAL_PRELUDE_CHARS);
  }, 60_000);
  it("returns an unwitnessed source file to the planner before failing", async () => {
    const withoutWitness = structuredClone(plan);
    withoutWitness.scenarios[0]!.sourceFiles.push("src/second.ts");
    const corrected = structuredClone(plan);
    corrected.scenarios[0]!.sourceFiles.push("src/second.ts");
    corrected.scenarios[0]!.requirements.push({
      behavior: "The second changed file is reviewed",
      quote: SECOND_FILE_QUOTE,
      sourceFile: "src/second.ts",
    });
    const f = await setup({
      plans: [withoutWitness, corrected],
      secondChangedFile: "src/second.ts",
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    // Le refus nomme le scénario et le fichier au planificateur, qui corrige
    // dans la même tentative au lieu de laisser le gate final bloquer le run.
    const correction = JSON.stringify(f.modelRequests.at(-1));
    expect(correction).toContain(
      "Scenario welcome declares src/second.ts without a source requirement witness"
    );
    expect(correction).toContain(
      "Add a requirement whose quote exists verbatim in src/second.ts; this critical file cannot be dropped from sourceFiles without an approved skip in .canary/qa.json on the trusted base branch."
    );
    // Un chemin critique ne se voit jamais proposer le remède skip, que le
    // gate refuserait.
    expect(correction).not.toContain("list it in skipped");
    expect(f.modelRequests).toHaveLength(2);
    expect(result.outcome).toBe("passed");
  });
  it("blocks the run when the corrected plan still declares an unwitnessed file", async () => {
    const withoutWitness = structuredClone(plan);
    withoutWitness.scenarios[0]!.sourceFiles.push("src/second.ts");
    const f = await setup({
      plans: [withoutWitness, withoutWitness],
      secondChangedFile: "src/second.ts",
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("COVERAGE_WITNESS_MISSING");
    expect(result.error).toBe(
      "Scenario welcome declares src/second.ts without a source requirement witness"
    );
    expect(result.scenarios).toEqual([]);
  });
  it("returns a requirement attributed to an undeclared file to the planner", async () => {
    const misattributed = structuredClone(plan);
    misattributed.scenarios[0]!.requirements[0] = {
      behavior: "Save the name via the form",
      quote: "a quote the declared sources do not carry",
      sourceFile: "src/other.ts",
    };
    const corrected = structuredClone(plan);
    const f = await setup({ plans: [misattributed, corrected] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    // Le refus nomme le scénario et le fichier cité au planificateur : il
    // corrige sa liste de sources dans la même tentative au lieu de faire
    // échouer le run sur une erreur nue, hors du canal réparable.
    const correction = JSON.stringify(f.modelRequests.at(-1));
    expect(correction).toContain(
      "Scenario welcome attributes a requirement to src/other.ts, which it does not declare in sourceFiles"
    );
    expect(correction).toContain(
      "This PR does not change src/other.ts, so it cannot be declared: attribute the requirement to one of the files the scenario declares (src/form.ts)."
    );
    // Le remède refusé par la forme du plan n'est ni proposé au planificateur
    // ni montré à l'opérateur.
    expect(correction).not.toContain("Declare src/other.ts");
    expect(f.modelRequests).toHaveLength(2);
    expect(result.outcome).toBe("passed");
  });
  it("blocks the run when the corrected plan still attributes a requirement to an undeclared file", async () => {
    const misattributed = structuredClone(plan);
    misattributed.scenarios[0]!.requirements[0] = {
      behavior: "Save the name via the form",
      quote: "a quote the declared sources do not carry",
      sourceFile: "src/other.ts",
    };
    const f = await setup({ plans: [misattributed, misattributed] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("COVERAGE_REQUIREMENT_SOURCE_MISSING");
    expect(result.error).toContain("welcome");
    expect(result.error).toContain("src/other.ts");
    expect(result.scenarios).toEqual([]);
  });
  /**
   * Un candidat fautif par refus de forme du plan : le planificateur reçoit le
   * code nommé dans sa tentative de correction, et le plan corrigé passe.
   */
  function shapeRefusalCandidates(): { candidate: Plan; code: string }[] {
    const tooMany = structuredClone(plan);
    for (let index = tooMany.scenarios.length; index < 9; index++) {
      tooMany.scenarios.push({
        ...structuredClone(plan.scenarios[0]!),
        id: `extra-${index}`,
      });
    }
    const reserved = structuredClone(plan);
    reserved.scenarios[0]!.id = "_discovery";
    const cited = structuredClone(plan);
    cited.scenarios[0]!.sourceFiles.push("docs/outside.md");
    const skipped = structuredClone(plan);
    skipped.skipped = [
      {
        sourceFile: "lib/outside.ts",
        reason: "Not reachable from a browser scenario",
      },
    ];
    const uncovered = structuredClone(plan);
    uncovered.scenarios = [];
    return [
      { candidate: tooMany, code: "PLAN_TOO_MANY_SCENARIOS" },
      { candidate: reserved, code: "PLAN_SCENARIO_ID_RESERVED" },
      { candidate: cited, code: "PLAN_SOURCE_OUTSIDE_DIFF" },
      { candidate: skipped, code: "PLAN_SKIP_OUTSIDE_DIFF" },
      { candidate: uncovered, code: "PLAN_CHANGED_FILE_UNCOVERED" },
    ];
  }
  it.each(
    shapeRefusalCandidates()
  )("returns the named refusal $code to the planner, then passes the corrected plan", async ({
    candidate,
    code,
  }) => {
    const f = await setup({ plans: [candidate, plan] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const correction = JSON.stringify(f.modelRequests.at(-1));
    expect(correction).toContain(code);
    expect(f.modelRequests).toHaveLength(2);
    expect(result.outcome).toBe("passed");
  }, 60_000);
  it.each(
    shapeRefusalCandidates()
  )("blocks an uncorrected plan with the named refusal $code, without executing a scenario", async ({
    candidate,
    code,
  }) => {
    const f = await setup({ plans: [candidate, candidate] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe(code);
    expect(result.scenarios).toEqual([]);
  }, 60_000);
  it("names the coverage refusal when a plan also cites a file outside the diff", async () => {
    const cumulative = structuredClone(plan);
    cumulative.scenarios[0]!.sourceFiles.push("docs/outside.md");
    cumulative.scenarios[0]!.requirements.push({
      behavior: "The requirement belongs to an undeclared source",
      quote: "a quote the declared sources do not carry",
      sourceFile: "src/undeclared.ts",
    });
    const f = await setup({ plans: [cumulative, cumulative] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    // Le refus nommé et réparable du canal de couverture n'est plus masqué par
    // la forme du plan : le cumul ne finit plus en QA_ERROR anonyme.
    expect(result.diagnostic?.code).toBe("COVERAGE_REQUIREMENT_SOURCE_MISSING");
    expect(result.outcome).toBe("blocked");
    expect(result.scenarios).toEqual([]);
    // Les deux classes fatales ont été montrées au planificateur dans la même
    // tentative de correction.
    const correction = JSON.stringify(f.modelRequests.at(-1));
    expect(correction).toContain("COVERAGE_REQUIREMENT_SOURCE_MISSING");
    expect(correction).toContain("PLAN_SOURCE_OUTSIDE_DIFF");
  });
  it("keeps both fatal refusal classes inside the truncated correction", async () => {
    const flooded = structuredClone(plan);
    const [scenario] = flooded.scenarios;
    for (let index = 0; index < 28; index++) {
      scenario!.sourceFiles.push(`src/no-witness-${index}.ts`);
    }
    scenario!.requirements.push({
      behavior: "The requirement belongs to an undeclared source",
      quote: "a quote the declared sources do not carry",
      sourceFile: "src/undeclared.ts",
    });
    const f = await setup({ plans: [flooded, plan] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const request = f.modelRequests.at(-1)!;
    const messages = request.messages as { content: string; role: string }[];
    const correction = messages.at(-1)!.content;
    // Le message de correction est bien tronqué à 2000 caractères...
    expect(correction).toHaveLength(2000);
    // ...et les deux classes fatales y survivent, agrégées en tête de message,
    // même quand les chemins sans témoin remplissent à eux seuls la fin utile.
    expect(correction).toContain("COVERAGE_WITNESS_MISSING");
    expect(correction).toContain("COVERAGE_REQUIREMENT_SOURCE_MISSING");
    expect(correction).not.toContain("src/no-witness-27.ts");
  });
  /**
   * Chaque classe fatale du canal de correction, saturée : les onze classes
   * (couverture, contexte, budget, forme) portent leurs entrées fautives en
   * même temps, et le préambule fatal doit tenir dans la troncature à 2000
   * caractères de `model.ts` — codes compris — sans perdre la dernière classe.
   */
  function saturatedFatalCandidate(
    firstUngroundedQuote = "a quote the fixture diff does not carry"
  ): Plan {
    const saturated = structuredClone(plan);
    const [first] = saturated.scenarios;
    first!.sourceFiles = Array.from(
      { length: 6 },
      (_, index) => `src/no-witness-${index}.ts`
    );
    first!.requirements.push(
      ...Array.from({ length: 7 }, (_, index) => ({
        behavior: "The requirement belongs to an undeclared source",
        quote:
          index === 0
            ? firstUngroundedQuote
            : "a quote the fixture diff does not carry",
        sourceFile: `src/undeclared-${index}.ts`,
      }))
    );
    for (let index = 0; index < 22; index++) {
      first!.steps.push({
        description: "Observe the page",
        id: `warmup-${index}`,
        action: { type: "observe" as const },
      });
    }
    saturated.skipped = Array.from({ length: 7 }, (_, index) => ({
      reason: "Not reachable from a browser scenario",
      sourceFile: `src/other-${index}.ts`,
    }));
    for (let index = 1; index < 13; index++) {
      saturated.scenarios.push({
        ...structuredClone(plan.scenarios[0]!),
        id: index === 1 ? "_discovery" : `extra-${index}`,
        requirements: [
          {
            behavior: "The requirement belongs to an undeclared source",
            quote: "a quote the fixture diff does not carry",
            sourceFile: `src/clone-${index}.ts`,
          },
        ],
        sourceFiles: [`src/clone-${index}.ts`],
      });
    }
    return saturated;
  }
  it("bounds the whole fatal prelude inside the truncated correction", async () => {
    const f = await setup({ plans: [saturatedFatalCandidate(), plan] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const request = f.modelRequests.at(-1)!;
    const messages = request.messages as { content: string; role: string }[];
    const correction = messages.at(-1)!.content;
    // Onze classes fatales saturées dépassent largement la fenêtre : la
    // correction est bien tronquée à 2000 caractères.
    expect(correction).toHaveLength(2000);
    expect(correction.startsWith("Plan rejected: Fatal refusals")).toBe(true);
    // L'en-tête nomme d'abord tous les codes fatals : chacun survit à la
    // troncature, y compris PLAN_SCENARIO_ID_RESERVED et les suivants.
    expect(correction).toContain(
      "Fatal refusals (each one blocks the whole run): COVERAGE_WITNESS_MISSING, COVERAGE_REQUIREMENT_SOURCE_MISSING, REQUIREMENT_UNGROUNDED, CRITICAL_COVERAGE_MISSING, CONTEXT_INCOMPLETE, CONTRACT_BUDGET, PLAN_TOO_MANY_SCENARIOS, PLAN_SCENARIO_ID_RESERVED, PLAN_SOURCE_OUTSIDE_DIFF, PLAN_SKIP_OUTSIDE_DIFF, PLAN_CHANGED_FILE_UNCOVERED."
    );
    // Et chaque classe reçoit encore sa ligne bornée : l'en-tête ne remplace pas
    // les remèdes, il les protège. La dernière classe est le témoin du bornage
    // global — sa ligne n'existerait pas sous les bornes par classe.
    expect(correction).toContain("PLAN_CHANGED_FILE_UNCOVERED: ");
    const preludeEnd = correction.indexOf("Scenario welcome declares");
    expect(preludeEnd).toBeGreaterThan(0);
    expect(preludeEnd).toBeLessThan(1900);
  }, 60_000);
  /**
   * Défaut signalé par la revue de la PR #63 : un refus de précondition garanti
   * dans SON budget de 1 500 caractères ne l'était pas dans la correction, parce
   * que le préambule fatal (1 860) puis les citations non fondées le précédaient.
   * Sous onze classes fatales saturées ET une précondition absente, le refus de
   * précondition passe donc en tête de la correction : il reste lisible dans la
   * fenêtre de 2 000, entier, avec son catalogue et son remède. Replacé derrière
   * le préambule, ce test tombe.
   */
  it("keeps the precondition refusal ahead of a saturated fatal prelude", async () => {
    const saturated = saturatedFatalCandidate();
    saturated.scenarios[0]!.preconditions = ["role:Administrateur démo 1"];
    const f = await setup({ plans: [saturated, plan] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    // Le préambule fatal sature à lui seul la fenêtre : la correction est
    // tronquée.
    expect(correction).toHaveLength(2000);
    // Le refus de précondition est en tête, avant tout diagnostic.
    expect(
      correction.startsWith(
        "Plan rejected: Preconditions no scenario can satisfy"
      )
    ).toBe(true);
    // Ce que le catalogue porte et le remède qui débloque le plan y sont, dans
    // la fenêtre, alors qu'ils disparaîtraient derrière les 1 860 caractères du
    // préambule.
    const catalogue = correction.indexOf(
      "The trusted catalog declares nothing for fixture/app"
    );
    const remedy = correction.indexOf("is a step, not a precondition");
    expect(catalogue).toBeGreaterThan(0);
    expect(remedy).toBeGreaterThan(catalogue);
    // L'en-tête du préambule fatal reste visible derrière le refus, donc le
    // planificateur lit encore les codes fatals que sa correction doit couvrir.
    expect(correction).toContain(
      "Fatal refusals (each one blocks the whole run):"
    );
  }, 60_000);
  /**
   * La citation fautive est le détail que le planificateur doit lire : elle
   * passe en tête de la ligne de sa classe, avant le remède et les valeurs
   * fautives, et le préambule réserve la place de son extrait entier avant de
   * distribuer les valeurs. La citation survit donc à la troncature à 2000 de
   * `model.ts` ; onze classes saturées, le maximum constructible, sont testées
   * juste après.
   */
  it("keeps the rejected quote on its fatal line under eight saturated classes", async () => {
    const invented = `the plan invented ${"x".repeat(100)} tail`;
    const saturated = structuredClone(plan);
    const [first] = saturated.scenarios;
    first!.sourceFiles.push("src/no-witness.ts");
    first!.requirements.push({
      behavior: "The requirement belongs to an undeclared source",
      quote: invented,
      sourceFile: "src/undeclared.ts",
    });
    for (let index = 0; index < 22; index++) {
      first!.steps.push({
        description: "Observe the page",
        id: `warmup-${index}`,
        action: { type: "observe" as const },
      });
    }
    saturated.skipped = [
      {
        reason: "Not reachable from a browser scenario",
        sourceFile: "src/second.ts",
      },
    ];
    for (let index = 1; index < 9; index++) {
      saturated.scenarios.push({
        ...structuredClone(saturated.scenarios[0]!),
        id: `extra-${index}`,
      });
    }
    const corrected = structuredClone(plan);
    corrected.scenarios[0]!.sourceFiles.push("src/second.ts");
    corrected.scenarios[0]!.requirements.push({
      behavior: "The second changed file is reviewed",
      quote: SECOND_FILE_QUOTE,
      sourceFile: "src/second.ts",
    });
    const f = await setup({
      plans: [saturated, corrected],
      secondChangedFile: "src/second.ts",
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    // Huit classes fatales saturées : la correction est bien tronquée à 2000.
    expect(correction).toHaveLength(2000);
    const header = correction.slice(
      correction.indexOf("): ") + 3,
      correction.indexOf(".")
    );
    expect(header.split(", ")).toEqual([
      "COVERAGE_WITNESS_MISSING",
      "COVERAGE_REQUIREMENT_SOURCE_MISSING",
      "REQUIREMENT_UNGROUNDED",
      "CRITICAL_COVERAGE_MISSING",
      "CONTEXT_INCOMPLETE",
      "CONTRACT_BUDGET",
      "PLAN_TOO_MANY_SCENARIOS",
      "PLAN_SOURCE_OUTSIDE_DIFF",
    ]);
    // L'extrait entier, non rogné, précède le remède de sa citation.
    expect(correction).toContain(
      `REQUIREMENT_UNGROUNDED: ${JSON.stringify(quoteExcerpt(invented))} → `
    );
  }, 60_000);
  /**
   * Le garant doit tenir jusqu'au maximum réellement constructible : onze
   * classes fatales saturées (`saturatedFatalCandidate`). Chaque citation
   * fautive est appariée à son remède — ici le conseil générique, puisque
   * l'extrait inventé n'existe nulle part — et le préambule complet tient sous
   * son plafond : une citation longue n'est plus coupée au milieu et la
   * dernière classe fatale survit.
   */
  it("keeps the rejected quote and its remedy at eleven saturated fatal classes", async () => {
    const invented = `the plan invented ${"x".repeat(100)} tail`;
    const f = await setup({ plans: [saturatedFatalCandidate(invented), plan] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    expect(correction).toHaveLength(2000);
    // La citation entière, non rognée, puis son remède, dans le même segment ;
    // la seconde citation fautive est annoncée explicitement, jamais perdue.
    expect(correction).toContain(
      `REQUIREMENT_UNGROUNDED: ${JSON.stringify(quoteExcerpt(invented))} → Quote exact source or diff text; page content alone is not a requirement. (+1 more faulty quote)`
    );
    // Marge mesurée : le préambule complet tient sous `FATAL_PRELUDE_CHARS`, donc
    // la citation et son remède finissent avant la troncature de `model.ts`. Les
    // onze classes saturées laissent 47 caractères de réserve au-dessus des têtes
    // minimales — l'extrait de 120 et le conseil générique, eux, sont comptés
    // dans les têtes et non dans cette réserve.
    const preludeEnd = correction.indexOf("Scenario welcome declares");
    expect(preludeEnd).toBeGreaterThan(0);
    const preludeLength = preludeEnd - "Plan rejected: ".length - 1;
    expect(preludeLength).toBeLessThanOrEqual(FATAL_PRELUDE_CHARS);
    expect(FATAL_PRELUDE_CHARS - preludeLength).toBeGreaterThan(0);
  }, 60_000);
  /**
   * Deux exigences fautives distinctes : la ligne nomme chaque citation entière
   * et l'apparie à son remède — jamais une ligne partagée qui perd tout après la
   * première, ni un remède posé à côté d'une citation qui n'est pas la sienne.
   */
  it("names each faulty quote and announces the ones it does not show", async () => {
    const first = "the first invented quote witness";
    const second = "the second invented quote witness";
    const faulty = structuredClone(plan);
    faulty.scenarios[0]!.requirements = [
      {
        behavior: "The first invented source is changed",
        quote: first,
        sourceFile: "src/form.ts",
      },
      {
        behavior: "The second invented source is changed",
        quote: second,
        sourceFile: "src/form.ts",
      },
    ];
    const f = await setup({ plans: [faulty, plan] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    // Les deux citations tiennent ici, chacune appariée à son propre remède :
    // aucun compteur, et aucun remède posé à côté d'une citation qui n'est pas
    // la sienne.
    expect(correction).toContain(
      `REQUIREMENT_UNGROUNDED: ${JSON.stringify(quoteExcerpt(first))} → Quote exact source or diff text; page content alone is not a requirement.; ${JSON.stringify(quoteExcerpt(second))} → Quote exact source or diff text; page content alone is not a requirement.`
    );
  }, 60_000);
  /**
   * Défaut signalé par la revue : la ligne agrégée nommait les citations dans un
   * ordre et présentait les remèdes dans un autre — le témoin faible, exclu des
   * remèdes précis, décalait la liste et le remède de la seconde citation se
   * retrouvait collé à la première. Chaque segment nomme désormais sa citation
   * puis le remède qui la concerne.
   */
  it("never attaches the remedy of one faulty quote to another", async () => {
    const absent = "show('Welcome '+nom) and save";
    const faulty = structuredClone(plan);
    faulty.scenarios[0]!.requirements = [
      {
        behavior: "The weak witness is reviewed",
        quote: WEAK_WITNESS_QUOTE,
        sourceFile: "src/form.ts",
      },
      {
        behavior: "The absent quote is replaced by a real line",
        quote: absent,
        sourceFile: "src/form.ts",
      },
    ];
    const f = await setup({
      plans: [faulty, plan],
      formPatch: WEAK_WITNESS_PATCH,
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    const suggestion = `Real lines of src/form.ts to quote instead: 1: ${JSON.stringify("Use the Name textbox and Save button; status displays Welcome <name>")}.`;
    // Chaque citation est appariée à son propre remède, dans l'ordre du plan.
    expect(correction).toContain(
      `REQUIREMENT_UNGROUNDED: ${JSON.stringify(quoteExcerpt(WEAK_WITNESS_QUOTE))} → ${UNGROUNDED_WEAK_REMEDY}; ${JSON.stringify(quoteExcerpt(absent))} → ${suggestion}`
    );
    // Le remède de la seconde citation n'est jamais reporté sur la première — le
    // témoin faible, lui, reçoit le conseil de son propre défaut.
    expect(correction).not.toContain(
      `${JSON.stringify(quoteExcerpt(WEAK_WITNESS_QUOTE))} → ${suggestion}`
    );
  }, 60_000);
  /**
   * Trois exigences fautives distinctes, deux remèdes qui tiennent dans la
   * réserve : chacun reste apparié à sa citation, dans l'ordre du plan et avec la
   * ligne de son propre fichier, et la troisième est annoncée par son nombre.
   * Un segment ne peut donc pas porter le remède d'une autre citation que la
   * sienne, même tronqué. Cinq scénarios saturés laissent la réserve porter les
   * deux premiers segments (120 caractères chacun) et pas le troisième (288), qui
   * n'aurait pas la place de s'afficher entier.
   */
  it("couples each shown remedy to its own quote when only two fit", async () => {
    const quote = (marker: string) => `${marker} token one ${marker} token one`;
    const long = "z".repeat(60);
    const line = (marker: string) => `const ${marker} = "${marker} token one";`;
    const longLine = (marker: string) =>
      `const ${marker} = "eta token one eta end ${long}";`;
    const saturated = saturatedFatalCandidate(quote("alpha"));
    saturated.scenarios = saturated.scenarios.slice(0, 5);
    const [first] = saturated.scenarios;
    first!.requirements = ["alpha", "delta", "eta"].map((marker) => ({
      behavior: "The absent quote is replaced by real lines",
      quote: quote(marker),
      sourceFile: "src/form.ts",
    }));
    // Les scénarios saturés reprennent la première faute à l'identique : elle ne
    // compte qu'une fois, donc la place ne décide qu'entre trois fautes.
    for (const scenario of saturated.scenarios.slice(1)) {
      scenario.requirements = [
        {
          behavior: "The absent quote is replaced by real lines",
          quote: quote("alpha"),
          sourceFile: "src/form.ts",
        },
      ];
    }
    const f = await setup({
      plans: [saturated, plan],
      formPatch: `@@ -1,1 +1,5 @@\n+${line("alpha")}\n+${line("delta")}\n+${longLine("eta")}\n+${longLine("iota")}\n+show('Welcome '+name)`,
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    // Le remède de chaque citation vient de sa propre citation : la ligne 1 du
    // fichier cité pour la première, la ligne 2 pour la seconde.
    expect(correction).toContain(
      `REQUIREMENT_UNGROUNDED: ${JSON.stringify(quoteExcerpt(quote("alpha")))} → Real lines of src/form.ts to quote instead: 1: ${JSON.stringify(line("alpha"))}.; ${JSON.stringify(quoteExcerpt(quote("delta")))} → Real lines of src/form.ts to quote instead: 2: ${JSON.stringify(line("delta"))}. (+1 more faulty quote)`
    );
    // Le remède de la troisième faute n'est collé à aucune autre citation : elle
    // est comptée, jamais servie avec le mauvais extrait.
    expect(correction).not.toContain(
      `${JSON.stringify(quoteExcerpt(quote("alpha")))} → Real lines of src/form.ts to quote instead: 3:`
    );
    expect(correction).not.toContain(`3: ${JSON.stringify(longLine("eta"))}`);
    const preludeEnd = correction.indexOf("Scenario welcome declares");
    expect(preludeEnd).toBeGreaterThan(0);
    expect(preludeEnd - "Plan rejected: ".length - 1).toBeLessThanOrEqual(
      FATAL_PRELUDE_CHARS
    );
  }, 60_000);
  /**
   * Pire configuration réellement constructible : onze classes fatales saturées,
   * une citation dont l'extrait atteint son plafond de 120 caractères et un
   * remède précis au plafond de ses deux lignes réelles (110 caractères chacune).
   * Le premier remède est mesuré contre la réserve comme les autres : il n'y
   * tient pas, donc la classe retombe sur son conseil de repli au lieu de pousser
   * un message plus long que `FATAL_PRELUDE_CHARS`. Aucune classe fatale ne perd
   * sa tête, et la dernière garde son conseil entier.
   */
  it("keeps every fatal head when the first coupled remedy does not fit", async () => {
    const line = `const saveButton = "welcome name save ${"y".repeat(70)}";`;
    const quote = "welcome name save ".repeat(7).slice(0, 120);
    const saturated = saturatedFatalCandidate(quote);
    const [first] = saturated.scenarios;
    first!.requirements[0] = {
      behavior: "The absent quote is replaced by two real lines",
      quote,
      sourceFile: "src/form.ts",
    };
    const f = await setup({
      plans: [saturated, plan],
      formPatch: `@@ -1,1 +1,3 @@\n+${line}\n+${line.replace("saveButton", "saveLabel")}\n+show('Welcome '+name)`,
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    const correction = messages.at(-1)!.content;
    // Le préambule complet tient sous son plafond : la ligne de détail qui suit
    // et la dernière classe fatale survivent à la troncature de `model.ts`.
    const preludeEnd = correction.indexOf("Scenario welcome declares");
    expect(preludeEnd).toBeGreaterThan(0);
    expect(preludeEnd - "Plan rejected: ".length - 1).toBeLessThanOrEqual(
      FATAL_PRELUDE_CHARS
    );
    // Toutes les classes gardent leur tête, pas seulement l'en-tête qui les cite.
    for (const code of [
      "COVERAGE_WITNESS_MISSING",
      "COVERAGE_REQUIREMENT_SOURCE_MISSING",
      "REQUIREMENT_UNGROUNDED",
      "CRITICAL_COVERAGE_MISSING",
      "CONTEXT_INCOMPLETE",
      "CONTRACT_BUDGET",
      "PLAN_TOO_MANY_SCENARIOS",
      "PLAN_SCENARIO_ID_RESERVED",
      "PLAN_SOURCE_OUTSIDE_DIFF",
      "PLAN_SKIP_OUTSIDE_DIFF",
      "PLAN_CHANGED_FILE_UNCOVERED",
    ]) {
      expect(correction).toContain(`${code}: `);
    }
    expect(correction).toContain(
      "PLAN_CHANGED_FILE_UNCOVERED: Cover each listed changed file with a scenario; ignoring one is only allowed where the policy approves the skip."
    );
    // Le remède trop long n'est jamais poussé : la citation fautive garde son
    // extrait entier et la classe son conseil de repli.
    expect(correction).toContain(
      `REQUIREMENT_UNGROUNDED: Rejected quotes: ${JSON.stringify(quoteExcerpt(quote))} (+2 more) ${UNGROUNDED_ABSENT_REMEDY}`
    );
    expect(correction).not.toContain("Real lines of src/form.ts");
  }, 60_000);
  /**
   * CONTEXT_INCOMPLETE et CONTRACT_BUDGET bloquaient le run sans jamais passer
   * par le canal réparable : le planificateur épuisait sa tentative sans les
   * voir, et le refus masquait REQUIREMENT_UNGROUNDED. Nommés dans le préambule
   * fatal, ils atteignent le planificateur, qui corrige dans la même tentative.
   */
  it.each([
    {
      candidate: () => {
        const candidate = structuredClone(plan);
        candidate.scenarios[0]!.sourceFiles.push("src/outside.ts");
        return candidate;
      },
      code: "CONTEXT_INCOMPLETE",
      name: "a scenario citing a path without source evidence",
    },
    {
      candidate: () => {
        const candidate = structuredClone(plan);
        for (let index = 0; index < 22; index++) {
          candidate.scenarios[0]!.steps.push({
            description: "Observe the page",
            id: `warmup-${index}`,
            action: { type: "observe" as const },
          });
        }
        return candidate;
      },
      code: "CONTRACT_BUDGET",
      name: "a scenario over the step budget",
    },
  ])("returns $code to the planner, then passes the corrected plan ($name)", async ({
    candidate,
    code,
  }) => {
    const f = await setup({ plans: [candidate(), plan] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const correction = JSON.stringify(f.modelRequests.at(-1));
    expect(correction).toContain(code);
    expect(f.modelRequests).toHaveLength(2);
    expect(result.outcome).toBe("passed");
  }, 60_000);
  it("gives CRITICAL_COVERAGE_MISSING a correction attempt, and names the exception in the prompt", async () => {
    const skipped = structuredClone(plan);
    skipped.skipped = [
      {
        reason: "Not reachable from a browser scenario",
        sourceFile: "src/form.ts",
      },
    ];
    const f = await setup({ plans: [skipped, plan] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    // Le plan fautif consomme une tentative de correction au lieu de bloquer le
    // run directement sur le contrôle final.
    expect(f.modelRequests).toHaveLength(2);
    const request = f.modelRequests.at(-1)!;
    const messages = request.messages as { content: string; role: string }[];
    expect(messages.at(-1)!.content).toContain("CRITICAL_COVERAGE_MISSING");
    // Le prompt enseigne l'exception des chemins critiques après la règle du
    // skip, et non la règle seule.
    expect(messages[0]!.content).toContain("CRITICAL_COVERAGE_MISSING");
    expect(result.outcome).toBe("passed");
  }, 60_000);
  it("retries a model call cut by the transport, and counts it", async () => {
    const f = await setup({ env: { QA_MODEL_RETRIES: "1" }, modelResets: 1 });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    // La première proposition de plan est coupée avant toute réponse, donc seule
    // la seconde — la reprise — est enregistrée par le fixture.
    expect(f.modelRequests).toHaveLength(1);
    expect(result.usage?.retries).toBe(1);
    expect(result.outcome).toBe("passed");
    // La reprise est publiée pendant l'attente : le tableau de bord ne doit pas
    // paraître figé, et l'instabilité reste lisible dans l'historique.
    const events = await readFile(
      join(f.dataDir, result.id, "events.jsonl"),
      "utf8"
    );
    expect(events).toContain('"retry":{"attempt":1,"max":1,"code":');
  }, 40_000);
  it("stops after the configured retries and names the transport failure", async () => {
    const f = await setup({ env: { QA_MODEL_RETRIES: "2" }, modelResets: 9 });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toMatch(/ECONNRESET|UND_ERR_SOCKET/);
    expect(result.error).toContain("(after 2 retries)");
    expect(result.usage?.retries).toBe(2);
    expect(result.usage?.calls).toBe(0);
    expect(f.modelRequests).toHaveLength(0);
  }, 60_000);
  it("replays a model call the gateway refuses with 503, and counts it", async () => {
    const f = await setup({
      completionsStatuses: [503],
      env: { QA_MODEL_RETRIES: "1" },
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    expect(result.usage?.retries).toBe(1);
    // Le refus et la reprise : deux envois pour un seul appel répondu.
    expect(f.completionRequests()).toBe(2);
    const events = await readFile(
      join(f.dataDir, result.id, "events.jsonl"),
      "utf8"
    );
    expect(events).toContain('"retry":{"attempt":1,"max":1,"code":"HTTP_503"}');
  }, 40_000);
  it("blocks on a permanent 503 with the original code and the retry count", async () => {
    const f = await setup({
      completionsStatus: 503,
      env: { QA_MODEL_RETRIES: "2" },
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("HTTP_503");
    expect(result.error).toContain("(after 2 retries)");
    expect(result.usage?.retries).toBe(2);
    expect(result.usage?.calls).toBe(0);
    // L'envoi refusé et ses deux reprises, puis plus rien.
    expect(f.completionRequests()).toBe(3);
  }, 40_000);
  it("never replays a request the endpoint rejects with a 4xx", async () => {
    const f = await setup({
      completionsStatus: 400,
      env: { QA_MODEL_RETRIES: "3" },
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("HTTP_400");
    expect(result.usage?.retries).toBe(0);
    expect(f.completionRequests()).toBe(1);
  }, 40_000);
  it("never spends the transport budget on a semantic refusal", async () => {
    const ungrounded = structuredClone(plan);
    ungrounded.scenarios[0]!.requirements[0]!.quote = "show('Welcome '+nom)";
    const f = await setup({
      env: { QA_MODEL_RETRIES: "3" },
      plans: [ungrounded, plan],
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    // Plan refusé puis corrigé : deux appels, et aucune reprise de transport.
    expect(f.modelRequests).toHaveLength(2);
    expect(result.usage?.retries).toBe(0);
    expect(result.outcome).toBe("passed");
  });
  it("classes what may be retried and what may not", () => {
    expect(
      transportCode(
        Object.assign(new Error("terminated"), {
          cause: { code: "ECONNRESET" },
        })
      )
    ).toBe("ECONNRESET");
    expect(transportCode(new Error("socket hang up"))).toBe("UND_ERR_SOCKET");
    // Nos normalisations de transport : délai du client et flux tronqué.
    expect(transportCode(new QaError("TIMEOUT", "x", "y"))).toBe("TIMEOUT");
    expect(transportCode(new QaError("MODEL_STREAM_TRUNCATED", "x", "y"))).toBe(
      "MODEL_STREAM_TRUNCATED"
    );
    // Déterministes, donc jamais rejoués.
    expect(
      transportCode(new QaError("MODEL_STREAM_ERROR", "x", "y"))
    ).toBeUndefined();
    expect(
      transportCode(new QaError("REQUIREMENT_UNGROUNDED", "x", "y"))
    ).toBeUndefined();
  });
  it("retries a stream closed without its terminal marker", async () => {
    const f = await setup({
      env: { QA_MODEL_RETRIES: "1" },
      modelTruncations: 1,
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.usage?.retries).toBe(1);
    expect(result.outcome).toBe("passed");
    expect(f.modelRequests).toHaveLength(2);
  }, 40_000);
  it("replays once a plan cut by the endpoint's own output bound", async () => {
    // Le run 49bdb8b9 est mort sur MODEL_OUTPUT_INCOMPLETE avec retries: 0 :
    // l'endpoint avait répondu, la reprise d'un contenu inexploitable tranche.
    const f = await setup({ modelIncomplete: 1 });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    expect(result.usage?.retries).toBe(1);
    expect(result.usage?.calls).toBe(2);
    // La réponse coupée n'offre rien à corriger : la reprise repose le plan.
    expect(f.modelRequests).toHaveLength(2);
    const events = await readFile(
      join(f.dataDir, result.id, "events.jsonl"),
      "utf8"
    );
    expect(events).toContain(
      '"retry":{"attempt":1,"max":1,"code":"MODEL_OUTPUT_INCOMPLETE"}'
    );
  }, 40_000);
  it("replays once a complete plan the schema cannot read", async () => {
    // Le run 47fb77de est mort sur MODEL_JSON_INVALID avec retries: 0 : deux
    // réponses illisibles suffisaient à perdre le run.
    const f = await setup({ modelUnreadable: 2 });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    expect(result.usage?.retries).toBe(1);
    expect(result.usage?.calls).toBe(3);
    expect(f.modelRequests).toHaveLength(3);
  }, 40_000);
  it("keeps a second truncated generation fatal, naming the retry", async () => {
    const f = await setup({ modelIncomplete: 2 });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("MODEL_OUTPUT_INCOMPLETE");
    expect(result.diagnostic?.message).toContain("(after 1 retry)");
    expect(result.usage?.retries).toBe(1);
    expect(result.usage?.calls).toBe(2);
    expect(f.modelRequests).toHaveLength(2);
  }, 40_000);
  it("sends no replay when retries are disabled", async () => {
    const f = await setup({
      env: { QA_MODEL_RETRIES: "0" },
      modelIncomplete: 1,
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("MODEL_OUTPUT_INCOMPLETE");
    expect(result.usage?.retries).toBe(0);
    expect(result.diagnostic?.message).not.toContain("retry");
    expect(f.modelRequests).toHaveLength(1);
  }, 40_000);
  it("borne la sortie demandée par appel, quelle que soit la borne du plan", async () => {
    // Le plafond par appel est le plus petit de la borne de l'appelant et de
    // QA_CALL_MAX_TOKENS, et c'est ce chiffre-là qui part au fournisseur : le
    // run ne peut plus demander 400 000 tokens de sortie par appel. L'enveloppe
    // est rélevée pour que ces deux envois tiennent — un plafond par appel ne
    // sert que sous une enveloppe qui couvre l'entrée plus ce plafond.
    const wide = await setup({
      env: { QA_PLAN_MAX_TOKENS: "400000", QA_RUN_MAX_TOKENS: "1000000" },
    });
    fakeBrowser();
    const capped = await runQa(
      { prUrl: PR_URL, previewUrl: wide.baseUrl },
      wide.config
    );
    expect(capped.outcome).toBe("passed");
    expect(capped.usage?.retries).toBe(0);
    expect(wide.modelRequests[0]?.max_tokens).toBe(MAX_OUTPUT_TOKENS_PER_CALL);

    const tighter = await setup({
      env: {
        QA_PLAN_MAX_TOKENS: "400000",
        QA_RUN_MAX_TOKENS: "1000000",
        QA_CALL_MAX_TOKENS: "16384",
      },
    });
    fakeBrowser();
    const lowered = await runQa(
      { prUrl: PR_URL, previewUrl: tighter.baseUrl },
      tighter.config
    );
    expect(lowered.outcome).toBe("passed");
    expect(lowered.usage?.retries).toBe(0);
    expect(tighter.modelRequests[0]?.max_tokens).toBe(16_384);
  }, 60_000);
  it("refuse un plafond de sortie nul ou sous le plancher mesuré", () => {
    // 0 n'est pas « pas de plafond » : c'est l'absence de borne sur un envoi qui
    // a brûlé l'enveloppe du run 1eb26f8c. Une valeur sous le plancher est
    // refusée pour la même raison positive : le plus gros plan mesuré du lot Q
    // (8 scénarios, 39 761 octets, environ 11 400 tokens à 3,5 octets par token)
    // ne tient plus dedans. Le refus est explicite au chargement, jamais
    // découvert par un plan tronqué.
    expect(() => loadConfig({ QA_CALL_MAX_TOKENS: "0" })).toThrow();
    expect(() =>
      loadConfig({ QA_CALL_MAX_TOKENS: String(MIN_OUTPUT_TOKENS_PER_CALL - 1) })
    ).toThrow();
    expect(
      loadConfig({
        QA_CALL_MAX_TOKENS: String(MIN_OUTPUT_TOKENS_PER_CALL),
      }).QA_CALL_MAX_TOKENS
    ).toBe(MIN_OUTPUT_TOKENS_PER_CALL);
    expect(loadConfig({}).QA_CALL_MAX_TOKENS).toBe(MAX_OUTPUT_TOKENS_PER_CALL);
  });
  it("épingle le plafond par appel sur le lot Q mesuré, pas sur lui-même", () => {
    // Ce n'est pas une mesure du plafond, c'est une décision de dimensionnement
    // adossée à une mesure : l'endpoint ne stocke pas sa `completion_tokens`, la
    // sortie d'un appel se déduit d'un total rapporté moins l'entrée, et le
    // chiffre choisi est un choix justifié par la distribution du lot Q. Il est
    // figé ici en littéral pour qu'un retour à 32 768 — qui tronque 10 des 37
    // appels mesurés — ne passe plus la suite en silence.
    expect(MAX_OUTPUT_TOKENS_PER_CALL).toBe(98_304);
    expect(MIN_OUTPUT_TOKENS_PER_CALL).toBe(16_384);
    // Le plus gros plan du lot Q : 8 scénarios, 39 761 octets de JSON, 109 666
    // tokens comptés pour un seul appel, dont au plus 50 061 de sortie sous
    // l'entrée la plus défavorable (238 420 octets à quatre octets par token).
    // Le défaut couvre ce pire cas avec plus de 95 % de marge.
    const largestPlanTokens = 109_666;
    const smallestInputTokens = 59_605;
    expect(largestPlanTokens - smallestInputTokens).toBe(50_061);
    expect(
      MAX_OUTPUT_TOKENS_PER_CALL / (largestPlanTokens - smallestInputTokens)
    ).toBeGreaterThan(1.95);
    // Le plancher, lui, ne porte que ce JSON : sous 16 384, même un plan de
    // 39 761 octets ne tient plus à 3,5 octets par token.
    expect(39_761 / 3.5).toBeLessThan(MIN_OUTPUT_TOKENS_PER_CALL);
  });
  it("traite une sortie au-delà de la borne comme inutilisable et la rejoue une fois", async () => {
    // Un endpoint qui ignore le champ de limite répond un plan complet en
    // annonçant plus de tokens de sortie que la borne : la dépense que la borne
    // refusait de payer n'est pas acceptée, elle est rejouée une seule fois.
    const f = await setup({
      env: {
        QA_CALL_MAX_TOKENS: "16384",
        QA_PLAN_MAX_TOKENS: "32768",
        QA_RUN_MAX_TOKENS: "1000000",
      },
      modelOverBound: 1,
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    expect(result.usage?.retries).toBe(1);
    expect(result.usage?.calls).toBe(2);
    expect(f.modelRequests).toHaveLength(2);
    const events = await readFile(
      join(f.dataDir, result.id, "events.jsonl"),
      "utf8"
    );
    expect(events).toContain(
      '"retry":{"attempt":1,"max":1,"code":"MODEL_OUTPUT_INCOMPLETE"}'
    );
  }, 40_000);
  it("garde fatal un second dépassement de la borne, en la nommant", async () => {
    const f = await setup({
      env: {
        QA_CALL_MAX_TOKENS: "16384",
        QA_PLAN_MAX_TOKENS: "32768",
        QA_RUN_MAX_TOKENS: "1000000",
      },
      modelOverBound: 2,
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("MODEL_OUTPUT_INCOMPLETE");
    expect(result.diagnostic?.message).toContain("(after 1 retry)");
    expect(result.diagnostic?.message).toContain(
      "The endpoint reported 17384 output tokens for a 16384-token bound."
    );
    expect(result.usage?.retries).toBe(1);
    expect(result.usage?.calls).toBe(2);
    expect(f.modelRequests).toHaveLength(2);
  }, 40_000);
  it("rejoue le run dont un seul appel épuisait l'enveloppe", async () => {
    // Forme mesurée du run 1eb26f8c (lot Q, PR#17, 58 s, aucun scénario) : aucun
    // usage rapporté, borne de plan 393 216, enveloppe 1 000 000. Le premier
    // appel était compté à l'entrée estimée plus le plafond entier — 512 618
    // tokens sur les 1 000 000 de l'enveloppe —, la reprise de ce contenu
    // inexploitable ne tenait plus dans ce qui restait, et le run bloquait sur
    // le budget au lieu de rejouer. Le compteur suit maintenant ce que la
    // réponse a livré : la reprise part, même sans plafond par appel serré.
    const burnedEnv = {
      OPENAI_STREAM: "false" as const,
      QA_PLAN_MAX_TOKENS: "393216",
      QA_RUN_MAX_TOKENS: "700000",
    };
    const unbounded = await setup({
      env: { ...burnedEnv, ...WIDE_CALL },
      modelIncomplete: 1,
    });
    fakeBrowser();
    const replayed = await runQa(
      { prUrl: PR_URL, previewUrl: unbounded.baseUrl },
      unbounded.config
    );
    expect(replayed.outcome).toBe("passed");
    expect(replayed.usage?.retries).toBe(1);
    expect(replayed.usage?.calls).toBe(2);
    expect(replayed.usage?.estimated).toBe(true);
    expect(replayed.diagnostic?.code).not.toBe("RUN_BUDGET_EXCEEDED");
    expect(unbounded.modelRequests).toHaveLength(2);
    // Mesure : ce que le premier appel a débité reste sous la réservation de son
    // envoi — l'entrée estimée plus le plafond de plan, 393 216 —, qui est
    // exactement ce que l'ancienne comptabilité inscrivait comme débit. La
    // reprise est admise parce que l'enveloppe couvre cette mesure plus la
    // réservation, pas parce que la réservation serait ignorée.
    const firstSend = sentReservation(unbounded.modelRequests[0]!);
    expect(replayed.usage?.tokens ?? 0).toBeLessThan(firstSend);
    expect(firstSend).toBeGreaterThan(393_216);

    // Le plafond par appel reste ce qui fait tenir ce run sous une enveloppe
    // plus serrée : la même reprise passe à 98 304, et la borne du plan seule
    // n'aurait même pas laissé partir le premier envoi.
    const capped = await setup({
      env: { ...burnedEnv, QA_RUN_MAX_TOKENS: "300000" },
      modelIncomplete: 1,
    });
    fakeBrowser();
    const bounded = await runQa(
      { prUrl: PR_URL, previewUrl: capped.baseUrl },
      capped.config
    );
    expect(bounded.outcome).toBe("passed");
    expect(bounded.usage?.retries).toBe(1);
    expect(capped.modelRequests).toHaveLength(2);
    expect(sentReservation(capped.modelRequests[0]!)).toBeLessThan(
      sentReservation(unbounded.modelRequests[0]!)
    );

    const refused = await setup({
      env: { ...burnedEnv, ...WIDE_CALL, QA_RUN_MAX_TOKENS: "300000" },
      modelIncomplete: 1,
    });
    fakeBrowser();
    const blocked = await runQa(
      { prUrl: PR_URL, previewUrl: refused.baseUrl },
      refused.config
    );
    expect(blocked.diagnostic?.code).toBe("RUN_BUDGET_EXCEEDED");
    expect(blocked.usage?.calls).toBe(0);
    expect(blocked.usage?.retries).toBe(0);
    expect(refused.modelRequests).toHaveLength(0);
  }, 90_000);
  it.each([
    401, 500,
  ])("never replays a content failure the endpoint answers with HTTP %i", async (status) => {
    const f = await setup({ completionsStatus: status });
    fakeBrowser();
    const request = vi.spyOn(globalThis, "fetch");
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe(`HTTP_${status}`);
    expect(result.usage?.retries).toBe(0);
    // Ni 4xx ni 5xx ne s'améliorent au second essai : un seul envoi part.
    expect(
      request.mock.calls.filter(([url]) =>
        String(url).endsWith("/chat/completions")
      )
    ).toHaveLength(1);
  }, 40_000);
  it("keeps the diagnostic on the response, bounded and without the prompt", async () => {
    // Le prompt n'est jamais recopié dans le diagnostic, et l'extrait est borné :
    // 500 caractères, plus la position d'arrêt de la génération.
    const incomplete = `{"summary":"${"x".repeat(700)}","scenarios":[{"id":"welcome"`;
    const f = await setup({
      modelIncomplete: 2,
      incompleteContent: incomplete,
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const message = result.diagnostic?.message ?? "";
    expect(message).toContain("finish_reason=length");
    expect(message).toContain(`${incomplete.length} characters`);
    // Un JSON resté ouvert à la coupure : la signature d'une troncature.
    expect(message).toContain(JSON.stringify(incomplete.slice(0, 500)));
    expect(message).not.toContain(JSON.stringify(incomplete.slice(0, 501)));
    expect(message).toContain("[truncated]");
    // Le prompt système et le diff de la PR restent hors de l'extrait.
    expect(message).not.toContain("You plan functional QA");
    expect(message).not.toContain("changedFiles");
  }, 40_000);
  it("keeps a second unreadable plan fatal, and names the drift in a redacted excerpt", async () => {
    const f = await setup({
      modelUnreadable: 3,
      unreadableContent:
        "I cannot use fixture-token for this plan, ask the maintainer.",
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const message = result.diagnostic?.message ?? "";
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("MODEL_JSON_INVALID");
    expect(message).toContain("(after 1 retry)");
    expect(result.usage?.retries).toBe(1);
    // La reprise consommée n'ouvre pas un second cycle de correction : le plan
    // reste fatal au troisième appel, sans boucle.
    expect(f.modelRequests).toHaveLength(3);
    // Contenu complet (finish_reason=stop) mais hors schéma : une dérive du
    // modèle, là où une accolade non fermée trahirait une coupure.
    expect(message).toContain("finish_reason=stop");
    expect(result.diagnostic?.hint).toContain(
      "Response content is not valid JSON"
    );
    expect(message).toContain("cannot use");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("fixture-token");
    expect(message).not.toContain("You plan functional QA");
  }, 40_000);
  it("names a readable plan whose ifPresent click proves nothing, and lets the model repair it", async () => {
    const { f, result } = await contractRefusal(
      planWithoutEstablishingAssertion
    );
    expect(result.diagnostic?.code).toBe("PLAN_SCHEMA_INVALID");
    expect(result.diagnostic?.hint ?? "").toMatch(IF_PRESENT_RULE);
    expect(result.diagnostic?.message ?? "").not.toContain(
      "invalid structured output"
    );
    expectCallsWithTargetedCorrection(f, result, IF_PRESENT_RULE);
  }, 60_000);
  it("names a readable plan that cites an unknown assertion, and lets the model repair it", async () => {
    const { f, result } = await contractRefusal(planWithUnknownAssertion);
    expect(result.diagnostic?.code).toBe("PLAN_SCHEMA_INVALID");
    expect(result.diagnostic?.hint ?? "").toMatch(UNKNOWN_ASSERTION_RULE);
    expectCallsWithTargetedCorrection(f, result, UNKNOWN_ASSERTION_RULE);
  }, 60_000);
  it("reserves the content replay on the request it actually sends", async () => {
    // Deux réponses illisibles d'affilée : la seconde place la reprise unique,
    // et la conversation porte alors le contenu fautif et son message correctif.
    // La réservation doit porter sur cet envoi-là, jamais sur la version plus
    // courte d'avant la correction.
    const unreadableContent = "x".repeat(60_000);
    const reference = await setup({ modelUnreadable: 2, unreadableContent });
    fakeBrowser();
    const before = budget.reserves.length;
    const replayed = await runQa(
      { prUrl: PR_URL, previewUrl: reference.baseUrl },
      reference.config
    );
    expect(replayed.outcome).toBe("passed");
    expect(replayed.usage?.retries).toBe(1);
    const sent = reference.modelRequests;
    expect(sent).toHaveLength(3);
    // Mesure : la réservation déposée avant chaque envoi couvre la taille réelle
    // de cet envoi. Le troisième porte le contenu fautif et sa correction, que
    // la réservation du deuxième ne mesure pas.
    for (const [index, request] of sent.entries()) {
      expect(budget.reserves[before + index] ?? 0).toBeGreaterThanOrEqual(
        sentReservation(request)
      );
    }
    expect(sentReservation(sent[2]!)).toBeGreaterThan(
      sentReservation(sent[1]!)
    );
    // Enveloppe qui couvre la réservation du deuxième envoi, pas le troisième :
    // la reprise doit être refusée avant l'envoi au lieu de laisser partir une
    // requête plus grosse que l'enveloppe ne l'autorise.
    const tight = await setup({
      env: { QA_RUN_MAX_TOKENS: String(sentReservation(sent[1]!) + 1000) },
      modelUnreadable: 2,
      unreadableContent,
    });
    fakeBrowser();
    const refused = await runQa(
      { prUrl: PR_URL, previewUrl: tight.baseUrl },
      tight.config
    );
    expect(refused.outcome).toBe("blocked");
    expect(refused.diagnostic?.code).toBe("RUN_BUDGET_EXCEEDED");
    expect(tight.modelRequests).toHaveLength(2);
  }, 60_000);
  it("keeps the correction cycle after an incomplete replay", async () => {
    // Une génération coupée ne produit aucun candidat : sa reprise ne consomme
    // pas le créneau de correction. Le refus renvoyé ensuite reçoit son message
    // correctif au lieu d'être retourné tel quel à `settlePlan`, qui bloque alors
    // le run sur la preuve manquante.
    const refused = structuredClone(plan);
    refused.scenarios[0]!.requirements[0]!.quote = "show('Welcome '+nom)";
    const f = await setup({ modelIncomplete: 1, plans: [refused, plan] });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    expect(result.usage?.retries).toBe(1);
    expect(result.usage?.calls).toBe(3);
    expect(f.modelRequests).toHaveLength(3);
    const messages = f.modelRequests.at(-1)!.messages as {
      content: string;
      role: string;
    }[];
    // Le troisième envoi porte le refus et le message correctif qui l'explique.
    expect(messages.at(-1)!.role).toBe("user");
    expect(messages.at(-1)!.content).toContain("Plan rejected:");
    expect(messages.at(-2)!.role).toBe("assistant");
    expect(messages.at(-2)!.content).toContain("show('Welcome '+nom)");
  }, 60_000);
  it("refuses a retry the current failure and the retry would push over the cap", () => {
    // `used` compte les réponses et les reprises déjà faites : l'échec courant
    // et la reprise envisagée occupent deux créneaux de plus.
    expect(mayRetry(0, 5, 8)).toBe(true);
    expect(mayRetry(0, 5, 9)).toBe(false);
    expect(mayRetry(5, 5, 0)).toBe(false);
  });
  it("debits the lost attempt apart from the consumed budget", async () => {
    const env = { QA_MODEL_RETRIES: "1", QA_PLAN_MAX_TOKENS: "5000" };
    const reference = await setup({ env: { QA_PLAN_MAX_TOKENS: "5000" } });
    fakeBrowser();
    const baseline = await runQa(
      { prUrl: PR_URL, previewUrl: reference.baseUrl },
      reference.config
    );
    const lost = await setup({ env, modelResets: 1 });
    fakeBrowser();
    const retried = await runQa(
      { prUrl: PR_URL, previewUrl: lost.baseUrl },
      lost.config
    );
    expect(retried.usage?.retries).toBe(1);
    expect(retried.outcome).toBe("passed");
    // La tentative perdue est chiffrée à part des tokens rapportés par
    // l'endpoint, mais elle reste dans l'enveloppe : la reprise est admise
    // parce que l'enveloppe du fixture couvre la réserve plus la réservation
    // de l'appel à venir, pas parce que la réserve serait ignorée.
    expect(retried.usage?.reservedTokens ?? 0).toBeGreaterThanOrEqual(5000);
    expect(retried.usage?.tokens).toBe(baseline.usage?.tokens);
    expect(retried.usage?.estimated).toBe(true);
  }, 40_000);
  it("credits a lost attempt with what the transport delivered, and admits the correction", async () => {
    const refused = structuredClone(plan);
    refused.scenarios[0]!.requirements[0]!.quote = "show('Welcome '+nom)";
    const f = await setup({
      env: {
        ...WIDE_CALL,
        QA_MODEL_RETRIES: "1",
        QA_PLAN_MAX_TOKENS: "400000",
        QA_RUN_MAX_TOKENS: "500000",
      },
      modelTruncations: 1,
      plans: [refused, refused, plan],
    });
    fakeBrowser();
    const before = budget.reserves.length;
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const reserved = result.usage?.reservedTokens ?? 0;
    // Plan coupé (le flux a livré un seul caractère) puis reprise, plan refusé
    // sur sa preuve, correction : la forme du run 23d0807e. La réserve de
    // l'essai perdu est créditée de ce que le transport a livré — l'entrée du
    // prompt et le texte reçu — et non de la sortie maximale.
    expect(result.outcome).toBe("passed");
    expect(result.usage?.retries).toBe(1);
    expect(result.usage?.calls).toBe(2);
    expect(budget.reserves.length - before).toBe(3);
    expect(reserved).toBeGreaterThan(0);
    expect(reserved).toBeLessThan(50_000);
    // La première réservation est la borne théorique de ce même appel :
    // comptée deux fois, elle ne tient pas sous cette enveloppe. C'est la
    // réserve crédible qui laisse la place à la reprise puis à la correction.
    expect((budget.reserves[before] ?? 0) * 2).toBeGreaterThan(500_000);
    expect((result.usage?.tokens ?? 0) + reserved).toBeLessThan(500_000);
    expect(result.diagnostic?.code).not.toBe("RUN_BUDGET_EXCEEDED");
  }, 40_000);
  it("debits the last attempt too when no retry follows", async () => {
    const f = await setup({ env: { QA_MODEL_RETRIES: "0" }, modelResets: 1 });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toMatch(/ECONNRESET|UND_ERR_SOCKET/);
    expect(result.usage?.retries).toBe(0);
    // Aucune reprise ne suit et rien n'a été rapporté : la tentative perdue
    // reste chiffrée, au pire cas, sans devenir un token consommé.
    expect(result.usage?.tokens).toBe(0);
    expect(result.usage?.reservedTokens ?? 0).toBeGreaterThan(0);
    expect(result.usage?.estimated).toBe(true);
  }, 40_000);
  it("counts a lost attempt's bound inside the envelope and still admits the correction", async () => {
    const refused = structuredClone(plan);
    refused.scenarios[0]!.requirements[0]!.quote = "show('Welcome '+nom)";
    const f = await setup({
      env: {
        ...WIDE_CALL,
        QA_MODEL_RETRIES: "1",
        QA_PLAN_MAX_TOKENS: "400000",
        QA_RUN_MAX_TOKENS: "1000000",
      },
      modelResets: 1,
      plans: [refused, plan],
    });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const consumed = result.usage?.tokens ?? 0;
    const reserved = result.usage?.reservedTokens ?? 0;
    // Aucun octet n'a été livré avant la coupure : la tentative perdue est
    // chiffrée à sa borne théorique et cette borne compte dans l'admission.
    // L'enveloppe la couvre avec la correction qui suit, donc une dépense
    // réelle reste déclarée sans transformer le run en refus.
    expect(f.modelRequests).toHaveLength(2);
    expect(result.outcome).toBe("passed");
    expect(result.usage?.calls).toBe(2);
    expect(result.usage?.retries).toBe(1);
    expect(consumed).toBeLessThan(200_000);
    expect(reserved).toBeGreaterThanOrEqual(400_000);
    expect(budget.reserves.at(-1) ?? 0).toBeGreaterThan(400_000);
    expect(consumed + reserved + (budget.reserves.at(-1) ?? 0)).toBeLessThan(
      1_000_000
    );
    expect(result.usage?.estimated).toBe(true);
    expect(result.diagnostic?.code).not.toBe("RUN_BUDGET_EXCEEDED");
  }, 40_000);
  it("refuses a retry the consumed usage plus the lost bound no longer covers, without sending it", async () => {
    const refused = structuredClone(plan);
    refused.scenarios[0]!.requirements[0]!.quote = "show('Welcome '+nom)";
    const f = await setup({
      env: {
        ...WIDE_CALL,
        QA_MODEL_RETRIES: "1",
        QA_PLAN_MAX_TOKENS: "400000",
        QA_RUN_MAX_TOKENS: "700000",
      },
      modelResets: 1,
      plans: [refused, plan],
    });
    fakeBrowser();
    const request = vi.spyOn(globalThis, "fetch");
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    const consumed = result.usage?.tokens ?? 0;
    const reserved = result.usage?.reservedTokens ?? 0;
    // La socket est détruite avant tout octet : rien n'est observable, la
    // réserve retombe sur sa borne théorique (403 443 ici). Consommé + réserve
    // + la réservation de la reprise (806 886) dépasse l'enveloppe : la reprise
    // est refusée sans être envoyée, et le budget encadre la dépense totale.
    expect(reserved).toBeGreaterThanOrEqual(400_000);
    expect(consumed + reserved + (budget.reserves.at(-1) ?? 0)).toBeGreaterThan(
      700_000
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("RUN_BUDGET_EXCEEDED");
    expect(f.modelRequests).toHaveLength(0);
    expect(
      request.mock.calls.filter(([url]) =>
        String(url).endsWith("/chat/completions")
      )
    ).toHaveLength(1);
  }, 40_000);
  it("refuses the first attempt a run envelope cannot cover, without sending it", async () => {
    const f = await setup({
      env: {
        ...WIDE_CALL,
        QA_PLAN_MAX_TOKENS: "400000",
        QA_RUN_MAX_TOKENS: "100000",
      },
    });
    fakeBrowser();
    const request = vi.spyOn(globalThis, "fetch");
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    // Le garde-fou reste réel : une enveloppe inférieure à la première
    // réservation refuse l'appel avant tout envoi, donc sans dépense.
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("RUN_BUDGET_EXCEEDED");
    expect(f.modelRequests).toHaveLength(0);
    expect(
      request.mock.calls.some(([url]) =>
        String(url).endsWith("/chat/completions")
      )
    ).toBe(false);
    expect(result.usage?.tokens).toBe(0);
    expect(result.usage?.reservedTokens).toBe(0);
  }, 40_000);
  it("never lets a retry progress write take the worker down", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    const scope: RunScope = {
      calls: 0,
      costUsd: 0,
      id: "retry-progress",
      maxCostUsd: 1,
      maxTokens: 1000,
      reservedTokens: 0,
      reservedCostUsd: 0,
      signal: AbortSignal.timeout(1000),
      tokens: 0,
    };
    relayModelRetries(scope, {
      record: () => Promise.reject(new Error("ENOSPC")),
    } as unknown as Progress);
    scope.onRetry?.({ attempt: 1, code: "ECONNRESET", max: 3 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", onRejection);
    expect(rejections).toEqual([]);
  });
  it("reserves the budget of every attempt, retries included", async () => {
    const f = await setup({ env: { QA_MODEL_RETRIES: "1" }, modelResets: 1 });
    fakeBrowser();
    const before = budget.reserves.length;
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    // Deux tentatives de plan, donc deux réservations déposées avant chacune.
    expect(budget.reserves.length - before).toBe(2);
  }, 40_000);
  it("repairs a requirement attributed to the wrong declared file", async () => {
    const f = await setup();
    const context = await new GitHub(f.config).context(PR_URL);
    const contract = structuredClone(plan);
    contract.scenarios[0]!.sourceFiles = ["src/form.ts", "src/legacy.tsx"];
    contract.scenarios[0]!.requirements[0]!.sourceFile = "src/legacy.tsx";
    const repairs = repairRequirementAttribution(contract, {
      ...context,
      files: [
        ...context.files,
        {
          filename: "src/legacy.tsx",
          patch: "- <p>Work in progress</p>",
          status: "modified",
        },
      ],
    });
    expect(repairs).toEqual([
      {
        from: "src/legacy.tsx",
        quote: "show('Welcome '+name)",
        scenarioId: "welcome",
        to: "src/form.ts",
      },
    ]);
    expect(contract.scenarios[0]!.requirements[0]!.sourceFile).toBe(
      "src/form.ts"
    );
  });
  it("names where the quote lives, only among the files the PR changes", async () => {
    const f = await setup();
    const context = await new GitHub(f.config).context(PR_URL);
    const contract = structuredClone(plan);
    contract.scenarios[0]!.requirements[0]!.quote = "show('Welcome '+nom)";
    const inPr = ungroundedPlanRefusals(
      contract,
      {
        ...context,
        files: [
          ...context.files,
          {
            filename: "src/app.tsx",
            patch: "+ show('Welcome '+nom)",
            status: "modified",
          },
        ],
      },
      policyFor()
    );
    expect(inPr[0]).toContain("No source witness for welcome: src/form.ts");
    expect(inPr[0]).toContain("declare that file");
    // Un témoin hors diff ne doit pas être proposé : le planificateur le
    // déclarerait et la validation le refuserait, pour rien.
    const outside = ungroundedPlanRefusals(
      contract,
      {
        ...context,
        context: [
          {
            content: "show('Welcome '+nom)",
            path: "README.md",
            ref: context.sha,
          },
        ],
      },
      policyFor()
    );
    expect(outside[0]).toContain("this PR does not change");
    expect(outside[0]).not.toContain("declare that file");
  });
  it("names a target that never resolves, not one that is merely not actionable", () => {
    const waiting = diagnose(
      new Error(
        "Canary action failed: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('div[class*=\"place-items-center\"] p')"
      )
    );
    expect(waiting.code).toBe("TARGET_NOT_FOUND");
    expect(waiting.hint).toContain("kind hidden");
    // Un élément trouvé mais inactionnable n'est pas une cible à corriger.
    const actionable = diagnose(
      new Error(
        "Timeout 10000ms exceeded.\nCall log:\n  - locator resolved to <button>…\n  - element is not visible"
      )
    );
    expect(actionable.code).toBe("QA_ERROR");
    // Un événement attendu qui n'arrive pas parle de l'événement, pas d'un
    // élément : la cible du clic a bien été trouvée.
    const event = diagnose(
      new Error('Timeout 10000ms exceeded while waiting for event "download"')
    );
    expect(event.code).toBe("QA_ERROR");
  });
  it("plays the whole frozen contract without asking a model to decide", async () => {
    const f = await setup();
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("passed");
    // Le plan est le seul appel modèle : l'exécution rejoue le contrat figé,
    // elle n'envoie plus la page au modèle à chaque étape.
    expect(f.modelRequests).toHaveLength(1);
    expect(result.scenarios[0]?.contract?.completedSteps).toEqual([
      "enter",
      "save",
      "verify",
    ]);
    expect(result.scenarios[0]?.steps.map((step) => step.stepId)).toEqual([
      "enter",
      "save",
      "verify",
    ]);
    expect(
      f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
        .state
    ).toBe("success");
  });
  it("marks updated PR heads stale rather than posting success", async () => {
    const f = await setup({ updatedSha: true });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("stale");
    expect(
      f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
        .state
    ).toBe("error");
  });
  it("does not greenlight skipped-only plans", async () => {
    const f = await setup({ noScenarios: true });
    fakeBrowser();
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("CRITICAL_COVERAGE_MISSING");
    expect(
      f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
        .state
    ).toBe("error");
    expect(
      (await stat(join(f.dataDir, result.id, "report.html"))).size
    ).toBeGreaterThan(0);
  });
  it("cannot pass when video/evidence finalization fails", async () => {
    const f = await setup();
    fakeBrowser();
    vi.mocked(Canary.prototype.end)
      .mockResolvedValueOnce(["trace.zip"])
      .mockRejectedValueOnce(new Error("No video"));
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome).toBe("blocked");
    expect(result.scenarios[0]?.error).toContain("No video");
    expect(
      JSON.parse(
        await readFile(join(f.dataDir, result.id, "result.json"), "utf8")
      ).outcome
    ).toBe("blocked");
  });
});

it("closes an interrupted pinned GitHub check without publishing success", async () => {
  const f = await setup();
  fakeBrowser();
  const controller = new AbortController();
  vi.spyOn(Canary.prototype, "act").mockImplementation(async () => {
    controller.abort(new Error("Cancelled by operator"));
    controller.signal.throwIfAborted();
    throw new Error("unreachable");
  });
  vi.spyOn(Canary.prototype, "abort").mockResolvedValue(undefined);
  const result = await runScope.run(
    {
      id: "cancel-check",
      signal: controller.signal,
      tokens: 0,
      calls: 0,
      costUsd: 0,
      reservedTokens: 0,
      reservedCostUsd: 0,
      maxTokens: 100_000,
      maxCostUsd: 10,
    },
    () => runQa({ prUrl: PR_URL, previewUrl: f.baseUrl }, f.config)
  );
  expect(result.outcome).toBe("blocked");
  expect(f.outgoing.map((r) => r.payload.state).filter(Boolean)).toEqual([
    "pending",
    "error",
  ]);
});
it("never publishes a passing comment when the final GitHub status fails", async () => {
  const f = await setup();
  fakeBrowser();
  const status = GitHub.prototype.status;
  vi.spyOn(GitHub.prototype, "status").mockImplementation(async function (
    this: GitHub,
    ...args
  ) {
    if (args[1] === "success") {
      throw new Error("Status API unavailable");
    }
    return await status.apply(this, args);
  });
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(result.scenarios[0]?.outcome).toBe("passed");
  expect(result.outcome).toBe("blocked");
  expect(
    f.outgoing.some((r) => String(r.payload.body).includes("Result: PASSED"))
  ).toBe(false);
  expect(
    f.outgoing.filter((request) => request.payload.state).at(-1)?.payload.state
  ).toBe("error");
  expect(
    JSON.parse(
      await readFile(join(f.dataDir, result.id, "result.json"), "utf8")
    ).outcome
  ).toBe("blocked");
});
it("repairs a passing comment when GitHub wrote it but its response was lost", async () => {
  const f = await setup();
  fakeBrowser();
  const comment = GitHub.prototype.comment;
  let first = true;
  vi.spyOn(GitHub.prototype, "comment").mockImplementation(async function (
    this: GitHub,
    ...args
  ) {
    const url = await comment.apply(this, args);
    if (first) {
      first = false;
      throw new Error("Comment response lost");
    }
    return url;
  });
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(result.outcome).toBe("blocked");
  const comments = f.outgoing.filter((r) => r.payload.body);
  expect(comments.at(-1)?.payload.body).toContain("Result: BLOCKED");
  // Le rapport bloqué est republié, donc publié, alors que le commit status
  // posté porte le verdict du run : les deux notions ne se recopient plus.
  expect(result.publication?.status).toBe("published");
  expect(
    f.outgoing.filter((request) => request.payload.state).at(-1)?.payload.state
  ).toBe("error");
  const remoteComments = (await (
    await fetch(`${f.baseUrl}/repos/fixture/app/issues/1/comments?per_page=100`)
  ).json()) as { body: string }[];
  expect(remoteComments).toHaveLength(1);
  expect(remoteComments[0]!.body).toContain("Result: BLOCKED");
});
it("rejects publication when worker ownership cannot be verified, even after passing assertions", async () => {
  const f = await setup();
  fakeBrowser();
  const controller = new AbortController();
  const result = await runScope.run(
    {
      id: "lease-check",
      signal: controller.signal,
      tokens: 0,
      calls: 0,
      costUsd: 0,
      reservedTokens: 0,
      reservedCostUsd: 0,
      maxTokens: 100_000,
      maxCostUsd: 10,
      verifyOwnership: async () => {
        throw new Error("Lease expired before publication");
      },
    },
    () => runQa({ prUrl: PR_URL, previewUrl: f.baseUrl }, f.config)
  );
  expect(result.scenarios[0]?.outcome).toBe("passed");
  expect(result.outcome).toBe("blocked");
  expect(result.error).toContain("Lease expired");
  expect(f.outgoing.map((r) => r.payload.state).filter(Boolean)).toEqual([
    "pending",
    "error",
  ]);
  expect(f.outgoing.some((r) => r.path.endsWith("/comments"))).toBe(false);
});

it("links a session report only for the scenarios that produced one", async () => {
  const root = await mkdtemp(join(tmpdir(), "canary-report-test-"));
  close.push(async () => {
    await rm(root, { force: true, recursive: true });
  });
  const first = plan.scenarios[0]!;
  const blocked = (
    scenario: typeof first,
    artifacts: string[]
  ): ScenarioResult => ({
    artifacts,
    assertions: [],
    outcome: "blocked",
    scenario,
    steps: [],
  });
  await saveReport(root, {
    endedAt: "2026-01-01T00:05:00.000Z",
    id: "11111111-1111-1111-1111-111111111111",
    outcome: "blocked",
    prUrl: PR_URL,
    scenarios: [
      blocked(first, ["report.html", "trace.zip"]),
      // A planning refusal, a failed preparation or a lost evidence
      // finalization exports no report: its link would always miss.
      blocked({ ...first, id: "refused" }, []),
    ],
    sha: SHA,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  const html = await readFile(join(root, "report.html"), "utf8");
  expect(html).toContain('href="welcome/report.html"');
  expect(html).not.toContain('href="refused/report.html"');
});

/**
 * Contexte minimal d'un PR d'une ligne : le contrôle structurel du prompt n'a
 * besoin que des clés du payload et du matériel numéroté.
 */
const PLANNER_CONTEXT: PrContext = {
  baseSha: BASE_SHA,
  body: "",
  context: [],
  contextWarnings: [],
  files: [
    {
      filename: "src/a.ts",
      patch: "@@ -1,0 +1,1 @@\n+const saved = true;",
      status: "modified",
    },
  ],
  headRepo: "fixture/app",
  ref: parsePrUrl(PR_URL),
  sha: SHA,
  title: "",
};
const PLANNER_PREVIEW = {
  evidence: "JSON sha at /version.json",
  sha: SHA,
  url: "https://preview.example/",
};
const PLANNER_PAGE: Observation = {
  snapshot: "",
  url: "https://preview.example/",
};
const PLANNER_FIXTURES = { fixtures: {}, roles: [], visuals: [] };

/**
 * Les chemins de champs que le prompt annonce au planificateur : un span entre
 * backticks qui est un chemin de segments (`sourceLines`, `pr.files`) dont le
 * premier est une clé du payload reçu — c'est la racine que le modèle voit. Les
 * autres spans cités sont des exemples de code ou de citation tirés du dépôt,
 * jamais des chemins du message.
 */
function citedPayloadPaths(prompt: string, payload: object): string[] {
  const roots = new Set(Object.keys(payload));
  return [...prompt.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] ?? "")
    .filter(
      (span) =>
        roots.has(span.split(".")[0] ?? "") &&
        /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(span)
    );
}

/** Vrai quand ce chemin de champs existe dans le payload réellement envoyé. */
function resolvesPath(payload: object, path: string): boolean {
  let node: unknown = payload;
  for (const segment of path.split(".")) {
    if (
      typeof node !== "object" ||
      node === null ||
      !Object.hasOwn(node, segment)
    ) {
      return false;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return true;
}

/**
 * Le prompt annonce des chemins de champs au modèle ; chacun doit exister dans
 * le message qu'il reçoit vraiment, sinon le matériel numéroté que les refus
 * réclament reste hors de portée. Un prompt qui citait `pr.sourceLines` — le
 * matériel est à la racine du payload, pas sous `pr` — échoue ici.
 */
it("points the planner only at payload paths it actually receives", () => {
  const payload = planPayload(
    PLANNER_CONTEXT,
    PLANNER_PREVIEW,
    PLANNER_PAGE,
    PLANNER_FIXTURES,
    loadConfig({})
  );
  const cited = citedPayloadPaths(PLANNER_PROMPT, payload);
  // Tout chemin cité doit exister dans le message envoyé : `pr.sourceLines`
  // n'y est pas, le matériel numéroté est à la racine du payload.
  expect(cited.filter((path) => !resolvesPath(payload, path))).toEqual([]);
  // La consigne qui fait recopier les lignes réelles fait partie du prompt.
  expect(cited).toContain("sourceLines");
  // Le chemin cité atteint le matériel numéroté lui-même : à la racine du
  // message, `[{ path, lines: [{ line, text }] }]` avec les lignes réelles du
  // diff, numérotées dans le nouveau fichier.
  expect(payload.sourceLines).toEqual([
    { path: "src/a.ts", lines: [{ line: 1, text: "const saved = true;" }] },
  ]);
});

/**
 * L'étape d'établissement tolère une cible ABSENTE, jamais une cible qu'elle
 * n'a pas su atteindre. Un délai de localisateur consommé dans le script
 * (1,5 s) transformait une ambiguïté, un nom accessible atteint par le repli ou
 * un contrôle apparu après ce délai en étape sautée : l'état visé restait alors
 * non établi, en silence.
 */
describe("click(ifPresent): l'absence se mesure, elle ne se déduit pas d'un délai", () => {
  const opening: Locator = {
    by: "role",
    value: "button",
    name: "Reopen counting",
  };
  async function run(
    elements: EstablishingElement[],
    locator: Locator = opening
  ) {
    const page = establishingPage(elements);
    const result = await runCompiledScript(
      compileAction(
        {
          type: "click",
          locator,
          ifPresent: true,
        } as Parameters<typeof compileAction>[0],
        "https://preview.test"
      ),
      page.page
    );
    return { ...result, clicked: page.clicked };
  }

  it("saute l'étape quand aucun élément ne correspond : zéro correspondance est une absence", async () => {
    const step = await run([]);
    expect(step.failure).toBeUndefined();
    expect(step.observation?.actual).toBe(false);
    expect(step.clicked).toEqual([]);
  });

  it("clique la cible présente et unique", async () => {
    const step = await run([{ name: "Reopen counting" }]);
    expect(step.failure).toBeUndefined();
    expect(step.observation?.actual).toBe(true);
    expect(step.clicked).toEqual(["Reopen counting"]);
  });

  it("lève sur une cible ambiguë au lieu de la sauter", async () => {
    const step = await run([
      { name: "Reopen counting" },
      { name: "Reopen counting" },
    ]);
    expect(step.failure).toBeDefined();
    expect(step.observation).toBeUndefined();
    expect(step.clicked).toEqual([]);
  });

  it("attend le délai d'un clic ordinaire : un contrôle visible après 1,5 s est cliqué", async () => {
    const step = await run([{ name: "Reopen counting", appearsAfterMs: 2000 }]);
    expect(step.failure).toBeUndefined();
    expect(step.observation?.actual).toBe(true);
    expect(step.clicked).toEqual(["Reopen counting"]);
  });

  it("atteint par le nom accessible un contrôle dont le libellé exact ne résout rien", async () => {
    // Le délai du libellé strict doit remonter jusqu'au repli : consommé dans
    // le script, il faisait passer un contrôle présent pour absent.
    const step = await run([{ name: "Reopen counting" }], {
      by: "label",
      value: "Reopen counting",
    });
    expect(step.failure).toBeUndefined();
    expect(step.observation?.actual).toBe(true);
    expect(step.clicked).toEqual(["Reopen counting"]);
  });
});
