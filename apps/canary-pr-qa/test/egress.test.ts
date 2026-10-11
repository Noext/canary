import dns from "node:dns/promises";
import { createServer, request } from "node:http";
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
        { host: "127.0.0.1", port: 3128, path: url },
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
