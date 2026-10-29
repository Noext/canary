import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Canary, compileAction } from "../../src/canary.js";
import { GitHubSetup } from "../../src/github-setup.js";
import { LocalAuth } from "../../src/local-auth.js";
import { startProductionServer } from "../../src/production-server.js";
import { Queue } from "../../src/queue.js";
import { fixture, PR_URL, SHA } from "../fixture.js";
import { githubSetupFixture } from "../github-setup-fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

import { dashboardDatabase } from "./onboarding-helpers.js";

it("clears a failed automatic attempt from the list once the confirmation is answered", async () => {
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
  // Two failures of the same repository: only the one the operator confirms may
  // leave the list, so the assertion below cannot pass on an empty list.
  await queue.pool.query(
    `INSERT INTO qa_deliveries(id,event,payload,status,attempts,reason,deadline_at,updated_at)
     SELECT id,'pull_request',$1::jsonb||jsonb_build_object('number',number),'expired',3,'PREVIEW_NOT_FOUND',now(),now()
     FROM (VALUES('delete-me',1),('keep-me',2)) AS rows(id,number)`,
    [JSON.stringify({ prUrl: PR_URL, repo: "fixture/app", sha: SHA })]
  );
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
  const session = await canary.start("Delete a failed automatic attempt", {
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
  try {
    await act("open-home", { type: "goto", path: "/" });
    // The row offers the two actions of a failure: re-arm it, or clear it.
    await act(
      "delete-offered",
      {
        type: "assert",
        assertionId: "delete-offered",
        locator: { by: "css", value: "#automaticDelete-delete-me" },
      },
      {
        id: "delete-offered",
        description: "La tentative en échec propose sa suppression",
        kind: "visible",
        verification: "state",
      }
    );
    await act("delete-click", {
      type: "click",
      locator: { by: "css", value: "#automaticDelete-delete-me" },
    });
    // The first click only asks: the failure is still listed until it is
    // answered, and the two answers are both on screen.
    await act(
      "confirmation-asked",
      {
        type: "assert",
        assertionId: "confirmation-asked",
        locator: {
          by: "css",
          value: "#automaticDelete-delete-me-question-text",
        },
      },
      {
        id: "confirmation-asked",
        description: "Supprimer cette tentative en échec ?",
        expected: "Supprimer cette tentative en échec ?",
        kind: "text",
        verification: "state",
      }
    );
    expect(
      (await queue.delivery("delete-me", 1800))?.status,
      "the question deletes nothing"
    ).toBe("expired");
    await act("cancel-click", {
      type: "click",
      locator: { by: "css", value: "#automaticDelete-delete-me-cancel" },
    });
    await act(
      "cancel-keeps-the-attempt",
      {
        type: "assert",
        assertionId: "cancel-keeps-the-attempt",
        locator: { by: "css", value: "#automaticDelete-delete-me" },
      },
      {
        id: "cancel-keeps-the-attempt",
        description: "Annuler laisse la tentative en place",
        kind: "visible",
        verification: "state",
      }
    );
    expect(
      (await queue.delivery("delete-me", 1800))?.status,
      "cancel deletes nothing"
    ).toBe("expired");
    // The same two clicks, answered this time.
    await act("delete-again", {
      type: "click",
      locator: { by: "css", value: "#automaticDelete-delete-me" },
    });
    await act("confirm-click", {
      type: "click",
      locator: { by: "css", value: "#automaticDelete-delete-me-confirm" },
    });
    await act(
      "deleted-attempt-gone",
      {
        type: "assert",
        assertionId: "deleted-attempt-gone",
        locator: { by: "css", value: "#automaticDelete-delete-me" },
      },
      {
        id: "deleted-attempt-gone",
        description: "La tentative supprimée a quitté la liste",
        kind: "hidden",
        verification: "state",
      }
    );
    // The failure the operator did not touch is still there, and the count the
    // block displays followed the deletion.
    await act(
      "other-attempt-kept",
      {
        type: "assert",
        assertionId: "other-attempt-kept",
        locator: { by: "css", value: "#automaticDelete-keep-me" },
      },
      {
        id: "other-attempt-kept",
        description: "L'autre tentative reste listée",
        kind: "visible",
        verification: "state",
      }
    );
    await act(
      "summary-followed",
      {
        type: "assert",
        assertionId: "summary-followed",
        locator: { by: "css", value: "#automaticSummary" },
      },
      {
        id: "summary-followed",
        description: "1 délai(s) dépassé(s)",
        expected: "1 délai(s) dépassé(s)",
        kind: "text",
        verification: "state",
      }
    );
    // No read reports the row any more, and the audit trail says who cleared it.
    expect(await queue.delivery("delete-me", 1800)).toBeUndefined();
    expect(await queue.delivery("keep-me", 1800)).toMatchObject({
      status: "expired",
    });
    // The row itself stayed, as a tombstone: it is what keeps GitHub from having
    // the same delivery accepted again — and probed, and turned into a run — once
    // an operator has cleared it.
    const tombstone = (
      await queue.pool.query<{ status: string }>(
        "SELECT status FROM qa_deliveries WHERE id='delete-me'"
      )
    ).rows[0];
    expect(tombstone).toEqual({ status: "deleted" });
    expect(
      await queue.acceptDelivery("delete-me", "pull_request", {
        number: 1,
        prUrl: PR_URL,
        repo: "fixture/app",
        sha: SHA,
      })
    ).toBe(false);
    const audit = await queue.pool.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM qa_audit WHERE action='automatic.deleted'"
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.details).toMatchObject({
      attempts: 3,
      delivery: "delete-me",
      pr: 1,
      repo: "fixture/app",
      sha: SHA,
    });
    await canary.end(session, join(f.dataDir, "deleted-attempt-evidence"));
  } catch (error) {
    await canary.abort(session);
    throw error;
  }
}, 180_000);
it("removes the connected GitHub App from the dashboard only after an explicit confirmation", async () => {
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
  const queue = new Queue(config.DATABASE_URL);
  const accounts = new LocalAuth(queue.pool);
  const user = await accounts.setup(
    {
      username: "ui-github-remover",
      password: "ui-github-remover-2026",
      setupCode: await accounts.issueSetupTicket(),
    },
    []
  );
  const token = await accounts.session(user);
  // Connect the App through the same server-side flow the onboarding uses.
  const setup = new GitHubSetup(queue.pool, config);
  await setup.convert(
    user.id,
    await setup.state(user.id, "manifest"),
    "fixture-manifest-code"
  );
  await setup.select(["fixture/app"]);
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
  const id = await canary.start("GitHub App dashboard removal", {
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
  ) => canary.act(id, label, compileAction(action, url, assertion));
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
    await act("dashboard", { type: "goto", path: "/" });
    await click("open-github-settings", "#nav-settings");
    await assertText("connected", "#githubConnection", "Connecté");
    await click("open-danger-zone", "#githubDanger > summary");
    // A cancelled confirmation must leave GitHub and the local connection alone.
    await click("ask-disconnect", "#githubUninstall");
    await assertText(
      "confirmation-visible",
      "#githubConfirmText",
      "Désinstaller l'App GitHub"
    );
    await click("cancel-disconnect", "#githubConfirmCancel");
    await assertText("still-connected", "#githubConnection", "Connecté");
    expect(f.state.uninstalls).toBe(0);
    expect((await setup.status()).app?.id).toBe("95001");
    // Confirming uninstalls the App on GitHub and wipes the local connection.
    await click("ask-disconnect-again", "#githubUninstall");
    await click("confirm-disconnect", "#githubConfirmRun");
    await assertText("disconnected", "#githubConnection", "À connecter");
    // A refused remote deletion must not be reported as a successful removal.
    await setup.convert(
      user.id,
      await setup.state(user.id, "manifest"),
      "fixture-manifest-code"
    );
    f.state.installed = true;
    await setup.select(["fixture/app"]);
    f.state.deleteFails = true;
    await act("dashboard-reconnected", { type: "goto", path: "/" });
    await click("open-github-settings-again", "#nav-settings");
    await assertText("connected-again", "#githubConnection", "Connecté");
    await click("open-danger-zone-again", "#githubDanger > summary");
    await click("ask-second-removal", "#githubUninstall");
    await click("confirm-second-removal", "#githubConfirmRun");
    await assertText(
      "refused-notice",
      "#githubNotice",
      "Connexion locale effacée"
    );
    const refused = await canary.act(
      id,
      "refused-message-text",
      `const page=await browser.getPage("qa"); console.log("CANARY_PR_QA_OBSERVATION:"+JSON.stringify({url:page.url(),snapshot:(await page.snapshotForAI()).full,actual:await page.evaluate(()=>document.getElementById("githubNotice").textContent)}));`
    );
    expect(String(refused.actual)).toContain("a échoué");
    expect(String(refused.actual)).not.toContain(
      "App désinstallée sur GitHub."
    );
    await canary.end(id, join(f.dataDir, "github-removal-evidence"));
  } catch (error) {
    await canary.abort(id);
    throw error;
  }
  expect(f.state.uninstalls).toBe(1);
  expect((await setup.status()).app).toBeNull();
  expect((await setup.status()).repositories).toEqual([]);
  const effective = await new GitHubSetup(queue.pool, config).effective();
  expect(effective.githubInstallations).toBeUndefined();
  expect(effective.allowedRepos).toEqual([]);
}, 180_000);
