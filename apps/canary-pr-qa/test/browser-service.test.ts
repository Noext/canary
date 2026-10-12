import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startBrowserService } from "../src/browser-service.js";
import { loadConfig } from "../src/config.js";
import { PREVIEW_POLICY_FILE } from "../src/preview-hosts.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

function policy(hosts: string[]) {
  return JSON.stringify({
    hosts,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin-1",
  });
}

it("re-reads the published host list before it starts a session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canary-browser-"));
  const stub = join(directory, "cli.mjs");
  // Stand-in for the Canary CLI: it reports the network policy it was given, so
  // the test sees exactly what the daemon would install for the session.
  await writeFile(
    stub,
    `process.stdout.write(JSON.stringify({ sessionId: "stub", hosts: process.env.CANARY_NETWORK_ALLOWED_HOSTS }));`
  );
  await writeFile(
    join(directory, PREVIEW_POLICY_FILE),
    policy(["boot.example.com"])
  );
  const config = loadConfig({
    CANARY_CLI_PATH: stub,
    PREVIEW_ALLOWED_HOSTS: "boot.example.com",
    QA_BROWSER_HOST: "127.0.0.1",
    QA_BROWSER_PORT: "0",
    QA_BROWSER_SERVICE_TOKEN: "browser-service-token-0123456789",
    QA_POLICY_DIR: directory,
  });
  const server = await startBrowserService(config);
  cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
  const port = (server.address() as { port: number }).port;
  // An administrator saves a new host while the service is already running: the
  // next session must not install the list from before the edit, which the daemon
  // would keep for the whole browser context.
  await writeFile(
    join(directory, PREVIEW_POLICY_FILE),
    policy(["boot.example.com", "new.example.com:8443"])
  );
  const response = await fetch(`http://127.0.0.1:${port}/command`, {
    body: JSON.stringify({
      args: ["session", "start", "--headless", "--name", "policy-sync"],
    }),
    headers: {
      Authorization: `Bearer ${config.QA_BROWSER_SERVICE_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as { stdout: string };
  expect(JSON.parse(result.stdout)).toMatchObject({
    hosts: "boot.example.com,new.example.com:8443",
  });
});
