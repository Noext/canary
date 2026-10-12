import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { GitHub } from "../src/github.js";
import { Model } from "../src/model.js";
import { runScope } from "../src/run-scope.js";
import { fixture, PR_URL } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
it("refuses a billable model request before exceeding its configured cost ceiling", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const request = vi.spyOn(globalThis, "fetch");
  const config = {
    ...f.config,
    QA_INPUT_COST_PER_MILLION: 1,
    QA_OUTPUT_COST_PER_MILLION: 2,
  };
  await expect(
    runScope.run(
      {
        id: "cost-preflight",
        signal: new AbortController().signal,
        tokens: 0,
        costUsd: 0,
        calls: 0,
        maxTokens: 100_000,
        maxCostUsd: 0.000_01,
      },
      () =>
        new Model(config).json("JSON", {}, z.object({ ok: z.boolean() }), 1024)
    )
  ).rejects.toMatchObject({ code: "RUN_BUDGET_EXCEEDED" });
  expect(request).not.toHaveBeenCalled();
});
it("finds the existing bot report beyond 100 human comments and updates it", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const github = new GitHub(f.config);
  const context = await github.context(PR_URL);
  const request = vi
    .spyOn(github, "request")
    .mockImplementation(async (path, method = "GET") => {
      if (method === "PATCH") {
        return { html_url: `${PR_URL}#issuecomment-444` };
      }
      if (path.endsWith("page=1")) {
        return Array.from({ length: 100 }, (_, i) => ({
          id: i,
          body: "Human discussion",
          user: { type: "User" },
        }));
      }
      if (path.endsWith("page=2")) {
        return [
          {
            id: 444,
            body: "<!-- canary-pr-qa -->\nold report",
            user: { type: "Bot" },
          },
        ];
      }
      throw new Error("Unexpected request / duplicate comment");
    });
  await expect(github.comment(context, "replacement")).resolves.toContain(
    "444"
  );
  expect(request).toHaveBeenCalledWith(
    "/repos/fixture/app/issues/comments/444",
    "PATCH",
    { body: "<!-- canary-pr-qa -->\nreplacement" }
  );
  expect(request.mock.calls.some(([, method]) => method === "POST")).toBe(
    false
  );
});
