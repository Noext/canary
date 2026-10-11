import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GitHub } from "../src/github.js";
import { githubToken, verifyWebhook } from "../src/github-app.js";
import { fixture, SHA } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
it("signs a real RSA App JWT, caches installation credentials and renews before expiry", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const keyFile = join(f.dataDir, "app.pem");
  await writeFile(
    keyFile,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 }
  );
  const now = Date.now();
  let requests = 0;
  const tokens: string[] = [];
  const server = createServer((req, res) => {
    const jwt = String(req.headers.authorization).replace(/^Bearer /, "");
    tokens.push(jwt);
    requests++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        token: `installation-${requests}`,
        expires_at: new Date(now + requests * 3_600_000).toISOString(),
      })
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
  const config = {
    ...f.config,
    GITHUB_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    GITHUB_APP_ID: "9001",
    GITHUB_INSTALLATION_ID: "42",
    GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
  };
  expect(await githubToken(config)).toBe("installation-1");
  expect(await githubToken(config)).toBe("installation-1");
  expect(requests).toBe(1);
  const [header, payload, signature] = tokens[0]!.split(".");
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature!, "base64url")
    )
  ).toBe(true);
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
  expect(claims.iss).toBe("9001");
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  vi.spyOn(Date, "now").mockReturnValue(now + 3_550_000);
  expect(await githubToken(config)).toBe("installation-2");
  expect(requests).toBe(2);
});
it("rejects modified webhook bytes and malformed signatures", () => {
  const secret = "webhook-secret-0123456789-abcdef-123456";
  const raw = Buffer.from('{"action":"synchronize"}');
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  expect(verifyWebhook(raw, signature, secret)).toBe(true);
  expect(
    verifyWebhook(Buffer.from('{"action":"opened"}'), signature, secret)
  ).toBe(false);
  expect(verifyWebhook(raw, "sha256=abc", secret)).toBe(false);
  expect(verifyWebhook(raw, signature, "weak")).toBe(false);
});
it("updates only the configured App's check and translates success to a completed check", async () => {
  const f = await fixture();
  cleanup.push(f.close);
  // Isolate check protocol from token minting; the RSA/mint protocol is tested above against an HTTP server.
  const github = new GitHub({ ...f.config, GITHUB_APP_ID: "9001" });
  const requests: { path: string; method: string; payload: unknown }[] = [];
  vi.spyOn(github, "request").mockImplementation(
    async (path, method, payload) => {
      requests.push({ path, method: method ?? "GET", payload });
      if (!method || method === "GET") {
        return {
          check_runs: [
            { id: 99, app: { id: 8 } },
            { id: 42, app: { id: 9001 } },
          ],
        };
      }
      return {};
    }
  );
  await github.status(
    {
      ref: {
        repo: "fixture/app",
        number: 1,
        url: "https://github.com/fixture/app/pull/1",
      },
      sha: SHA,
    } as Parameters<GitHub["status"]>[0],
    "success",
    "Verified"
  );
  expect(requests[1]).toMatchObject({
    path: "/repos/fixture/app/check-runs/42",
    method: "PATCH",
    payload: { head_sha: SHA, status: "completed", conclusion: "success" },
  });
});
