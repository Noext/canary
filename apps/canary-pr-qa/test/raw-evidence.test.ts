import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { startProductionServer } from "../src/production-server.js";
import { fixture, PR_URL, pgliteQueue, SHA } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

/**
 * Un serveur de production avec un run terminé et les preuves qu'un scénario
 * laisse sur disque : rapport, dumps bruts et trace.
 */
async function evidenceServer(extra: Partial<Config> = {}) {
  const q = await pgliteQueue(cleanup);
  const f = await fixture();
  cleanup.push(f.close);
  const server = await startProductionServer({
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
    ...extra,
  });
  cleanup.push(() => server.shutdown());
  const queued = await q.enqueue(
    "fixture/app",
    7,
    SHA,
    "alice",
    { prUrl: PR_URL },
    "fixture"
  );
  const worker = "raw-evidence-fixture";
  await q.claim(worker);
  await q.complete(queued.id, worker, "passed");
  const dir = join(f.dataDir, queued.id, "welcome");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.html"), "<!doctype html><h1>report</h1>");
  await writeFile(join(dir, "console.log"), "[info] ready\n");
  await writeFile(join(dir, "network.har"), JSON.stringify({ log: {} }));
  await writeFile(join(dir, "results.json"), JSON.stringify({ id: queued.id }));
  await writeFile(join(dir, "trace.zip"), Buffer.alloc(32));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    q,
    read: (path: string) =>
      fetch(`${url}/artifacts/${queued.id}/${path}`, {
        headers: { Authorization: `Bearer ${f.config.QA_API_TOKEN}` },
      }),
  };
}

it("keeps the raw evidence policy identical on the HTTP route and the MCP tools", async () => {
  const closed = await evidenceServer();
  // Le rapport est la sortie du service, pas un dump : il passe sans réglage.
  expect((await closed.read("welcome/report.html")).status).toBe(200);
  for (const path of [
    "welcome/console.log",
    "welcome/network.har",
    "welcome/results.json",
    "welcome/trace.zip",
  ]) {
    const refused = await closed.read(path);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: "Raw evidence disabled by data policy",
    });
  }
  // Une seule lecture a été servie — le rapport ; les quatre refus n'ont rien
  // ajouté au journal.
  const refusedAudits = await closed.q.pool.query(
    "SELECT details FROM qa_audit WHERE action='artifact.read' ORDER BY id"
  );
  expect(
    refusedAudits.rows.map(
      (row) => (row as { details: { path: string } }).details.path
    )
  ).toEqual(["welcome/report.html"]);
  const opened = await evidenceServer({ QA_RAW_EVIDENCE: "true" });
  expect((await opened.read("welcome/network.har")).status).toBe(200);
  expect((await opened.read("welcome/report.html")).status).toBe(200);
  // Toute lecture servie est auditée, y compris celle qui n'avait pas besoin du
  // réglage : l'audit suit le succès, pas le seul cas ouvert.
  const reads = await opened.q.pool.query(
    "SELECT details FROM qa_audit WHERE action='artifact.read' ORDER BY id"
  );
  expect(
    reads.rows.map((row) => (row as { details: { path: string } }).details.path)
  ).toEqual(["welcome/network.har", "welcome/report.html"]);
}, 30_000);
