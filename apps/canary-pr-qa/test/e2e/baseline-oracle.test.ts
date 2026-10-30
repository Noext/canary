import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary } from "../../src/canary.js";
import { runQa } from "../../src/runner.js";
import { BASE_SHA, fixture, PR_URL, plan } from "../fixture.js";

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
});

async function baselineRun(
  options: Parameters<typeof fixture>[0] & {
    baseApp: { greeting: string; sha?: string };
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
  const stored = JSON.parse(
    await readFile(join(f.dataDir, result.id, "result.json"), "utf8")
  );
  return { comment, reportMd, result, status, stored };
}

describe("la base rejouée comme oracle indépendant", () => {
  it("liste le comportement modifié en tête du rapport, du statut et de result.json", async () => {
    const { comment, reportMd, result, status, stored } = await baselineRun({
      baseApp: { greeting: "Hello " },
    });
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
    expect(status?.state).toBe("error");
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
});
