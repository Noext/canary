import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { APPROVED_SKIPS_GATE } from "../../src/approved-skips.js";
import { Canary } from "../../src/canary.js";
import { runQa } from "../../src/runner.js";
import type { Plan } from "../../src/schema.js";
import { fixture, PR_URL, plan } from "../fixture.js";

/**
 * Le même contrat qu'en test unitaire, contre la préversion servie à un vrai
 * Chromium : une PR de documentation seule, approuvée ignorée par la base, ne
 * dépense ni appel modèle ni session navigateur ; une PR mêlée est planifiée et
 * jouée comme avant.
 */
const DOCS_REASON = "Documentation only, reviewed by humans";
const APPROVED = [{ path: "docs/**", reason: DOCS_REASON }];
const DOCS_PATCH = "@@ -1,1 +1,1 @@\n-Old guide\n+New guide";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

it("skips a docs-only PR approved by the base policy with zero model requests", async () => {
  const start = vi.spyOn(Canary.prototype, "start");
  const f = await fixture({
    approvedSkips: APPROVED,
    changedFiles: [
      { filename: "docs/guide.md", patch: DOCS_PATCH },
      { filename: "docs/api/index.md", patch: DOCS_PATCH },
    ],
  });
  closers.push(f.close);
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(result.outcome, result.error).toBe("skipped");
  expect(f.completionRequests()).toBe(0);
  expect(result.usage).toMatchObject({ calls: 0, reservedTokens: 0 });
  expect(start).not.toHaveBeenCalled();
  expect(result.scenarios).toEqual([]);
  expect(result.coverage?.gate).toBe(APPROVED_SKIPS_GATE);
  expect(result.plan?.skipped).toEqual([
    { sourceFile: "docs/guide.md", reason: DOCS_REASON },
    { sourceFile: "docs/api/index.md", reason: DOCS_REASON },
  ]);
  expect(
    f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
      .description
  ).toBe(
    "QA skipped: 2/2 changed files are approved skips (.canary/qa.json); no browser scenario run"
  );
  expect(
    await readFile(join(f.dataDir, result.id, "report.md"), "utf8")
  ).toContain(`- Not browser-tested: \`docs/guide.md\` — ${DOCS_REASON}`);
}, 120_000);

it("still plans and executes a mixed PR in Chromium", async () => {
  const mixed: Plan = {
    ...structuredClone(plan),
    skipped: [{ sourceFile: "docs/guide.md", reason: DOCS_REASON }],
  };
  const f = await fixture({
    approvedSkips: APPROVED,
    changedFiles: [
      {
        filename: "src/form.ts",
        patch: "- show('Hello')\n+ show('Welcome '+name)",
      },
      { filename: "docs/guide.md", patch: DOCS_PATCH },
    ],
    plans: [mixed],
  });
  closers.push(f.close);
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(result.outcome, result.error).toBe("passed");
  expect(f.modelRequests.length).toBeGreaterThan(0);
  expect(result.coverage?.gate).toBe("complete");
  expect(result.plan?.skipped).toEqual(mixed.skipped);
  expect(result.scenarios.map((item) => item.outcome)).toEqual(["passed"]);
}, 180_000);
