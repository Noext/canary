import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { Canary, compileAction } from "../../src/canary.js";
import { GitHubSetup } from "../../src/github-setup.js";
import { LocalAuth } from "../../src/local-auth.js";
import { startProductionServer } from "../../src/production-server.js";
import { Queue } from "../../src/queue.js";
import { saveReport } from "../../src/report.js";
import { runQa } from "../../src/runner.js";
import { fixture, PR_URL, plan, SHA } from "../fixture.js";
import { githubSetupFixture } from "../github-setup-fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

it("uses the actual dashboard in Chromium: login, project list, live SSE and cancellation", async () => {
  await dashboardDatabase();
  const f = await fixture();
  closers.push(f.close);
  const viewerToken = "dashboard-viewer-token-0123456789";
  const usersFile = join(f.dataDir, "dashboard-users.json");
  await writeFile(
    usersFile,
    JSON.stringify([
      {
        id: "read-only",
        role: "viewer",
        repos: ["fixture/app"],
        tokenSha256: createHash("sha256").update(viewerToken).digest("hex"),
      },
    ])
  );
  const config = {
    ...f.config,
    OPENAI_MODEL: "missing-default-model",
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
    QA_USERS_FILE: usersFile,
  };
  const server = await startProductionServer(config);
  closers.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const queue = new Queue(config.DATABASE_URL);
  const job = await queue.enqueue(
    "fixture/app",
    1,
    SHA,
    "tester",
    { prUrl: PR_URL },
    "dashboard-test"
  );
  const canary = new Canary({
    ...config,
    allowedHosts: [...config.allowedHosts, new URL(url).host],
    PREVIEW_ALLOWED_HOSTS: [
      ...config.allowedHosts,
      new URL(url).host,
      new URL(url.replace("127.0.0.1", "localhost")).host,
    ].join(","),
  });
  const id = await canary.start("Dashboard UI verification");
  async function act(
    label: string,
    action: Parameters<typeof compileAction>[0],
    assertion?: Parameters<typeof compileAction>[2]
  ) {
    return canary.act(id, label, compileAction(action, url, assertion));
  }
  try {
    await act("open-dashboard", { type: "goto", path: "/" });
    await act("technical-access", {
      type: "click",
      locator: { by: "css", value: "#technicalAccess > summary" },
    });
    await act("enter-token", {
      type: "fill",
      locator: { by: "css", value: "#token" },
      value: config.QA_API_TOKEN,
    });
    await act("login", {
      type: "click",
      locator: { by: "role", value: "button", name: "Connexion technique" },
    });
    await act("history-navigation", {
      type: "click",
      locator: { by: "css", value: "#nav-runs" },
    });
    const listed = await act(
      "list",
      {
        type: "assert",
        assertionId: "list",
        locator: { by: "css", value: "#runs" },
      },
      {
        id: "list",
        description: "Project visible",
        kind: "text",
        expected: "fixture/app #1",
        verification: "state",
        afterStep: "login",
      }
    );
    expect(listed.actual).toContain("fixture/app #1");
    await act("new-test-navigation", {
      type: "click",
      locator: { by: "css", value: "#nav-new" },
    });
    const noFallback = await act(
      "no-fallback",
      {
        type: "assert",
        assertionId: "no-fallback",
        locator: { by: "css", value: "#modelState" },
      },
      {
        id: "no-fallback",
        description: "Explicit choice required for missing default",
        kind: "text",
        expected: "choisissez explicitement",
        verification: "state",
      }
    );
    expect(noFallback.actual).toContain("choisissez explicitement");
    const disabled = await act(
      "launch-disabled",
      {
        type: "assert",
        assertionId: "disabled",
        locator: { by: "css", value: "#startRun:disabled" },
      },
      {
        id: "disabled",
        description: "Cannot launch before explicit selection",
        kind: "visible",
        verification: "state",
      }
    );
    expect(disabled.actual).toBe(true);
    await act("back-to-history", {
      type: "click",
      locator: { by: "css", value: "#nav-runs" },
    });
    await act("open-run", {
      type: "click",
      locator: { by: "role", value: "link", name: "fixture/app #1" },
    });
    const stream = await act(
      "live",
      {
        type: "assert",
        assertionId: "live",
        locator: { by: "css", value: "#liveConnection" },
      },
      {
        id: "live",
        description: "SSE connected",
        kind: "text",
        expected: "Suivi en direct connecté",
        verification: "state",
        afterStep: "open",
      }
    );
    expect(stream.actual).toBe("Suivi en direct connecté");
    await queue.claim("dashboard-worker");
    const running = await act(
      "running",
      {
        type: "assert",
        assertionId: "running",
        locator: { by: "css", value: "#runState" },
      },
      {
        id: "running",
        description: "Running update delivered",
        kind: "text",
        expected: "En cours",
        verification: "state",
        afterStep: "open",
      }
    );
    expect(String(running.actual).toLowerCase()).toContain("en cours");
    await act("cancel", {
      type: "click",
      locator: { by: "role", value: "button", name: "Annuler le test" },
    });
    for (
      let i = 0;
      i < 20 && !(await queue.get(job.id))?.cancel_requested;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await queue.get(job.id))?.cancel_requested).toBe(true);
    await act("new-after-cancel", {
      type: "click",
      locator: { by: "css", value: "#nav-new" },
    });
    await act("choose-model", {
      type: "select",
      locator: { by: "css", value: "#model" },
      value: "fixture-alternate-model",
    });
    await act("enter-pr", {
      type: "fill",
      locator: { by: "css", value: "#pr" },
      value: PR_URL,
    });
    await act("enter-preview", {
      type: "fill",
      locator: { by: "css", value: "#preview" },
      value: f.baseUrl,
    });
    await act("preflight-before-launch", {
      type: "click",
      locator: { by: "css", value: "#checkRun" },
    });
    const checked = await act(
      "preflight-confirmation",
      {
        type: "assert",
        assertionId: "preflight",
        locator: { by: "css", value: "#preflightSummary" },
      },
      {
        id: "preflight",
        description: "PR and preview verified",
        kind: "text",
        expected: "fixture/app",
        verification: "state",
      }
    );
    expect(checked.actual).toContain("fixture/app");
    await act("launch-selected-model", {
      type: "click",
      locator: { by: "css", value: "#startRun" },
    });
    for (
      let i = 0;
      i < 30 && (await queue.list(["fixture/app"])).length < 2;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const selected = (await queue.list(["fixture/app"])).find(
      (run) => run.id !== job.id
    );
    expect(selected?.input.model).toBe("fixture-alternate-model");
    expect(f.catalogRequests.length).toBeGreaterThan(0);
    await act("logout", {
      type: "click",
      locator: { by: "role", value: "button", name: "Déconnexion" },
    });
    await act("viewer-technical-access", {
      type: "click",
      locator: { by: "css", value: "#technicalAccess > summary" },
    });
    await act("viewer-token", {
      type: "fill",
      locator: { by: "css", value: "#token" },
      value: viewerToken,
    });
    await act("viewer-login", {
      type: "click",
      locator: { by: "role", value: "button", name: "Connexion technique" },
    });
    const viewer = await act(
      "viewer-ready",
      {
        type: "assert",
        assertionId: "viewer",
        locator: { by: "css", value: "#connection" },
      },
      {
        id: "viewer",
        description: "Viewer identified",
        kind: "text",
        expected: "read-only",
        verification: "state",
        afterStep: "login",
      }
    );
    expect(viewer.actual).toContain("read-only");
    const controls = await act(
      "viewer-controls",
      {
        type: "assert",
        assertionId: "controls",
        locator: { by: "css", value: "#runForm" },
      },
      {
        id: "controls",
        description: "Read-only controls hidden",
        kind: "hidden",
        verification: "state",
        afterStep: "login",
      }
    );
    expect(controls.actual).toBe(false);
    const reportRoot = join(f.dataDir, job.id);
    const files = await canary.end(id, join(reportRoot, "dashboard"));
    await saveReport(
      reportRoot,
      {
        id: job.id,
        prUrl: PR_URL,
        sha: SHA,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        outcome: "passed",
        scenarios: [
          {
            scenario: {
              ...plan.scenarios[0]!,
              id: "dashboard",
              title: "Dashboard test recording",
            },
            steps: [],
            assertions: [],
            artifacts: files,
            outcome: "passed",
          },
        ],
      },
      config
    );
    const htmlPath = join(reportRoot, "report.html");
    await writeFile(
      htmlPath,
      `${await readFile(htmlPath, "utf8")}<script>document.documentElement.dataset.qaInjection="executed";</script>`
    );
    const login = await fetch(`${url}/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.QA_API_TOKEN}` },
    });
    const cookie = login.headers
      .get("set-cookie")!
      .split(";")[0]!
      .slice("qa_session=".length);
    const reportUrl = `${url.replace("127.0.0.1", "localhost")}/artifacts/${job.id}/report.html`;
    const player = await canary.start("Authenticated report video playback", {
      cookies: [
        {
          name: "qa_session",
          value: cookie,
          domain: "localhost",
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
          expires: -1,
        },
      ],
      origins: [],
    });
    try {
      const playback = await canary.act(
        player,
        "playback",
        `const page = await browser.getPage("qa");
await page.goto(${JSON.stringify(f.baseUrl)}, {waitUntil:"domcontentloaded"});
await page.evaluate(href => { const link = document.createElement("a"); link.href = href; link.textContent = "Open QA report"; document.body.append(link); }, ${JSON.stringify(reportUrl)});
await page.getByRole("link", {name:"Open QA report"}).click();
await page.waitForURL(${JSON.stringify(reportUrl)});
await page.locator("video").click();
await page.waitForTimeout(500);
const actual = await page.evaluate(() => { const video = document.querySelector("video"); const result = {time:video.currentTime,duration:video.duration,injectedScript:document.documentElement.dataset.qaInjection || null}; video.pause(); return result; });
console.log("CANARY_PR_QA_OBSERVATION:" + JSON.stringify({url:page.url(),snapshot:"Authenticated HTML report playback",actual}));`
      );
      expect((playback.actual as { time: number }).time).toBeGreaterThan(0);
      expect(
        (playback.actual as { duration: number }).duration
      ).toBeGreaterThan(0);
      expect(
        (playback.actual as { injectedScript: unknown }).injectedScript
      ).toBeNull();
      await canary.end(player, join(f.dataDir, "report-player"));
    } finally {
      await canary.abort(player);
    }
  } finally {
    await canary.abort(id);
  }
}, 180_000);
it("creates a local admin and logs in/out with a password in real mobile Chromium", async () => {
  await dashboardDatabase();
  const f = await fixture();
  closers.push(f.close);
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
  };
  const server = await startProductionServer(config);
  closers.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const queue = new Queue(config.DATABASE_URL);
  const code = await new LocalAuth(queue.pool).issueSetupTicket();
  const canary = new Canary({
    ...config,
    allowedHosts: [...config.allowedHosts, new URL(url).host],
    PREVIEW_ALLOWED_HOSTS: [...config.allowedHosts, new URL(url).host].join(
      ","
    ),
  });
  const legacyLogin = await fetch(`${url}/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.QA_API_TOKEN}` },
  });
  const legacyValue = legacyLogin.headers
    .get("set-cookie")!
    .split(";")[0]!
    .slice("qa_session=".length);
  const id = await canary.start("Local account setup and password login", {
    cookies: [
      {
        name: "qa_session",
        value: legacyValue,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
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
  ) => canary.act(id, label, compileAction(action, url, assertion));
  const fill = (label: string, selector: string, value: string) =>
    act(label, {
      type: "fill",
      locator: { by: "css", value: selector },
      value,
    });
  const click = (label: string, selector: string) =>
    act(label, { type: "click", locator: { by: "css", value: selector } });
  const assertText = (label: string, selector: string, expected: string) =>
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
    await act("setup-link", { type: "goto", path: `/#setup=${code}` });
    await assertText(
      "setup-title",
      "#authTitle",
      "Créez votre compte administrateur"
    );
    await fill("username", "#username", "ui-admin");
    await fill("password", "#password", "ui-password-long-2026");
    await fill("confirmation", "#confirmPassword", "ui-password-long-2026");
    await click("create-admin", "#accountSubmit");
    await assertText("admin-connected", "#connection", "ui-admin");
    expect(await new LocalAuth(queue.pool).status()).toEqual({
      initialized: true,
    });
    await click("logout", "#logout");
    await assertText("normal-login", "#authTitle", "Connectez-vous");
    await fill("login-name", "#username", "ui-admin");
    await fill("wrong-password", "#password", "incorrect-password-2026");
    await click("wrong-login", "#accountSubmit");
    await assertText(
      "login-error",
      "#error",
      "Identifiant ou mot de passe incorrect"
    );
    await fill("right-password", "#password", "ui-password-long-2026");
    await click("local-login", "#accountSubmit");
    await assertText("signed-in-again", "#connection", "ui-admin");
    await click("logout-again", "#logout");
    const mobile = await canary.act(
      id,
      "mobile-layout",
      `const page=await browser.getPage("qa"); await page.setViewportSize({width:390,height:844}); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)}));`
    );
    expect(mobile.actual).toBe(true);
    await canary.end(id, join(f.dataDir, "local-login-evidence"));
  } catch (error) {
    await canary.abort(id);
    throw error;
  }
}, 180_000);
it("creates and installs the GitHub App from the dashboard, selects a repository and publishes a Chromium QA run without a PAT", async () => {
  await dashboardDatabase();
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
async function dashboardDatabase() {
  const db = await PGlite.create();
  closers.push(() => db.close());
  const query = async (text: string, values?: unknown[]) => {
    if (!values && text.includes("CREATE TABLE")) {
      await db.exec(text);
      return { rows: [], rowCount: 0 };
    }
    const result = await db.query(text, values);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  };
  vi.spyOn(pg, "Pool").mockImplementation(
    class {
      query = query;
      connect = async () => ({ query, release: () => undefined });
      end = async () => undefined;
      on = () => undefined;
    } as unknown as typeof pg.Pool
  );
}
