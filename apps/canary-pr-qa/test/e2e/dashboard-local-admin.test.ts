import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Canary, compileAction } from "../../src/canary.js";
import { LocalAuth } from "../../src/local-auth.js";
import { startProductionServer } from "../../src/production-server.js";
import { Queue } from "../../src/queue.js";
import { fixture } from "../fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

import { dashboardDatabase } from "./onboarding-helpers.js";

it("creates a local admin and logs in/out with a password in real mobile Chromium", async () => {
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
