import { readdir, readFile, stat } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../../src/doctor.js";
import { runQa } from "../../src/runner.js";
import { fixture, PR_URL, SHA } from "../fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

describe("real Canary Chromium with GitHub/AI REST fixtures", () => {
  it("runs the installation doctor through actual Chromium, REST/model and SHA probes without publishing", async () => {
    const f = await fixture();
    closers.push(f.close);
    const result = await doctor(f.config, {
      prUrl: PR_URL,
      previewUrl: f.baseUrl,
    });
    expect(result.healthy, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.filter((check) => check.status !== "passed")).toEqual(
      []
    );
    expect(f.outgoing).toEqual([]);
    expect(await readdir(join(f.dataDir, "_doctor"))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(f.config.GITHUB_TOKEN);
  }, 180_000);
  it("plays the form test, records video/trace/screenshots and publishes passed results", async () => {
    const f = await fixture({ unnamedStatus: true });
    closers.push(f.close);
    const result = await runQa(
      {
        prUrl: PR_URL,
        previewUrl: f.baseUrl,
        model: "fixture-alternate-model",
      },
      f.config
    );
    expect(result.model).toBe("fixture-alternate-model");
    expect(
      f.modelRequests.every(
        (request) => request.model === "fixture-alternate-model"
      )
    ).toBe(true);
    expect(result.outcome, result.error ?? result.scenarios[0]?.error).toBe(
      "passed"
    );
    expect(result.sha).toBe(SHA);
    const scenario = result.scenarios[0]!;
    expect(scenario.assertions).toEqual([
      {
        id: "saved",
        passed: true,
        actual: "Welcome Ada",
        baseline: "",
        // Instrumentation de mesure : le type et la preuve d'exécution sont
        // publiés dans l'artefact, pas seulement le résultat.
        verification: "transition",
        changed: true,
      },
    ]);
    expect(scenario.steps.map((step) => step.action.type)).toEqual([
      "fill",
      "click",
      "assert",
    ]);
    for (const extension of [".webm", ".zip", ".png", ".har"]) {
      const file = scenario.artifacts.find((path) => path.endsWith(extension));
      expect(file, `missing ${extension}`).toBeDefined();
      expect(
        (await stat(join(f.dataDir, result.id, "welcome", file!))).size
      ).toBeGreaterThan(0);
    }
    expect(
      f.outgoing.map((request) => request.payload.state).filter(Boolean)
    ).toEqual(["pending", "success"]);
    expect(
      f.outgoing.find((request) => request.path.endsWith("/comments"))?.payload
        .body
    ).toContain("PASSED");
    const html = await readFile(
      join(f.dataDir, result.id, "report.html"),
      "utf8"
    );
    expect(html).toContain("<video controls");
    expect(html).not.toContain("fixture-token");
    process.stdout.write(
      `E2E passed report: ${join(f.dataDir, result.id, "report.html")}\n`
    );
  }, 180_000);
  it("detects an actual UI regression and publishes failure with the recorded video", async () => {
    const f = await fixture({ broken: true });
    closers.push(f.close);
    const result = await runQa(
      { prUrl: PR_URL, previewUrl: f.baseUrl },
      f.config
    );
    expect(result.outcome, result.error ?? result.scenarios[0]?.error).toBe(
      "failed"
    );
    expect(result.scenarios[0]?.assertions).toEqual([
      {
        id: "saved",
        passed: false,
        actual: "Wrong output",
        baseline: "",
        verification: "transition",
        changed: true,
      },
    ]);
    expect(
      f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
        .state
    ).toBe("failure");
    expect(
      result.scenarios[0]?.artifacts.some((file) => file.endsWith(".webm"))
    ).toBe(true);
    process.stdout.write(
      `E2E failed-case report: ${join(f.dataDir, result.id, "report.html")}\n`
    );
  }, 180_000);
  it.skipIf(!process.env.CANARY_DAEMON_PORT)(
    "rejects an unauthorized request on the actual loopback daemon",
    async () => {
      await new Promise<void>((done, reject) => {
        const socket = net.connect({
          host: "127.0.0.1",
          port: Number(process.env.CANARY_DAEMON_PORT),
        });
        let output = "";
        socket.setTimeout(3000, () => {
          socket.destroy();
          reject(new Error("Authentication test timed out"));
        });
        socket.on("connect", () =>
          socket.write(
            `${JSON.stringify({
              id: "unauthorized",
              type: "status",
              transportToken: "wrong-token",
            })}\n`
          )
        );
        socket.on("data", (data) => {
          output += data.toString();
        });
        socket.on("error", reject);
        socket.on("close", () => {
          if (output) {
            reject(new Error("Unauthenticated daemon returned data"));
          } else {
            done();
          }
        });
      });
    }
  );
});
