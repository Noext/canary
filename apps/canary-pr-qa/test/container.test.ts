import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { RunResult } from "../src/schema.js";
import { fixture, PR_URL } from "./fixture.js";
import { githubSetupFixture } from "./github-setup-fixture.js";

const exec = promisify(execFile);
const image = process.env.CANARY_DOCKER_IMAGE;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((fn) => fn()));
});
async function freePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}
async function container(broken = false, appSetup = false) {
  const f = appSetup
    ? await githubSetupFixture({ listenHost: "0.0.0.0" })
    : await fixture({ broken, listenHost: "0.0.0.0" });
  closers.push(f.close);
  const directory = await mkdtemp(join(tmpdir(), "canary-container-"));
  const envFile = join(directory, "fixture.env");
  const override = join(directory, "compose.yml");
  const project = `canaryqa${randomUUID().replaceAll("-", "")}`;
  const port = await freePort();
  const inside = `http://host.docker.internal:${new URL(f.config.GITHUB_API_URL).port}`;
  const values = {
    ...f.config,
    QA_DB_PASSWORD: "container-fixture-db-password-012345",
    QA_BROWSER_SERVICE_TOKEN: "container-fixture-browser-token-0123456789",
    QA_IMAGE: image,
    GITHUB_API_URL: inside,
    OPENAI_BASE_URL: `${inside}/v1`,
    PREVIEW_ALLOWED_HOSTS: new URL(inside).host,
    QA_PORT: port,
  };
  await writeFile(
    envFile,
    Object.entries(values)
      .filter(
        ([key, value]) =>
          key !== "CANARY_CLI_PATH" &&
          ["string", "number"].includes(typeof value)
      )
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    { mode: 0o600 }
  );
  await writeFile(override, `services:\n  pr-qa:\n    image: ${image}\n`);
  const compose = async (...args: string[]) =>
    await exec(
      "docker",
      [
        "compose",
        "--project-directory",
        repositoryRoot,
        "--env-file",
        envFile,
        "-p",
        project,
        "-f",
        join(repositoryRoot, "docker-compose.yml"),
        "-f",
        override,
        ...args,
      ],
      {
        env: { ...process.env, QA_ENV_FILE: envFile },
        timeout: 120_000,
        maxBuffer: 5_000_000,
      }
    );
  closers.push(async () => {
    try {
      const logs = await compose(
        "logs",
        "--no-color",
        "pr-qa",
        "worker",
        "browser",
        "egress",
        "db"
      );
      await writeFile(
        join(directory, "service.log"),
        `${logs.stdout}\n${logs.stderr}`
      );
    } finally {
      // Only this test's random Compose project and newly created test volumes.
      await compose("down", "--volumes", "--remove-orphans");
    }
  });
  await compose("up", "-d", "--no-build", "--pull", "never");
  const url = `http://127.0.0.1:${port}`;
  const waitHealthy = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if (
          (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }))
            .ok
        ) {
          return;
        }
      } catch {
        /* wait for container readiness */
      }
      await delay(200);
    }
    throw new Error(
      "Production container did not become healthy; inspect preserved service.log"
    );
  };
  await waitHealthy();
  const headers = {
    Authorization: `Bearer ${f.config.QA_API_TOKEN}`,
    "Content-Type": "application/json",
  };
  return { ...f, compose, inside, url, waitHealthy, headers };
}
async function execute(s: Awaited<ReturnType<typeof container>>) {
  const response = await fetch(`${s.url}/runs`, {
    method: "POST",
    headers: s.headers,
    body: JSON.stringify({ prUrl: PR_URL, previewUrl: s.inside }),
  });
  expect(response.status).toBe(202);
  const accepted = (await response.json()) as { id: string; statusUrl: string };
  for (let i = 0; i < 150; i++) {
    const job = (await (
      await fetch(`${s.url}${accepted.statusUrl}`, { headers: s.headers })
    ).json()) as { status: string };
    if (job.status === "completed") {
      const result = (await (
        await fetch(`${s.url}/artifacts/${accepted.id}/result.json`, {
          headers: s.headers,
        })
      ).json()) as RunResult;
      return { accepted, result };
    }
    if (["failed", "interrupted"].includes(job.status)) {
      throw new Error(`Container job ended ${JSON.stringify(job)}`);
    }
    await delay(200);
  }
  throw new Error("Container run did not complete within the test deadline");
}
describe.skipIf(!image)(
  "first installation of the production Compose image",
  () => {
    it("boots without a PAT, connects the App and runs through the worker after API/worker restart", async () => {
      const s = await container(false, true);
      const cookie = await localAccountFlow(s);
      const auth = { ...s.headers, Cookie: cookie };
      const registration = (await (
        await fetch(`${s.url}/github/app/manifest`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ name: "Canary Compose fixture" }),
        })
      ).json()) as { action: string };
      const state = new URL(registration.action).searchParams.get("state")!;
      expect(
        (
          await fetch(
            `${s.url}/github/app/callback?state=${state}&code=fixture-manifest-code`,
            { headers: auth, redirect: "manual" }
          )
        ).status
      ).toBe(303);
      expect(
        (
          await fetch(`${s.url}/github/app/repositories`, {
            method: "PUT",
            headers: auth,
            body: JSON.stringify({ repositories: ["fixture/app"] }),
          })
        ).status
      ).toBe(200);
      await s.compose("restart", "pr-qa", "worker");
      await s.waitHealthy();
      const status = (await (
        await fetch(`${s.url}/github/app`, { headers: auth })
      ).json()) as { app: { id: string } };
      expect(status.app.id).toBe("95001");
      const result = await execute(s);
      expect(result.result.outcome, JSON.stringify(result.result)).toBe(
        "passed"
      );
      expect(
        s.outgoing.some((request) => request.payload.state === "success")
      ).toBe(true);
    }, 180_000);
    it("starts under UID 1000 with new writable volumes, runs doctor and a real Chromium test, persists evidence across restart", async () => {
      const s = await container();
      expect(
        (
          await s.compose(
            "exec",
            "-T",
            "pr-qa",
            "node",
            "-e",
            "process.stdout.write(String(process.getuid()))"
          )
        ).stdout
      ).toBe("1000");
      const checked = JSON.parse(
        (
          await s.compose(
            "exec",
            "-T",
            "pr-qa",
            "canary-pr-qa",
            "doctor",
            "--json",
            "--pr",
            PR_URL,
            "--preview",
            s.inside
          )
        ).stdout
      );
      expect(checked.healthy, JSON.stringify(checked.checks)).toBe(true);
      expect(
        checked.checks.every((c: { status: string }) => c.status === "passed")
      ).toBe(true);
      expect(
        (await fetch(`${s.url}/runs`, { method: "POST", body: "{}" })).status
      ).toBe(401);
      const { accepted, result } = await execute(s);
      expect(result.outcome, JSON.stringify(result)).toBe("passed");
      expect(result.scenarios[0]?.assertions[0]?.actual).toBe("Welcome Ada");
      for (const extension of [".webm", ".zip", ".har", ".png"]) {
        const file = result.scenarios[0]?.artifacts.find((path) =>
          path.endsWith(extension)
        );
        expect(file).toBeDefined();
        const artifact = await fetch(
          `${s.url}/artifacts/${accepted.id}/welcome/${file}`,
          { headers: s.headers }
        );
        if ([".zip", ".har"].includes(extension)) {
          expect(artifact.status).toBe(403);
          // Raw files must exist, while default project policy prevents HTTP disclosure.
          const size = await s.compose(
            "exec",
            "-T",
            "pr-qa",
            "node",
            "-e",
            `process.stdout.write(String(require('node:fs').statSync(${JSON.stringify(`/data/${accepted.id}/welcome/${file}`)}).size))`
          );
          expect(Number(size.stdout)).toBeGreaterThan(0);
        } else {
          expect(artifact.ok, `${extension}: HTTP ${artifact.status}`).toBe(
            true
          );
          expect((await artifact.arrayBuffer()).byteLength).toBeGreaterThan(0);
        }
      }
      expect(
        s.outgoing.map((request) => request.payload.state).filter(Boolean)
      ).toEqual(["pending", "success"]);
      const support = (
        await s.compose(
          "exec",
          "-T",
          "pr-qa",
          "canary-pr-qa",
          "diagnose",
          accepted.id
        )
      ).stdout;
      expect(JSON.parse(support).result.outcome).toBe("passed");
      expect(support).not.toContain("Welcome Ada");
      const localCookie = await localAccountFlow(s);
      const publications = s.outgoing.length;
      await s.compose("restart", "pr-qa");
      await s.waitHealthy();
      expect(
        await (
          await fetch(`${s.url}${accepted.statusUrl}`, { headers: s.headers })
        ).json()
      ).toMatchObject({ status: "completed", progress: { phase: "done" } });
      expect(s.outgoing.length).toBe(publications);
      expect(
        (await fetch(`${s.url}/me`, { headers: { Cookie: localCookie } }))
          .status
      ).toBe(200);
    }, 180_000);
    it("detects a real broken UI inside the production image and posts failure with video evidence", async () => {
      const s = await container(true);
      const { result } = await execute(s);
      expect(result.outcome, JSON.stringify(result)).toBe("failed");
      expect(result.scenarios[0]?.assertions[0]).toMatchObject({
        passed: false,
        actual: "Wrong output",
      });
      expect(
        result.scenarios[0]?.artifacts.some((file) => file.endsWith(".webm"))
      ).toBe(true);
      expect(
        s.outgoing.filter((request) => request.payload.state).at(-1)?.payload
          .state
      ).toBe("failure");
    }, 180_000);
  }
);

async function localAccountFlow(s: Awaited<ReturnType<typeof container>>) {
  const output = (
    await s.compose(
      "exec",
      "-T",
      "pr-qa",
      "canary-pr-qa",
      "setup-admin",
      "--origin",
      s.url
    )
  ).stdout;
  const setupCode = /#setup=([a-f0-9]{64})/.exec(output)?.[1];
  expect(setupCode).toBeDefined();
  const credentials = {
    username: "container-admin",
    password: "container-password-long-2026",
  };
  const request = (path: string, payload: unknown) =>
    fetch(`${s.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: s.url },
      body: JSON.stringify(payload),
    });
  const setup = await request("/auth/setup", { ...credentials, setupCode });
  expect(setup.status).toBe(200);
  const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (await fetch(`${s.url}/me`, { headers: { Cookie: cookie } })).status
  ).toBe(200);
  const reset = await s.compose(
    "exec",
    "-T",
    "pr-qa",
    "sh",
    "-c",
    "printf %s 'container-replacement-password-2026' | canary-pr-qa reset-password container-admin"
  );
  expect(reset.stdout).toContain("All local sessions revoked");
  expect(
    (await fetch(`${s.url}/me`, { headers: { Cookie: cookie } })).status
  ).toBe(401);
  expect((await request("/auth/login", credentials)).status).toBe(401);
  const login = await request("/auth/login", {
    ...credentials,
    password: "container-replacement-password-2026",
  });
  expect(login.status).toBe(200);
  return login.headers.get("set-cookie")!.split(";")[0]!;
}
