import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  NON_RUNTIME_GATE,
  settleNonRuntimeDiff,
} from "../src/approved-skips.js";
import { Canary } from "../src/canary.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import { PolicySchema } from "../src/policy.js";
import { statusDescription } from "../src/report.js";
import { runQa } from "../src/runner.js";
import type { Plan, RunResult } from "../src/schema.js";
import { BASE_SHA, fixture, PR_URL, plan } from "./fixture.js";

/**
 * Une PR dont chaque fichier changé est documentation ou test n'a rien de
 * testable au navigateur. Mesuré sur une PR de documentation seule : le run
 * réservait un appel de plan payant et finissait bloqué par son plafond de
 * coût. Le run se conclut désormais `skipped`, sans préversion, appel modèle ni
 * scénario. Un fichier exécuté — même approuvé ignoré par la base — garde le
 * chemin de planification d'avant : une approbation permet au planificateur de
 * laisser un fichier hors de ses scénarios, elle ne dit pas qu'il n'y a rien à
 * tester.
 */
const DOCS_REASON = "Documentation only, reviewed by humans";
const GENERATED_REASON = "Generated client covered by the required type check";
const APPROVED = [
  { path: "docs/**", reason: DOCS_REASON },
  { path: "src/generated.ts", reason: GENERATED_REASON },
];
const policy = PolicySchema.parse({ version: 1, approvedSkips: APPROVED });
/** Les entrées de `.canary/qa.json` d'arpilabe (main 7427180) en jeu ici. */
const BARREL_REASON =
  "Barrel de ré-export du domaine, sans règle propre : son effet est exercé par les scénarios qui passent par apps/web/app/page.tsx.";
const SPEC_REASON = "Tests unitaires vitest du domaine, exécutés par la CI.";
const arpilabe = PolicySchema.parse({
  version: 1,
  approvedSkips: [
    { path: "docs/**", reason: DOCS_REASON },
    {
      path: "packages/domain/src/__tests__/*.spec.ts",
      reason: SPEC_REASON,
    },
    { path: "packages/domain/src/index.ts", reason: BARREL_REASON },
  ],
});
const DOCUMENTATION_REASON =
  "Documentation (never critical): no runtime behavior to exercise in a browser.";
const TEST_REASON =
  "Test file: exercised by CI, no runtime behavior to exercise in a browser.";

function contextOf(files: PrContext["files"]): PrContext {
  return {
    baseSha: BASE_SHA,
    body: "",
    context: [],
    contextWarnings: [],
    files,
    headRepo: "fixture/app",
    ref: parsePrUrl(PR_URL),
    sha: "1".repeat(40),
    title: "",
  };
}
const changed = (filename: string, previous?: string, status = "modified") => ({
  filename,
  status: previous ? "renamed" : status,
  ...(previous ? { previous_filename: previous } : {}),
});
const blank = (): RunResult => ({
  id: "approved-skips",
  prUrl: PR_URL,
  startedAt: new Date(0).toISOString(),
  outcome: "blocked",
  scenarios: [],
});

/** Un run vierge, tel que le runner le passe avant la préversion. */
function settle(files: PrContext["files"], skips = policy) {
  const result = blank();
  const settled = settleNonRuntimeDiff(result, skips, contextOf(files));
  return { result, settled };
}

it("settles a documentation and test diff as skipped, approved reasons first", () => {
  const { result, settled } = settle([
    changed("docs/guide.md"),
    changed("README.md"),
    changed("src/form.test.ts"),
  ]);
  const skipped = [
    { sourceFile: "docs/guide.md", reason: DOCS_REASON },
    { sourceFile: "README.md", reason: DOCUMENTATION_REASON },
    { sourceFile: "src/form.test.ts", reason: TEST_REASON },
  ];
  expect(settled).toBe(true);
  expect(result).toMatchObject({
    outcome: "skipped",
    plan: { summary: expect.any(String), scenarios: [], skipped },
    coverage: {
      covered: [],
      skipped,
      policyRef: BASE_SHA,
      gate: NON_RUNTIME_GATE,
    },
  });
  expect(statusDescription(result)).toBe(
    "QA skipped: 3/3 changed files are documentation or tests; no browser scenario run"
  );
});

it.each([
  ["README.md"],
  ["CHANGELOG.md"],
  ["apps/web/README.md"],
  ["apps/web/AGENTS.md"],
  ["LICENSE"],
  ["openspec/changes/add-banner/proposal.md"],
  ["docs/sources/export.pdf"],
])("skips %s without an approval entry, with or without a policy", (file) => {
  for (const skips of [arpilabe, PolicySchema.parse({ version: 1 })]) {
    expect(settle([changed(file)], skips).settled).toBe(true);
  }
});

it("keeps the arpilabe approved reason for a domain spec change", () => {
  const { result } = settle(
    [changed("packages/domain/src/__tests__/cash.spec.ts")],
    arpilabe
  );
  expect(result.outcome).toBe("skipped");
  expect(result.plan?.skipped).toEqual([
    {
      sourceFile: "packages/domain/src/__tests__/cash.spec.ts",
      reason: SPEC_REASON,
    },
  ]);
});

const pristine = blank();
it.each([
  ["a changed file outside every approved skip", [changed("src/form.ts")]],
  [
    "an approved generated runtime file",
    [changed("docs/guide.md"), changed("src/generated.ts")],
  ],
  ["a rename out of a runtime path", [changed("docs/form.md", "src/form.ts")]],
  [
    "a route under a nested docs directory",
    [changed("apps/web/app/docs/page.tsx")],
  ],
  ["an MDX page, compiled into a component", [changed("docs/intro.mdx")]],
  ["an empty diff", []],
])("keeps planning with %s", (_label, files) => {
  const { result, settled } = settle(files);
  expect(settled).toBe(false);
  // Le run reste intact : la planification part du même état qu'avant.
  expect(result).toEqual(pristine);
});

it.each([
  "modified",
  "removed",
])("plans the arpilabe barrel alone (%s) although the base approves its skip", (status) => {
  const { result, settled } = settle(
    [changed("packages/domain/src/index.ts", undefined, status)],
    arpilabe
  );
  expect(settled).toBe(false);
  expect(result).toEqual(pristine);
});

it.each([
  "**/*.tsx",
  "apps/**",
])("plans a page under the over-broad approval %s", (path) => {
  const broad = PolicySchema.parse({
    version: 1,
    approvedSkips: [{ path, reason: "Over-broad approval of runtime code" }],
  });
  expect(settle([changed("apps/web/app/page.tsx")], broad).settled).toBe(false);
});

it("accepts a rename between two documentation paths", () => {
  expect(settle([changed("docs/new.md", "docs/old.md")]).result.outcome).toBe(
    "skipped"
  );
});

it.each([
  "stale",
  "blocked",
] as const)("keeps the generic status text once the run turns %s", (outcome) => {
  const { result } = settle([changed("docs/guide.md")]);
  result.outcome = outcome;
  expect(statusDescription(result)).toBe(`QA ${outcome}: 0/0 scenarios`);
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
});
async function setup(options: Parameters<typeof fixture>[0]) {
  const f = await fixture(options);
  closers.push(f.close);
  return f;
}
const DOCS_PATCH = "@@ -1,1 +1,1 @@\n-Old guide\n+New guide";
const FORM_PATCH = "- show('Hello')\n+ show('Welcome '+name)";

it("ends a documentation and test PR skipped without any model call or browser session", async () => {
  const start = vi.spyOn(Canary.prototype, "start");
  const f = await setup({
    approvedSkips: APPROVED,
    changedFiles: [
      { filename: "docs/guide.md", patch: DOCS_PATCH },
      { filename: "src/form.test.ts", patch: "+it('works', () => {});" },
    ],
  });
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(result.outcome, result.error).toBe("skipped");
  expect(f.completionRequests()).toBe(0);
  expect(f.modelRequests).toHaveLength(0);
  expect(f.catalogRequests).toHaveLength(0);
  expect(result.usage).toMatchObject({
    calls: 0,
    tokens: 0,
    reservedTokens: 0,
  });
  expect(start).not.toHaveBeenCalled();
  expect(result.scenarios).toEqual([]);
  expect(result.preview).toBeUndefined();
  expect(result.coverage?.gate).toBe(NON_RUNTIME_GATE);
  const statuses = f.outgoing.filter((request) => request.payload.state);
  // `skipped` ne signifie jamais réussite : le statut n'est pas vert, mais il
  // dit pourquoi aucun scénario n'a été joué.
  expect(statuses.at(-1)?.payload).toMatchObject({
    state: "error",
    description:
      "QA skipped: 2/2 changed files are documentation or tests; no browser scenario run",
  });
  const report = await readFile(
    join(f.dataDir, result.id, "report.md"),
    "utf8"
  );
  expect(report).toContain("**Result: SKIPPED**");
  expect(report).toContain(
    `- Not browser-tested: \`docs/guide.md\` — ${DOCS_REASON}`
  );
  expect(report).toContain(
    `- Not browser-tested: \`src/form.test.ts\` — ${TEST_REASON}`
  );
  const saved = JSON.parse(
    await readFile(join(f.dataDir, result.id, "result.json"), "utf8")
  );
  expect(saved).toMatchObject({
    outcome: "skipped",
    coverage: { gate: NON_RUNTIME_GATE },
    plan: { scenarios: [] },
  });
  expect(statusDescription(result)).toBe(statuses.at(-1)?.payload.description);
});

it("skips a documentation PR whose host deployed no preview of its head", async () => {
  const f = await setup({
    noSha: true,
    changedFiles: [{ filename: "README.md", patch: DOCS_PATCH }],
  });
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(result.outcome, result.error).toBe("skipped");
  expect(result.diagnostic).toBeUndefined();
});

it("reports a documentation PR whose head moved as stale, not skipped", async () => {
  const f = await setup({
    updatedSha: true,
    changedFiles: [{ filename: "docs/guide.md", patch: DOCS_PATCH }],
  });
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(result.outcome).toBe("stale");
  expect(
    f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
  ).toMatchObject({ state: "error", description: "QA stale: 0/0 scenarios" });
});

it("plans the approved arpilabe barrel like any runtime change", async () => {
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
  const f = await setup({
    approvedSkips: arpilabe.approvedSkips,
    changedFiles: [
      {
        filename: "packages/domain/src/index.ts",
        patch: '+export const CASH_LABEL = "Caisse";',
      },
    ],
  });
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(f.modelRequests.length).toBeGreaterThan(0);
  expect(result.coverage?.gate).not.toBe(NON_RUNTIME_GATE);
});

it("keeps planning a mixed PR where one changed file is runtime code", async () => {
  const mixed: Plan = {
    ...structuredClone(plan),
    skipped: [{ sourceFile: "docs/guide.md", reason: DOCS_REASON }],
  };
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
  const f = await setup({
    approvedSkips: APPROVED,
    changedFiles: [
      { filename: "src/form.ts", patch: FORM_PATCH },
      { filename: "docs/guide.md", patch: DOCS_PATCH },
    ],
    plans: [mixed],
  });
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(result.outcome, result.error).toBe("passed");
  expect(f.modelRequests.length).toBeGreaterThan(0);
  expect(result.coverage?.gate).toBe("complete");
  expect(result.plan?.skipped).toEqual(mixed.skipped);
  expect(result.scenarios.map((item) => item.scenario.id)).toEqual(["welcome"]);
});
