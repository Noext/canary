import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Canary, compileAction } from "../../src/canary.js";
import { startProductionServer } from "../../src/production-server.js";
import { Queue } from "../../src/queue.js";
import { runQa } from "../../src/runner.js";
import { fixture, PR_URL, SHA } from "../fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

import { dashboardDatabase } from "./onboarding-helpers.js";

it("presents actual assertions and a playable video instead of raw JSON in the dashboard result", async () => {
  await dashboardDatabase(closers);
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
  const job = await queue.enqueue(
    "fixture/app",
    1,
    SHA,
    "admin",
    { prUrl: PR_URL },
    "human-result"
  );
  await queue.claim("worker");
  const result = await runQa(
    { id: job.id, prUrl: PR_URL, previewUrl: f.baseUrl, publish: true },
    config
  );
  expect(result.outcome).toBe("passed");
  await queue.complete(job.id, "worker", result.outcome);
  const login = await fetch(`${url}/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.QA_API_TOKEN}` },
  });
  const value = login.headers
    .get("set-cookie")!
    .split(";")[0]!
    .slice("qa_session=".length);
  const hosts = [...config.allowedHosts, new URL(url).host];
  const canary = new Canary({
    ...config,
    allowedHosts: hosts,
    PREVIEW_ALLOWED_HOSTS: hosts.join(","),
  });
  const session = await canary.start("Readable result and video", {
    cookies: [
      {
        name: "qa_session",
        value,
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
  try {
    await canary.act(
      session,
      "open-result",
      compileAction({ type: "goto", path: `/#${job.id}` }, url)
    );
    const summary = await canary.act(
      session,
      "human-summary",
      compileAction(
        {
          type: "assert",
          assertionId: "summary",
          locator: { by: "css", value: "#resultSummary" },
        },
        url,
        {
          id: "summary",
          description: "Readable result",
          kind: "text",
          expected: "Les assertions ont réussi",
          verification: "state",
        }
      )
    );
    expect(summary.actual).toContain("Les assertions ont réussi");
    const evidence = await canary.act(
      session,
      "result-mobile",
      `const page=await browser.getPage("qa"); await page.setViewportSize({width:390,height:844}); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:await page.evaluate(()=>({fits:document.documentElement.scrollWidth<=innerWidth,overflow:[...document.querySelectorAll("body *")].filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>({id:e.id,tag:e.tagName,right:e.getBoundingClientRect().right})).slice(0,8),css:getComputedStyle(document.body).margin,video:document.querySelector("#scenarioCards video")?.getAttribute("src"),diagnosticClosed:!document.querySelector("#detail details").open}))}));`
    );
    const shown = evidence.actual as {
      fits: boolean;
      video: string;
      diagnosticClosed: boolean;
    };
    expect(shown.fits, JSON.stringify(shown)).toBe(true);
    expect(shown.diagnosticClosed).toBe(true);
    expect(shown.video).toContain(".webm");
    const video = await fetch(url + shown.video, {
      headers: { Authorization: `Bearer ${config.QA_API_TOKEN}` },
    });
    expect(video.ok).toBe(true);
    expect((await video.arrayBuffer()).byteLength).toBeGreaterThan(0);
    await canary.end(session, join(f.dataDir, "human-dashboard-evidence"));
  } catch (error) {
    await canary.abort(session);
    throw error;
  }
}, 180_000);
it("explains a blocked run and an expired automatic attempt on their own deep links", async () => {
  await dashboardDatabase(closers);
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
  // The preview answers, but never publishes the pinned SHA: the run is blocked
  // and its report must name that cause instead of a generic failure.
  const job = await queue.enqueue(
    "fixture/app",
    1,
    SHA,
    "admin",
    { prUrl: PR_URL },
    "explained-run"
  );
  await queue.claim("worker");
  const blocked = await runQa(
    { id: job.id, prUrl: PR_URL, previewUrl: f.baseUrl, publish: false },
    { ...config, PREVIEW_SHA_HEADER: "x-absent" }
  );
  expect(blocked.outcome, blocked.error).toBe("blocked");
  expect(blocked.diagnostic?.code).toBe("PREVIEW_SHA_MISMATCH");
  await queue.complete(job.id, "worker", blocked.outcome);
  // An attempt that waited out its whole window: the two audit steps are what
  // the screen has to explain.
  await queue.pool.query(
    `INSERT INTO qa_deliveries(id,event,payload,status,attempts,reason,deadline_at,updated_at)
     VALUES($1,'pull_request',$2::jsonb,'expired',3,'PREVIEW_NOT_FOUND',now(),now())`,
    [
      "e2e-attempt",
      JSON.stringify({
        number: 1,
        prUrl: PR_URL,
        repo: "fixture/app",
        sha: SHA,
      }),
    ]
  );
  await queue.audit("webhook", "automatic.preview_wait", undefined, {
    backoffSeconds: 30,
    delivery: "e2e-attempt",
    pr: 1,
    reason: "PREVIEW_NOT_FOUND",
    repo: "fixture/app",
    sha: SHA,
  });
  await queue.audit("webhook", "automatic.preview_expired", undefined, {
    attempts: 3,
    delivery: "e2e-attempt",
    pr: 1,
    repo: "fixture/app",
    sha: SHA,
  });
  const login = await fetch(`${url}/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.QA_API_TOKEN}` },
  });
  const value = login.headers
    .get("set-cookie")!
    .split(";")[0]!
    .slice("qa_session=".length);
  const hosts = [...config.allowedHosts, new URL(url).host];
  const canary = new Canary({
    ...config,
    allowedHosts: hosts,
    PREVIEW_ALLOWED_HOSTS: hosts.join(","),
  });
  const session = await canary.start("Explain a failed run", {
    cookies: [
      {
        name: "qa_session",
        value,
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
  ) => canary.act(session, label, compileAction(action, url, assertion));
  // One observation per screen: the accessible text of the document, which is
  // what the operator reads and what the assertions below pin.
  const observed = async (label: string) => {
    const step = await canary.act(
      session,
      label,
      `const page=await browser.getPage("qa"); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    // `url` is the observation's own field; the innerText travels in `actual`.
    return { text: String(step.actual ?? ""), url: step.url };
  };
  try {
    await act("blocked-run-report", {
      type: "goto",
      path: `/history/${job.id}/report`,
    });
    const runScreen = await observed("blocked-run-detail");
    // The report has its own page: the operator reloads the address they are
    // reading, so the server serves that path instead of falling back home.
    expect(new URL(runScreen.url).pathname).toBe(`/history/${job.id}/report`);
    expect(new URL(runScreen.url).hash).toBe("");
    expect(runScreen.text).toContain("Détail du test");
    // The cause the operator could not see before: the server diagnostic, its
    // next step, and the phase the run stopped in.
    expect(runScreen.text).toContain("Pourquoi ce test n’est pas allé au bout");
    expect(runScreen.text).toContain("PREVIEW_SHA_MISMATCH");
    // The known code is explained from the French catalogue, not with the raw
    // English message the server wrote into the report.
    expect(runScreen.text).toContain(
      "L’application de test répond, mais elle n’annonce pas le commit de cette PR"
    );
    expect(runScreen.text).toContain("À faire :");
    expect(runScreen.text).not.toContain("Preview SHA mismatch");
    // What the operator actually does with that link: reload it.
    const reloadedRun = await canary.act(
      session,
      "run-link-survives-a-reload",
      `const page=await browser.getPage("qa"); await page.waitForSelector("#runScreen",{timeout:15000}); await page.reload({waitUntil:"domcontentloaded",timeout:15000}); await page.waitForSelector("#runDiagnostic",{timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(new URL(reloadedRun.url).pathname).toBe(`/history/${job.id}/report`);
    expect(String(reloadedRun.actual)).toContain(
      "Pourquoi ce test n’est pas allé au bout"
    );
    // The one fragment left in this file: a link cited before the screens had
    // paths, `#run=<uuid>`, opens the same report and the load rewrites the
    // address bar onto that page.
    await act("legacy-run-fragment-link", {
      type: "goto",
      path: `/#run=${job.id}`,
    });
    const legacyRun = await observed("legacy-run-fragment-opened-report");
    expect(legacyRun.text).toContain("Détail du test");
    expect(new URL(legacyRun.url).pathname).toBe(`/history/${job.id}/report`);
    expect(new URL(legacyRun.url).hash).toBe("");
    await act("back-to-history", {
      type: "click",
      locator: { by: "css", value: "#runScreenBack" },
    });
    const history = await observed("history-after-back");
    expect(history.text).toContain("Vos tests");
    // The list has its own address: it is the link the operator reloads or
    // shares, so the server has to serve the document on that path, and Retour
    // must have left the report's page behind.
    expect(new URL(history.url).pathname).toBe("/history");
    expect(new URL(history.url).hash).toBe("");
    const reloadedHistory = await canary.act(
      session,
      "history-list-survives-a-reload",
      `const page=await browser.getPage("qa"); await page.reload({waitUntil:"domcontentloaded",timeout:15000}); await page.waitForSelector("#historyTable",{timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(new URL(reloadedHistory.url).pathname).toBe("/history");
    // Retour must restore the list, not only move the address: selecting a run
    // pushes its own page, `/history/<uuid>`, so the entry the browser restores
    // is a document the dashboard serves.
    await act("select-run-in-history", {
      type: "click",
      locator: { by: "css", value: "#runs tr:first-child a" },
    });
    const selectedRun = await canary.act(
      session,
      "history-run-selected",
      `const page=await browser.getPage("qa"); await page.waitForSelector("#detail",{state:"visible",timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(new URL(selectedRun.url).pathname).toMatch(
      /^\/history\/[0-9a-f-]{36}$/
    );
    expect(new URL(selectedRun.url).hash).toBe("");
    const backToHistory = await canary.act(
      session,
      "back-to-the-history-list",
      `const page=await browser.getPage("qa"); await page.goBack({waitUntil:"domcontentloaded",timeout:15000}); await page.waitForSelector("#detail",{state:"hidden",timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(new URL(backToHistory.url).pathname).toBe("/history");
    // Same for the page that starts a test: its address is a path too, and a
    // reload is served by the dashboard instead of answering 404.
    await act("open-new-test", {
      type: "click",
      locator: { by: "css", value: "#nav-new" },
    });
    const newTest = await observed("new-test-address");
    expect(new URL(newTest.url).pathname).toBe("/new-test");
    const reloadedNewTest = await canary.act(
      session,
      "new-test-page-survives-a-reload",
      `const page=await browser.getPage("qa"); await page.reload({waitUntil:"domcontentloaded",timeout:15000}); await page.waitForSelector("#runForm",{timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(new URL(reloadedNewTest.url).pathname).toBe("/new-test");
    expect(String(reloadedNewTest.actual)).toContain("Vérifier les accès");
    // Reach the home panel on a fresh document: the dashboard reads the address
    // of a screen once at load and does not act on a same-document change.
    await act("fresh-document", { type: "goto", path: "/?reload=1" });
    // The failure is actionable where the operator first meets it: the home
    // block offers the same retry as the detail screen, on the same attempt.
    const home = await canary.act(
      session,
      "home-lists-a-retryable-failure",
      `const page=await browser.getPage("qa"); await page.waitForSelector(${JSON.stringify("#automaticRetry-e2e-attempt")},{timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(String(home.actual)).toContain("Relancer la vérification");
    expect(String(home.actual)).toContain("Délai dépassé");
    await act("expired-attempt-link", {
      type: "goto",
      path: "/automatic/e2e-attempt",
    });
    const attempt = await observed("expired-attempt-detail");
    expect(new URL(attempt.url).pathname).toBe("/automatic/e2e-attempt");
    expect(attempt.text).toContain("Lancements automatiques");
    expect(attempt.text).toContain("Pourquoi Canary n’a pas démarré le test");
    expect(attempt.text).toContain(
      "Canary n’a trouvé aucune application de test pour ce commit"
    );
    expect(attempt.text).toContain(
      "Renseignez le modèle d’URL de votre application de test"
    );
    expect(attempt.text).toContain("3 vérifications effectuées");
    // The two audit steps are the trail that explains the wait.
    expect(attempt.text).toContain(
      "Application de test absente ou sans la bonne version"
    );
    expect(attempt.text).toContain("Délai d’attente dépassé");
    // Deployment topology is administrator-only, but this session is admin.
    expect(attempt.text).toContain("Preuve de version exigée");
    // The link the operator shares is the one they reload: both the screen and
    // its address have to come back, not the home panel.
    const reloadedAttempt = await canary.act(
      session,
      "automatic-link-survives-a-reload",
      `const page=await browser.getPage("qa"); await page.reload({waitUntil:"domcontentloaded",timeout:15000}); await page.waitForSelector("#automaticDetailCause",{timeout:15000}); const text=await page.evaluate(()=>document.body.innerText); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:text}));`
    );
    expect(new URL(reloadedAttempt.url).pathname).toBe(
      "/automatic/e2e-attempt"
    );
    expect(String(reloadedAttempt.actual)).toContain("Délai d’attente dépassé");
    // An expired attempt is not a dead end any more: the screen the operator is
    // already reading re-arms it, on the same commit, with a fresh window. The
    // assertion polls the state pill, so the click's write is what is measured.
    await act("retry-expired-attempt", {
      type: "click",
      locator: { by: "css", value: "#automaticDetailRetry" },
    });
    await act(
      "retried-attempt-waiting",
      {
        type: "assert",
        assertionId: "retry-waiting",
        locator: { by: "css", value: "#automaticDetailPill" },
      },
      {
        id: "retry-waiting",
        description: "En attente de la préversion",
        kind: "text",
        expected: "En attente de la préversion",
        verification: "state",
      }
    );
    const rearmed = await observed("retried-attempt-detail");
    expect(rearmed.text).toContain("Relancé depuis le tableau de bord");
    // Nothing stopped it any more: the screen must not keep explaining a cause
    // and an advice for an attempt that is waiting again with no reason yet.
    expect(rearmed.text).not.toContain(
      "Pourquoi Canary n’a pas démarré le test"
    );
    expect(rearmed.text).not.toContain("Ce qu’il reste à faire");
    // The row itself is what was re-armed: due again, with its history kept as
    // the attempt's audit trail rather than as a probe count.
    const row = (
      await queue.pool.query(
        "SELECT status,attempts,reason FROM qa_deliveries WHERE id='e2e-attempt'"
      )
    ).rows[0];
    expect(row).toEqual({ attempts: 0, reason: null, status: "pending" });
    await canary.end(session, join(f.dataDir, "failed-run-evidence"));
  } catch (error) {
    await canary.abort(session);
    throw error;
  }
}, 180_000);
