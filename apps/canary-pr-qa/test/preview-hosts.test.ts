import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { browserEnvironment } from "../src/canary.js";
import { loadConfig, validatePreviewUrl } from "../src/config.js";
import {
  applyPreviewHosts,
  normalizePreviewHosts,
  PREVIEW_POLICY_FILE,
  PreviewHosts,
  watchPreviewPolicy,
} from "../src/preview-hosts.js";
import { startProductionServer } from "../src/production-server.js";
import { fixture, pgliteQueue } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});
async function sqlDatabase() {
  return await pgliteQueue(cleanup);
}
async function temporaryDirectory(prefix: string) {
  return await mkdtemp(join(tmpdir(), prefix));
}
function cookieOf(response: Response) {
  const header = response.headers.get("set-cookie");
  if (!header) {
    throw new Error("No session cookie");
  }
  return header.split(";")[0] ?? "";
}

it("accepts only exact host or host:port entries", () => {
  expect(
    normalizePreviewHosts([
      " Preview.Example.com ",
      "preview.example.com:8443",
      "PREVIEW.EXAMPLE.COM",
      "",
      "[2001:db8::1]:8443",
    ])
  ).toEqual([
    "preview.example.com",
    "preview.example.com:8443",
    "[2001:db8::1]:8443",
  ]);
  for (const invalid of [
    "https://preview.example.com",
    "preview.example.com/path",
    "preview.example.com?x=1",
    "*.example.com",
    "user@preview.example.com",
    ".preview.example.com",
    "preview.example.com:99999",
    "preview.example.com:0",
    "a b",
  ]) {
    expect(() => normalizePreviewHosts([invalid]), invalid).toThrow();
  }
  expect(() => normalizePreviewHosts([])).toThrow();
  expect(() =>
    normalizePreviewHosts(
      Array.from({ length: 51 }, (_, index) => `preview-${index}.example.com`)
    )
  ).toThrow();
});

it("applies a dashboard list over the environment default in every process", async () => {
  const q = await sqlDatabase();
  const config = loadConfig({
    PREVIEW_ALLOWED_HOSTS: "preview.test, other.test:8443",
  });
  const hosts = new PreviewHosts(q.pool, config);
  expect(await hosts.managed()).toBe(false);
  expect(await hosts.load()).toEqual(["preview.test", "other.test:8443"]);
  expect(validatePreviewUrl("https://preview.test", config).host).toBe(
    "preview.test"
  );
  await hosts.set("admin-1", ["new.example.com:9443"]);
  expect(await hosts.managed()).toBe(true);
  expect(config.allowedHosts).toEqual(["new.example.com:9443"]);
  expect(config.PREVIEW_ALLOWED_HOSTS).toBe("new.example.com:9443");
  expect(validatePreviewUrl("https://new.example.com:9443", config).host).toBe(
    "new.example.com:9443"
  );
  expect(() => validatePreviewUrl("https://preview.test", config)).toThrow();
  expect(hosts.defaults()).toEqual(["preview.test", "other.test:8443"]);
  // A second process (the worker) reads the stored list, not its own environment.
  const worker = new PreviewHosts(
    q.pool,
    loadConfig({ PREVIEW_ALLOWED_HOSTS: "preview.test" })
  );
  expect(await worker.load()).toEqual(["new.example.com:9443"]);
  await q.pool.query(
    "UPDATE qa_preview_hosts SET hosts=$1::jsonb WHERE singleton=true",
    [JSON.stringify(["https://preview.test/path"])]
  );
  expect(await hosts.load()).toEqual(["preview.test", "other.test:8443"]);
  await hosts.set("admin-1", ["new.example.com:9443"]);
  expect(await hosts.reset("admin-1")).toEqual([
    "preview.test",
    "other.test:8443",
  ]);
  expect(await hosts.managed()).toBe(false);
});

it("passes the effective list to the browser session policy", () => {
  const config = loadConfig({ PREVIEW_ALLOWED_HOSTS: "preview.test" });
  applyPreviewHosts(config, ["new.example.com:8443"]);
  // The daemon reads this variable and the CLI takes the same list as an
  // argument: a dashboard edit must reach both without a restart.
  expect(browserEnvironment(config).CANARY_NETWORK_ALLOWED_HOSTS).toBe(
    "new.example.com:8443"
  );
});

it("publishes the list for the enforcement containers and ignores a corrupted policy", async () => {
  const q = await sqlDatabase();
  const directory = await temporaryDirectory("canary-policy-");
  const config = loadConfig({
    PREVIEW_ALLOWED_HOSTS: "preview.test",
    QA_POLICY_DIR: directory,
  });
  const hosts = new PreviewHosts(q.pool, config);
  await hosts.set("admin-1", ["new.example.com"]);
  const policy = join(directory, PREVIEW_POLICY_FILE);
  expect(JSON.parse(await readFile(policy, "utf8"))).toMatchObject({
    hosts: ["new.example.com"],
    updatedBy: "admin-1",
  });
  // The enforcement process starts from its environment list and follows the file.
  const enforcement = loadConfig({
    PREVIEW_ALLOWED_HOSTS: "preview.test",
    QA_POLICY_DIR: directory,
  });
  const watch = watchPreviewPolicy(enforcement, 3_600_000);
  try {
    await watch.sync();
    expect(enforcement.allowedHosts).toEqual(["new.example.com"]);
    expect(enforcement.PREVIEW_ALLOWED_HOSTS).toBe("new.example.com");
    await writeFile(policy, "not json");
    await watch.sync();
    expect(enforcement.allowedHosts).toEqual(["new.example.com"]);
    await writeFile(
      policy,
      JSON.stringify({
        hosts: ["injected.example.com", "https://evil.test"],
        updatedAt: new Date().toISOString(),
        updatedBy: "unknown",
      })
    );
    await watch.sync();
    expect(enforcement.allowedHosts).toEqual(["new.example.com"]);
  } finally {
    watch.stop();
  }
});

it("reports an unwritable policy directory instead of saving silently", async () => {
  const q = await sqlDatabase();
  const blocked = join(await temporaryDirectory("canary-file-"), "policy");
  // A file where the policy directory should be: publishing cannot succeed.
  await writeFile(blocked, "not a directory");
  const hosts = new PreviewHosts(
    q.pool,
    loadConfig({
      PREVIEW_ALLOWED_HOSTS: "preview.test",
      QA_POLICY_DIR: blocked,
    })
  );
  await expect(hosts.set("admin-1", ["new.example.com"])).rejects.toMatchObject(
    { code: "PREVIEW_POLICY_UNWRITABLE" }
  );
  // The list is stored even when the publication fails, so a retry stays cheap.
  expect(await hosts.effective()).toEqual(["new.example.com"]);
});

it("audits a stored list whose publication failed", async () => {
  const q = await sqlDatabase();
  const f = await fixture();
  cleanup.push(f.close);
  // A file where the policy directory should be: the row is written, the
  // publication cannot succeed.
  const blocked = join(await temporaryDirectory("canary-blocked-"), "policy");
  await writeFile(blocked, "not a directory");
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
    QA_POLICY_DIR: blocked,
  };
  const server = await startProductionServer(config);
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const admin = cookieOf(
    await fetch(`${url}/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.config.QA_API_TOKEN}` },
    })
  );
  const response = await fetch(`${url}/dashboard/preview-hosts`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: admin },
    body: JSON.stringify({ hosts: ["new.example.com"] }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    code: "PREVIEW_POLICY_UNWRITABLE",
  });
  // The failed request still changed the stored allowlist: it must be audited.
  expect(
    (
      await q.pool.query(
        "SELECT action,details FROM qa_audit WHERE action LIKE 'preview.hosts.%' ORDER BY id"
      )
    ).rows
  ).toEqual([
    {
      action: "preview.hosts.updated",
      details: { hosts: ["new.example.com"], published: false },
    },
  ]);
  expect(
    (
      await q.pool.query(
        "SELECT hosts FROM qa_preview_hosts WHERE singleton=true"
      )
    ).rows[0]
  ).toEqual({ hosts: ["new.example.com"] });
  // A retry after the volume is fixed is a single click: the list is stored.
  expect(config.allowedHosts).toEqual(["new.example.com"]);
}, 30_000);

it("lets only an administrator edit the host list and audits every change", async () => {
  const q = await sqlDatabase();
  const f = await fixture();
  cleanup.push(f.close);
  const usersFile = join(
    await temporaryDirectory("canary-users-"),
    "users.json"
  );
  const operatorToken = "operator-token-0123456789-abcdef";
  await writeFile(
    usersFile,
    JSON.stringify([
      {
        id: "operator-1",
        role: "operator",
        repos: ["fixture/app"],
        tokenSha256: createHash("sha256").update(operatorToken).digest("hex"),
      },
    ]),
    { mode: 0o600 }
  );
  const policyDir = await temporaryDirectory("canary-policy-http-");
  const config = {
    ...f.config,
    DATABASE_URL: "postgres://fixture",
    QA_PORT: 0,
    QA_POLICY_DIR: policyDir,
    QA_USERS_FILE: usersFile,
  };
  const defaultHosts = [...f.config.allowedHosts];
  const server = await startProductionServer(config);
  cleanup.push(() => server.shutdown());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const jsonHeaders = { "Content-Type": "application/json" };
  const audit = async () =>
    (
      await q.pool.query(
        "SELECT action,details FROM qa_audit WHERE action LIKE 'preview.hosts.%' ORDER BY id"
      )
    ).rows;
  const admin = cookieOf(
    await fetch(`${url}/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.config.QA_API_TOKEN}` },
    })
  );
  const operator = cookieOf(
    await fetch(`${url}/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${operatorToken}` },
    })
  );
  // The upload of a hosts edit is a state change: the dashboard CSRF check applies.
  expect(
    (
      await fetch(`${url}/dashboard/preview-hosts`, {
        method: "PUT",
        headers: {
          ...jsonHeaders,
          Cookie: admin,
          Origin: "https://attacker.invalid",
        },
        body: JSON.stringify({ hosts: ["evil.test"] }),
      })
    ).status
  ).toBe(403);
  expect(
    (
      await fetch(`${url}/dashboard/preview-hosts`, {
        method: "PUT",
        headers: { ...jsonHeaders, Cookie: operator },
        body: JSON.stringify({ hosts: ["evil.test"] }),
      })
    ).status
  ).toBe(403);
  const operatorStatus = await fetch(`${url}/dashboard/status`, {
    headers: { Cookie: operator },
  });
  expect((await operatorStatus.json()).preview).not.toHaveProperty("hosts");
  // An invalid list is refused and leaves the current one in place.
  expect(
    (
      await fetch(`${url}/dashboard/preview-hosts`, {
        method: "PUT",
        headers: { ...jsonHeaders, Cookie: admin },
        body: JSON.stringify({ hosts: ["https://evil.test/path"] }),
      })
    ).status
  ).toBe(400);
  const saved = await (
    await fetch(`${url}/dashboard/preview-hosts`, {
      method: "PUT",
      headers: { ...jsonHeaders, Cookie: admin },
      body: JSON.stringify({
        hosts: ["New.Example.com:8443", "new.example.com:8443"],
      }),
    })
  ).json();
  expect(saved).toMatchObject({
    hosts: ["new.example.com:8443"],
    hostsDefault: defaultHosts,
  });
  expect(config.allowedHosts).toEqual(["new.example.com:8443"]);
  expect(
    JSON.parse(await readFile(join(policyDir, PREVIEW_POLICY_FILE), "utf8"))
      .hosts
  ).toEqual(["new.example.com:8443"]);
  const status = await (
    await fetch(`${url}/dashboard/status`, { headers: { Cookie: admin } })
  ).json();
  expect(status.preview).toMatchObject({
    hosts: ["new.example.com:8443"],
    hostsDefault: defaultHosts,
  });
  const reset = await (
    await fetch(`${url}/dashboard/preview-hosts`, {
      method: "DELETE",
      headers: { Cookie: admin },
    })
  ).json();
  expect(reset).toMatchObject({
    hosts: defaultHosts,
    hostsDefault: defaultHosts,
  });
  expect(await audit()).toEqual([
    {
      action: "preview.hosts.updated",
      details: { hosts: ["new.example.com:8443"], published: true },
    },
    {
      action: "preview.hosts.reset",
      details: { hosts: defaultHosts, published: true },
    },
  ]);
}, 30_000);
