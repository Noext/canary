import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertionMatches,
  Canary,
  compileAction,
  compileProbe,
} from "../src/canary.js";
import { classifyFailure } from "../src/diagnostics.js";
import { doctor } from "../src/doctor.js";
import { executeScenario } from "../src/executor.js";
import { GitHubSetup } from "../src/github-setup.js";
import { LocalAuth } from "../src/local-auth.js";
import { startProductionServer } from "../src/production-server.js";
import { Queue } from "../src/queue.js";
import { saveReport } from "../src/report.js";
import { runQa } from "../src/runner.js";
import { fixture, PR_URL, plan, SHA } from "./fixture.js";
import { githubSetupFixture } from "./github-setup-fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});
describe("real Canary Chromium with GitHub/AI REST fixtures", () => {
  it("runs the installation doctor through actual Chromium, REST/model and SHA probes without publishing", async () => {
    const f = await fixture();
    closers.push(f.close);
    const result = await doctor(f.config, {
      prUrl: PR_URL,
      previewUrl: f.baseUrl,
    });
    expect(result.healthy, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.filter((check) => check.status !== "passed")).toEqual(
      []
    );
    expect(f.outgoing).toEqual([]);
    expect(await readdir(join(f.dataDir, "_doctor"))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(f.config.GITHUB_TOKEN);
  }, 180_000);
  it("plays the form test, records video/trace/screenshots and publishes passed results", async () => {
    const f = await fixture({ unnamedStatus: true });
    closers.push(f.close);
    const result = await runQa(
      {
        prUrl: PR_URL,
        previewUrl: f.baseUrl,
        model: "fixture-alternate-model",
      },
      f.config
    );
    expect(result.model).toBe("fixture-alternate-model");
    expect(
      f.modelRequests.every(
        (request) => request.model === "fixture-alternate-model"
      )
    ).toBe(true);
    expect(result.outcome, result.error ?? result.scenarios[0]?.error).toBe(
      "passed"
    );
    expect(result.sha).toBe(SHA);
    const scenario = result.scenarios[0]!;
    expect(scenario.assertions).toEqual([
      { id: "saved", passed: true, actual: "Welcome Ada", baseline: "" },
    ]);
    expect(scenario.steps.map((step) => step.action.type)).toEqual([
      "fill",
      "click",
      "assert",
    ]);
    for (const extension of [".webm", ".zip", ".png", ".har"]) {
      const file = scenario.artifacts.find((path) => path.endsWith(extension));
      expect(file, `missing ${extension}`).toBeDefined();
      expect(
        (await stat(join(f.dataDir, result.id, "welcome", file!))).size
      ).toBeGreaterThan(0);
    }
    expect(
      f.outgoing.map((request) => request.payload.state).filter(Boolean)
    ).toEqual(["pending", "success"]);
    expect(
      f.outgoing.find((request) => request.path.endsWith("/comments"))?.payload
        .body
    ).toContain("PASSED");
    const html = await readFile(
      join(f.dataDir, result.id, "report.html"),
      "utf8"
    );
    expect(html).toContain("<video controls");
    expect(html).not.toContain("fixture-token");
    process.stdout.write(
      `E2E passed report: ${join(f.dataDir, result.id, "report.html")}\n`
    );
  }, 180_000);
  it("detects an actual UI regression and publishes failure with the recorded video", async () => {
    const f = await fixture({ broken: true });
    closers.push(f.close);
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome, result.error ?? result.scenarios[0]?.error).toBe(
      "failed"
    );
    expect(result.scenarios[0]?.assertions).toEqual([
      { id: "saved", passed: false, actual: "Wrong output", baseline: "" },
    ]);
    expect(
      f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
        .state
    ).toBe("failure");
    expect(
      result.scenarios[0]?.artifacts.some((file) => file.endsWith(".webm"))
    ).toBe(true);
    process.stdout.write(
      `E2E failed-case report: ${join(f.dataDir, result.id, "report.html")}\n`
    );
  }, 180_000);
  it.skipIf(!process.env.CANARY_DAEMON_PORT)(
    "rejects an unauthorized request on the actual loopback daemon",
    async () => {
      await new Promise<void>((done, reject) => {
        const socket = net.connect({
          host: "127.0.0.1",
          port: Number(process.env.CANARY_DAEMON_PORT),
        });
        let output = "";
        socket.setTimeout(3000, () => {
          socket.destroy();
          reject(new Error("Authentication test timed out"));
        });
        socket.on("connect", () =>
          socket.write(
            `${JSON.stringify({
              id: "unauthorized",
              type: "status",
              transportToken: "wrong-token",
            })}\n`
          )
        );
        socket.on("data", (data) => {
          output += data.toString();
        });
        socket.on("error", reject);
        socket.on("close", () => {
          if (output) {
            reject(new Error("Unauthenticated daemon returned data"));
          } else {
            done();
          }
        });
      });
    }
  );
});

it("blames the plan for a transition on an invariant, and the application for a missed one", async () => {
  const f = await fixture({ unchangedState: true });
  closers.push(f.close);
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  // La page n'a pas bougé ET le libellé attendu est déjà celui qui s'affiche :
  // le plan a exigé un changement sur un invariant, donc le verdict nomme le
  // plan (`blocked`) au lieu d'accuser l'application (`failed`).
  expect(result.outcome, result.scenarios[0]?.error).toBe("blocked");
  expect(result.scenarios[0]?.diagnostic?.code).toBe("TRANSITION_ON_INVARIANT");
  expect(result.scenarios[0]?.assertions[0]).toMatchObject({
    baseline: "Welcome Ada",
    actual: "Welcome Ada",
    passed: false,
  });
  const differentName = structuredClone(plan.scenarios[0]!);
  differentName.id = "unchanged-grace";
  const enter = differentName.steps[0]!.action;
  if (enter.type !== "fill") {
    throw new Error("Expected form input");
  }
  enter.value = "Grace";
  const assertion = differentName.assertions[0]!;
  if (assertion.kind !== "text") {
    throw new Error("Expected text assertion");
  }
  assertion.expected = "Welcome Grace";
  const alternate = await executeScenario(
    differentName,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config)
  );
  // Ici l'attendu n'est pas atteint : l'application n'a pas fait ce que
  // l'étape promettait, et le verdict reste un échec.
  expect(alternate.outcome, alternate.error).toBe("failed");
  expect(alternate.diagnostic?.code).toBe("TRANSITION_NOT_OBSERVED");
  expect(alternate.assertions[0]).toMatchObject({
    baseline: "Welcome Ada",
    actual: "Welcome Ada",
    passed: false,
  });
}, 180_000);
/**
 * Le faux vert de `STATE_ALREADY_SATISFIED`, sur une page réelle : `#saved` porte
 * déjà « Welcome Ada » au chargement, et le gestionnaire de soumission se
 * réécrit lui-même (option `unchangedState`), donc le clic ne déplace rien.
 * L'assertion `state` constatait cet état initial et le scénario sortait vert.
 *
 * Le même plan en `transition` est le test précédent (`TRANSITION_ON_INVARIANT`).
 * L'exécution passe par `executeScenario` directement, comme la seconde moitié
 * de ce test : un scénario qui interagit sans preuve de changement est refusé
 * avant exécution par `writeEvidenceRefusals` (`WRITE_EVIDENCE_MISSING`), ce qui
 * est la politique du plan et n'a pas changé ici.
 */
it("blames the plan for a state assertion already satisfied before a real click", async () => {
  const f = await fixture({ unchangedState: true });
  closers.push(f.close);
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.id = "already-satisfied-state";
  scenario.assertions[0]!.verification = "state";
  const result = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config)
  );
  // La valeur d'arrivée est identique à celle d'avant, et celle d'avant
  // satisfaisait déjà l'attendu : l'étape n'a rien produit de vérifiable.
  expect(result.outcome, result.error).toBe("blocked");
  expect(result.diagnostic?.code).toBe("STATE_ALREADY_SATISFIED");
  expect(result.assertions[0]).toMatchObject({
    actual: "Welcome Ada",
    baseline: "Welcome Ada",
    passed: false,
    preMatched: true,
  });
  // Le blâme va au plan dans les DEUX taxonomies : `classifyFailure` (rapport et
  // mesures) et `classifyScenarioResult` (chemin observe→act, lu par
  // `enforceObjectiveProof`). Un code de défaut de plan absent de la seconde
  // faisait sortir le scénario `indeterminate`.
  expect(classifyFailure({ code: result.diagnostic?.code })).toBe(
    "plan-defective"
  );
  expect(result.classification).toBe("test-defect");
}, 180_000);
it("keeps a skipped ifPresent establishment green in real Chromium", async () => {
  // L'établissement tolérant : le contrôle n'existe pas sur cette page, l'étape
  // est sautée et l'assertion d'état constate l'état voulu. Le plan a déclaré le
  // no-op, donc la pré-satisfaction reste légitime.
  const f = await fixture({ unchangedState: true });
  closers.push(f.close);
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.id = "skipped-establishment";
  scenario.steps = [
    scenario.steps[0]!,
    {
      id: "reopen",
      description: "réouvrir le comptage si le contrôle est présent",
      action: {
        type: "click",
        ifPresent: true,
        locator: { by: "role", value: "button", name: "Réouvrir le comptage" },
      },
    },
    {
      id: "verify",
      description: "relire l'état",
      action: { type: "assert", assertionId: "saved" },
    },
  ];
  const assertion = scenario.assertions[0]!;
  assertion.afterStep = "reopen";
  assertion.verification = "state";
  const result = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config)
  );
  expect(result.outcome, result.error).toBe("passed");
  expect(result.steps.find((step) => step.stepId === "reopen")?.skipped).toBe(
    true
  );
  expect(result.assertions[0]).toMatchObject({ passed: true });
}, 180_000);
it("keeps an assertion anchored on the initial navigation green in real Chromium", async () => {
  // Ancre navigation : aucune valeur d'avant n'est relevée, donc aucune
  // pré-satisfaction ne peut être inventée, même quand la page porte déjà
  // l'attendu au chargement.
  const f = await fixture({ unchangedState: true });
  closers.push(f.close);
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.id = "navigation-anchor";
  scenario.steps = [
    {
      id: "load",
      description: "ouvrir la page",
      action: { type: "goto", path: "/" },
    },
    {
      id: "verify",
      description: "relire l'état",
      action: { type: "assert", assertionId: "saved" },
    },
  ];
  const assertion = scenario.assertions[0]!;
  assertion.afterStep = "load";
  assertion.verification = "state";
  const result = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config)
  );
  expect(result.outcome, result.error).toBe("passed");
  expect(result.assertions[0]).toMatchObject({ passed: true });
  expect(result.assertions[0]).not.toHaveProperty("preMatched");
}, 180_000);
/**
 * Le cas réel f0f24722 : le plan recopie la ponctuation de sa source (U+0027),
 * l'application expose l'apostrophe typographique (U+2019), et Playwright
 * compare le nom accessible caractère par caractère avec `exact: true`. Le repli
 * ne vise l'autre graphie que si elle atteint exactement un élément, et le nom
 * réellement visé est publié avec l'observation.
 */
it("targets the exposed spelling in actual Chromium, and nothing when two compete", async () => {
  const f = await fixture();
  closers.push(f.close);
  const canary = new Canary(f.config);
  const id = await canary.start("Typographic accessible name");
  const planned = {
    by: "role" as const,
    value: "textbox",
    name: "Justification de l'écart",
  };
  try {
    await canary.act(
      id,
      "open",
      compileAction({ type: "goto", path: "/typographie" }, f.baseUrl)
    );
    const filled = await canary.act(
      id,
      "fill",
      compileAction(
        { type: "fill", locator: planned, value: "Écart constaté" },
        f.baseUrl
      )
    );
    expect(filled.targetName).toBe("Justification de l\u2019écart");
    const read = await canary.act(
      id,
      "read",
      compileProbe(
        {
          id: "justification",
          kind: "value",
          description: "la justification saisie est relue",
          expected: "Écart constaté",
          target: planned,
        },
        f.baseUrl
      )
    );
    expect(read.actual).toBe("Écart constaté");
    // `isVisible()` et `count()` ne lèvent jamais, même sur un locator vide :
    // sans résolution préalable du nom exposé, « hidden » passait sur une cible
    // visible et « visible »/« count » échouaient dessus. Les trois verdicts
    // doivent être justes, sur la graphie que la page expose.
    const visible = await canary.act(
      id,
      "visible",
      compileProbe(
        {
          id: "visible",
          kind: "visible",
          description: "la justification de l'écart est visible",
          target: planned,
        },
        f.baseUrl
      )
    );
    expect(visible.actual).toBe(true);
    expect(visible.targetName).toBe("Justification de l\u2019écart");
    const hidden = await canary.act(
      id,
      "hidden",
      compileProbe(
        {
          id: "hidden",
          kind: "hidden",
          description: "la justification de l'écart est cachée",
          target: planned,
        },
        f.baseUrl
      )
    );
    expect(hidden.actual).toBe(true);
    expect(hidden.targetName).toBe("Justification de l\u2019écart");
    expect(
      assertionMatches(
        {
          id: "hidden",
          kind: "hidden",
          description: "la justification de l'écart est cachée",
        },
        hidden.actual
      )
    ).toBe(false);
    const count = await canary.act(
      id,
      "count",
      compileProbe(
        {
          id: "count",
          kind: "count",
          description: "la justification de l'écart compte un élément",
          expected: 1,
          target: planned,
        },
        f.baseUrl
      )
    );
    expect(count.actual).toBe(1);
    expect(count.targetName).toBe("Justification de l\u2019écart");
    // Deux graphies concurrentes : la cible du plan ne résout toujours rien, et
    // l'échec d'origine remonte au lieu d'un contrôle choisi au hasard.
    await canary.act(
      id,
      "open-double",
      compileAction({ type: "goto", path: "/typographie-double" }, f.baseUrl)
    );
    await expect(
      canary.act(
        id,
        "ambiguous-fill",
        compileAction(
          { type: "fill", locator: planned, value: "Écart constaté" },
          f.baseUrl
        )
      )
    ).rejects.toThrow(/Timeout \d+ms exceeded/);
    // Une lecture qui mesure ne rend ni false ni 0 : elle nomme l'ambiguïté au
    // lieu de laisser « hidden » passer sur un locator vide.
    await expect(
      canary.act(
        id,
        "ambiguous-hidden",
        compileProbe(
          {
            id: "hidden",
            kind: "hidden",
            description: "la justification de l'écart est cachée",
            target: planned,
          },
          f.baseUrl
        )
      )
    ).rejects.toThrow(/Ambiguous accessible name/);
    // Un comptage ne choisit pas un élément : les deux graphies du même signe
    // s'additionnent, donc « count: 1 » est faux au lieu d'être une ambiguïté.
    const doubleCount = await canary.act(
      id,
      "count-double",
      compileProbe(
        {
          id: "count",
          kind: "count",
          description: "la justification de l'écart compte un élément",
          expected: 1,
          target: planned,
        },
        f.baseUrl
      )
    );
    expect(doubleCount.actual).toBe(2);
    expect(
      assertionMatches(
        {
          id: "count",
          kind: "count",
          description: "la justification de l'écart compte un élément",
          expected: 1,
        },
        doubleCount.actual
      )
    ).toBe(false);
    const doubleCountTwo = await canary.act(
      id,
      "count-double-two",
      compileProbe(
        {
          id: "count",
          kind: "count",
          description: "les deux graphies comptent deux éléments",
          expected: 2,
          target: planned,
        },
        f.baseUrl
      )
    );
    // Le total des deux graphies tombe juste : aucune unicité n'est exigée.
    expect(doubleCountTwo.actual).toBe(2);
    expect(
      assertionMatches(
        {
          id: "count",
          kind: "count",
          description: "les deux graphies comptent deux éléments",
          expected: 2,
        },
        doubleCountTwo.actual
      )
    ).toBe(true);
  } finally {
    await canary.abort(id).catch(() => undefined);
  }
}, 180_000);
/**
 * Le cas F1b : le texte ou le placeholder ne diffère du plan que par la graphie
 * de l'apostrophe, et `isVisible()`/`count()` ne lèvent jamais sur un locator
 * vide — sans résolution préalable, « hidden » passait sur un texte pourtant
 * affiché. Le comptage additionne les graphies du même signe, donc l'unicité n'y
 * a pas de sens, et deux graphies concurrentes restent un échec explicite.
 */
it("measures text and placeholder spellings in actual Chromium", async () => {
  const f = await fixture();
  closers.push(f.close);
  const canary = new Canary(f.config);
  const id = await canary.start("Typographic text and placeholder");
  const exposed = "Justification de l\u2019écart";
  const targets = [
    { by: "text" as const, value: "Justification de l'écart" },
    { by: "placeholder" as const, value: "Justification de l'écart" },
  ];
  const reading = (
    target: (typeof targets)[number],
    kind: "visible" | "hidden" | "count",
    expected = 1
  ) =>
    kind === "count"
      ? compileProbe(
          {
            id: "count",
            kind: "count",
            description: "la justification de l'écart compte des éléments",
            expected,
            target,
          },
          f.baseUrl
        )
      : compileProbe(
          {
            id: kind,
            kind,
            description: `la justification de l'écart est ${kind === "hidden" ? "cachée" : "affichée"}`,
            target,
          },
          f.baseUrl
        );
  try {
    for (const target of targets) {
      await canary.act(
        id,
        `open-${target.by}`,
        compileAction({ type: "goto", path: "/typographie-texte" }, f.baseUrl)
      );
      const visible = await canary.act(
        id,
        `visible-${target.by}`,
        reading(target, "visible")
      );
      expect(visible.actual, target.by).toBe(true);
      expect(visible.targetName, target.by).toBe(exposed);
      const hidden = await canary.act(
        id,
        `hidden-${target.by}`,
        reading(target, "hidden")
      );
      // Le texte est affiché : « hidden » est faux au lieu de passer sur un
      // locator vide.
      expect(hidden.actual, target.by).toBe(true);
      expect(
        assertionMatches(
          {
            id: "hidden",
            kind: "hidden",
            description: "la justification de l'écart est cachée",
          },
          hidden.actual
        ),
        target.by
      ).toBe(false);
      const count = await canary.act(
        id,
        `count-${target.by}`,
        reading(target, "count")
      );
      expect(count.actual, target.by).toBe(1);
      expect(count.targetName, target.by).toBe(exposed);
    }
    // Libellés français à trois puis quatre signes repliables (27 et 81
    // graphies) : au plafond historique de 16 la lecture retombait sur la
    // graphie brute, donc « hidden » passait sur un texte pourtant affiché. Les
    // verdicts doivent porter sur la graphie que Chromium expose.
    for (const [route, label] of [
      ["/typographie-texte-long", "l'écart d'espèces n'est pas justifié"],
      [
        "/typographie-texte-long-four",
        "l'écart d'espèces n'est pas justifié par l'opérateur",
      ],
    ] as const) {
      const longExposed = label.replace(/'/g, "\u2019");
      await canary.act(
        id,
        `open-${route}`,
        compileAction({ type: "goto", path: route }, f.baseUrl)
      );
      for (const target of [
        { by: "text" as const, value: label },
        { by: "placeholder" as const, value: label },
      ]) {
        const visible = await canary.act(
          id,
          `visible-${route}-${target.by}`,
          reading(target, "visible")
        );
        expect(visible.actual, `${route} ${target.by}`).toBe(true);
        expect(visible.targetName, `${route} ${target.by}`).toBe(longExposed);
        const hidden = await canary.act(
          id,
          `hidden-${route}-${target.by}`,
          reading(target, "hidden")
        );
        expect(hidden.actual, `${route} ${target.by}`).toBe(true);
        expect(
          assertionMatches(
            {
              id: "hidden",
              kind: "hidden",
              description: "l'écart d'espèces n'est pas justifié",
            },
            hidden.actual
          ),
          `${route} ${target.by}`
        ).toBe(false);
        const count = await canary.act(
          id,
          `count-${route}-${target.by}`,
          reading(target, "count")
        );
        expect(count.actual, `${route} ${target.by}`).toBe(1);
      }
    }
    // Un comptage honnête additionne les graphies décalées : deux éléments pour
    // un compte de deux est vrai, trois pour deux est faux, sans ambiguïté.
    await canary.act(
      id,
      "open-double",
      compileAction(
        { type: "goto", path: "/typographie-texte-double" },
        f.baseUrl
      )
    );
    const doubleText = await canary.act(
      id,
      "count-double-text",
      reading(targets[0]!, "count", 2)
    );
    expect(doubleText.actual).toBe(2);
    await canary.act(
      id,
      "open-triple",
      compileAction(
        { type: "goto", path: "/typographie-texte-triple" },
        f.baseUrl
      )
    );
    const triplePlaceholder = await canary.act(
      id,
      "count-triple-placeholder",
      reading(targets[1]!, "count", 2)
    );
    expect(triplePlaceholder.actual).toBe(3);
    // Deux graphies concurrentes : la mesure échoue explicitement au lieu de
    // rendre un verdict sur un locator vide.
    await canary.act(
      id,
      "open-double-again",
      compileAction(
        { type: "goto", path: "/typographie-texte-double" },
        f.baseUrl
      )
    );
    for (const target of targets) {
      await expect(
        canary.act(id, `ambiguous-${target.by}`, reading(target, "hidden")),
        target.by
      ).rejects.toThrow(new RegExp(`Ambiguous ${target.by}`));
    }
  } finally {
    await canary.abort(id).catch(() => undefined);
  }
}, 180_000);
it("checks persistence after real reload and fails a missing storage write", async () => {
  for (const broken of [false, true]) {
    const f = await fixture({ persistent: true, persistenceBroken: broken });
    closers.push(f.close);
    const scenario = structuredClone(plan.scenarios[0]!);
    scenario.assertions[0]!.verification = "persisted";
    const result = await executeScenario(
      scenario,
      f.baseUrl,
      f.dataDir,
      f.config,
      new Canary(f.config)
    );
    expect(result.outcome, result.error).toBe(broken ? "failed" : "passed");
    expect(result.assertions[0]?.persisted).toBe(broken ? "" : "Welcome Ada");
  }
}, 180_000);
it("blocks actual page subrequests outside the approved host and port", async () => {
  let hits = 0;
  const sink = createServer((_req, res) => {
    hits++;
    res.end("not allowed");
  });
  await new Promise<void>((done) => sink.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise<void>((done) => sink.close(() => done())));
  const address = sink.address() as { port: number };
  const f = await fixture({
    maliciousUrl: `http://127.0.0.1:${address.port}/probe`,
  });
  closers.push(f.close);
  const canary = new Canary(f.config);
  const id = await canary.start("Network isolation probe");
  try {
    await canary.act(
      id,
      "open",
      compileAction({ type: "goto", path: f.baseUrl }, f.baseUrl)
    );
    await canary.act(
      id,
      "observe",
      compileAction({ type: "observe" }, f.baseUrl)
    );
    expect(hits).toBe(0);
    await canary.end(id, join(f.dataDir, "network"));
  } finally {
    await canary.abort(id);
  }
}, 180_000);
it("installs trusted role cookies before navigation, with no secrets sent to the model", async () => {
  const f = await fixture({ requireCookie: true });
  closers.push(f.close);
  const file = join(f.dataDir, "fixtures.json");
  await writeFile(
    file,
    JSON.stringify({ "fixture/app": { roles: { member: "QA_E2E_ROLE" } } })
  );
  vi.stubEnv(
    "QA_E2E_ROLE",
    JSON.stringify({
      cookies: [
        {
          name: "qa_role",
          value: "test-member-secret",
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
          expires: -1,
        },
      ],
      origins: [],
    })
  );
  const config = { ...f.config, QA_FIXTURES_FILE: file };
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.preconditions = ["role:member"];
  try {
    const result = await executeScenario(
      scenario,
      f.baseUrl,
      f.dataDir,
      config,
      new Canary(config),
      undefined,
      "fixture/app"
    );
    expect(result.outcome, result.error).toBe("passed");
    expect(JSON.stringify(f.modelRequests)).not.toContain("test-member-secret");
  } finally {
    vi.unstubAllEnvs();
  }
}, 180_000);
it("verifies real download and popup events through the immutable scenario contract", async () => {
  const f = await fixture();
  closers.push(f.close);
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.id = "browser-events";
  scenario.steps = [
    {
      id: "open",
      description: "Open the preview",
      action: { type: "goto", path: "/" },
    },
    {
      id: "download",
      description: "Download the report",
      action: {
        type: "download",
        locator: { by: "role", value: "link", name: "Download report" },
        assertionId: "downloaded",
      },
    },
    {
      id: "popup",
      description: "Open popup",
      action: {
        type: "popup",
        locator: { by: "role", value: "link", name: "Open popup" },
        assertionId: "opened",
      },
    },
  ];
  scenario.assertions = [
    {
      id: "downloaded",
      description: "Correct file downloaded",
      kind: "download",
      expected: "report.txt",
      afterStep: "open",
      verification: "state",
    },
    {
      id: "opened",
      description: "Correct popup opened",
      kind: "popup",
      expected: `${f.baseUrl}/popup`,
      afterStep: "open",
      verification: "state",
    },
  ];
  const result = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config)
  );
  expect(result.outcome, result.error).toBe("passed");
  expect(result.assertions.map((a) => a.actual)).toEqual([
    "report.txt",
    `${f.baseUrl}/popup`,
  ]);
}, 180_000);
it("compares real screenshots with a trusted baseline and rejects a changed image", async () => {
  const f = await fixture();
  closers.push(f.close);
  const canary = new Canary(f.config);
  const id = await canary.start("Trusted visual test oracle");
  let image: string;
  const assertion = {
    id: "visual",
    description: "Heading appearance",
    kind: "visual" as const,
    expected: "heading",
    target: { by: "css" as const, value: "h1" },
    afterStep: "open",
    verification: "state" as const,
  };
  try {
    await canary.act(
      id,
      "open",
      compileAction({ type: "goto", path: "/" }, f.baseUrl)
    );
    image = (
      await canary.act(
        id,
        "capture",
        compileAction(
          { type: "assert", assertionId: "visual", locator: assertion.target },
          f.baseUrl,
          assertion
        )
      )
    ).actual as string;
    await canary.end(id, join(f.dataDir, "visual-oracle"));
  } finally {
    await canary.abort(id);
  }
  const baseline = join(f.dataDir, "baseline.png");
  await writeFile(baseline, Buffer.from(image!, "base64"));
  const fixturesFile = join(f.dataDir, "visual-fixtures.json");
  await writeFile(
    fixturesFile,
    JSON.stringify({ "fixture/app": { visuals: { heading: baseline } } })
  );
  const config = { ...f.config, QA_FIXTURES_FILE: fixturesFile };
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.id = "visual-heading";
  scenario.steps = [
    {
      id: "open",
      description: "Open preview",
      action: { type: "goto", path: "/" },
    },
    {
      id: "verify",
      description: "Compare appearance",
      action: { type: "assert", assertionId: "visual" },
    },
  ];
  scenario.assertions = [assertion];
  const healthy = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    config,
    new Canary(config),
    undefined,
    "fixture/app"
  );
  expect(healthy.outcome, healthy.error).toBe("passed");
  const { PNG } = await import("pngjs");
  const changed = PNG.sync.read(Buffer.from(image!, "base64"));
  changed.data.fill(255);
  await writeFile(baseline, PNG.sync.write(changed));
  const broken = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    config,
    new Canary(config),
    undefined,
    "fixture/app"
  );
  expect(broken.outcome, broken.error).toBe("failed");
}, 180_000);

it("uses the actual dashboard in Chromium: login, project list, live SSE and cancellation", async () => {
  await dashboardDatabase();
  const f = await fixture();
  closers.push(f.close);
  const viewerToken = "dashboard-viewer-token-0123456789";
  const usersFile = join(f.dataDir, "dashboard-users.json");
  await writeFile(
    usersFile,
    JSON.stringify([
      {
        id: "read-only",
        role: "viewer",
        repos: ["fixture/app"],
        tokenSha256: createHash("sha256").update(viewerToken).digest("hex"),
      },
    ])
  );
  const config = {
    ...f.config,
    OPENAI_MODEL: "missing-default-model",
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
    QA_USERS_FILE: usersFile,
  };
  const server = await startProductionServer(config);
  closers.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const queue = new Queue(config.DATABASE_URL);
  const job = await queue.enqueue(
    "fixture/app",
    1,
    SHA,
    "tester",
    { prUrl: PR_URL },
    "dashboard-test"
  );
  const canary = new Canary({
    ...config,
    allowedHosts: [...config.allowedHosts, new URL(url).host],
    PREVIEW_ALLOWED_HOSTS: [
      ...config.allowedHosts,
      new URL(url).host,
      new URL(url.replace("127.0.0.1", "localhost")).host,
    ].join(","),
  });
  const id = await canary.start("Dashboard UI verification");
  async function act(
    label: string,
    action: Parameters<typeof compileAction>[0],
    assertion?: Parameters<typeof compileAction>[2]
  ) {
    return canary.act(id, label, compileAction(action, url, assertion));
  }
  try {
    await act("open-dashboard", { type: "goto", path: "/" });
    await act("technical-access", {
      type: "click",
      locator: { by: "css", value: "#technicalAccess > summary" },
    });
    await act("enter-token", {
      type: "fill",
      locator: { by: "css", value: "#token" },
      value: config.QA_API_TOKEN,
    });
    await act("login", {
      type: "click",
      locator: { by: "role", value: "button", name: "Connexion technique" },
    });
    await act("history-navigation", {
      type: "click",
      locator: { by: "css", value: "#nav-runs" },
    });
    const listed = await act(
      "list",
      {
        type: "assert",
        assertionId: "list",
        locator: { by: "css", value: "#runs" },
      },
      {
        id: "list",
        description: "Project visible",
        kind: "text",
        expected: "fixture/app #1",
        verification: "state",
        afterStep: "login",
      }
    );
    expect(listed.actual).toContain("fixture/app #1");
    await act("new-test-navigation", {
      type: "click",
      locator: { by: "css", value: "#nav-new" },
    });
    const noFallback = await act(
      "no-fallback",
      {
        type: "assert",
        assertionId: "no-fallback",
        locator: { by: "css", value: "#modelState" },
      },
      {
        id: "no-fallback",
        description: "Explicit choice required for missing default",
        kind: "text",
        expected: "choisissez explicitement",
        verification: "state",
      }
    );
    expect(noFallback.actual).toContain("choisissez explicitement");
    const disabled = await act(
      "launch-disabled",
      {
        type: "assert",
        assertionId: "disabled",
        locator: { by: "css", value: "#startRun:disabled" },
      },
      {
        id: "disabled",
        description: "Cannot launch before explicit selection",
        kind: "visible",
        verification: "state",
      }
    );
    expect(disabled.actual).toBe(true);
    await act("back-to-history", {
      type: "click",
      locator: { by: "css", value: "#nav-runs" },
    });
    await act("open-run", {
      type: "click",
      locator: { by: "role", value: "link", name: "fixture/app #1" },
    });
    const stream = await act(
      "live",
      {
        type: "assert",
        assertionId: "live",
        locator: { by: "css", value: "#liveConnection" },
      },
      {
        id: "live",
        description: "SSE connected",
        kind: "text",
        expected: "Suivi en direct connecté",
        verification: "state",
        afterStep: "open",
      }
    );
    expect(stream.actual).toBe("Suivi en direct connecté");
    await queue.claim("dashboard-worker");
    const running = await act(
      "running",
      {
        type: "assert",
        assertionId: "running",
        locator: { by: "css", value: "#runState" },
      },
      {
        id: "running",
        description: "Running update delivered",
        kind: "text",
        expected: "En cours",
        verification: "state",
        afterStep: "open",
      }
    );
    expect(String(running.actual).toLowerCase()).toContain("en cours");
    await act("cancel", {
      type: "click",
      locator: { by: "role", value: "button", name: "Annuler le test" },
    });
    for (
      let i = 0;
      i < 20 && !(await queue.get(job.id))?.cancel_requested;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await queue.get(job.id))?.cancel_requested).toBe(true);
    await act("new-after-cancel", {
      type: "click",
      locator: { by: "css", value: "#nav-new" },
    });
    await act("choose-model", {
      type: "select",
      locator: { by: "css", value: "#model" },
      value: "fixture-alternate-model",
    });
    await act("enter-pr", {
      type: "fill",
      locator: { by: "css", value: "#pr" },
      value: PR_URL,
    });
    await act("enter-preview", {
      type: "fill",
      locator: { by: "css", value: "#preview" },
      value: f.baseUrl,
    });
    await act("preflight-before-launch", {
      type: "click",
      locator: { by: "css", value: "#checkRun" },
    });
    const checked = await act(
      "preflight-confirmation",
      {
        type: "assert",
        assertionId: "preflight",
        locator: { by: "css", value: "#preflightSummary" },
      },
      {
        id: "preflight",
        description: "PR and preview verified",
        kind: "text",
        expected: "fixture/app",
        verification: "state",
      }
    );
    expect(checked.actual).toContain("fixture/app");
    await act("launch-selected-model", {
      type: "click",
      locator: { by: "css", value: "#startRun" },
    });
    for (
      let i = 0;
      i < 30 && (await queue.list(["fixture/app"])).length < 2;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const selected = (await queue.list(["fixture/app"])).find(
      (run) => run.id !== job.id
    );
    expect(selected?.input.model).toBe("fixture-alternate-model");
    expect(f.catalogRequests.length).toBeGreaterThan(0);
    await act("logout", {
      type: "click",
      locator: { by: "role", value: "button", name: "Déconnexion" },
    });
    await act("viewer-technical-access", {
      type: "click",
      locator: { by: "css", value: "#technicalAccess > summary" },
    });
    await act("viewer-token", {
      type: "fill",
      locator: { by: "css", value: "#token" },
      value: viewerToken,
    });
    await act("viewer-login", {
      type: "click",
      locator: { by: "role", value: "button", name: "Connexion technique" },
    });
    const viewer = await act(
      "viewer-ready",
      {
        type: "assert",
        assertionId: "viewer",
        locator: { by: "css", value: "#connection" },
      },
      {
        id: "viewer",
        description: "Viewer identified",
        kind: "text",
        expected: "read-only",
        verification: "state",
        afterStep: "login",
      }
    );
    expect(viewer.actual).toContain("read-only");
    const controls = await act(
      "viewer-controls",
      {
        type: "assert",
        assertionId: "controls",
        locator: { by: "css", value: "#runForm" },
      },
      {
        id: "controls",
        description: "Read-only controls hidden",
        kind: "hidden",
        verification: "state",
        afterStep: "login",
      }
    );
    expect(controls.actual).toBe(false);
    const reportRoot = join(f.dataDir, job.id);
    const files = await canary.end(id, join(reportRoot, "dashboard"));
    await saveReport(
      reportRoot,
      {
        id: job.id,
        prUrl: PR_URL,
        sha: SHA,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        outcome: "passed",
        scenarios: [
          {
            scenario: {
              ...plan.scenarios[0]!,
              id: "dashboard",
              title: "Dashboard test recording",
            },
            steps: [],
            assertions: [],
            artifacts: files,
            outcome: "passed",
          },
        ],
      },
      config
    );
    const htmlPath = join(reportRoot, "report.html");
    await writeFile(
      htmlPath,
      `${await readFile(htmlPath, "utf8")}<script>document.documentElement.dataset.qaInjection="executed";</script>`
    );
    const login = await fetch(`${url}/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.QA_API_TOKEN}` },
    });
    const cookie = login.headers
      .get("set-cookie")!
      .split(";")[0]!
      .slice("qa_session=".length);
    const reportUrl = `${url.replace("127.0.0.1", "localhost")}/artifacts/${job.id}/report.html`;
    const player = await canary.start("Authenticated report video playback", {
      cookies: [
        {
          name: "qa_session",
          value: cookie,
          domain: "localhost",
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
          expires: -1,
        },
      ],
      origins: [],
    });
    try {
      const playback = await canary.act(
        player,
        "playback",
        `const page = await browser.getPage("qa");
await page.goto(${JSON.stringify(f.baseUrl)}, {waitUntil:"domcontentloaded"});
await page.evaluate(href => { const link = document.createElement("a"); link.href = href; link.textContent = "Open QA report"; document.body.append(link); }, ${JSON.stringify(reportUrl)});
await page.getByRole("link", {name:"Open QA report"}).click();
await page.waitForURL(${JSON.stringify(reportUrl)});
await page.locator("video").click();
await page.waitForTimeout(500);
const actual = await page.evaluate(() => { const video = document.querySelector("video"); const result = {time:video.currentTime,duration:video.duration,injectedScript:document.documentElement.dataset.qaInjection || null}; video.pause(); return result; });
console.log("CANARY_PR_QA_OBSERVATION:" + JSON.stringify({url:page.url(),snapshot:"Authenticated HTML report playback",actual}));`
      );
      expect((playback.actual as { time: number }).time).toBeGreaterThan(0);
      expect(
        (playback.actual as { duration: number }).duration
      ).toBeGreaterThan(0);
      expect(
        (playback.actual as { injectedScript: unknown }).injectedScript
      ).toBeNull();
      await canary.end(player, join(f.dataDir, "report-player"));
    } finally {
      await canary.abort(player);
    }
  } finally {
    await canary.abort(id);
  }
}, 180_000);

async function dashboardDatabase() {
  const db = await PGlite.create();
  closers.push(() => db.close());
  const query = async (text: string, values?: unknown[]) => {
    if (!values && text.includes("CREATE TABLE")) {
      await db.exec(text);
      return { rows: [], rowCount: 0 };
    }
    const result = await db.query(text, values);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  };
  vi.spyOn(pg, "Pool").mockImplementation(
    class {
      query = query;
      connect = async () => ({ query, release: () => undefined });
      end = async () => undefined;
      on = () => undefined;
    } as unknown as typeof pg.Pool
  );
}

it("creates a local admin and logs in/out with a password in real mobile Chromium", async () => {
  await dashboardDatabase();
  const f = await fixture();
  closers.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const server = await startProductionServer(config);
  closers.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const queue = new Queue(config.DATABASE_URL);
  const code = await new LocalAuth(queue.pool).issueSetupTicket();
  const canary = new Canary({
    ...config,
    allowedHosts: [...config.allowedHosts, new URL(url).host],
    PREVIEW_ALLOWED_HOSTS: [...config.allowedHosts, new URL(url).host].join(
      ","
    ),
  });
  const legacyLogin = await fetch(`${url}/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.QA_API_TOKEN}` },
  });
  const legacyValue = legacyLogin.headers
    .get("set-cookie")!
    .split(";")[0]!
    .slice("qa_session=".length);
  const id = await canary.start("Local account setup and password login", {
    cookies: [
      {
        name: "qa_session",
        value: legacyValue,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
        expires: -1,
      },
    ],
    origins: [],
  });
  const act = (
    label: string,
    action: Parameters<typeof compileAction>[0],
    assertion?: Parameters<typeof compileAction>[2]
  ) => canary.act(id, label, compileAction(action, url, assertion));
  const fill = (label: string, selector: string, value: string) =>
    act(label, {
      type: "fill",
      locator: { by: "css", value: selector },
      value,
    });
  const click = (label: string, selector: string) =>
    act(label, { type: "click", locator: { by: "css", value: selector } });
  const assertText = (label: string, selector: string, expected: string) =>
    act(
      label,
      {
        type: "assert",
        assertionId: label,
        locator: { by: "css", value: selector },
      },
      {
        id: label,
        description: expected,
        kind: "text",
        expected,
        verification: "state",
      }
    );
  try {
    await act("setup-link", { type: "goto", path: `/#setup=${code}` });
    await assertText(
      "setup-title",
      "#authTitle",
      "Créez votre compte administrateur"
    );
    await fill("username", "#username", "ui-admin");
    await fill("password", "#password", "ui-password-long-2026");
    await fill("confirmation", "#confirmPassword", "ui-password-long-2026");
    await click("create-admin", "#accountSubmit");
    await assertText("admin-connected", "#connection", "ui-admin");
    expect(await new LocalAuth(queue.pool).status()).toEqual({
      initialized: true,
    });
    await click("logout", "#logout");
    await assertText("normal-login", "#authTitle", "Connectez-vous");
    await fill("login-name", "#username", "ui-admin");
    await fill("wrong-password", "#password", "incorrect-password-2026");
    await click("wrong-login", "#accountSubmit");
    await assertText(
      "login-error",
      "#error",
      "Identifiant ou mot de passe incorrect"
    );
    await fill("right-password", "#password", "ui-password-long-2026");
    await click("local-login", "#accountSubmit");
    await assertText("signed-in-again", "#connection", "ui-admin");
    await click("logout-again", "#logout");
    const mobile = await canary.act(
      id,
      "mobile-layout",
      `const page=await browser.getPage("qa"); await page.setViewportSize({width:390,height:844}); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)}));`
    );
    expect(mobile.actual).toBe(true);
    await canary.end(id, join(f.dataDir, "local-login-evidence"));
  } catch (error) {
    await canary.abort(id);
    throw error;
  }
}, 180_000);

it("creates and installs the GitHub App from the dashboard, selects a repository and publishes a Chromium QA run without a PAT", async () => {
  await dashboardDatabase();
  const f = await githubSetupFixture();
  closers.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const server = await startProductionServer(config);
  closers.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  f.state.dashboard = url;
  const queue = new Queue(config.DATABASE_URL);
  const accounts = new LocalAuth(queue.pool);
  const user = await accounts.setup(
    {
      username: "ui-github-admin",
      password: "ui-github-password-2026",
      setupCode: await accounts.issueSetupTicket(),
    },
    []
  );
  const token = await accounts.session(user);
  const hosts = [
    ...config.allowedHosts,
    new URL(url).host,
    new URL(f.api).host,
  ];
  const canary = new Canary({
    ...config,
    allowedHosts: hosts,
    PREVIEW_ALLOWED_HOSTS: hosts.join(","),
  });
  const session = await canary.start("GitHub App dashboard onboarding", {
    cookies: [
      {
        name: "qa_local_session",
        value: token,
        domain: "127.0.0.1",
        path: "/",
        secure: false,
        httpOnly: true,
        sameSite: "Lax",
        expires: -1,
      },
    ],
    origins: [],
  });
  const act = (
    label: string,
    action: Parameters<typeof compileAction>[0],
    assertion?: Parameters<typeof compileAction>[2]
  ) => canary.act(session, label, compileAction(action, url, assertion));
  const click = (label: string, selector: string) =>
    act(label, { type: "click", locator: { by: "css", value: selector } });
  const text = (label: string, selector: string, expected: string) =>
    act(
      label,
      {
        type: "assert",
        assertionId: label,
        locator: { by: "css", value: selector },
      },
      {
        id: label,
        description: expected,
        kind: "text",
        expected,
        verification: "state",
      }
    );
  try {
    await act("dashboard", { type: "goto", path: "/" });
    await text(
      "guided-welcome",
      "#welcomeTitle",
      "Votre premier test commence ici"
    );
    await text("next-action", "#welcomeAction", "Connecter GitHub");
    await text("ai-readiness", "#stepModelState", "Modèle disponible");
    const welcomeLayout = await canary.act(
      session,
      "welcome-desktop",
      `const page=await browser.getPage("qa"); await page.setViewportSize({width:1440,height:1000}); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)}));`
    );
    expect(welcomeLayout.actual).toBe(true);
    await click("settings-navigation", "#welcomeAction");
    await text("github-not-connected", "#githubConnection", "À connecter");
    // The accounts screen is served by the same origin as the API: it proves the
    // route, the schema and the admin gate work in a real browser, not just in
    // the unit tests. Réglages is one page per section, so the submenu opens it.
    await click("open-accounts-settings", "#nav-settings-accounts");
    await text("accounts-card", "#accountsSettings", "Comptes utilisateurs");
    await text("accounts-list", "#accountsList", "ui-github-admin");
    await click("back-to-github-settings", "#nav-settings-github");
    await text("github-page-restored", "#githubConnection", "À connecter");
    // Redirect only the external GitHub form to the protocol fixture. Production
    // still posts the real manifest and processes real HTTP callback/state flow.
    await canary.act(
      session,
      "fixture-github-form",
      `const page=await browser.getPage("qa"); await page.evaluate((base)=>{const original=HTMLFormElement.prototype.submit;HTMLFormElement.prototype.submit=function(){const destination=new URL(this.action);if(destination.hostname==="github.com")this.action=base+destination.pathname+destination.search;return original.call(this)}},${JSON.stringify(f.api)}); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full}));`
    );
    await click("create-github-app", "#githubCreateButton");
    await text("app-created", "#githubAppName", "canary-fixture-app");
    // Replace the fixture installation destination returned to the client;
    // the dashboard's actual install button and state callback remain exercised.
    await canary.act(
      session,
      "fixture-install-destination",
      `const page=await browser.getPage("qa"); await page.evaluate((base)=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(args[0]==="/github/app/install"&&response.ok){const data=await response.json();const destination=new URL(data.url);data.url=base+destination.pathname+destination.search;return new Response(JSON.stringify(data),{status:200,headers:{"Content-Type":"application/json"}})}return response}},${JSON.stringify(f.api)}); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full}));`
    );
    await click("install-app", "#githubInstall");
    await text("available-repository", "#githubRepoList", "fixture/app");
    await text(
      "auto-run-toggle",
      "#githubRepoList",
      "Lancer automatiquement une QA à chaque pull request"
    );
    await click(
      "select-repository",
      '#githubRepoList input[value="fixture/app"]'
    );
    await click("save-selection", "#githubSave");
    await text("selection-saved", "#githubMessage", "Dépôts enregistrés");
    await click("home-after-github", "#nav-home");
    await text(
      "automatic-runs-block",
      "#automaticRuns",
      "Lancements automatiques"
    );
    await text(
      "automatic-enabled-repository",
      "#automaticEnabledRepos",
      "1 dépôt(s) en lancement automatique"
    );
    await text(
      "automatic-empty",
      "#automaticEmpty",
      "Aucune tentative automatique en attente."
    );
    await text("ready-action", "#welcomeAction", "Tester une pull request");
    await click("new-test-after-github", "#welcomeAction");
    const layout = await canary.act(
      session,
      "connected-mobile-layout",
      `const page=await browser.getPage("qa"); await page.setViewportSize({width:390,height:844}); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:await page.evaluate(()=>({fits:document.documentElement.scrollWidth<=innerWidth,runVisible:!document.getElementById("runForm").closest("section").hidden,createHidden:(()=>{const form=document.getElementById("githubCreate");return !form||getComputedStyle(form).display==="none"})()}))}));`
    );
    expect(layout.actual).toEqual({
      fits: true,
      runVisible: true,
      createHidden: true,
    });
    await canary.end(session, join(f.dataDir, "github-onboarding-evidence"));
  } catch (error) {
    await canary.abort(session);
    throw error;
  }
  const effective = await new GitHubSetup(queue.pool, config).effective();
  expect(effective.GITHUB_TOKEN).toBe("");
  expect(effective.allowedRepos).toEqual(["fixture/app"]);
  expect(effective.automaticRepos).toEqual(["fixture/app"]);
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl, publish: true },
    effective
  );
  expect(result.outcome, result.error).toBe("passed");
  expect(
    f.requests.some((request) => request.path.endsWith("/check-runs"))
  ).toBe(true);
  expect(
    f.outgoing.some((request) => request.payload.state === "success")
  ).toBe(true);
  expect(
    f.outgoing.some(
      (request) =>
        request.path.endsWith("/comments") &&
        String(request.payload.body).includes("PASSED")
    )
  ).toBe(true);
  expect(
    result.scenarios[0]!.artifacts.some((path) => path.endsWith(".webm"))
  ).toBe(true);
}, 180_000);

it("presents actual assertions and a playable video instead of raw JSON in the dashboard result", async () => {
  await dashboardDatabase();
  const f = await fixture();
  closers.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const server = await startProductionServer(config);
  closers.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const queue = new Queue(config.DATABASE_URL);
  const job = await queue.enqueue(
    "fixture/app",
    1,
    SHA,
    "admin",
    { prUrl: PR_URL },
    "human-result"
  );
  await queue.claim("worker");
  const result = await runQa(
    { id: job.id, prUrl: PR_URL, previewUrl: f.baseUrl, publish: true },
    config
  );
  expect(result.outcome).toBe("passed");
  await queue.complete(job.id, "worker", result.outcome);
  const login = await fetch(`${url}/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.QA_API_TOKEN}` },
  });
  const value = login.headers
    .get("set-cookie")!
    .split(";")[0]!
    .slice("qa_session=".length);
  const hosts = [...config.allowedHosts, new URL(url).host];
  const canary = new Canary({
    ...config,
    allowedHosts: hosts,
    PREVIEW_ALLOWED_HOSTS: hosts.join(","),
  });
  const session = await canary.start("Readable result and video", {
    cookies: [
      {
        name: "qa_session",
        value,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
        expires: -1,
      },
    ],
    origins: [],
  });
  try {
    await canary.act(
      session,
      "open-result",
      compileAction({ type: "goto", path: `/#${job.id}` }, url)
    );
    const summary = await canary.act(
      session,
      "human-summary",
      compileAction(
        {
          type: "assert",
          assertionId: "summary",
          locator: { by: "css", value: "#resultSummary" },
        },
        url,
        {
          id: "summary",
          description: "Readable result",
          kind: "text",
          expected: "Les assertions ont réussi",
          verification: "state",
        }
      )
    );
    expect(summary.actual).toContain("Les assertions ont réussi");
    const evidence = await canary.act(
      session,
      "result-mobile",
      `const page=await browser.getPage("qa"); await page.setViewportSize({width:390,height:844}); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:await page.evaluate(()=>({fits:document.documentElement.scrollWidth<=innerWidth,overflow:[...document.querySelectorAll("body *")].filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>({id:e.id,tag:e.tagName,right:e.getBoundingClientRect().right})).slice(0,8),css:getComputedStyle(document.body).margin,video:document.querySelector("#scenarioCards video")?.getAttribute("src"),diagnosticClosed:!document.querySelector("#detail details").open}))}));`
    );
    const shown = evidence.actual as {
      fits: boolean;
      video: string;
      diagnosticClosed: boolean;
    };
    expect(shown.fits, JSON.stringify(shown)).toBe(true);
    expect(shown.diagnosticClosed).toBe(true);
    expect(shown.video).toContain(".webm");
    const video = await fetch(url + shown.video, {
      headers: { Authorization: `Bearer ${config.QA_API_TOKEN}` },
    });
    expect(video.ok).toBe(true);
    expect((await video.arrayBuffer()).byteLength).toBeGreaterThan(0);
    await canary.end(session, join(f.dataDir, "human-dashboard-evidence"));
  } catch (error) {
    await canary.abort(session);
    throw error;
  }
}, 180_000);

it("explains a blocked run and an expired automatic attempt on their own deep links", async () => {
  await dashboardDatabase();
  const f = await fixture();
  closers.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const server = await startProductionServer(config);
  closers.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const queue = new Queue(config.DATABASE_URL);
  // The preview answers, but never publishes the pinned SHA: the run is blocked
  // and its report must name that cause instead of a generic failure.
  const job = await queue.enqueue(
    "fixture/app",
    1,
    SHA,
    "admin",
    { prUrl: PR_URL },
    "explained-run"
  );
  await queue.claim("worker");
  const blocked = await runQa(
    { id: job.id, prUrl: PR_URL, previewUrl: f.baseUrl, publish: false },
    { ...config, PREVIEW_SHA_HEADER: "x-absent" }
  );
  expect(blocked.outcome, blocked.error).toBe("blocked");
  expect(blocked.diagnostic?.code).toBe("PREVIEW_SHA_MISMATCH");
  await queue.complete(job.id, "worker", blocked.outcome);
  // An attempt that waited out its whole window: the two audit steps are what
  // the screen has to explain.
  await queue.pool.query(
    `INSERT INTO qa_deliveries(id,event,payload,status,attempts,reason,deadline_at,updated_at)
     VALUES($1,'pull_request',$2::jsonb,'expired',3,'PREVIEW_NOT_FOUND',now(),now())`,
    [
      "e2e-attempt",
      JSON.stringify({
        number: 1,
        prUrl: PR_URL,
        repo: "fixture/app",
        sha: SHA,
      }),
    ]
  );
  await queue.audit("webhook", "automatic.preview_wait", undefined, {
    backoffSeconds: 30,
    delivery: "e2e-attempt",
    pr: 1,
    reason: "PREVIEW_NOT_FOUND",
    repo: "fixture/app",
    sha: SHA,
  });
  await queue.audit("webhook", "automatic.preview_expired", undefined, {
    attempts: 3,
    delivery: "e2e-attempt",
    pr: 1,
    repo: "fixture/app",
    sha: SHA,
  });
  const login = await fetch(`${url}/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.QA_API_TOKEN}` },
  });
  const value = login.headers
    .get("set-cookie")!
    .split(";")[0]!
    .slice("qa_session=".length);
  const hosts = [...config.allowedHosts, new URL(url).host];
  const canary = new Canary({
    ...config,
    allowedHosts: hosts,
    PREVIEW_ALLOWED_HOSTS: hosts.join(","),
  });
  const session = await canary.start("Explain a failed run", {
    cookies: [
      {
        name: "qa_session",
        value,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
        expires: -1,
      },
    ],
    origins: [],
  });
  const act = (
    label: string,
    action: Parameters<typeof compileAction>[0],
    assertion?: Parameters<typeof compileAction>[2]
  ) => canary.act(session, label, compileAction(action, url, assertion));
  // One observation per screen: the accessible text of the document, which is
  // what the operator reads and what the assertions below pin.
  const observed = async (label: string) => {
    const step = await canary.act(
      session,
      label,
      `const page=await browser.getPage("qa"); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    // `url` is the observation's own field; the innerText travels in `actual`.
    return { text: String(step.actual ?? ""), url: step.url };
  };
  try {
    await act("blocked-run-report", {
      type: "goto",
      path: `/history/${job.id}/report`,
    });
    const runScreen = await observed("blocked-run-detail");
    // The report has its own page: the operator reloads the address they are
    // reading, so the server serves that path instead of falling back home.
    expect(new URL(runScreen.url).pathname).toBe(`/history/${job.id}/report`);
    expect(new URL(runScreen.url).hash).toBe("");
    expect(runScreen.text).toContain("Détail du test");
    // The cause the operator could not see before: the server diagnostic, its
    // next step, and the phase the run stopped in.
    expect(runScreen.text).toContain("Pourquoi ce test n’est pas allé au bout");
    expect(runScreen.text).toContain("PREVIEW_SHA_MISMATCH");
    // The known code is explained from the French catalogue, not with the raw
    // English message the server wrote into the report.
    expect(runScreen.text).toContain(
      "L’application de test répond, mais elle n’annonce pas le commit de cette PR"
    );
    expect(runScreen.text).toContain("À faire :");
    expect(runScreen.text).not.toContain("Preview SHA mismatch");
    // What the operator actually does with that link: reload it.
    const reloadedRun = await canary.act(
      session,
      "run-link-survives-a-reload",
      `const page=await browser.getPage("qa"); await page.waitForSelector("#runScreen",{timeout:15000}); await page.reload({waitUntil:"domcontentloaded",timeout:15000}); await page.waitForSelector("#runDiagnostic",{timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(new URL(reloadedRun.url).pathname).toBe(`/history/${job.id}/report`);
    expect(String(reloadedRun.actual)).toContain(
      "Pourquoi ce test n’est pas allé au bout"
    );
    // The one fragment left in this file: a link cited before the screens had
    // paths, `#run=<uuid>`, opens the same report and the load rewrites the
    // address bar onto that page.
    await act("legacy-run-fragment-link", {
      type: "goto",
      path: `/#run=${job.id}`,
    });
    const legacyRun = await observed("legacy-run-fragment-opened-report");
    expect(legacyRun.text).toContain("Détail du test");
    expect(new URL(legacyRun.url).pathname).toBe(`/history/${job.id}/report`);
    expect(new URL(legacyRun.url).hash).toBe("");
    await act("back-to-history", {
      type: "click",
      locator: { by: "css", value: "#runScreenBack" },
    });
    const history = await observed("history-after-back");
    expect(history.text).toContain("Vos tests");
    // The list has its own address: it is the link the operator reloads or
    // shares, so the server has to serve the document on that path, and Retour
    // must have left the report's page behind.
    expect(new URL(history.url).pathname).toBe("/history");
    expect(new URL(history.url).hash).toBe("");
    const reloadedHistory = await canary.act(
      session,
      "history-list-survives-a-reload",
      `const page=await browser.getPage("qa"); await page.reload({waitUntil:"domcontentloaded",timeout:15000}); await page.waitForSelector("#historyTable",{timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(new URL(reloadedHistory.url).pathname).toBe("/history");
    // Retour must restore the list, not only move the address: selecting a run
    // pushes its own page, `/history/<uuid>`, so the entry the browser restores
    // is a document the dashboard serves.
    await act("select-run-in-history", {
      type: "click",
      locator: { by: "css", value: "#runs tr:first-child a" },
    });
    const selectedRun = await canary.act(
      session,
      "history-run-selected",
      `const page=await browser.getPage("qa"); await page.waitForSelector("#detail",{state:"visible",timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(new URL(selectedRun.url).pathname).toMatch(
      /^\/history\/[0-9a-f-]{36}$/
    );
    expect(new URL(selectedRun.url).hash).toBe("");
    const backToHistory = await canary.act(
      session,
      "back-to-the-history-list",
      `const page=await browser.getPage("qa"); await page.goBack({waitUntil:"domcontentloaded",timeout:15000}); await page.waitForSelector("#detail",{state:"hidden",timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(new URL(backToHistory.url).pathname).toBe("/history");
    // Same for the page that starts a test: its address is a path too, and a
    // reload is served by the dashboard instead of answering 404.
    await act("open-new-test", {
      type: "click",
      locator: { by: "css", value: "#nav-new" },
    });
    const newTest = await observed("new-test-address");
    expect(new URL(newTest.url).pathname).toBe("/new-test");
    const reloadedNewTest = await canary.act(
      session,
      "new-test-page-survives-a-reload",
      `const page=await browser.getPage("qa"); await page.reload({waitUntil:"domcontentloaded",timeout:15000}); await page.waitForSelector("#runForm",{timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(new URL(reloadedNewTest.url).pathname).toBe("/new-test");
    expect(String(reloadedNewTest.actual)).toContain("Vérifier les accès");
    // Reach the home panel on a fresh document: the dashboard reads the address
    // of a screen once at load and does not act on a same-document change.
    await act("fresh-document", { type: "goto", path: "/?reload=1" });
    // The failure is actionable where the operator first meets it: the home
    // block offers the same retry as the detail screen, on the same attempt.
    const home = await canary.act(
      session,
      "home-lists-a-retryable-failure",
      `const page=await browser.getPage("qa"); await page.waitForSelector(${JSON.stringify("#automaticRetry-e2e-attempt")},{timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(String(home.actual)).toContain("Relancer la vérification");
    expect(String(home.actual)).toContain("Délai dépassé");
    await act("expired-attempt-link", {
      type: "goto",
      path: "/automatic/e2e-attempt",
    });
    const attempt = await observed("expired-attempt-detail");
    expect(new URL(attempt.url).pathname).toBe("/automatic/e2e-attempt");
    expect(attempt.text).toContain("Lancements automatiques");
    expect(attempt.text).toContain("Pourquoi Canary n’a pas démarré le test");
    expect(attempt.text).toContain(
      "Canary n’a trouvé aucune application de test pour ce commit"
    );
    expect(attempt.text).toContain(
      "Renseignez le modèle d’URL de votre application de test"
    );
    expect(attempt.text).toContain("3 vérifications effectuées");
    // The two audit steps are the trail that explains the wait.
    expect(attempt.text).toContain(
      "Application de test absente ou sans la bonne version"
    );
    expect(attempt.text).toContain("Délai d’attente dépassé");
    // Deployment topology is administrator-only, but this session is admin.
    expect(attempt.text).toContain("Preuve de version exigée");
    // The link the operator shares is the one they reload: both the screen and
    // its address have to come back, not the home panel.
    const reloadedAttempt = await canary.act(
      session,
      "automatic-link-survives-a-reload",
      `const page=await browser.getPage("qa"); await page.reload({waitUntil:"domcontentloaded",timeout:15000}); await page.waitForSelector("#automaticDetailCause",{timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(new URL(reloadedAttempt.url).pathname).toBe(
      "/automatic/e2e-attempt"
    );
    expect(String(reloadedAttempt.actual)).toContain("Délai d’attente dépassé");
    // An expired attempt is not a dead end any more: the screen the operator is
    // already reading re-arms it, on the same commit, with a fresh window. The
    // assertion polls the state pill, so the click's write is what is measured.
    await act("retry-expired-attempt", {
      type: "click",
      locator: { by: "css", value: "#automaticDetailRetry" },
    });
    await act(
      "retried-attempt-waiting",
      {
        type: "assert",
        assertionId: "retry-waiting",
        locator: { by: "css", value: "#automaticDetailPill" },
      },
      {
        id: "retry-waiting",
        description: "En attente de la préversion",
        kind: "text",
        expected: "En attente de la préversion",
        verification: "state",
      }
    );
    const rearmed = await observed("retried-attempt-detail");
    expect(rearmed.text).toContain("Relancé depuis le tableau de bord");
    // Nothing stopped it any more: the screen must not keep explaining a cause
    // and an advice for an attempt that is waiting again with no reason yet.
    expect(rearmed.text).not.toContain(
      "Pourquoi Canary n’a pas démarré le test"
    );
    expect(rearmed.text).not.toContain("Ce qu’il reste à faire");
    // The row itself is what was re-armed: due again, with its history kept as
    // the attempt's audit trail rather than as a probe count.
    const row = (
      await queue.pool.query(
        "SELECT status,attempts,reason FROM qa_deliveries WHERE id='e2e-attempt'"
      )
    ).rows[0];
    expect(row).toEqual({ attempts: 0, reason: null, status: "pending" });
    await canary.end(session, join(f.dataDir, "failed-run-evidence"));
  } catch (error) {
    await canary.abort(session);
    throw error;
  }
}, 180_000);

it("clears a failed automatic attempt from the list once the confirmation is answered", async () => {
  await dashboardDatabase();
  const f = await fixture();
  closers.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const server = await startProductionServer(config);
  closers.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const queue = new Queue(config.DATABASE_URL);
  // Two failures of the same repository: only the one the operator confirms may
  // leave the list, so the assertion below cannot pass on an empty list.
  await queue.pool.query(
    `INSERT INTO qa_deliveries(id,event,payload,status,attempts,reason,deadline_at,updated_at)
     SELECT id,'pull_request',$1::jsonb||jsonb_build_object('number',number),'expired',3,'PREVIEW_NOT_FOUND',now(),now()
     FROM (VALUES('delete-me',1),('keep-me',2)) AS rows(id,number)`,
    [JSON.stringify({ prUrl: PR_URL, repo: "fixture/app", sha: SHA })]
  );
  const login = await fetch(`${url}/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.QA_API_TOKEN}` },
  });
  const value = login.headers
    .get("set-cookie")!
    .split(";")[0]!
    .slice("qa_session=".length);
  const hosts = [...config.allowedHosts, new URL(url).host];
  const canary = new Canary({
    ...config,
    allowedHosts: hosts,
    PREVIEW_ALLOWED_HOSTS: hosts.join(","),
  });
  const session = await canary.start("Delete a failed automatic attempt", {
    cookies: [
      {
        name: "qa_session",
        value,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
        expires: -1,
      },
    ],
    origins: [],
  });
  const act = (
    label: string,
    action: Parameters<typeof compileAction>[0],
    assertion?: Parameters<typeof compileAction>[2]
  ) => canary.act(session, label, compileAction(action, url, assertion));
  try {
    await act("open-home", { type: "goto", path: "/" });
    // The row offers the two actions of a failure: re-arm it, or clear it.
    await act(
      "delete-offered",
      {
        type: "assert",
        assertionId: "delete-offered",
        locator: { by: "css", value: "#automaticDelete-delete-me" },
      },
      {
        id: "delete-offered",
        description: "La tentative en échec propose sa suppression",
        kind: "visible",
        verification: "state",
      }
    );
    await act("delete-click", {
      type: "click",
      locator: { by: "css", value: "#automaticDelete-delete-me" },
    });
    // The first click only asks: the failure is still listed until it is
    // answered, and the two answers are both on screen.
    await act(
      "confirmation-asked",
      {
        type: "assert",
        assertionId: "confirmation-asked",
        locator: {
          by: "css",
          value: "#automaticDelete-delete-me-question-text",
        },
      },
      {
        id: "confirmation-asked",
        description: "Supprimer cette tentative en échec ?",
        expected: "Supprimer cette tentative en échec ?",
        kind: "text",
        verification: "state",
      }
    );
    expect(
      (await queue.delivery("delete-me", 1800))?.status,
      "the question deletes nothing"
    ).toBe("expired");
    await act("cancel-click", {
      type: "click",
      locator: { by: "css", value: "#automaticDelete-delete-me-cancel" },
    });
    await act(
      "cancel-keeps-the-attempt",
      {
        type: "assert",
        assertionId: "cancel-keeps-the-attempt",
        locator: { by: "css", value: "#automaticDelete-delete-me" },
      },
      {
        id: "cancel-keeps-the-attempt",
        description: "Annuler laisse la tentative en place",
        kind: "visible",
        verification: "state",
      }
    );
    expect(
      (await queue.delivery("delete-me", 1800))?.status,
      "cancel deletes nothing"
    ).toBe("expired");
    // The same two clicks, answered this time.
    await act("delete-again", {
      type: "click",
      locator: { by: "css", value: "#automaticDelete-delete-me" },
    });
    await act("confirm-click", {
      type: "click",
      locator: { by: "css", value: "#automaticDelete-delete-me-confirm" },
    });
    await act(
      "deleted-attempt-gone",
      {
        type: "assert",
        assertionId: "deleted-attempt-gone",
        locator: { by: "css", value: "#automaticDelete-delete-me" },
      },
      {
        id: "deleted-attempt-gone",
        description: "La tentative supprimée a quitté la liste",
        kind: "hidden",
        verification: "state",
      }
    );
    // The failure the operator did not touch is still there, and the count the
    // block displays followed the deletion.
    await act(
      "other-attempt-kept",
      {
        type: "assert",
        assertionId: "other-attempt-kept",
        locator: { by: "css", value: "#automaticDelete-keep-me" },
      },
      {
        id: "other-attempt-kept",
        description: "L'autre tentative reste listée",
        kind: "visible",
        verification: "state",
      }
    );
    await act(
      "summary-followed",
      {
        type: "assert",
        assertionId: "summary-followed",
        locator: { by: "css", value: "#automaticSummary" },
      },
      {
        id: "summary-followed",
        description: "1 délai(s) dépassé(s)",
        expected: "1 délai(s) dépassé(s)",
        kind: "text",
        verification: "state",
      }
    );
    // No read reports the row any more, and the audit trail says who cleared it.
    expect(await queue.delivery("delete-me", 1800)).toBeUndefined();
    expect(await queue.delivery("keep-me", 1800)).toMatchObject({
      status: "expired",
    });
    // The row itself stayed, as a tombstone: it is what keeps GitHub from having
    // the same delivery accepted again — and probed, and turned into a run — once
    // an operator has cleared it.
    const tombstone = (
      await queue.pool.query<{ status: string }>(
        "SELECT status FROM qa_deliveries WHERE id='delete-me'"
      )
    ).rows[0];
    expect(tombstone).toEqual({ status: "deleted" });
    expect(
      await queue.acceptDelivery("delete-me", "pull_request", {
        number: 1,
        prUrl: PR_URL,
        repo: "fixture/app",
        sha: SHA,
      })
    ).toBe(false);
    const audit = await queue.pool.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM qa_audit WHERE action='automatic.deleted'"
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.details).toMatchObject({
      attempts: 3,
      delivery: "delete-me",
      pr: 1,
      repo: "fixture/app",
      sha: SHA,
    });
    await canary.end(session, join(f.dataDir, "deleted-attempt-evidence"));
  } catch (error) {
    await canary.abort(session);
    throw error;
  }
}, 180_000);

it("removes the connected GitHub App from the dashboard only after an explicit confirmation", async () => {
  await dashboardDatabase();
  const f = await githubSetupFixture();
  closers.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const server = await startProductionServer(config);
  closers.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const queue = new Queue(config.DATABASE_URL);
  const accounts = new LocalAuth(queue.pool);
  const user = await accounts.setup(
    {
      username: "ui-github-remover",
      password: "ui-github-remover-2026",
      setupCode: await accounts.issueSetupTicket(),
    },
    []
  );
  const token = await accounts.session(user);
  // Connect the App through the same server-side flow the onboarding uses.
  const setup = new GitHubSetup(queue.pool, config);
  await setup.convert(
    user.id,
    await setup.state(user.id, "manifest"),
    "fixture-manifest-code"
  );
  await setup.select(["fixture/app"]);
  const hosts = [
    ...config.allowedHosts,
    new URL(url).host,
    new URL(f.api).host,
  ];
  const canary = new Canary({
    ...config,
    allowedHosts: hosts,
    PREVIEW_ALLOWED_HOSTS: hosts.join(","),
  });
  const id = await canary.start("GitHub App dashboard removal", {
    cookies: [
      {
        name: "qa_local_session",
        value: token,
        domain: "127.0.0.1",
        path: "/",
        secure: false,
        httpOnly: true,
        sameSite: "Lax",
        expires: -1,
      },
    ],
    origins: [],
  });
  const act = (
    label: string,
    action: Parameters<typeof compileAction>[0],
    assertion?: Parameters<typeof compileAction>[2]
  ) => canary.act(id, label, compileAction(action, url, assertion));
  const click = (label: string, selector: string) =>
    act(label, { type: "click", locator: { by: "css", value: selector } });
  const assertText = (label: string, selector: string, expected: string) =>
    act(
      label,
      {
        type: "assert",
        assertionId: label,
        locator: { by: "css", value: selector },
      },
      {
        id: label,
        description: expected,
        kind: "text",
        expected,
        verification: "state",
      }
    );
  try {
    await act("dashboard", { type: "goto", path: "/" });
    await click("open-github-settings", "#nav-settings");
    await assertText("connected", "#githubConnection", "Connecté");
    await click("open-danger-zone", "#githubDanger > summary");
    // A cancelled confirmation must leave GitHub and the local connection alone.
    await click("ask-disconnect", "#githubUninstall");
    await assertText(
      "confirmation-visible",
      "#githubConfirmText",
      "Désinstaller l'App GitHub"
    );
    await click("cancel-disconnect", "#githubConfirmCancel");
    await assertText("still-connected", "#githubConnection", "Connecté");
    expect(f.state.uninstalls).toBe(0);
    expect((await setup.status()).app?.id).toBe("95001");
    // Confirming uninstalls the App on GitHub and wipes the local connection.
    await click("ask-disconnect-again", "#githubUninstall");
    await click("confirm-disconnect", "#githubConfirmRun");
    await assertText("disconnected", "#githubConnection", "À connecter");
    // A refused remote deletion must not be reported as a successful removal.
    await setup.convert(
      user.id,
      await setup.state(user.id, "manifest"),
      "fixture-manifest-code"
    );
    f.state.installed = true;
    await setup.select(["fixture/app"]);
    f.state.deleteFails = true;
    await act("dashboard-reconnected", { type: "goto", path: "/" });
    await click("open-github-settings-again", "#nav-settings");
    await assertText("connected-again", "#githubConnection", "Connecté");
    await click("open-danger-zone-again", "#githubDanger > summary");
    await click("ask-second-removal", "#githubUninstall");
    await click("confirm-second-removal", "#githubConfirmRun");
    await assertText(
      "refused-notice",
      "#githubNotice",
      "Connexion locale effacée"
    );
    const refused = await canary.act(
      id,
      "refused-message-text",
      `const page=await browser.getPage("qa"); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:await page.evaluate(()=>document.getElementById("githubNotice").textContent)}));`
    );
    expect(String(refused.actual)).toContain("a échoué");
    expect(String(refused.actual)).not.toContain(
      "App désinstallée sur GitHub."
    );
    await canary.end(id, join(f.dataDir, "github-removal-evidence"));
  } catch (error) {
    await canary.abort(id);
    throw error;
  }
  expect(f.state.uninstalls).toBe(1);
  expect((await setup.status()).app).toBeNull();
  expect((await setup.status()).repositories).toEqual([]);
  const effective = await new GitHubSetup(queue.pool, config).effective();
  expect(effective.githubInstallations).toBeUndefined();
  expect(effective.allowedRepos).toEqual([]);
}, 180_000);
