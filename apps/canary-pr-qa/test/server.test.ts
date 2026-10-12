import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runQa } from "../src/runner.js";
import { startServer } from "../src/server.js";
import { fixture, PR_URL } from "./fixture.js";

vi.mock("../src/runner.js", () => ({ runQa: vi.fn() }));
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((fn) => fn()));
});
async function service() {
  const f = await fixture();
  closers.push(f.close);
  const server = await startServer({ ...f.config, QA_PORT: 0 });
  closers.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      })
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No service address");
  }
  return {
    ...f,
    server,
    url: `http://127.0.0.1:${address.port}`,
    headers: {
      Authorization: `Bearer ${f.config.QA_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
}
describe("persistent authenticated job service", () => {
  it("returns actionable errors for oversized or malformed JSON without echoing submitted data", async () => {
    const s = await service();
    const huge = await fetch(`${s.url}/runs`, {
      method: "POST",
      headers: s.headers,
      body: JSON.stringify({ prUrl: PR_URL, extra: "x".repeat(20_000) }),
    });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    const malformed = await fetch(`${s.url}/runs`, {
      method: "POST",
      headers: s.headers,
      body: '{"secret": "private-malformed-value',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain("private-malformed-value");
    expect(runQa).not.toHaveBeenCalled();
  });
  it("rejects a port conflict as a diagnosable startup error", async () => {
    const s = await service();
    const port = (s.server.address() as { port: number }).port;
    await expect(
      startServer({ ...s.config, QA_PORT: port })
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
  it("bounds the queue even during simultaneous submissions", async () => {
    const s = await service();
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    vi.mocked(runQa).mockImplementation(async () => {
      await pending;
      return {
        id: "fixture",
        prUrl: PR_URL,
        outcome: "passed",
        startedAt: "now",
        scenarios: [],
      };
    });
    const responses = await Promise.all(
      Array.from({ length: 45 }, () =>
        fetch(`${s.url}/runs`, {
          method: "POST",
          headers: s.headers,
          body: JSON.stringify({ prUrl: PR_URL }),
        })
      )
    );
    expect(
      responses.filter((r) => r.status === 202).length
    ).toBeLessThanOrEqual(21);
    expect(responses.some((r) => r.status === 429)).toBe(true);
    const health = (await (await fetch(`${s.url}/health`)).json()) as {
      queued: number;
    };
    expect(health.queued).toBeLessThanOrEqual(20);
    const stopped = s.server.shutdown();
    release();
    await stopped;
    expect(runQa).toHaveBeenCalledTimes(1);
  });
  it("reports failed persistence through health and refuses more jobs", async () => {
    const s = await service();
    const reports = await import("../src/report.js");
    const original = reports.writeJson;
    let writes = 0;
    vi.spyOn(reports, "writeJson").mockImplementation(async (path, value) => {
      if (path.endsWith("job.json") && ++writes > 1) {
        throw Object.assign(new Error("simulated full disk"), {
          code: "ENOSPC",
        });
      }
      await original(path, value);
    });
    const submitted = await fetch(`${s.url}/runs`, {
      method: "POST",
      headers: s.headers,
      body: JSON.stringify({ prUrl: PR_URL }),
    });
    expect(submitted.status).toBe(202);
    let health: Response | undefined;
    for (let i = 0; i < 50; i++) {
      health = await fetch(`${s.url}/health`);
      if (health.status === 503) {
        break;
      }
      await delay(10);
    }
    expect(health?.status).toBe(503);
    expect(await health?.json()).toMatchObject({
      ok: false,
      diagnostic: { code: "ENOSPC" },
    });
    expect(
      (
        await fetch(`${s.url}/runs`, {
          method: "POST",
          headers: s.headers,
          body: JSON.stringify({ prUrl: PR_URL }),
        })
      ).status
    ).toBe(503);
  });
  it("exposes persisted live action progress and returns 404 for an unknown run", async () => {
    const s = await service();
    const id = "12345678-1234-1234-1234-123456789012";
    await mkdir(join(s.dataDir, id));
    await writeFile(
      join(s.dataDir, id, "job.json"),
      JSON.stringify({ id, status: "running" })
    );
    await writeFile(
      join(s.dataDir, id, "progress.json"),
      JSON.stringify({ phase: "execution", step: 3, action: "assert" })
    );
    expect(
      await (await fetch(`${s.url}/runs/${id}`, { headers: s.headers })).json()
    ).toMatchObject({
      status: "running",
      progress: { step: 3, action: "assert" },
    });
    const response = await fetch(
      `${s.url}/runs/87654321-1234-1234-1234-123456789012`,
      { headers: s.headers }
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("X-Request-ID")).toBeTruthy();
    expect(await response.json()).toHaveProperty("hint");
  });
  it("blocks a symlink to an artifact outside its run", async () => {
    const s = await service();
    const id = "12345678-1234-1234-1234-123456789012";
    await mkdir(join(s.dataDir, id));
    await writeFile(join(s.dataDir, "outside.html"), "private data");
    await symlink(
      join(s.dataDir, "outside.html"),
      join(s.dataDir, id, "report.html")
    );
    const response = await fetch(`${s.url}/artifacts/${id}/report.html`, {
      headers: s.headers,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private data");
  });
  it("requires strong API auth and an explicit repository allowlist", async () => {
    const f = await fixture();
    closers.push(f.close);
    await expect(
      startServer({ ...f.config, QA_API_TOKEN: "short" })
    ).rejects.toThrow();
    await expect(
      startServer({ ...f.config, allowedRepos: [] })
    ).rejects.toThrow();
    const s = await service();
    expect((await fetch(`${s.url}/health`)).status).toBe(200);
    expect(
      (await fetch(`${s.url}/runs`, { method: "POST", body: "{}" })).status
    ).toBe(401);
    expect(
      (
        await fetch(`${s.url}/runs`, {
          method: "POST",
          headers: s.headers,
          body: JSON.stringify({
            prUrl: "https://github.com/other/repo/pull/1",
          }),
        })
      ).status
    ).toBe(400);
    expect(runQa).not.toHaveBeenCalled();
  });
  it("persists and executes a queued job, then exposes authenticated status", async () => {
    const s = await service();
    vi.mocked(runQa).mockResolvedValue({
      id: "fixture",
      prUrl: PR_URL,
      outcome: "passed",
      startedAt: "now",
      scenarios: [],
    });
    const response = await fetch(`${s.url}/runs`, {
      method: "POST",
      headers: s.headers,
      body: JSON.stringify({ prUrl: PR_URL, previewUrl: s.baseUrl }),
    });
    expect(response.status).toBe(202);
    const job = (await response.json()) as { id: string; statusUrl: string };
    for (let i = 0; i < 50; i++) {
      const state = (await (
        await fetch(`${s.url}${job.statusUrl}`, { headers: s.headers })
      ).json()) as { status: string };
      if (state.status === "completed") {
        break;
      }
      await delay(10);
    }
    expect(runQa).toHaveBeenCalledWith(
      {
        prUrl: PR_URL,
        previewUrl: s.baseUrl,
        publish: true,
        id: job.id,
        model: "fixture-scripted-model",
      },
      expect.anything()
    );
    expect(
      JSON.parse(await readFile(join(s.dataDir, job.id, "job.json"), "utf8"))
        .status
    ).toBe("completed");
  });
  it("blocks artifact traversal, job metadata and unauthenticated access", async () => {
    const s = await service();
    const id = "12345678-1234-1234-1234-123456789012";
    await mkdir(join(s.dataDir, id));
    await writeFile(join(s.dataDir, id, "report.html"), "fixture report");
    await writeFile(join(s.dataDir, id, "job.json"), "{}");
    expect((await fetch(`${s.url}/artifacts/${id}/report.html`)).status).toBe(
      401
    );
    expect(
      await (
        await fetch(`${s.url}/artifacts/${id}/report.html`, {
          headers: s.headers,
        })
      ).text()
    ).toBe("fixture report");
    expect(
      (await fetch(`${s.url}/artifacts/${id}/job.json`, { headers: s.headers }))
        .status
    ).toBe(400);
    expect(
      (
        await fetch(`${s.url}/artifacts/${id}/%2e%2e%2foutside.json`, {
          headers: s.headers,
        })
      ).status
    ).toBe(400);
  });
  it("marks interrupted jobs after a restart instead of replaying them", async () => {
    const f = await fixture();
    closers.push(f.close);
    const id = "12345678-1234-1234-1234-123456789012";
    await mkdir(join(f.dataDir, id));
    await writeFile(
      join(f.dataDir, id, "job.json"),
      JSON.stringify({ id, status: "running", input: { prUrl: PR_URL } })
    );
    const server: Server = await startServer({ ...f.config, QA_PORT: 0 });
    closers.push(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        })
    );
    expect(
      JSON.parse(await readFile(join(f.dataDir, id, "job.json"), "utf8")).status
    ).toBe("interrupted");
    expect(runQa).not.toHaveBeenCalled();
  });
});
