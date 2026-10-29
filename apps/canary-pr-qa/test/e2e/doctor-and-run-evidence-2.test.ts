import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Canary, compileAction } from "../../src/canary.js";
import { executeScenario } from "../../src/executor.js";
import { fixture, plan } from "../fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  vi.restoreAllMocks();
});

it("checks persistence after real reload and fails a missing storage write", async () => {
  for (const broken of [false, true]) {
    const f = await fixture({ persistent: true, persistenceBroken: broken });
    closers.push(f.close);
    const scenario = structuredClone(plan.scenarios[0]!);
    scenario.assertions[0]!.verification = "persisted";
    const result = await executeScenario(
      scenario,
      f.baseUrl,
      f.dataDir,
      f.config,
      new Canary(f.config)
    );
    expect(result.outcome, result.error).toBe(broken ? "failed" : "passed");
    expect(result.assertions[0]?.persisted).toBe(broken ? "" : "Welcome Ada");
  }
}, 180_000);
it("blocks actual page subrequests outside the approved host and port", async () => {
  let hits = 0;
  const sink = createServer((_req, res) => {
    hits++;
    res.end("not allowed");
  });
  await new Promise<void>((done) => sink.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise<void>((done) => sink.close(() => done())));
  const address = sink.address() as { port: number };
  const f = await fixture({
    maliciousUrl: `http://127.0.0.1:${address.port}/probe`,
  });
  closers.push(f.close);
  const canary = new Canary(f.config);
  const id = await canary.start("Network isolation probe");
  try {
    await canary.act(
      id,
      "open",
      compileAction({ type: "goto", path: f.baseUrl }, f.baseUrl)
    );
    await canary.act(
      id,
      "observe",
      compileAction({ type: "observe" }, f.baseUrl)
    );
    expect(hits).toBe(0);
    await canary.end(id, join(f.dataDir, "network"));
  } finally {
    await canary.abort(id);
  }
}, 180_000);
it("installs trusted role cookies before navigation, with no secrets sent to the model", async () => {
  const f = await fixture({ requireCookie: true });
  closers.push(f.close);
  const file = join(f.dataDir, "fixtures.json");
  await writeFile(
    file,
    JSON.stringify({ "fixture/app": { roles: { member: "QA_E2E_ROLE" } } })
  );
  vi.stubEnv(
    "QA_E2E_ROLE",
    JSON.stringify({
      cookies: [
        {
          name: "qa_role",
          value: "test-member-secret",
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
          expires: -1,
        },
      ],
      origins: [],
    })
  );
  const config = { ...f.config, QA_FIXTURES_FILE: file };
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.preconditions = ["role:member"];
  try {
    const result = await executeScenario(
      scenario,
      f.baseUrl,
      f.dataDir,
      config,
      new Canary(config),
      undefined,
      "fixture/app"
    );
    expect(result.outcome, result.error).toBe("passed");
    expect(JSON.stringify(f.modelRequests)).not.toContain("test-member-secret");
  } finally {
    vi.unstubAllEnvs();
  }
}, 180_000);
it("verifies real download and popup events through the immutable scenario contract", async () => {
  const f = await fixture();
  closers.push(f.close);
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.id = "browser-events";
  scenario.steps = [
    {
      id: "open",
      description: "Open the preview",
      action: { type: "goto", path: "/" },
    },
    {
      id: "download",
      description: "Download the report",
      action: {
        type: "download",
        locator: { by: "role", value: "link", name: "Download report" },
        assertionId: "downloaded",
      },
    },
    {
      id: "popup",
      description: "Open popup",
      action: {
        type: "popup",
        locator: { by: "role", value: "link", name: "Open popup" },
        assertionId: "opened",
      },
    },
  ];
  scenario.assertions = [
    {
      id: "downloaded",
      description: "Correct file downloaded",
      kind: "download",
      expected: "report.txt",
      afterStep: "open",
      verification: "state",
    },
    {
      id: "opened",
      description: "Correct popup opened",
      kind: "popup",
      expected: `${f.baseUrl}/popup`,
      afterStep: "open",
      verification: "state",
    },
  ];
  const result = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    f.config,
    new Canary(f.config)
  );
  expect(result.outcome, result.error).toBe("passed");
  expect(result.assertions.map((a) => a.actual)).toEqual([
    "report.txt",
    `${f.baseUrl}/popup`,
  ]);
}, 180_000);
it("compares real screenshots with a trusted baseline and rejects a changed image", async () => {
  const f = await fixture();
  closers.push(f.close);
  const canary = new Canary(f.config);
  const id = await canary.start("Trusted visual test oracle");
  let image: string;
  const assertion = {
    id: "visual",
    description: "Heading appearance",
    kind: "visual" as const,
    expected: "heading",
    target: { by: "css" as const, value: "h1" },
    afterStep: "open",
    verification: "state" as const,
  };
  try {
    await canary.act(
      id,
      "open",
      compileAction({ type: "goto", path: "/" }, f.baseUrl)
    );
    image = (
      await canary.act(
        id,
        "capture",
        compileAction(
          { type: "assert", assertionId: "visual", locator: assertion.target },
          f.baseUrl,
          assertion
        )
      )
    ).actual as string;
    await canary.end(id, join(f.dataDir, "visual-oracle"));
  } finally {
    await canary.abort(id);
  }
  const baseline = join(f.dataDir, "baseline.png");
  await writeFile(baseline, Buffer.from(image!, "base64"));
  const fixturesFile = join(f.dataDir, "visual-fixtures.json");
  await writeFile(
    fixturesFile,
    JSON.stringify({ "fixture/app": { visuals: { heading: baseline } } })
  );
  const config = { ...f.config, QA_FIXTURES_FILE: fixturesFile };
  const scenario = structuredClone(plan.scenarios[0]!);
  scenario.id = "visual-heading";
  scenario.steps = [
    {
      id: "open",
      description: "Open preview",
      action: { type: "goto", path: "/" },
    },
    {
      id: "verify",
      description: "Compare appearance",
      action: { type: "assert", assertionId: "visual" },
    },
  ];
  scenario.assertions = [assertion];
  const healthy = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    config,
    new Canary(config),
    undefined,
    "fixture/app"
  );
  expect(healthy.outcome, healthy.error).toBe("passed");
  const { PNG } = await import("pngjs");
  const changed = PNG.sync.read(Buffer.from(image!, "base64"));
  changed.data.fill(255);
  await writeFile(baseline, PNG.sync.write(changed));
  const broken = await executeScenario(
    scenario,
    f.baseUrl,
    f.dataDir,
    config,
    new Canary(config),
    undefined,
    "fixture/app"
  );
  expect(broken.outcome, broken.error).toBe("failed");
}, 180_000);
