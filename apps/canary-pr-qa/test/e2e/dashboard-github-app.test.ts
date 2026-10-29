import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Canary, compileAction } from "../../src/canary.js";
import { GitHubSetup } from "../../src/github-setup.js";
import { LocalAuth } from "../../src/local-auth.js";
import { startProductionServer } from "../../src/production-server.js";
import { Queue } from "../../src/queue.js";
import { runQa } from "../../src/runner.js";
import { PR_URL } from "../fixture.js";
import { githubSetupFixture } from "../github-setup-fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

import { dashboardDatabase } from "./onboarding-helpers.js";

it("creates and installs the GitHub App from the dashboard, selects a repository and publishes a Chromium QA run without a PAT", async () => {
  await dashboardDatabase(closers);
  const f = await githubSetupFixture();
  closers.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const server = await startProductionServer(config);
  closers.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  f.state.dashboard = url;
  const queue = new Queue(config.DATABASE_URL);
  const accounts = new LocalAuth(queue.pool);
  const user = await accounts.setup(
    {
      username: "ui-github-admin",
      password: "ui-github-password-2026",
      setupCode: await accounts.issueSetupTicket(),
    },
    []
  );
  const token = await accounts.session(user);
  const hosts = [
    ...config.allowedHosts,
    new URL(url).host,
    new URL(f.api).host,
  ];
  const canary = new Canary({
    ...config,
    allowedHosts: hosts,
    PREVIEW_ALLOWED_HOSTS: hosts.join(","),
  });
  const session = await canary.start("GitHub App dashboard onboarding", {
    cookies: [
      {
        name: "qa_local_session",
        value: token,
        domain: "127.0.0.1",
        path: "/",
        secure: false,
        httpOnly: true,
        sameSite: "Lax",
        expires: -1,
      },
    ],
    origins: [],
  });
  const act = (
    label: string,
    action: Parameters<typeof compileAction>[0],
    assertion?: Parameters<typeof compileAction>[2]
  ) => canary.act(session, label, compileAction(action, url, assertion));
  const click = (label: string, selector: string) =>
    act(label, { type: "click", locator: { by: "css", value: selector } });
  const text = (label: string, selector: string, expected: string) =>
    act(
      label,
      {
        type: "assert",
        assertionId: label,
        locator: { by: "css", value: selector },
      },
      {
        id: label,
        description: expected,
        kind: "text",
        expected,
        verification: "state",
      }
    );
  try {
    await act("dashboard", { type: "goto", path: "/" });
    await text(
      "guided-welcome",
      "#welcomeTitle",
      "Votre premier test commence ici"
    );
    await text("next-action", "#welcomeAction", "Connecter GitHub");
    await text("ai-readiness", "#stepModelState", "Modèle disponible");
    const welcomeLayout = await canary.act(
      session,
      "welcome-desktop",
      `const page=await browser.getPage("qa"); await page.setViewportSize({width:1440,height:1000}); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)}));`
    );
    expect(welcomeLayout.actual).toBe(true);
    await click("settings-navigation", "#welcomeAction");
    await text("github-not-connected", "#githubConnection", "À connecter");
    // The accounts screen is served by the same origin as the API: it proves the
    // route, the schema and the admin gate work in a real browser, not just in
    // the unit tests. Réglages is one page per section, so the submenu opens it.
    await click("open-accounts-settings", "#nav-settings-accounts");
    await text("accounts-card", "#accountsSettings", "Comptes utilisateurs");
    await text("accounts-list", "#accountsList", "ui-github-admin");
    await click("back-to-github-settings", "#nav-settings-github");
    await text("github-page-restored", "#githubConnection", "À connecter");
    // Redirect only the external GitHub form to the protocol fixture. Production
    // still posts the real manifest and processes real HTTP callback/state flow.
    await canary.act(
      session,
      "fixture-github-form",
      `const page=await browser.getPage("qa"); await page.evaluate((base)=>{const original=HTMLFormElement.prototype.submit;HTMLFormElement.prototype.submit=function(){const destination=new URL(this.action);if(destination.hostname==="github.com")this.action=base+destination.pathname+destination.search;return original.call(this)}},${JSON.stringify(f.api)}); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full}));`
    );
    await click("create-github-app", "#githubCreateButton");
    await text("app-created", "#githubAppName", "canary-fixture-app");
    // Replace the fixture installation destination returned to the client;
    // the dashboard's actual install button and state callback remain exercised.
    await canary.act(
      session,
      "fixture-install-destination",
      `const page=await browser.getPage("qa"); await page.evaluate((base)=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(args[0]==="/github/app/install"&&response.ok){const data=await response.json();const destination=new URL(data.url);data.url=base+destination.pathname+destination.search;return new Response(JSON.stringify(data),{status:200,headers:{"Content-Type":"application/json"}})}return response}},${JSON.stringify(f.api)}); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full}));`
    );
    await click("install-app", "#githubInstall");
    await text("available-repository", "#githubRepoList", "fixture/app");
    await text(
      "auto-run-toggle",
      "#githubRepoList",
      "Lancer automatiquement une QA à chaque pull request"
    );
    await click(
      "select-repository",
      '#githubRepoList input[value="fixture/app"]'
    );
    await click("save-selection", "#githubSave");
    await text("selection-saved", "#githubMessage", "Dépôts enregistrés");
    await click("home-after-github", "#nav-home");
    await text(
      "automatic-runs-block",
      "#automaticRuns",
      "Lancements automatiques"
    );
    await text(
      "automatic-enabled-repository",
      "#automaticEnabledRepos",
      "1 dépôt(s) en lancement automatique"
    );
    await text(
      "automatic-empty",
      "#automaticEmpty",
      "Aucune tentative automatique en attente."
    );
    await text("ready-action", "#welcomeAction", "Tester une pull request");
    await click("new-test-after-github", "#welcomeAction");
    const layout = await canary.act(
      session,
      "connected-mobile-layout",
      `const page=await browser.getPage("qa"); await page.setViewportSize({width:390,height:844}); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:await page.evaluate(()=>({fits:document.documentElement.scrollWidth<=innerWidth,runVisible:!document.getElementById("runForm").closest("section").hidden,createHidden:(()=>{const form=document.getElementById("githubCreate");return !form||getComputedStyle(form).display==="none"})()}))}));`
    );
    expect(layout.actual).toEqual({
      fits: true,
      runVisible: true,
      createHidden: true,
    });
    await canary.end(session, join(f.dataDir, "github-onboarding-evidence"));
  } catch (error) {
    await canary.abort(session);
    throw error;
  }
  const effective = await new GitHubSetup(queue.pool, config).effective();
  expect(effective.GITHUB_TOKEN).toBe("");
  expect(effective.allowedRepos).toEqual(["fixture/app"]);
  expect(effective.automaticRepos).toEqual(["fixture/app"]);
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl, publish: true },
    effective
  );
  expect(result.outcome, result.error).toBe("passed");
  expect(
    f.requests.some((request) => request.path.endsWith("/check-runs"))
  ).toBe(true);
  expect(
    f.outgoing.some((request) => request.payload.state === "success")
  ).toBe(true);
  expect(
    f.outgoing.some(
      (request) =>
        request.path.endsWith("/comments") &&
        String(request.payload.body).includes("PASSED")
    )
  ).toBe(true);
  expect(
    result.scenarios[0]!.artifacts.some((path) => path.endsWith(".webm"))
  ).toBe(true);
}, 180_000);
