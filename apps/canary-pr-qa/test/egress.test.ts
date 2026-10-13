import { execFileSync } from "node:child_process";
import dns from "node:dns/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import tls from "node:tls";
import { afterEach, expect, it, vi } from "vitest";
import {
  networkAllowed,
  privateAddress,
} from "../../canary-daemon/src/network-policy.js";
import { startEgressProxy } from "../src/egress-proxy.js";
import { fixture } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
it("denies non-approved hosts, private IPs and metadata, even with an approved hostname", async () => {
  expect(await networkAllowed("http://127.0.0.1/a", ["127.0.0.1"])).toBe(false);
  expect(
    await networkAllowed(
      "http://169.254.169.254/latest",
      ["169.254.169.254"],
      true
    )
  ).toBe(false);
  expect(
    await networkAllowed("https://other.example/a", ["preview.example"])
  ).toBe(false);
  for (const ip of [
    "::1",
    "::ffff:127.0.0.1",
    "10.1.2.3",
    "172.20.1.1",
    "169.254.169.254",
    "fd00::1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "ff02::1",
  ]) {
    expect(privateAddress(ip)).toBe(true);
  }
});
it("forwards approved traffic to a DNS-pinned target and rejects other destinations at the egress proxy", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const proxy = await startEgressProxy(f.config);
  cleanup.push(() => new Promise<void>((done) => proxy.close(() => done())));
  const unauthorized = createServer((_req, res) => res.end("private"));
  await new Promise<void>((done) => unauthorized.listen(0, "127.0.0.1", done));
  cleanup.push(
    () => new Promise<void>((done) => unauthorized.close(() => done()))
  );
  const get = (url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        // `agent: false` keeps one test from reusing the keep-alive socket of the
        // proxy a previous test already closed: every test binds the same port,
        // and a recycled socket answers with ECONNRESET instead of the policy
        // verdict under test.
        { agent: false, host: "127.0.0.1", port: 3128, path: url },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        }
      );
      req.on("error", reject);
      req.end();
    });
  expect((await get(f.baseUrl)).status).toBe(200);
  const address = unauthorized.address() as { port: number };
  expect((await get(`http://127.0.0.1:${address.port}/`)).status).toBe(403);
});

it("denies every destination while the published policy is unreadable, then follows it", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const directory = await mkdtemp(join(tmpdir(), "canary-egress-policy-"));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const policy = join(directory, "preview-hosts.json");
  // The upstream is reachable and listed in PREVIEW_ALLOWED_HOSTS: only the
  // unreadable published policy can explain a refusal.
  const upstream = createServer((_req, res) => res.end("reachable"));
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>((done) => upstream.close(() => done())));
  const host = `127.0.0.1:${(upstream.address() as { port: number }).port}`;
  await writeFile(policy, "not json");
  const proxy = await startEgressProxy({
    ...f.config,
    allowedHosts: [host],
    PREVIEW_ALLOWED_HOSTS: host,
    QA_POLICY_DIR: directory,
  });
  cleanup.push(() => new Promise<void>((done) => proxy.close(() => done())));
  const get = (url: string) =>
    new Promise<{ body: string; status: number }>((resolve, reject) => {
      const req = request(
        // See the first helper: no shared keep-alive socket across proxies.
        { agent: false, host: "127.0.0.1", path: url, port: 3128 },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ body, status: res.statusCode ?? 0 }));
        }
      );
      req.on("error", reject);
      req.end();
    });
  expect((await get(`http://${host}/`)).status).toBe(403);
  // The API republishes the effective list: the poll picks it up without a restart.
  await writeFile(
    policy,
    JSON.stringify({
      hosts: [host],
      updatedAt: new Date().toISOString(),
      updatedBy: "admin-1",
    })
  );
  await delay(2500);
  const allowed = await get(`http://${host}/`);
  expect(allowed.status, JSON.stringify(allowed)).toBe(200);
  expect(allowed.body).toBe("reachable");
});

it("enforces a wildcard entry at the proxy, for its subdomains only", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const upstream = createServer((_req, res) => res.end("reachable"));
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>((done) => upstream.close(() => done())));
  const port = (upstream.address() as { port: number }).port;
  // The proxy resolves and pins the address itself, so the local fixture stands
  // in for the real preview host.
  vi.spyOn(dns, "lookup").mockResolvedValue([
    { address: "127.0.0.1", family: 4 },
  ] as never);
  const proxy = await startEgressProxy({
    ...f.config,
    allowedHosts: [`*.arpilabe.pharmania.fr:${port}`],
  });
  cleanup.push(() => new Promise<void>((done) => proxy.close(() => done())));
  const get = (url: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        // See the first helper: no shared keep-alive socket across proxies.
        { agent: false, host: "127.0.0.1", path: url, port: 3128 },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        }
      );
      req.on("error", reject);
      req.end();
    });
  expect(await get(`http://pr-12.arpilabe.pharmania.fr:${port}/`)).toBe(200);
  // The wildcard never covers the bare domain, a look-alike suffix, or another
  // port than the one the administrator wrote.
  expect(await get(`http://arpilabe.pharmania.fr:${port}/`)).toBe(403);
  expect(await get(`http://notarpilabe.pharmania.fr:${port}/`)).toBe(403);
  expect(await get("http://pr-12.arpilabe.pharmania.fr/")).toBe(403);
});

it("tunnels an approved absolute ws URL and denies unapproved or metadata destinations", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const upstream = createServer();
  upstream.on("upgrade", (req, socket, head) => {
    socket.end(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n${req.url}:${head.toString()}`
    );
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>((done) => upstream.close(() => done())));
  const host = `127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const proxy = await startEgressProxy({
    ...f.config,
    allowedHosts: [host, "169.254.169.254"],
  });
  cleanup.push(() => new Promise<void>((done) => proxy.close(() => done())));
  const upgrade = (url: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = connect(3128, "127.0.0.1", () =>
        socket.write(
          `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nclient-probe`
        )
      );
      let response = "";
      socket.on("data", (chunk) => {
        response += chunk.toString();
      });
      socket.on("end", () => resolve(response));
      socket.on("error", reject);
      socket.setTimeout(5000, () =>
        socket.destroy(new Error("Upgrade timed out"))
      );
    });
  const response = await upgrade(`ws://${host}/updates?probe=1`);
  expect(response).toContain("101 Switching Protocols");
  expect(response).toContain("/updates?probe=1:client-probe");
  expect(await upgrade("ws://unapproved.example/events")).toContain(
    "403 Forbidden"
  );
  expect(await upgrade("ws://169.254.169.254/latest")).toContain(
    "403 Forbidden"
  );
  expect(await upgrade("wss://169.254.169.254/latest")).toContain(
    "403 Forbidden"
  );
});

it("rejects DNS aliases to metadata even when private previews are enabled", async () => {
  vi.spyOn(dns, "lookup").mockResolvedValue([
    { address: "169.254.169.254", family: 4 },
  ] as never);
  expect(
    await networkAllowed("http://alias.example/latest", ["alias.example"], true)
  ).toBe(false);
  expect(
    await networkAllowed(
      "http://[::ffff:a9fe:a9fe]/latest",
      ["[::ffff:a9fe:a9fe]"],
      true
    )
  ).toBe(false);
});

it("delegates hostname DNS to the isolated egress proxy but still denies metadata literals", async () => {
  vi.spyOn(dns, "lookup").mockRejectedValue(
    new Error("External DNS unavailable in browser")
  );
  expect(
    await networkAllowed(
      "https://preview.example/a",
      ["preview.example"],
      false,
      true
    )
  ).toBe(true);
  expect(
    await networkAllowed(
      "http://169.254.169.254/",
      ["169.254.169.254"],
      true,
      true
    )
  ).toBe(false);
  expect(
    await networkAllowed(
      "http://[fd00:ec2::254]/",
      ["[fd00:ec2::254]"],
      true,
      true
    )
  ).toBe(false);
  expect(
    await networkAllowed("http://127.0.0.1/", ["127.0.0.1"], false, true)
  ).toBe(false);
});

it("uses real TLS with the original hostname for an approved wss upgrade", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const certPath = join(f.dataDir, "websocket-cert.pem");
  const keyPath = join(f.dataDir, "websocket-key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" }
  );
  const cert = await readFile(certPath);
  const key = await readFile(keyPath);
  const realConnect = tls.connect;
  // Trust only this ephemeral test CA; TLS and hostname verification still execute.
  const tlsConnect = vi
    .spyOn(tls, "connect")
    .mockImplementation(((options: tls.ConnectionOptions, ready: () => void) =>
      realConnect({ ...options, ca: cert }, ready)) as typeof tls.connect);
  const upstream = tls.createServer({ key, cert }, (socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.includes("\r\n\r\n")) {
        socket.end(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nsecure:${input.split("\r\n")[0]}`
        );
      }
    });
  });
  await new Promise<void>((done) => upstream.listen(0, "localhost", done));
  cleanup.push(() => new Promise<void>((done) => upstream.close(() => done())));
  const port = (upstream.address() as { port: number }).port;
  const host = `localhost:${port}`;
  const proxy = await startEgressProxy({ ...f.config, allowedHosts: [host] });
  cleanup.push(() => new Promise<void>((done) => proxy.close(() => done())));
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(3128, "127.0.0.1", () =>
      socket.write(
        `GET wss://${host}/secure-events HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
      )
    );
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString();
    });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
    socket.setTimeout(5000, () =>
      socket.destroy(new Error("Secure upgrade timed out"))
    );
  });
  expect(response).toContain("101 Switching Protocols");
  expect(response).toContain("secure:GET /secure-events HTTP/1.1");
  expect(tlsConnect).toHaveBeenCalledWith(
    expect.objectContaining({ servername: "localhost", port }),
    expect.any(Function)
  );
});
