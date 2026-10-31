import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary, type Observation } from "../src/canary.js";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { durableWriteClaimed } from "../src/durable-write.js";
import { executeScenario } from "../src/executor.js";
import type { PrContext } from "../src/github.js";
import { sourceLineMaterial } from "../src/policy.js";
import {
  judgeAgainstBaseline,
  reportMarkdown,
  saveReport,
} from "../src/report.js";
import type { RunResult } from "../src/results.js";
import { type Scenario, ScenarioSchema } from "../src/schema.js";

/**
 * Point 6 du plan du juge (banc pharmania, PR #20 run 1 et f1 run 1) : une
 * `persisted` sur un état tenu en mémoire de la vue échouait au rechargement
 * sur la base comme sur la tête. Sans écriture durable dans le diff, et avec
 * un aller-retour de vue prouvé, elle se juge à la réentrée ; partout ailleurs
 * le rechargement reste la règle.
 */
const EXPECTED = "Erreur de rendu de monnaie";
const IN_MEMORY_PATCH = [
  "@@ -1,3 +1,4 @@",
  " export function CashView() {",
  "-  const [note, setNote] = useState('');",
  "+  const [note, setNote] = useState(draft);",
  "+  const reset = () => setCounts(empty);",
  " }",
].join("\n");

function context(patch: string, filename = "apps/web/app/page.tsx") {
  return {
    files: [
      { filename, status: "modified", patch },
      {
        filename: "openspec/proposal.md",
        status: "modified",
        patch:
          "@@ -1 +1 @@\n-ancien\n+Aucune persistance : fetch, localStorage, mutation.",
      },
    ],
  } as unknown as PrContext;
}

function scenario(
  overrides: {
    kind?: Scenario["kind"];
    leave?: "click" | "fill";
    refill?: boolean;
    title?: string;
  } = {}
): Scenario {
  const refill = overrides.refill
    ? [
        {
          id: "refill",
          description: "ressaisir la justification",
          action: {
            type: "fill",
            locator: { by: "label", value: "Justification" },
            value: EXPECTED,
          },
        },
      ]
    : [];
  const leave =
    overrides.leave === "fill"
      ? {
          type: "fill",
          locator: { by: "label", value: "Commentaire" },
          value: "ok",
        }
      : {
          type: "click",
          locator: { by: "role", value: "link", name: "Pilotage" },
        };
  return ScenarioSchema.parse({
    id: "justification-conservee",
    title: overrides.title ?? "La justification survit à la sortie de la vue",
    rationale: "La justification est gardée dans la vue Caisse et Coffre",
    kind: overrides.kind ?? "happy_path",
    sourceFiles: ["apps/web/app/page.tsx"],
    preconditions: [],
    requirements: [
      {
        sourceFile: "apps/web/app/page.tsx",
        quote: "const [note, setNote] = useState(draft);",
        behavior: "La justification saisie reste dans la vue",
      },
    ],
    steps: [
      {
        id: "open",
        description: "ouvrir",
        action: { type: "goto", path: "/" },
      },
      {
        id: "fill",
        description: "saisir la justification",
        action: {
          type: "fill",
          locator: { by: "label", value: "Justification" },
          value: EXPECTED,
        },
      },
      { id: "leave", description: "quitter la vue", action: leave },
      {
        id: "back",
        description: "revenir sur Caisse et Coffre",
        action: {
          type: "click",
          locator: { by: "role", value: "link", name: "Caisse et Coffre" },
        },
      },
      ...refill,
      {
        id: "check",
        description: "relire la justification",
        action: { type: "assert", assertionId: "justification-retrouvee" },
      },
    ],
    assertions: [
      {
        id: "justification-retrouvee",
        description: "la justification saisie est retrouvée",
        kind: "value",
        expected: EXPECTED,
        target: { by: "label", value: "Justification" },
        afterStep: "back",
        verification: "persisted",
        assertionIntent: "persistence",
        requirement: 0,
      },
    ],
  });
}

interface Probes {
  /** Avec un oracle de base (`QA_BASELINE_URL_TEMPLATE`) ; vrai par défaut. */
  base?: boolean;
  /** Valeur juste avant le retour ; absente = cible introuvable. */
  beforeReturn?: string;
  /** Valeur avant le départ ; absente = cible introuvable. */
  departure?: string;
  /** Code d'une erreur de navigateur levée par la relecture de fin de scénario. */
  reloadError?: string;
  /** Valeur après le rechargement ; absente = cible introuvable. */
  reloaded: string | undefined;
  /** Valeur relue après le retour ; l'attendu par défaut. */
  returned?: string;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

async function run(plan: Scenario, patch: string | undefined, probes: Probes) {
  const dataDir = await mkdtemp(join(tmpdir(), "canary-reentry-"));
  cleanups.push(() => rm(dataDir, { force: true, recursive: true }));
  const preview = "http://127.0.0.1:9/preview";
  const config = loadConfig({
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    OPENAI_MODEL: "fixture-scripted-model",
    QA_ALLOW_PRIVATE_PREVIEWS: "true",
    QA_API_TOKEN: "fixture-api-token-123456789012345",
    QA_DATA_DIR: dataDir,
    ...(probes.base === false
      ? {}
      : { QA_BASELINE_URL_TEMPLATE: "http://127.0.0.1:9/base/{sha}" }),
  });
  const labels: string[] = [];
  const read = (value: string | undefined): Observation => {
    if (value === undefined) {
      throw new QaError("TARGET_NOT_FOUND", "cible absente", "relire");
    }
    return { actual: value, snapshot: "vue", url: preview };
  };
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("reentry");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_session, label) => {
      labels.push(label);
      if (label.startsWith("departure-")) {
        return read(probes.departure);
      }
      if (label.startsWith("baseline-")) {
        return read(probes.beforeReturn);
      }
      if (label.startsWith("persistence-")) {
        return read(probes.reloaded);
      }
      if (label.startsWith("reload-")) {
        if (probes.reloadError) {
          throw new QaError(probes.reloadError, "navigateur", "relancer");
        }
        return read(probes.reloaded);
      }
      return read(
        label.endsWith("-assert") ? (probes.returned ?? EXPECTED) : EXPECTED
      );
    }
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([]);
  const result = await executeScenario(
    plan,
    preview,
    dataDir,
    config,
    new Canary(config),
    undefined,
    "",
    patch === undefined ? [] : sourceLineMaterial(context(patch))
  );
  return { labels, result };
}

const reloadsLost = {
  departure: EXPECTED,
  reloaded: "",
} satisfies Probes;

describe("persisted sans écriture durable dans le diff", () => {
  it("se juge à la réentrée quand le diff est purement en mémoire et que la vue a été quittée puis retrouvée", async () => {
    const { labels, result } = await run(
      scenario(),
      IN_MEMORY_PATCH,
      reloadsLost
    );
    expect(result.outcome).toBe("passed");
    // Aucun rechargement pendant le scénario : la valeur perdue au reload ne
    // décide pas l'issue de la tête. La relecture après rechargement est faite
    // en fin de scénario et consignée pour la base.
    expect(labels.some((label) => label.startsWith("persistence-"))).toBe(
      false
    );
    expect(labels.at(-1)).toBe("reload-justification-retrouvee");
    expect(result.assertions[0]).toMatchObject({
      passed: true,
      actual: EXPECTED,
      baseline: null,
      changed: true,
      verification: "persisted",
      reloadPersistence: "not-claimed",
      reloadPassed: false,
      reloadReading: "",
    });
    const runResult = {
      id: "run",
      outcome: "passed",
      prUrl: "https://github.com/o/r/pull/1",
      scenarios: [result],
      startedAt: "2026-10-31T00:00:00.000Z",
    } as RunResult;
    expect(reportMarkdown(runResult)).toContain(
      "reload persistence not claimed"
    );
    // Le rapport HTML publie la même réserve que report.md.
    const root = await mkdtemp(join(tmpdir(), "canary-reentry-report-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    await saveReport(root, runResult);
    const html = await readFile(join(root, "report.html"), "utf8");
    expect(html).toContain(
      "judged on re-entry: reload persistence not claimed"
    );
  });

  it("garde le rechargement quand le diff ajoute une écriture localStorage", async () => {
    const patch = `${IN_MEMORY_PATCH}\n+  localStorage.setItem("note", note);`;
    const { labels, result } = await run(scenario(), patch, reloadsLost);
    expect(labels.some((label) => label.startsWith("persistence-"))).toBe(true);
    expect(result.outcome).toBe("failed");
    expect(result.assertions[0]?.reloadPersistence).toBeUndefined();
  });

  it("garde le rechargement quand le diff retire une écriture localStorage", async () => {
    const patch = `${IN_MEMORY_PATCH}\n-  localStorage.setItem("note", note);`;
    const { labels, result } = await run(scenario(), patch, reloadsLost);
    expect(labels.some((label) => label.startsWith("persistence-"))).toBe(true);
    expect(result.outcome).toBe("failed");
  });

  it("garde le rechargement sans aller-retour de vue avant l'étape d'ancrage", async () => {
    const { labels, result } = await run(
      scenario({ leave: "fill" }),
      IN_MEMORY_PATCH,
      reloadsLost
    );
    expect(labels.some((label) => label.startsWith("departure-"))).toBe(false);
    expect(labels.some((label) => label.startsWith("persistence-"))).toBe(true);
    expect(result.outcome).toBe("failed");
  });

  it("garde le rechargement quand une écriture sépare le retour de la lecture", async () => {
    const { labels, result } = await run(
      scenario({ refill: true }),
      IN_MEMORY_PATCH,
      reloadsLost
    );
    expect(labels.some((label) => label.startsWith("departure-"))).toBe(false);
    expect(labels.some((label) => label.startsWith("persistence-"))).toBe(true);
    expect(result.outcome).toBe("failed");
  });

  it("garde le rechargement quand la valeur n'était pas là avant le départ", async () => {
    const { labels, result } = await run(scenario(), IN_MEMORY_PATCH, {
      reloaded: "",
    });
    expect(labels.some((label) => label.startsWith("persistence-"))).toBe(true);
    expect(result.outcome).toBe("failed");
  });

  it("garde le rechargement quand la cible n'a pas disparu avant le retour", async () => {
    const { labels, result } = await run(scenario(), IN_MEMORY_PATCH, {
      ...reloadsLost,
      beforeReturn: "",
    });
    expect(labels.some((label) => label.startsWith("persistence-"))).toBe(true);
    expect(result.outcome).toBe("failed");
  });

  it("garde le rechargement pour un scénario `regression`, même sans écriture dans le diff", async () => {
    // Une régression peut casser la relecture d'une persistance existante sur
    // une ligne sans mot-clé ; l'aller-retour, servi par un état en mémoire,
    // passerait des deux côtés. Le rechargement, lui, la mesure.
    const { labels, result } = await run(
      scenario({ kind: "regression" }),
      IN_MEMORY_PATCH,
      reloadsLost
    );
    expect(labels.some((label) => label.startsWith("departure-"))).toBe(false);
    expect(labels.some((label) => label.startsWith("persistence-"))).toBe(true);
    expect(result.outcome).toBe("failed");
    expect(result.assertions[0]?.reloadPersistence).toBeUndefined();
  });

  it("garde le rechargement quand le scénario parle de rechargement", async () => {
    const { labels, result } = await run(
      scenario({ title: "La justification survit au rechargement de la page" }),
      IN_MEMORY_PATCH,
      reloadsLost
    );
    expect(labels.some((label) => label.startsWith("persistence-"))).toBe(true);
    expect(result.outcome).toBe("failed");
  });

  it("garde le rechargement sans matériel de diff lié", async () => {
    const { labels, result } = await run(scenario(), undefined, reloadsLost);
    expect(labels.some((label) => label.startsWith("persistence-"))).toBe(true);
    expect(result.outcome).toBe("failed");
  });

  it("échoue à la réentrée quand la valeur est perdue au retour", async () => {
    const { result } = await run(scenario(), IN_MEMORY_PATCH, {
      ...reloadsLost,
      returned: "",
    });
    expect(result.outcome).toBe("failed");
    expect(result.assertions[0]).toMatchObject({
      passed: false,
      actual: "",
      reloadPersistence: "not-claimed",
    });
  });
});

describe("persisted jugée à la réentrée, confrontée au rechargement de la base", () => {
  // Une PR casse une persistance existante dont la lecture du stockage est
  // HORS du diff : `loadCart` lit localStorage ailleurs, le diff n'a aucun
  // mot-clé d'écriture durable.
  const LOAD_CART_PATCH = [
    "@@ -10,3 +10,3 @@ export function CartView() {",
    "-  useEffect(() => setItems(loadCart()), []);",
    "+  useEffect(() => setItems([]), []);",
  ].join("\n");
  const BASE_SHA = "b".repeat(40);

  function judged(
    head: Awaited<ReturnType<typeof run>>["result"],
    base: Awaited<ReturnType<typeof run>>["result"] | undefined
  ): RunResult {
    const result = {
      id: "run",
      outcome: "passed",
      prUrl: "https://github.com/o/r/pull/1",
      scenarios: [head],
      startedAt: "2026-10-31T00:00:00.000Z",
      baseline: {
        sha: BASE_SHA,
        url: "http://127.0.0.1:9/base",
        scenarios: base ? [base] : [],
      },
    } as RunResult;
    judgeAgainstBaseline(result, loadConfig({}));
    return result;
  }

  it("sans base, garde le rechargement comme sur main", async () => {
    const { labels, result } = await run(scenario(), LOAD_CART_PATCH, {
      ...reloadsLost,
      base: false,
    });
    expect(labels.some((label) => label.startsWith("departure-"))).toBe(false);
    expect(labels.some((label) => label.startsWith("persistence-"))).toBe(true);
    expect(labels.some((label) => label.startsWith("reload-"))).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.assertions[0]?.reloadPersistence).toBeUndefined();
  });

  it("rend BASELINE_REGRESSION quand la base garde la valeur au rechargement et pas la tête", async () => {
    const head = await run(scenario(), LOAD_CART_PATCH, reloadsLost);
    expect(head.result.outcome).toBe("passed");
    expect(head.result.assertions[0]).toMatchObject({
      reloadPersistence: "not-claimed",
      reloadPassed: false,
    });
    // La base joue le même plan avec le même exécuteur : elle aussi juge à la
    // réentrée, et consigne la relecture après rechargement.
    const base = await run(scenario(), LOAD_CART_PATCH, {
      departure: EXPECTED,
      reloaded: EXPECTED,
    });
    expect(base.result.assertions[0]).toMatchObject({
      reloadPersistence: "not-claimed",
      reloadPassed: true,
      reloadReading: EXPECTED,
    });
    const result = judged(head.result, base.result);
    expect(head.result.outcome).toBe("failed");
    expect(head.result.diagnostic?.code).toBe("BASELINE_REGRESSION");
    expect(result.baselineComparison?.regressions).toEqual([
      expect.objectContaining({
        assertionId: "justification-retrouvee",
        head: { passed: false, actual: "" },
        base: { passed: true, actual: EXPECTED },
      }),
    ]);
  });

  it("rend BASELINE_REGRESSION quand la base, rechargée sans réentrée, relit la valeur", async () => {
    const head = await run(scenario(), LOAD_CART_PATCH, reloadsLost);
    // Sur la base, la vue n'a pas été quittée : rechargement ordinaire.
    const base = await run(scenario(), LOAD_CART_PATCH, {
      beforeReturn: EXPECTED,
      departure: EXPECTED,
      reloaded: EXPECTED,
    });
    expect(base.result.assertions[0]?.reloadPersistence).toBeUndefined();
    judged(head.result, base.result);
    expect(head.result.outcome).toBe("failed");
    expect(head.result.diagnostic?.code).toBe("BASELINE_REGRESSION");
  });

  it("bloque quand la relecture de la base après rechargement n'est pas concluante", async () => {
    const head = await run(scenario(), LOAD_CART_PATCH, reloadsLost);
    const base = await run(scenario(), LOAD_CART_PATCH, {
      departure: EXPECTED,
      reloaded: EXPECTED,
      reloadError: "BROWSER_UNAVAILABLE",
    });
    expect(base.result.assertions[0]?.reloadPassed).toBeUndefined();
    const result = judged(head.result, base.result);
    expect(head.result.outcome).toBe("blocked");
    expect(head.result.diagnostic?.code).toBe("RELOAD_PERSISTENCE_UNPROVEN");
    expect(result.baselineComparison?.inconclusive).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assertionId: "justification-retrouvee" }),
      ])
    );
  });

  it("bloque quand la base manque ou est indisponible", async () => {
    const missing = await run(scenario(), LOAD_CART_PATCH, reloadsLost);
    judged(missing.result, undefined);
    expect(missing.result.outcome).toBe("blocked");
    const unavailable = await run(scenario(), LOAD_CART_PATCH, reloadsLost);
    const result = {
      id: "run",
      outcome: "passed",
      prUrl: "https://github.com/o/r/pull/1",
      scenarios: [unavailable.result],
      startedAt: "2026-10-31T00:00:00.000Z",
      baseline: {
        sha: BASE_SHA,
        url: "http://127.0.0.1:9/base",
        scenarios: [],
        diagnostic: { code: "PREVIEW_UNREACHABLE", message: "x", hint: "" },
      },
    } as RunResult;
    judgeAgainstBaseline(result, loadConfig({}));
    expect(unavailable.result.outcome).toBe("blocked");
  });

  it("bloque quand la relecture de la tête après rechargement manque", async () => {
    const head = await run(scenario(), IN_MEMORY_PATCH, {
      ...reloadsLost,
      reloadError: "BROWSER_UNAVAILABLE",
    });
    const base = await run(scenario(), IN_MEMORY_PATCH, reloadsLost);
    judged(head.result, base.result);
    expect(head.result.outcome).toBe("blocked");
  });

  it("laisse passer, avec la réserve, quand la valeur est perdue au rechargement des deux côtés", async () => {
    const head = await run(scenario(), IN_MEMORY_PATCH, reloadsLost);
    // La base montre une autre valeur au retour (la PR change le
    // comportement), et la perd elle aussi au rechargement.
    const base = await run(scenario(), IN_MEMORY_PATCH, {
      ...reloadsLost,
      returned: "Autre motif",
    });
    expect(base.result.assertions[0]).toMatchObject({
      reloadPersistence: "not-claimed",
      reloadPassed: false,
    });
    const result = judged(head.result, base.result);
    expect(head.result.outcome).toBe("passed");
    expect(result.baselineComparison?.regressions).toEqual([]);
    expect(reportMarkdown(result)).toContain("reload persistence not claimed");
  });

  it("laisse passer quand la cible est absente sur la base (interface ajoutée par la PR)", async () => {
    const head = await run(scenario(), IN_MEMORY_PATCH, reloadsLost);
    const base = await run(scenario(), IN_MEMORY_PATCH, {
      ...reloadsLost,
      departure: undefined,
      reloaded: undefined,
    });
    base.result.assertions = [];
    base.result.outcome = "blocked";
    base.result.diagnostic = {
      code: "TARGET_NOT_FOUND",
      message: "cible absente",
      hint: "",
    };
    judged(head.result, base.result);
    expect(head.result.outcome).toBe("passed");
  });

  it("laisse passer quand la tête garde la valeur au rechargement", async () => {
    const head = await run(scenario(), LOAD_CART_PATCH, {
      departure: EXPECTED,
      reloaded: EXPECTED,
    });
    judged(head.result, undefined);
    expect(head.result.outcome).toBe("passed");
  });
});

describe("lecture du diff pour l'écriture durable", () => {
  const claimed = (patch: string, filename?: string) =>
    durableWriteClaimed(sourceLineMaterial(context(patch, filename)));

  it("ne lit pas la prose ni un attribut de repérage data-*-action", () => {
    expect(claimed(IN_MEMORY_PATCH)).toBe(false);
    expect(
      claimed(`${IN_MEMORY_PATCH}\n+  <Button data-cash-action="cloturer" />`)
    ).toBe(false);
  });

  it("revendique une écriture pour le réseau, une action ou une aide d'écriture", () => {
    for (const line of [
      "+  await fetch('/api/notes', { body });",
      "+  axios.post(url, note);",
      "+  <form action={saveNote}>",
      "+'use server';",
      "-  saveDraft(note);",
      "+  const mutation = useMutation(update);",
      "+  document.cookie = 'note=' + note;",
      "+  router.replace('?note=' + note);",
      "+  persist(store);",
    ]) {
      expect(claimed(`${IN_MEMORY_PATCH}\n${line}`), line).toBe(true);
    }
  });

  it("revendique une écriture quand le diff touche le voisinage d'un stockage, même sans mot-clé modifié", () => {
    for (const patch of [
      [
        "@@ -4,3 +4,3 @@ export function Draft() {",
        "   const saved = localStorage.getItem('draft');",
        "-  if (saved) setDraft(saved);",
        "+  if (!saved) setDraft(saved);",
      ].join("\n"),
      [
        "@@ -8,3 +8,3 @@ function restoreDraft() {",
        "   const raw = window.sessionStorage.getItem('draft');",
        "-  hydrate(JSON.parse(raw));",
        "+  hydrate(raw);",
      ].join("\n"),
    ]) {
      expect(claimed(patch), patch).toBe(true);
    }
  });

  it("tient un fichier de code sans patch pour une écriture, pas une image", () => {
    const material = sourceLineMaterial({
      files: [
        { filename: "src/a.ts", status: "modified", patch: IN_MEMORY_PATCH },
        { filename: "src/huge.ts", status: "modified" },
      ],
    } as unknown as PrContext);
    expect(durableWriteClaimed(material)).toBe(true);
    const image = sourceLineMaterial({
      files: [
        { filename: "src/a.ts", status: "modified", patch: IN_MEMORY_PATCH },
        { filename: "public/logo.png", status: "added" },
      ],
    } as unknown as PrContext);
    expect(durableWriteClaimed(image)).toBe(false);
  });

  it("tient un matériel non lié pour une écriture", () => {
    expect(durableWriteClaimed([])).toBe(true);
  });
});
