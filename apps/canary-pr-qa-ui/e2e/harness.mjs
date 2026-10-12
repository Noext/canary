/**
 * Shared world for the dashboard end-to-end suite.
 *
 * Playwright's global setup starts this file in its own Node process (see
 * `global-setup.ts`), which owns everything the specs talk to:
 *
 *  - the PR QA preview/model fixture (`@usecanary/pr-qa/test/fixture`), including
 *    the GitHub App protocol server that keeps every GitHub round-trip local;
 *  - PGlite behind the `pg.Pool` the server and the worker construct, the same
 *    database boundary the Vitest suite uses (no external PostgreSQL);
 *  - the real production server (`startProductionServer`) serving the built
 *    React dashboard, plus ONE real worker (`startWorker`) so a launched run is
 *    executed by Chromium and the fixture's model endpoint.
 *
 * It prints one `CANARY_E2E_READY <json>` line with the URLs, the fixture PR and
 * the credentials the specs use, then stays alive until the parent stops it.
 *
 * Node runs this file with tsx (`--import`) plus the `?ui` hook, because the
 * server source is TypeScript and imports its Vite build through that suffix.
 */
import { createRequire, register } from "node:module";

register(new URL("./ui-assets-hooks.mjs", import.meta.url));

/** `pg` and PGlite belong to the PR QA workspace: its store, its instances. */
const requireFromPrQa = createRequire(
  new URL("../../canary-pr-qa/package.json", import.meta.url)
);
const pg = requireFromPrQa("pg");
const { PGlite } = requireFromPrQa("@electric-sql/pglite");

const { githubSetupFixture } = await import(
  new URL("../../canary-pr-qa/test/github-setup-fixture.js", import.meta.url)
    .href
);
const { startProductionServer } = await import(
  new URL("../../canary-pr-qa/src/production-server.js", import.meta.url).href
);
const { Queue } = await import(
  new URL("../../canary-pr-qa/src/queue.js", import.meta.url).href
);
const { LocalAuth } = await import(
  new URL("../../canary-pr-qa/src/local-auth.js", import.meta.url).href
);
const { startWorker } = await import(
  new URL("../../canary-pr-qa/src/worker.js", import.meta.url).href
);
const { PR_URL } = await import(
  new URL("../../canary-pr-qa/test/fixture.js", import.meta.url).href
);

/** First administrator the login spec creates through the first-run screen. */
const username = "e2e-admin";
const password = "e2e-dashboard-password-2026";

/**
 * Both the server and the worker build their own `pg.Pool`; both must land on
 * the single in-process PGlite instance. Multi-statement DDL is executed with
 * `exec`, every other statement keeps its parameters.
 */
function installPoolMock(db) {
  const query = async (text, values) => {
    if (!values && text.includes("CREATE TABLE")) {
      await db.exec(text);
      return { rowCount: 0, rows: [] };
    }
    const result = await db.query(text, values);
    return {
      rowCount: result.affectedRows ?? result.rows.length,
      rows: result.rows,
    };
  };
  class HarnessPool {
    query = query;
    connect = async () => ({ query, release: () => undefined });
    end = async () => undefined;
    on = () => undefined;
  }
  pg.Pool = HarnessPool;
}

const ready = (value) =>
  process.stdout.write(`CANARY_E2E_READY ${JSON.stringify(value)}\n`);

const db = await PGlite.create();
installPoolMock(db);

const fixture = await githubSetupFixture();
// The App protocol server answers the manifest conversion and the installation
// sync; the preview server keeps the SHA proof and the plan/catalogue endpoints.
const config = {
  ...fixture.config,
  allowedRepos: ["fixture/app"],
  DATABASE_URL: "postgres://harness.invalid/qa",
  GITHUB_ALLOWED_REPOS: "fixture/app",
  GITHUB_TOKEN: "fixture-token",
  QA_PORT: 0,
};

const server = await startProductionServer(config);
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("The production server did not bind a TCP port");
}
const baseUrl = `http://127.0.0.1:${address.port}`;
// The App fixture sends the browser back to the dashboard after each GitHub
// round-trip; only the fixture knows where the dashboard answers.
fixture.state.dashboard = baseUrl;

const setupTicket = await new LocalAuth(
  new Queue(config.DATABASE_URL).pool
).issueSetupTicket();

const worker = new AbortController();
const workerDone = startWorker(config, worker);

let stopping = false;
async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  worker.abort(new Error("Dashboard e2e harness stopping"));
  await server.shutdown().catch(() => undefined);
  await fixture.close().catch(() => undefined);
  await db.close().catch(() => undefined);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
// An orphaned harness would keep the port and the worker alive: the parent's
// pipe closing is the signal that nobody is left to talk to.
process.stdin.on("end", () => void shutdown());
process.stdin.resume();
void workerDone.catch((error) => {
  process.stderr.write(`harness worker stopped: ${String(error)}\n`);
  void shutdown();
});

process.stderr.write(
  `harness: dashboard=${baseUrl} preview=${fixture.baseUrl} github=${fixture.api}\n`
);
ready({
  baseUrl,
  dataDir: fixture.dataDir,
  githubApiUrl: fixture.api,
  password,
  previewUrl: fixture.baseUrl,
  prUrl: PR_URL,
  setupTicket,
  username,
});
