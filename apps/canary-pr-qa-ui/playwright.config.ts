import { defineConfig } from "@playwright/test";

/**
 * Browser-level suite of the React dashboard.
 *
 * One shared world for the whole run (`e2e/global-setup.ts`): the PR QA fixture,
 * a PGlite-backed production server and one worker. Workers must stay at 1 —
 * the specs share that server state — and the projects encode the one real
 * ordering constraint: `login.spec.ts` creates the first administrator the two
 * other screens sign in with.
 */
export default defineConfig({
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  projects: [
    { name: "login", testMatch: /login\.spec\.ts/ },
    {
      dependencies: ["login"],
      name: "github-app",
      testMatch: /github-app\.spec\.ts/,
    },
    {
      dependencies: ["github-app"],
      name: "run-verdict",
      testMatch: /run-verdict\.spec\.ts/,
    },
  ],
  reporter: [["list"]],
  retries: process.env.CI ? 1 : 0,
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  workers: 1,
});
