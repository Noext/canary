import { expect, test } from "@playwright/test";
import { copy, harnessState, signIn } from "./fixtures";

/**
 * Flow B: Réglages → GitHub App.
 *
 * GitHub cannot be reached from a test run, but the round-trip it performs is
 * real: the dashboard posts the manifest to github.com as a cross-origin form,
 * and GitHub replies with a redirect to the dashboard callback. Both hops are
 * fulfilled from the fixture's App server, so the manifest conversion, the
 * install callback and the installation sync all execute the production code.
 */
test("creates, installs and configures the GitHub App against the local fixture", async ({
  page,
}) => {
  const state = harnessState();
  await signIn(page, state);

  const github = state.githubApiUrl;
  const redirected: { method: string; url: string }[] = [];
  // Every github.com request is answered by the fixture, api host included, so
  // the run cannot reach the real service.
  await page.route(/^https:\/\/(api\.)?github\.com\//, async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    redirected.push({ method: request.method(), url: request.url() });
    const post = request.postData();
    const response = await route.fetch({
      maxRedirects: 0,
      url: `${github}${target.pathname}${target.search}`,
      ...(post === null ? {} : { postData: post }),
    });
    await route.fulfill({
      headers: response.headers(),
      response,
      status: response.status(),
    });
  });

  await page.click("#nav-settings");
  await expect(page.locator("#viewTitle")).toHaveText(
    "Réglages de votre espace"
  );
  await expect(page.locator("#githubConnection")).toHaveText("À connecter");
  await expect(page.locator("#githubCreate")).toBeVisible();

  // 1. Create the App: the hidden manifest form leaves the dashboard, GitHub
  //    redirects back to /github/app/callback and the server converts the code.
  await page.fill("#githubName", "Canary e2e fixture app");
  await page.click("#githubCreateButton");
  await expect(page.locator("#githubAppName")).toContainText(
    "canary-fixture-app"
  );
  await expect(page.locator("#githubAppName")).toContainText("App #95001");

  // 2. Install it: the install destination is rewritten to the fixture, which
  //    redirects to /github/app/installed and syncs the installation.
  await page.click("#githubInstall");
  await expect(page.locator("#githubRefresh")).toBeEnabled();

  // 3. Re-read the connection, then select the repository the fixture exposes.
  await page.click("#githubRefresh");
  const repository = page.locator('#githubRepoList input[value="fixture/app"]');
  await expect(repository).toBeVisible();
  await repository.check();
  await page.click("#githubSave");
  await expect(page.locator("#githubMessage")).toContainText(copy.repoMessage);
  await expect(page.locator("#githubConnection")).toContainText("Connecté");

  // The manifest POST left for github.com, the install navigation too, and both
  // were answered by the fixture: no other host was contacted.
  expect(redirected).toHaveLength(2);
  const manifest = redirected.filter((entry) =>
    entry.url.includes("/settings/apps/new")
  );
  const install = redirected.filter((entry) =>
    entry.url.includes("/installations/new")
  );
  expect(manifest.map((entry) => entry.method)).toEqual(["POST"]);
  expect(manifest[0]?.url).toContain("?state=");
  expect(install.map((entry) => entry.method)).toEqual(["GET"]);
  expect(install[0]?.url).toContain("?state=");

  // The saved selection is what the app and the server now agree on.
  await page.reload();
  await page.click("#nav-settings");
  await expect(page.locator("#githubConnection")).toContainText("Connecté");
  await expect(repository).toBeChecked();
});
