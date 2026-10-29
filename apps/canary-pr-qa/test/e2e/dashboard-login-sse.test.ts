import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Canary, compileAction } from "../../src/canary.js";
import { startProductionServer } from "../../src/production-server.js";
import { Queue } from "../../src/queue.js";
import { saveReport } from "../../src/report.js";
import { fixture, PR_URL, plan, SHA } from "../fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

import { dashboardDatabase } from "./onboarding-helpers.js";

it("uses the actual dashboard in Chromium: login, project list, live SSE and cancellation", async () => {
  await dashboardDatabase(closers);
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
