import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { browserEnvironment } from "../src/canary.js";
import {
  loadConfig,
  validateConfiguration,
  validatePreviewUrl,
} from "../src/config.js";
import { prepareScenario } from "../src/fixtures.js";
import {
  applyPreviewHosts,
  normalizePreviewHosts,
  PREVIEW_POLICY_FILE,
  PreviewHosts,
  verifyPreviewPolicyTarget,
  verifyPublishedPreviewHosts,
  watchPreviewPolicy,
} from "../src/preview-hosts.js";
import { startProductionServer } from "../src/production-server.js";
import { fixture, pgliteQueue, plan } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

it("accepts a wildcard only as a whole leading label over a real domain", () => {
  expect(
    normalizePreviewHosts([
      " *.Arpilabe.Pharmania.fr ",
      "*.preview.example.com:8443",
      "*.preview.example.com",
    ])
  ).toEqual([
    "*.arpilabe.pharmania.fr",
    "*.preview.example.com:8443",
    "*.preview.example.com",
  ]);
  for (const invalid of [
    // A wildcard hands one label to whoever registers it, so a shared public
    // suffix would open every domain beneath it, ICANN section or private one.
    "*.com",
    "*.fr",
    "*.co.uk",
    "*.github.io",
    "*.vercel.app",
    "*.s3.amazonaws.com",
    // It never covers an IP literal, and never a partial label.
    "*.127.0.0.1",
    "*",
    "*.",
    "*example.com",
    "preview.*.example.com",
    "*.example.com/path",
    "*.example.com:99999",
    "*.user@example.com",
    "*.[2001:db8::1]",
  ]) {
    expect(() => normalizePreviewHosts([invalid]), invalid).toThrow();
  }
});

it("holds the environment list to the rule the dashboard edit enforces", () => {
  const base = {
    GITHUB_ALLOWED_REPOS: "fixture/app",
    OPENAI_BASE_URL: "https://ai.example/v1",
    OPENAI_MODEL: "test-model",
  };
  const good = loadConfig({
    ...base,
    PREVIEW_ALLOWED_HOSTS: "*.arpilabe.pharmania.fr,preview.test",
  });
  expect(good.allowedHosts).toEqual([
    "*.arpilabe.pharmania.fr",
    "preview.test",
  ]);
  expect(good.invalidAllowedHosts).toEqual([]);
  expect(good.PREVIEW_ALLOWED_HOSTS).toBe(
    "*.arpilabe.pharmania.fr,preview.test"
  );
  expect(() => validateConfiguration(good)).not.toThrow();
  for (const entry of ["*.co.uk", "*.com", "https://preview.example.com"]) {
    const config = loadConfig({ ...base, PREVIEW_ALLOWED_HOSTS: entry });
    // Loading drops the entry before any boundary sees it - `browser` and
    // `egress` start without the boot check, and without `QA_POLICY_DIR` they
    // never apply a published policy either...
    expect(config.allowedHosts, entry).toEqual([]);
    expect(config.PREVIEW_ALLOWED_HOSTS, entry).toBe("");
    expect(config.invalidAllowedHosts, entry).toEqual([entry]);
    // ...doctor and the boot check still name it instead of shrinking in
    // silence, and the session policy that reaches the browser is sanitized too.
    expect(() => validateConfiguration(config), entry).toThrow(
      /PREVIEW_ALLOWED_HOSTS entries must be/
    );
    expect(applyPreviewHosts(config, config.allowedHosts).allowedHosts).toEqual(
      []
    );
    expect(browserEnvironment(config).CANARY_NETWORK_ALLOWED_HOSTS).toBe("");
  }
});

it("covers subdomains with a wildcard, never the bare domain or another port", () => {
  const config = loadConfig({
    PREVIEW_ALLOWED_HOSTS: "*.arpilabe.pharmania.fr,*.preview.test:8443",
  });
  expect(
    validatePreviewUrl("https://pr-12.arpilabe.pharmania.fr", config).host
  ).toBe("pr-12.arpilabe.pharmania.fr");
  expect(
    validatePreviewUrl("https://a.b.arpilabe.pharmania.fr", config).host
  ).toBe("a.b.arpilabe.pharmania.fr");
  expect(
    validatePreviewUrl("https://pr-12.preview.test:8443", config).host
  ).toBe("pr-12.preview.test:8443");
  for (const denied of [
    // The wildcard never covers its own apex, a look-alike suffix, or a port
    // the entry did not authorize.
    "https://arpilabe.pharmania.fr",
    "https://notarpilabe.pharmania.fr",
    "https://pr-12.arpilabe.pharmania.fr:8443",
    "https://pr-12.preview.test",
  ]) {
    expect(() => validatePreviewUrl(denied, config), denied).toThrow();
  }
});

it("accepts the default port a scheme implies when the entry names it", () => {
  const config = loadConfig({
    PREVIEW_ALLOWED_HOSTS: "*.preview.test:443,preview.example.com:80",
  });
  expect(validatePreviewUrl("https://pr-12.preview.test", config).host).toBe(
    "pr-12.preview.test"
  );
  expect(validatePreviewUrl("http://preview.example.com", config).host).toBe(
    "preview.example.com"
  );
  for (const denied of [
    // The other scheme's default is a different port.
    "http://pr-12.preview.test",
    "https://preview.example.com",
  ]) {
    expect(() => validatePreviewUrl(denied, config), denied).toThrow();
  }
});

it("lets a wildcard entry cover the trusted auth a preview subdomain presents", async () => {
  const directory = await temporaryDirectory("canary-fixtures-");
  const file = join(directory, "fixtures.json");
  await writeFile(
    file,
    JSON.stringify({ "fixture/app": { roles: { member: "QA_ROLE_MEMBER" } } })
  );
  const config = loadConfig({
    PREVIEW_ALLOWED_HOSTS: "*.arpilabe.pharmania.fr",
    QA_FIXTURES_FILE: file,
  });
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.preconditions = ["role:member"];
  const auth = (cookieHost: string, origin: string) => ({
    cookies: [
      {
        domain: cookieHost,
        expires: -1,
        httpOnly: true,
        name: "session",
        path: "/",
        sameSite: "Lax",
        secure: true,
        value: "test-member-secret",
      },
    ],
    origins: [{ localStorage: [], origin }],
  });
  const subdomain = "pr-12.arpilabe.pharmania.fr";
  async function load(cookieHost: string, origin = `https://${subdomain}`) {
    vi.stubEnv("QA_ROLE_MEMBER", JSON.stringify(auth(cookieHost, origin)));
    return await prepareScenario(scenario, "fixture/app", config);
  }
  await expect(load(subdomain)).resolves.toHaveProperty("auth");
  // A parent-domain cookie is what the browser sends to the preview subdomain,
  // so the entry's base domain has to be accepted here.
  await expect(load("arpilabe.pharmania.fr")).resolves.toHaveProperty("auth");
  await expect(load("pharmania.fr")).rejects.toThrow(
    "Auth cookie domain outside approved previews"
  );
  await expect(load("notarpilabe.pharmania.fr")).rejects.toThrow(
    "Auth cookie domain outside approved previews"
  );
  await expect(
    load(subdomain, "https://arpilabe.pharmania.fr")
  ).rejects.toThrow("Auth localStorage origin outside approved previews");
  await expect(load(subdomain, `https://${subdomain}:8443`)).rejects.toThrow(
    "Auth localStorage origin outside approved previews"
  );
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

it("verifies the shared policy directory the doctor runs in", async () => {
  const directory = await temporaryDirectory("canary-doctor-");
  const config = loadConfig({
    PREVIEW_ALLOWED_HOSTS: "preview.test",
    QA_POLICY_DIR: directory,
  });
  expect(await verifyPreviewPolicyTarget(config)).toContain(
    "no list published yet"
  );
  // Nothing published yet: the enforcement containers deny every destination, and
  // doctor says so instead of reporting a healthy volume.
  await expect(verifyPublishedPreviewHosts(config)).rejects.toMatchObject({
    code: "PREVIEW_POLICY_MISSING",
  });
  await writeFile(
    join(directory, PREVIEW_POLICY_FILE),
    JSON.stringify({
      hosts: ["preview.test", "other.test:8443"],
      updatedAt: new Date().toISOString(),
      updatedBy: "admin-1",
    })
  );
  expect(await verifyPreviewPolicyTarget(config)).toContain(
    "2 host(s) published and readable"
  );
  // A stored-but-unpublished edit leaves the file on the previous list: the API
  // accepts a host the enforcement containers refuse.
  await expect(verifyPublishedPreviewHosts(config)).rejects.toMatchObject({
    code: "PREVIEW_POLICY_STALE",
  });
  applyPreviewHosts(config, ["preview.test", "other.test:8443"]);
  await expect(verifyPublishedPreviewHosts(config)).resolves.toContain(
    "2 host(s) published and matching the list in force"
  );
  // An invalid file is ignored by the enforcement containers: doctor must say so
  // instead of reporting a healthy volume.
  await writeFile(join(directory, PREVIEW_POLICY_FILE), "not json");
  await expect(verifyPreviewPolicyTarget(config)).rejects.toMatchObject({
    code: "PREVIEW_POLICY_INVALID",
  });
  await expect(verifyPublishedPreviewHosts(config)).rejects.toMatchObject({
    code: "PREVIEW_POLICY_INVALID",
  });
});

it("denies every destination while the published policy is unreadable", async () => {
  const q = await sqlDatabase();
  const directory = await temporaryDirectory("canary-policy-");
  const config = loadConfig({
    PREVIEW_ALLOWED_HOSTS: "preview.test",
    QA_POLICY_DIR: directory,
  });
  const hosts = new PreviewHosts(q.pool, config);
  const policy = join(directory, PREVIEW_POLICY_FILE);
  // An enforcement process that starts before the first publication has nothing to
  // trust: the environment default may allow a host an administrator removed.
  const enforcement = loadConfig({
    PREVIEW_ALLOWED_HOSTS: "preview.test",
    QA_POLICY_DIR: directory,
  });
  const watch = watchPreviewPolicy(enforcement, 3_600_000);
  try {
    await watch.sync();
    expect(enforcement.allowedHosts).toEqual([]);
    await hosts.set("admin-1", ["new.example.com"]);
    expect(JSON.parse(await readFile(policy, "utf8"))).toMatchObject({
      hosts: ["new.example.com"],
      updatedBy: "admin-1",
    });
    await watch.sync();
    expect(enforcement.allowedHosts).toEqual(["new.example.com"]);
    expect(enforcement.PREVIEW_ALLOWED_HOSTS).toBe("new.example.com");
    // A corrupt file fails closed instead of falling back to the environment list,
    // and an invalid list is rejected wholesale.
    await writeFile(policy, "not json");
    await watch.sync();
    expect(enforcement.allowedHosts).toEqual([]);
    await writeFile(
      policy,
      JSON.stringify({
        hosts: ["injected.example.com", "https://evil.test"],
        updatedAt: new Date().toISOString(),
        updatedBy: "unknown",
      })
    );
    await watch.sync();
    expect(enforcement.allowedHosts).toEqual([]);
    // The next valid publication is followed again, without a restart.
    await writeFile(
      policy,
      JSON.stringify({
        hosts: ["recovered.example.com"],
        updatedAt: new Date().toISOString(),
        updatedBy: "admin-1",
      })
    );
    await watch.sync();
    expect(enforcement.allowedHosts).toEqual(["recovered.example.com"]);
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
