import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Canary, compileAction } from "../src/canary.js";
import { doctor } from "../src/doctor.js";
import { executeScenario } from "../src/executor.js";
import { LocalAuth } from "../src/local-auth.js";
import { Model } from "../src/model.js";
import { startProductionServer } from "../src/production-server.js";
import { Queue } from "../src/queue.js";
import { saveReport } from "../src/report.js";
import { runQa } from "../src/runner.js";
import { fixture, PR_URL, plan, SHA } from "./fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});
describe("real Canary Chromium with GitHub/AI REST fixtures", () => {
  it("runs the installation doctor through actual Chromium, REST/model and SHA probes without publishing", async () => {
    const f = await fixture();
    closers.push(f.close);
    const result = await doctor(f.config, {
      prUrl: PR_URL,
      previewUrl: f.baseUrl,
    });
    expect(result.healthy, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.filter((check) => check.status !== "passed")).toEqual(
      []
    );
    expect(f.outgoing).toEqual([]);
    expect(await readdir(join(f.dataDir, "_doctor"))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(f.config.GITHUB_TOKEN);
  }, 180_000);
  it("plays the form test, records video/trace/screenshots and publishes passed results", async () => {
    const f = await fixture({ unnamedStatus: true });
    closers.push(f.close);
    const result = await runQa(
      {
        prUrl: PR_URL,
        previewUrl: f.baseUrl,
        model: "fixture-alternate-model",
      },
      f.config
    );
    expect(result.model).toBe("fixture-alternate-model");
    expect(
      f.modelRequests.every(
        (request) => request.model === "fixture-alternate-model"
      )
    ).toBe(true);
    expect(result.outcome, result.error ?? result.scenarios[0]?.error).toBe(
      "passed"
    );
    expect(result.sha).toBe(SHA);
    const scenario = result.scenarios[0]!;
    expect(scenario.assertions).toEqual([
      { id: "saved", passed: true, actual: "Welcome Ada", baseline: "" },
    ]);
    expect(scenario.steps.map((step) => step.action.type)).toEqual([
      "fill",
      "click",
      "assert",
    ]);
    for (const extension of [".webm", ".zip", ".png", ".har"]) {
      const file = scenario.artifacts.find((path) => path.endsWith(extension));
      expect(file, `missing ${extension}`).toBeDefined();
      expect(
        (await stat(join(f.dataDir, result.id, "welcome", file!))).size
      ).toBeGreaterThan(0);
    }
    expect(
      f.outgoing.map((request) => request.payload.state).filter(Boolean)
    ).toEqual(["pending", "success"]);
    expect(
      f.outgoing.find((request) => request.path.endsWith("/comments"))?.payload
        .body
    ).toContain("PASSED");
    const html = await readFile(
      join(f.dataDir, result.id, "report.html"),
      "utf8"
    );
    expect(html).toContain("<video controls");
    expect(html).not.toContain("fixture-token");
    process.stdout.write(
      `E2E passed report: ${join(f.dataDir, result.id, "report.html")}\n`
    );
  }, 180_000);
  it("detects an actual UI regression and publishes failure with the recorded video", async () => {
    const f = await fixture({ broken: true });
    closers.push(f.close);
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome, result.error ?? result.scenarios[0]?.error).toBe(
      "failed"
    );
    expect(result.scenarios[0]?.assertions).toEqual([
      { id: "saved", passed: false, actual: "Wrong output", baseline: "" },
    ]);
    expect(
      f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
        .state
    ).toBe("failure");
    expect(
      result.scenarios[0]?.artifacts.some((file) => file.endsWith(".webm"))
    ).toBe(true);
    process.stdout.write(
      `E2E failed-case report: ${join(f.dataDir, result.id, "report.html")}\n`
    );
  }, 180_000);
  it.skipIf(!process.env.CANARY_DAEMON_PORT)(
    "rejects an unauthorized request on the actual loopback daemon",
    async () => {
      await new Promise<void>((done, reject) => {
        const socket = net.connect({
          host: "127.0.0.1",
          port: Number(process.env.CANARY_DAEMON_PORT),
        });
        let output = "";
        socket.setTimeout(3000, () => {
          socket.destroy();
          reject(new Error("Authentication test timed out"));
        });
        socket.on("connect", () =>
          socket.write(
            `${JSON.stringify({
              id: "unauthorized",
              type: "status",
              transportToken: "wrong-token",
            })}\n`
          )
        );
        socket.on("data", (data) => {
          output += data.toString();
        });
        socket.on("error", reject);
        socket.on("close", () => {
          if (output) {
            reject(new Error("Unauthenticated daemon returned data"));
          } else {
            done();
          }
        });
      });
    }
  );
});

it("rejects static matching output as transition evidence in actual Chromium", async () => {
  const f = await fixture({ unchangedState: true });
  closers.push(f.close);
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(result.outcome, result.scenarios[0]?.error).toBe("failed");
  expect(result.scenarios[0]?.assertions[0]).toMatchObject({
    baseline: "Welcome Ada",
    actual: "Welcome Ada",
    passed: false,
  });
  const differentName = structuredClone(plan.scenarios[0]!);
  differentName.id = "unchanged-grace";
  const enter = differentName.steps[0]!.action;
  if (enter.type !== "fill") {
    throw new Error("Expected form input");
  }
  enter.value = "Grace";
  const assertion = differentName.assertions[0]!;
  if (assertion.kind !== "text") {
    throw new Error("Expected text assertion");
  }
  assertion.expected = "Welcome Grace";
  const alternate = await executeScenario(
    differentName,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config),
    new Model(f.config)
  );
  expect(alternate.outcome, alternate.error).toBe("failed");
  expect(alternate.assertions[0]).toMatchObject({
    baseline: "Welcome Ada",
    actual: "Welcome Ada",
    passed: false,
  });
}, 180_000);
it("checks persistence after real reload and fails a missing storage write", async () => {
  for (const broken of [false, true]) {
    const f = await fixture({ persistent: true, persistenceBroken: broken });
    closers.push(f.close);
    const scenario = structuredClone(plan.scenarios[0]!);
    scenario.assertions[0]!.verification = "persisted";
    const result = await executeScenario(
      scenario,
      f.baseUrl,
      f.dataDir,
      f.config,
      new Canary(f.config),
      new Model(f.config)
    );
    expect(result.outcome, result.error).toBe(broken ? "failed" : "passed");
    expect(result.assertions[0]?.persisted).toBe(broken ? "" : "Welcome Ada");
  }
}, 180_000);
it("blocks actual page subrequests outside the approved host and port", async () => {
  let hits = 0;
  const sink = createServer((_req, res) => {
    hits++;
    res.end("not allowed");
  });
  await new Promise<void>((done) => sink.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise<void>((done) => sink.close(() => done())));
  const address = sink.address() as { port: number };
  const f = await fixture({
    maliciousUrl: `http://127.0.0.1:${address.port}/probe`,
  });
  closers.push(f.close);
  const canary = new Canary(f.config);
  const id = await canary.start("Network isolation probe");
  try {
    await canary.act(
      id,
      "open",
      compileAction({ type: "goto", path: f.baseUrl }, f.baseUrl)
    );
    await canary.act(
      id,
      "observe",
      compileAction({ type: "observe" }, f.baseUrl)
    );
    expect(hits).toBe(0);
    await canary.end(id, join(f.dataDir, "network"));
  } finally {
    await canary.abort(id);
  }
}, 180_000);
it("installs trusted role cookies before navigation, with no secrets sent to the model", async () => {
  const f = await fixture({ requireCookie: true });
  closers.push(f.close);
  const file = join(f.dataDir, "fixtures.json");
  await writeFile(
    file,
    JSON.stringify({ "fixture/app": { roles: { member: "QA_E2E_ROLE" } } })
  );
  vi.stubEnv(
    "QA_E2E_ROLE",
    JSON.stringify({
      cookies: [
        {
          name: "qa_role",
          value: "test-member-secret",
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
          expires: -1,
        },
      ],
      origins: [],
    })
  );
  const config = { ...f.config, QA_FIXTURES_FILE: file };
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.preconditions = ["role:member"];
  try {
    const result = await executeScenario(
      scenario,
      f.baseUrl,
      f.dataDir,
      config,
      new Canary(config),
      new Model(config),
      undefined,
      "fixture/app"
    );
    expect(result.outcome, result.error).toBe("passed");
    expect(JSON.stringify(f.modelRequests)).not.toContain("test-member-secret");
  } finally {
    vi.unstubAllEnvs();
  }
}, 180_000);
it("verifies real download and popup events through the immutable scenario contract", async () => {
  const f = await fixture();
  closers.push(f.close);
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.id = "browser-events";
  scenario.steps = [
    {
      id: "open",
      description: "Open the preview",
      action: { type: "goto", path: "/" },
    },
    {
      id: "download",
      description: "Download the report",
      action: {
        type: "download",
        locator: { by: "role", value: "link", name: "Download report" },
        assertionId: "downloaded",
      },
    },
    {
      id: "popup",
      description: "Open popup",
      action: {
        type: "popup",
        locator: { by: "role", value: "link", name: "Open popup" },
        assertionId: "opened",
      },
    },
  ];
  scenario.assertions = [
    {
      id: "downloaded",
      description: "Correct file downloaded",
      kind: "download",
      expected: "report.txt",
      afterStep: "open",
      verification: "state",
    },
    {
      id: "opened",
      description: "Correct popup opened",
      kind: "popup",
      expected: `${f.baseUrl}/popup`,
      afterStep: "open",
      verification: "state",
    },
  ];
  const result = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config),
    new Model(f.config)
  );
  expect(result.outcome, result.error).toBe("passed");
  expect(result.assertions.map((a) => a.actual)).toEqual([
    "report.txt",
    `${f.baseUrl}/popup`,
  ]);
}, 180_000);
it("compares real screenshots with a trusted baseline and rejects a changed image", async () => {
  const f = await fixture();
  closers.push(f.close);
  const canary = new Canary(f.config);
  const id = await canary.start("Trusted visual test oracle");
  let image: string;
  const assertion = {
    id: "visual",
    description: "Heading appearance",
    kind: "visual" as const,
    expected: "heading",
    target: { by: "css" as const, value: "h1" },
    afterStep: "open",
    verification: "state" as const,
  };
  try {
    await canary.act(
      id,
      "open",
      compileAction({ type: "goto", path: "/" }, f.baseUrl)
    );
    image = (
      await canary.act(
        id,
        "capture",
        compileAction(
          { type: "assert", assertionId: "visual", locator: assertion.target },
          f.baseUrl,
          assertion
        )
      )
    ).actual as string;
    await canary.end(id, join(f.dataDir, "visual-oracle"));
  } finally {
    await canary.abort(id);
  }
  const baseline = join(f.dataDir, "baseline.png");
  await writeFile(baseline, Buffer.from(image!, "base64"));
  const fixturesFile = join(f.dataDir, "visual-fixtures.json");
  await writeFile(
    fixturesFile,
    JSON.stringify({ "fixture/app": { visuals: { heading: baseline } } })
  );
  const config = { ...f.config, QA_FIXTURES_FILE: fixturesFile };
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.id = "visual-heading";
  scenario.steps = [
    {
      id: "open",
      description: "Open preview",
      action: { type: "goto", path: "/" },
    },
    {
      id: "verify",
      description: "Compare appearance",
      action: { type: "assert", assertionId: "visual" },
    },
  ];
  scenario.assertions = [assertion];
  const healthy = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    config,
    new Canary(config),
    new Model(config),
    undefined,
    "fixture/app"
  );
  expect(healthy.outcome, healthy.error).toBe("passed");
  const { PNG } = await import("pngjs");
  const changed = PNG.sync.read(Buffer.from(image!, "base64"));
  changed.data.fill(255);
  await writeFile(baseline, PNG.sync.write(changed));
  const broken = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    config,
    new Canary(config),
    new Model(config),
    undefined,
    "fixture/app"
  );
  expect(broken.outcome, broken.error).toBe("failed");
}, 180_000);

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
    await act("open-run", {
      type: "click",
      locator: { by: "role", value: "link", name: "fixture/app #1" },
    });
    const stream = await act(
      "live",
      {
        type: "assert",
        assertionId: "live",
        locator: { by: "css", value: "#connection" },
      },
      {
        id: "live",
        description: "SSE connected",
        kind: "text",
        expected: "Flux live connecté",
        verification: "state",
        afterStep: "open",
      }
    );
    expect(stream.actual).toBe("Flux live connecté");
    await queue.claim("dashboard-worker");
    const running = await act(
      "running",
      {
        type: "assert",
        assertionId: "running",
        locator: { by: "css", value: "#provenance" },
      },
      {
        id: "running",
        description: "Running update delivered",
        kind: "text",
        expected: "running",
        verification: "state",
        afterStep: "open",
      }
    );
    expect(running.actual).toContain("running");
    await act("cancel", {
      type: "click",
      locator: { by: "role", value: "button", name: "Annuler" },
    });
    for (
      let i = 0;
      i < 20 && !(await queue.get(job.id))?.cancel_requested;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await queue.get(job.id))?.cancel_requested).toBe(true);
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
