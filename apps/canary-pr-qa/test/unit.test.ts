import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertionMatches,
  Canary,
  compileAction,
  locatorExpression,
} from "../src/canary.js";
import { loadConfig, validatePreviewUrl } from "../src/config.js";
import { GitHub, parsePrUrl } from "../src/github.js";
import { resolvePreview, verifyPreviewUrl } from "../src/preview.js";
import { saveReport } from "../src/report.js";
import { runScope } from "../src/run-scope.js";
import { runQa } from "../src/runner.js";
import {
  ActionSchema,
  PlanSchema,
  type ScenarioResult,
} from "../src/schema.js";
import { BASE_SHA, fixture, PR_URL, plan, SHA } from "./fixture.js";

const close: (() => Promise<void>)[] = [];
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
  it("keeps an exact label match and adds the accessible-name path of the same label", () => {
    const target = { by: "label" as const, value: "Pharmacie active" };
    const expression = locatorExpression(target);
    // Le libellé englobant d'un `<select>` inclut le texte de ses options : la
    // correspondance exacte seule ne résout rien, le nom accessible la rattrape.
    expect(expression).toContain(
      'page.getByLabel("Pharmacie active", { exact: true })'
    );
    expect(expression).toContain(
      'page.getByRole("combobox", { name: "Pharmacie active", exact: true })'
    );
    expect(expression).toContain(
      'page.getByRole("textbox", { name: "Pharmacie active", exact: true })'
    );
    // Jamais de correspondance par sous-chaîne : un libellé qui contient la
    // valeur ne doit pas être sélectionné à la place du bon contrôle.
    expect(expression).not.toMatch(/getByLabel\([^,]+(?:\)|, \))/);
    const command = compileAction(
      { type: "select", locator: target, value: "DEMO18" },
      "https://preview.test"
    );
    expect(command).toContain(
      `await ${expression}.selectOption("DEMO18", { timeout: 10000 });`
    );
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
    expect(
      f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
        .state
    ).toBe("error");
    expect(result.scenarios).toEqual([]);
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
  expect(result.publication?.status).toBe("error");
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
