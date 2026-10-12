import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { harnessState, signIn } from "./fixtures";

/**
 * Budget of the verification itself: the worker has to reach a terminal state
 * within this window, and the whole spec within its `timeout`.
 */
const verdictTimeoutMs = 45_000;

/**
 * Flow C: Nouveau test → verdict.
 *
 * Every layer is real: the fixture preview carries the PR commit, the server
 * runs the preflight, the worker claims the job, Chromium plays the scenario
 * the fixture's model endpoint scripted, and the video/report land under the
 * run id the interface displays.
 */
test("launches the fixture pull request and follows the run to its verdict", async ({
  page,
}) => {
  const state = harnessState();
  await signIn(page, state);
  await page.click("#nav-new");
  await expect(page.locator("#viewTitle")).toHaveText("Nouveau test");

  // The catalogue comes from the fixture and contains the configured default,
  // so the launch controls arm without a manual model choice.
  await expect(page.locator("#model")).not.toHaveValue("");
  await page.fill("#pr", state.prUrl);
  await page.fill("#preview", state.previewUrl);

  await page.click("#checkRun");
  await expect(page.locator("#preflightSummary")).toContainText("fixture/app");
  await expect(page.locator("#preflightSummary")).toContainText("version ");
  await expect(page.locator("#startRun")).toBeEnabled();

  await page.click("#startRun");
  await expect(page.locator("#runState")).toHaveText("Réussi", {
    timeout: verdictTimeoutMs,
  });
  await expect(page.locator("#liveConnection")).toHaveText("Suivi terminé");
  await expect(page.locator("#resultSummary")).toContainText(
    "Les assertions ont réussi sur la version testée."
  );

  const cards = page.locator("#scenarioCards article");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(
    "Submitting the name saves a welcome message"
  );
  await expect(cards.first().locator("video")).toHaveAttribute(
    "src",
    /\.webm$/
  );

  // The evidence is on disk under the run id the panel shows: the worker, not
  // the fixture, produced it.
  const runId =
    (await page.locator("#runIdentifier").textContent())
      ?.replace("Run ID : ", "")
      .trim() ?? "";
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  const video =
    (await cards.first().locator("video").getAttribute("src")) ?? "";
  const artifact = decodeURIComponent(
    video.replace(`/artifacts/${runId}/`, "")
  );
  expect(artifact).toMatch(/\.webm$/);
  expect(existsSync(join(state.dataDir, runId, artifact))).toBe(true);
  expect(existsSync(join(state.dataDir, runId, "report.html"))).toBe(true);
});
