import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  APPROVED_SKIPS_GATE,
  settleApprovedSkips,
} from "../src/approved-skips.js";
import { Canary } from "../src/canary.js";
import { type PrContext, parsePrUrl } from "../src/github.js";
import { PolicySchema } from "../src/policy.js";
import { statusDescription } from "../src/report.js";
import { runQa } from "../src/runner.js";
import type { Plan, RunResult } from "../src/schema.js";
import { BASE_SHA, fixture, PR_URL, plan } from "./fixture.js";

/**
 * Une PR dont chaque fichier changé est approuvé ignoré par la base n'a rien de
 * testable au navigateur. Mesuré sur une PR de documentation seule : le run
 * réservait un appel de plan payant et finissait bloqué par son plafond de
 * coût. Le run se conclut désormais `skipped`, sans appel modèle ni scénario ;
 * un diff mêlé garde le chemin de planification d'avant.
 */
const DOCS_REASON = "Documentation only, reviewed by humans";
const GENERATED_REASON = "Generated client covered by the required type check";
const APPROVED = [
  { path: "docs/**", reason: DOCS_REASON },
  { path: "src/generated.ts", reason: GENERATED_REASON },
];
const policy = PolicySchema.parse({ version: 1, approvedSkips: APPROVED });

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
const changed = (filename: string, previous?: string) => ({
  filename,
  status: previous ? "renamed" : "modified",
  ...(previous ? { previous_filename: previous } : {}),
});

/** Un run vierge, tel que le runner le passe avant la planification. */
function settle(files: PrContext["files"], approvals = policy) {
  const result: RunResult = {
    id: "approved-skips",
    prUrl: PR_URL,
    startedAt: new Date(0).toISOString(),
    outcome: "blocked",
    scenarios: [],
  };
  const settled = settleApprovedSkips(result, approvals, contextOf(files));
  return { result, settled };
}

it("settles a diff made only of approved skips as skipped, with their reasons", () => {
  const { result, settled } = settle([
    changed("docs/guide.md"),
    changed("src/generated.ts"),
  ]);
  const skipped = [
    { sourceFile: "docs/guide.md", reason: DOCS_REASON },
    { sourceFile: "src/generated.ts", reason: GENERATED_REASON },
  ];
  expect(settled).toBe(true);
  expect(result).toMatchObject({
    outcome: "skipped",
    plan: { summary: expect.any(String), scenarios: [], skipped },
    coverage: {
      covered: [],
      skipped,
      policyRef: BASE_SHA,
      gate: APPROVED_SKIPS_GATE,
    },
  });
  expect(statusDescription(result)).toBe(
    "QA skipped: 2/2 changed files are approved skips (.canary/qa.json); no browser scenario run"
  );
});

it.each([
  ["a changed file outside every approved skip", [changed("src/form.ts")]],
  [
    "a documentation file that is not approved",
    [changed("docs/guide.md"), changed("README.md")],
  ],
  [
    "a rename out of a path that is not approved",
    [changed("docs/form.ts", "src/form.ts")],
  ],
  ["an empty diff", []],
])("keeps planning with %s", (_label, files) => {
  const { result, settled } = settle(files);
  expect(settled).toBe(false);
  // Le run reste intact : la planification part du même état qu'avant.
  expect(result).toEqual({
    id: "approved-skips",
    prUrl: PR_URL,
    startedAt: new Date(0).toISOString(),
    outcome: "blocked",
    scenarios: [],
  });
});

it("never short-circuits on an over-broad approval pattern", () => {
  const blanket = PolicySchema.parse({
    version: 1,
    approvedSkips: [{ path: "**", reason: "Blanket approval of everything" }],
  });
  expect(settle([changed("docs/guide.md")], blanket).settled).toBe(false);
});

it("accepts a rename between two approved paths", () => {
  expect(settle([changed("docs/new.md", "docs/old.md")]).result.outcome).toBe(
    "skipped"
  );
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

it("ends an all-approved-skip PR skipped without any model call or browser session", async () => {
  const start = vi.spyOn(Canary.prototype, "start");
  const f = await setup({
    approvedSkips: APPROVED,
    changedFiles: [
      { filename: "docs/guide.md", patch: DOCS_PATCH },
      { filename: "src/generated.ts", patch: "+export const v = 2;" },
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
  expect(result.coverage?.gate).toBe(APPROVED_SKIPS_GATE);
  const statuses = f.outgoing.filter((request) => request.payload.state);
  // `skipped` ne signifie jamais réussite : le statut n'est pas vert, mais il
  // dit pourquoi aucun scénario n'a été joué.
  expect(statuses.at(-1)?.payload).toMatchObject({
    state: "error",
    description:
      "QA skipped: 2/2 changed files are approved skips (.canary/qa.json); no browser scenario run",
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
    `- Not browser-tested: \`src/generated.ts\` — ${GENERATED_REASON}`
  );
  const saved = JSON.parse(
    await readFile(join(f.dataDir, result.id, "result.json"), "utf8")
  );
  expect(saved).toMatchObject({
    outcome: "skipped",
    coverage: { gate: APPROVED_SKIPS_GATE },
    plan: { scenarios: [] },
  });
  expect(statusDescription(result)).toBe(statuses.at(-1)?.payload.description);
});

it("keeps planning a mixed PR where one changed file is not an approved skip", async () => {
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
