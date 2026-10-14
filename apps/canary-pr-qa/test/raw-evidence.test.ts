import { mkdir, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { signedArtifact } from "../src/access.js";
import type { Config } from "../src/config.js";
import { startProductionServer } from "../src/production-server.js";
import { serveArtifact } from "../src/server.js";
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
  // Le corps est lu jusqu'au bout : la route n'audite une lecture qu'une fois
  // le fichier remis à la réponse, pas à l'en-tête.
  const download = async (target: string, headers?: Record<string, string>) => {
    const response = await fetch(target, { headers });
    return { body: await response.text(), status: response.status };
  };
  return {
    config: f.config,
    id: queued.id,
    q,
    read: (path: string) =>
      download(`${url}/artifacts/${queued.id}/${path}`, {
        Authorization: `Bearer ${f.config.QA_API_TOKEN}`,
      }),
    // Le lien signé, celui que le dashboard distribue et que le MCP ne fabrique
    // pas : il se suit sans clé.
    signed: (path: string) =>
      download(`${url}${signedArtifact(queued.id, path, f.config)}`),
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
    expect(refused.body).toContain("Raw evidence disabled by data policy");
  }
  // Une seule lecture a été servie — le rapport ; les quatre refus n'ont rien
  // ajouté au journal. La ligne suit la fin du transfert, donc elle arrive
  // après que le client a lu le corps.
  const refusedAudits = () =>
    closed.q.pool
      .query(
        "SELECT details FROM qa_audit WHERE action='artifact.read' ORDER BY id"
      )
      .then((result) =>
        result.rows.map(
          (row) => (row as { details: { path: string } }).details.path
        )
      );
  await vi.waitFor(async () => {
    expect(await refusedAudits()).toEqual(["welcome/report.html"]);
  });
  const opened = await evidenceServer({ QA_RAW_EVIDENCE: "true" });
  expect((await opened.read("welcome/network.har")).status).toBe(200);
  expect((await opened.read("welcome/report.html")).status).toBe(200);
  // Toute lecture servie est auditée, y compris celle qui n'avait pas besoin du
  // réglage : l'audit suit le succès, pas le seul cas ouvert.
  const reads = async () => {
    const rows = await opened.q.pool.query(
      "SELECT details FROM qa_audit WHERE action='artifact.read' ORDER BY id"
    );
    return rows.rows.map(
      (row) => (row as { details: { path: string } }).details.path
    );
  };
  await vi.waitFor(async () => {
    expect(await reads()).toEqual([
      "welcome/network.har",
      "welcome/report.html",
    ]);
  });
}, 30_000);

it("audits the signed download itself, which carries no key to name", async () => {
  // Le lien signé est une délégation du droit de lire, pas une lecture : c'est
  // le téléchargement qui compte, et il n'a pas de compte à nommer.
  const closed = await evidenceServer();
  expect((await closed.signed("welcome/network.har")).status).toBe(403);
  const opened = await evidenceServer({ QA_RAW_EVIDENCE: "true" });
  expect((await opened.signed("welcome/network.har")).status).toBe(200);
  expect((await opened.signed("welcome/report.html")).status).toBe(200);
  const reads = async () => {
    const rows = await opened.q.pool.query(
      "SELECT actor, details FROM qa_audit WHERE action='artifact.read' ORDER BY id"
    );
    return rows.rows.map((row) => ({
      actor: (row as { actor: string }).actor,
      via: (row as { details: { via?: string } }).details.via ?? null,
      path: (row as { details: { path: string } }).details.path,
    }));
  };
  await vi.waitFor(async () => {
    expect(await reads()).toEqual([
      {
        actor: "artifact-signature",
        path: "welcome/network.har",
        via: "signature",
      },
      {
        actor: "artifact-signature",
        path: "welcome/report.html",
        via: "signature",
      },
    ]);
  });
}, 30_000);

it("resolves an artifact transfer only once the file reached the response", async () => {
  const server = await evidenceServer();
  // Un transfert complet résout : la route écrit sa ligne d'audit après coup,
  // sur un contenu qui est réellement parti.
  const complete = new PassThrough();
  complete.resume();
  await expect(
    serveArtifact(
      Object.assign(complete, {
        writeHead: () => complete,
      }) as unknown as ServerResponse,
      server.config,
      server.id,
      "welcome/network.har"
    )
  ).resolves.toBeUndefined();
  // Une réponse qui refuse le contenu rejette : sans cette attente, l'audit
  // affirmerait une lecture que personne n'a reçue.
  const cut = new Writable({
    write: (_chunk, _encoding, callback) => callback(new Error("cut")),
  });
  cut.on("error", () => undefined);
  await expect(
    serveArtifact(
      Object.assign(cut, {
        writeHead: () => cut,
      }) as unknown as ServerResponse,
      server.config,
      server.id,
      "welcome/network.har"
    )
  ).rejects.toThrow("Artifact transfer interrupted");
}, 30_000);
