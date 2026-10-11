import { mkdir, readFile, writeFile } from "node:fs/promises";
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
      { prUrl: PR_URL, previewUrl: s.baseUrl, publish: true, id: job.id },
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
