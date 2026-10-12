import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { REQUIRED_PERMISSIONS } from "../src/github-setup.js";
import { body, fixture, json } from "./fixture.js";

export async function githubSetupFixture(
  options: { listenHost?: string } = {}
) {
  const f = await fixture(options);
  const pem = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const secret = "github-setup-fixture-webhook-secret-2026-abcdefgh";
  const requests: { path: string; auth: string }[] = [];
  const state = {
    installed: true,
    removed: false,
    suspended: false,
    permissions: { ...REQUIRED_PERMISSIONS },
    dashboard: "",
    conversionCount: 0,
  };
  const server = createServer((req, res) => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Protocol fixture dispatches deterministic GitHub and QA endpoints.
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fixture");
      const path = url.pathname;
      requests.push({ path, auth: String(req.headers.authorization ?? "") });
      if (path === "/settings/apps/new" && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) {
          chunks.push(Buffer.from(c));
        }
        const manifest = JSON.parse(
          new URLSearchParams(Buffer.concat(chunks).toString()).get(
            "manifest"
          ) ?? "{}"
        );
        const callback = new URL("/github/app/callback", state.dashboard);
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        callback.searchParams.set("code", "fixture-manifest-code");
        if (manifest.default_permissions.checks !== "write") {
          throw new Error("Missing permission");
        }
        res.writeHead(303, { Location: callback.href });
        res.end();
        return;
      }
      if (path === "/app-manifests/fixture-manifest-code/conversions") {
        state.conversionCount++;
        json(res, {
          id: 95_001,
          slug: "canary-fixture-app",
          pem,
          webhook_secret: secret,
        });
        return;
      }
      if (path === "/apps/canary-fixture-app/installations/new") {
        state.installed = true;
        const callback = new URL("/github/app/installed", state.dashboard);
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        callback.searchParams.set("installation_id", "999999");
        res.writeHead(303, { Location: callback.href });
        res.end();
        return;
      }
      if (path === "/app/installations") {
        json(
          res,
          state.installed
            ? [
                {
                  id: 42_001,
                  app_id: 95_001,
                  account: { login: "fixture" },
                  suspended_at: state.suspended
                    ? new Date().toISOString()
                    : null,
                  permissions: state.permissions,
                },
              ]
            : []
        );
        return;
      }
      if (path === "/app/installations/42001/access_tokens") {
        json(res, {
          token: "fixture-installation-token-42001",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
        return;
      }
      if (path === "/installation/repositories") {
        json(res, {
          repositories: state.removed
            ? []
            : [{ id: 70_001, full_name: "fixture/app", private: true }],
        });
        return;
      }
      if (path.endsWith("/check-runs") && req.method === "GET") {
        json(res, { check_runs: [] });
        return;
      }
      if (path.endsWith("/check-runs") && req.method === "POST") {
        await body(req);
        json(res, { id: 70_002 });
        return;
      }
      const response = await fetch(`${f.baseUrl}${req.url}`, {
        method: req.method,
        headers: { "Content-Type": "application/json" },
        ...(req.method === "GET"
          ? {}
          : { body: JSON.stringify(await body(req)) }),
      });
      res.writeHead(response.status, {
        "Content-Type":
          response.headers.get("content-type") ?? "application/json",
        ...(response.headers.get("x-commit-sha")
          ? { "x-commit-sha": response.headers.get("x-commit-sha")! }
          : {}),
      });
      res.end(await response.text());
    })().catch(() => json(res, { error: "GitHub setup fixture failed" }, 500));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, options.listenHost ?? "127.0.0.1", resolve)
  );
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    ...f,
    pem,
    secret,
    requests,
    state,
    api,
    config: {
      ...f.config,
      GITHUB_API_URL: api,
      GITHUB_TOKEN: "",
      GITHUB_ALLOWED_REPOS: "",
      allowedRepos: [],
      ARTIFACT_BASE_URL: "https://qa.example.test",
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await f.close();
    },
  };
}
