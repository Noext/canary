import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary } from "../../src/canary.js";
import { GitHub } from "../../src/github.js";
import { runScope } from "../../src/run-scope.js";
import { runQa } from "../../src/runner.js";
import { BASE_SHA, fixture, PR_URL, plan, SHA } from "../fixture.js";

/**
 * La préversion de base comme oracle, de bout en bout : Chromium réel, deux
 * serveurs locaux (tête et base, deux origines), le stub `/v1/chat/completions`
 * du fixture. Le diff du fixture remplace `show('Hello')` par
 * `show('Welcome '+name)` : une base « Hello » est la base fidèle de ce diff.
 */
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function baselineRun(
  options: Parameters<typeof fixture>[0] & {
    baseApp: { greeting: string; sha?: string; button?: string };
    /** SHA annoncé par la base dès que son dernier scénario est finalisé. */
    redeployBaseTo?: string;
  }
) {
  const f = await fixture(options);
  closers.push(f.close);
  const redeploy = options.redeployBaseTo;
  if (redeploy) {
    const end = Canary.prototype.end;
    vi.spyOn(Canary.prototype, "end").mockImplementation(async function (
      this: Canary,
      id,
      destination
    ) {
      const artifacts = await end.call(this, id, destination);
      if (destination.includes("_baseline")) {
        f.setBaseSha?.(redeploy);
      }
      return artifacts;
    });
  }
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    { ...f.config, QA_BASELINE_URL_TEMPLATE: f.baseAppUrl ?? "" }
  );
  // Le dernier statut : le premier est « pending », posé avant le plan.
  const status = f.outgoing
    .filter((item) => item.path.includes("/statuses/"))
    .at(-1)?.payload as { description?: string; state?: string } | undefined;
  const comment = f.outgoing.find((item) => item.path.endsWith("/comments"))
    ?.payload.body as string | undefined;
  const reportMd = await readFile(
    join(f.dataDir, result.id, "report.md"),
    "utf8"
  );
  const reportHtml = await readFile(
    join(f.dataDir, result.id, "report.html"),
    "utf8"
  );
  const stored = JSON.parse(
    await readFile(join(f.dataDir, result.id, "result.json"), "utf8")
  );
  return { comment, f, reportHtml, reportMd, result, status, stored };
}

describe("la base rejouée comme oracle indépendant", () => {
  it("liste le comportement modifié en tête du rapport, du statut et de result.json", async () => {
    // Le SHA de prévisualisation actif au moment de chaque statut publié : la
    // base le remplace pendant son rejeu, et doit le rendre à la tête.
    const statusShas: (string | undefined)[] = [];
    const status0 = GitHub.prototype.status;
    vi.spyOn(GitHub.prototype, "status").mockImplementation(function (
      this: GitHub,
      ...args
    ) {
      statusShas.push(runScope.getStore()?.previewSha);
      return status0.apply(this, args);
    });
    const { comment, reportHtml, reportMd, result, status, stored } =
      await baselineRun({
        baseApp: { greeting: "Hello " },
      });
    expect(statusShas.at(-1)).toBe(SHA);
    expect(result.outcome, result.scenarios[0]?.error).toBe("passed");
    expect(result.baseline?.sha).toBe(BASE_SHA);
    expect(stored.baselineComparison.changes).toEqual([
      {
        scenarioId: "welcome",
        assertionId: "saved",
        objective: false,
        expected: "Welcome Ada",
        head: { passed: true, actual: "Welcome Ada" },
        base: { passed: false, actual: "Hello Ada" },
      },
    ]);
    expect(status?.state).toBe("success");
    expect(status?.description).toBe(
      "QA passed: 1/1 scenarios · 1 behavior change vs base 2222222, see report"
    );
    // Le rapport privé porte les deux valeurs, juste après le verdict.
    expect(reportMd).toContain(
      "- welcome · saved (attendu « Welcome Ada ») : main : « Hello Ada » (échoue) → PR : « Welcome Ada » (passe)"
    );
    expect(reportMd.indexOf("Comportements modifiés")).toBeLessThan(
      reportMd.indexOf("Model:")
    );
    // Le commentaire publié liste le changement sans valeur lue dans la page.
    expect(comment).toContain(
      "### Comportements modifiés par rapport à main (base 2222222)"
    );
    expect(comment).toContain("main : échoue → PR : passe");
    expect(comment).not.toContain("Hello Ada");
    // Le rapport HTML porte la même section, avant les scénarios.
    const section = reportHtml.indexOf(
      "Comportements modifiés par rapport à main (base 2222222)"
    );
    expect(section).toBeGreaterThan(-1);
    expect(reportHtml).toContain("« Hello Ada » (échoue)");
    expect(reportHtml).toContain("« Welcome Ada » (passe)");
    expect(section).toBeLessThan(reportHtml.indexOf("Submitting the name"));
  }, 180_000);

  it("rend rouge ce qui passe sur la base et casse sur la tête", async () => {
    const { comment, result, status, stored } = await baselineRun({
      broken: true,
      baseApp: { greeting: "Welcome " },
    });
    expect(result.outcome).toBe("failed");
    const scenario = result.scenarios[0]!;
    expect(scenario.diagnostic?.code).toBe("BASELINE_REGRESSION");
    expect(scenario.classification).toBe("failed");
    expect(stored.baselineComparison.regressions[0]).toMatchObject({
      assertionId: "saved",
      head: { passed: false, actual: "Wrong output" },
      base: { passed: true, actual: "Welcome Ada" },
    });
    expect(status?.state).toBe("failure");
    expect(status?.description).toContain("1 regression vs base 2222222");
    expect(comment).toContain("Régressions par rapport à main");
    expect(comment).not.toContain("Wrong output");
  }, 180_000);

  it("ne publie pas vert un objectif que la base satisfait à l'identique", async () => {
    const withObjective = structuredClone(plan);
    withObjective.scenarios[0]!.objective = "saved";
    const { result, status, stored } = await baselineRun({
      plans: [withObjective],
      baseApp: { greeting: "Welcome " },
    });
    expect(result.outcome).toBe("blocked");
    const scenario = result.scenarios[0]!;
    expect(scenario.diagnostic?.code).toBe("OBJECTIVE_NOT_DISCRIMINATING");
    expect(scenario.classification).toBe("test-defect");
    expect(stored.baselineComparison.notDiscriminating).toHaveLength(1);
    expect(stored.baselineComparison.changes).toEqual([]);
    expect(status?.state).toBe("failure");
  }, 180_000);

  it("rend la comparaison indisponible quand la base ne prouve pas son SHA", async () => {
    const { comment, result, status, stored } = await baselineRun({
      baseApp: { greeting: "Hello ", sha: "3".repeat(40) },
    });
    // Le verdict ne repose que sur la tête, et le dit.
    expect(result.outcome).toBe("passed");
    expect(result.baseline?.scenarios).toEqual([]);
    expect(stored.baselineComparison).toMatchObject({
      status: "unavailable",
      diagnostic: { code: "PREVIEW_SHA_MISMATCH" },
    });
    expect(status?.description).toBe(
      "QA passed: 1/1 scenarios · base 2222222 comparison unavailable"
    );
    expect(comment).toContain(
      "### Comparaison à main indisponible (base 2222222)"
    );
  }, 180_000);

  it("rend la comparaison indisponible quand la base change de SHA pendant le rejeu", async () => {
    // La provenance est revérifiée après le rejeu, comme la tête : une base
    // redéployée entre-temps n'est plus l'oracle que le rejeu a lu.
    const { result, status, stored } = await baselineRun({
      baseApp: { greeting: "Hello " },
      redeployBaseTo: "4".repeat(40),
    });
    expect(result.outcome).toBe("passed");
    expect(result.baseline?.scenarios).toHaveLength(1);
    expect(stored.baselineComparison).toMatchObject({
      status: "unavailable",
      diagnostic: { code: "PREVIEW_SHA_MISMATCH" },
      changes: [],
    });
    expect(status?.description).toContain("comparison unavailable");
  }, 180_000);

  it("compare à la base de fusion de la PR, pas à la pointe de main", async () => {
    // main a avancé depuis la bifurcation : la tête n'a jamais reçu ce qui y a
    // été fusionné depuis, donc l'oracle est le commit d'où elle est partie.
    const mergeBase = "5".repeat(40);
    const { result, status, stored } = await baselineRun({
      baseApp: { greeting: "Hello ", sha: mergeBase },
      mergeBaseSha: mergeBase,
    });
    expect(result.outcome).toBe("passed");
    expect(result.baseline?.sha).toBe(mergeBase);
    expect(stored.baselineComparison).toMatchObject({
      status: "compared",
      sha: mergeBase,
    });
    expect(stored.baselineComparison.changes).toHaveLength(1);
    expect(status?.description).toContain("1 behavior change vs base 5555555");
  }, 180_000);

  it("rend la comparaison indisponible quand la base déployée n'est pas la base de fusion", async () => {
    const { result, stored } = await baselineRun({
      baseApp: { greeting: "Welcome " },
      mergeBaseSha: "5".repeat(40),
    });
    expect(result.outcome).toBe("passed");
    expect(result.baseline?.scenarios).toEqual([]);
    expect(stored.baselineComparison).toMatchObject({
      status: "unavailable",
      sha: "5".repeat(40),
      diagnostic: { code: "PREVIEW_SHA_MISMATCH" },
    });
  }, 180_000);

  it("rejoue la base sans modèle : une cible absente n'y est jamais reprise", async () => {
    // Le bouton du plan n'existe pas sur la base. Avec le modèle, la reprise de
    // cible demanderait au modèle de cliquer autre chose sur un environnement
    // réel ; sans lui, la base s'arrête et la comparaison le dit.
    // Le diff déclare « Submit name » : la page de base l'expose, donc une reprise
    // de cible aurait un candidat à proposer au modèle.
    const { f, result, stored } = await baselineRun({
      baseApp: { greeting: "Hello ", button: "Submit name" },
      formPatch:
        "@@ -1 +1,2 @@\n-show('Hello')\n+show('Welcome '+name)\n+const label = \"Submit name\";",
    });
    expect(result.outcome).toBe("passed");
    const prompts = f.modelRequests.map(
      (request) =>
        (request.messages as { content: string }[] | undefined)?.[0]?.content ??
        ""
    );
    expect(prompts.filter((prompt) => !prompt.startsWith("You plan"))).toEqual(
      []
    );
    expect(
      result.baseline?.scenarios[0]?.steps.some((step) => step.repairedTarget)
    ).toBe(false);
    expect(stored.baselineComparison.changes).toEqual([]);
    expect(stored.baselineComparison.inconclusive).toMatchObject([
      {
        assertionId: "saved",
        reason: "not executed on the base (TARGET_NOT_FOUND)",
      },
    ]);
  }, 180_000);
});

describe("les fixtures sèment la tête, jamais la base", () => {
  it("ne rejoue pas sur la base un scénario à fixtures, et le dit", async () => {
    const seeded = structuredClone(plan);
    seeded.scenarios[0]!.preconditions = ["fixture:visitor"];
    const f = await fixture({
      plans: [seeded],
      baseApp: { greeting: "Hello " },
    });
    closers.push(f.close);
    const catalog = join(
      await mkdtemp(join(tmpdir(), "canary-baseline-fixtures-")),
      "fixtures.json"
    );
    await writeFile(
      catalog,
      JSON.stringify({
        "fixture/app": {
          fixtures: {
            visitor: {
              seedUrl: `${f.baseUrl}/fixture-seed`,
              cleanupUrl: `${f.baseUrl}/fixture-cleanup`,
              tokenEnv: "QA_BASELINE_FIXTURE_TOKEN",
              description: "A visitor for this run namespace",
            },
          },
        },
      })
    );
    vi.stubEnv("QA_BASELINE_FIXTURE_TOKEN", "fixture-token");
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      {
        ...f.config,
        QA_FIXTURES_FILE: catalog,
        QA_BASELINE_URL_TEMPLATE: f.baseAppUrl ?? "",
      }
    );
    expect(result.scenarios[0]?.outcome, result.scenarios[0]?.error).toBe(
      "passed"
    );
    // Un semis et un nettoyage : ceux de la tête, sous sa clé d'idempotence.
    expect(f.fixtureCalls.map((call) => call.path)).toEqual([
      "/fixture-seed",
      "/fixture-cleanup",
    ]);
    expect(result.baseline?.scenarios).toEqual([]);
    expect(result.baselineComparison?.inconclusive).toMatchObject([
      {
        assertionId: "saved",
        reason:
          "scenario not replayed on the base: its fixtures are seeded for the head environment only",
      },
    ]);
  }, 180_000);
});

describe("une base mal configurée échoue fort", () => {
  it("bloque le run avant toute dépense quand l'hôte de base n'est pas autorisé", async () => {
    const f = await fixture({});
    closers.push(f.close);
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      { ...f.config, QA_BASELINE_URL_TEMPLATE: "http://127.0.0.1:9/{sha}" }
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostic?.code).toBe("PREVIEW_HOST_NOT_ALLOWED");
    expect(result.scenarios).toEqual([]);
    expect(f.modelRequests).toEqual([]);
  });
});
