import { afterEach, expect, it, vi } from "vitest";
import { Canary } from "../src/canary.js";
import { runQa } from "../src/runner.js";
import type { Plan, Scenario } from "../src/schema.js";
import { BASE_SHA, fixture, PR_URL } from "./fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const ARIA = `- form [ref=e1]:
  - textbox "Name" [ref=e2]
  - button "Save" [ref=e3]`;

/**
 * `baseActual` est ce que montre la préversion de base (ouverte sur
 * `/baseline`) : une base identique à la tête rendrait toute preuve non
 * discriminante (`OBJECTIVE_NOT_DISCRIMINATING`), ce que ces tests ne visent pas.
 */
function fakeBrowser(baseActual = "Welcome Ada") {
  let onBase = false;
  vi.spyOn(Canary.prototype, "start").mockResolvedValue("fixture-session");
  vi.spyOn(Canary.prototype, "act").mockImplementation(
    async (_id, label, script) => {
      if (label === "open-preview") {
        onBase = script.includes("/baseline");
      }
      const shown = onBase ? baseActual : "Welcome Ada";
      return {
        url: "http://fixture/",
        snapshot: ARIA,
        evidence: label === "discover-preview" ? ARIA : undefined,
        actual: label.endsWith("assert") ? shown : undefined,
      };
    }
  );
  vi.spyOn(Canary.prototype, "end").mockResolvedValue([
    "video.webm",
    "trace.zip",
  ]);
}

const requirement = {
  sourceFile: "src/form.ts",
  quote: "show('Welcome '+name)",
  behavior: "Save the name via the form",
};

const staticScenario: Scenario = {
  id: "static-banner",
  title: "The welcome banner is visible after load",
  kind: "regression",
  rationale: "The diff changes the saved welcome output",
  sourceFiles: ["src/form.ts"],
  preconditions: [],
  requirements: [requirement],
  steps: [
    {
      id: "open",
      description: "Open the preview",
      action: { type: "goto", path: "/" },
    },
    {
      id: "verify",
      description: "Verify the banner",
      action: { type: "assert", assertionId: "banner" },
    },
  ],
  assertions: [
    {
      id: "banner",
      description: "The banner shows the saved name",
      kind: "text",
      expected: "Welcome Ada",
      target: { by: "css", value: "#saved" },
      afterStep: "open",
      verification: "state",
    },
  ],
};

function switchViewScenario(verification: "state" | "transition"): Scenario {
  return {
    id: "switch-view",
    title: "Switching view keeps the initial banner",
    kind: "happy_path",
    rationale: "The diff changes the view title and the shared banner",
    sourceFiles: ["src/form.ts"],
    preconditions: [],
    requirements: [requirement],
    steps: [
      {
        id: "open",
        description: "Open the preview",
        action: { type: "goto", path: "/" },
      },
      {
        id: "switch",
        description: "Switch to the other view",
        action: {
          type: "click",
          locator: { by: "role", value: "button", name: "Save" },
        },
      },
      {
        id: "verify",
        description: "Verify the banner",
        action: { type: "assert", assertionId: "banner" },
      },
    ],
    assertions: [
      {
        id: "banner",
        description: "The banner shows the saved name",
        kind: "text",
        expected: "Welcome Ada",
        target: { by: "css", value: "#saved" },
        afterStep: "switch",
        verification,
      },
    ],
  };
}

function planWith(...scenarios: Scenario[]): Plan {
  return {
    summary: "Cover the changed welcome output",
    scenarios,
    skipped: [],
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function plannerMessages(f: Fixture): unknown[][] {
  return f.modelRequests
    .filter((request) =>
      (request.messages as { content: string }[])[0]?.content.startsWith(
        "You plan"
      )
    )
    .map((request) => request.messages as unknown[]);
}
function plannerFeedback(f: Fixture): string[] {
  return plannerMessages(f)
    .filter((messages) => messages.length > 2)
    .map((messages) => (messages.at(-1) as { content: string }).content);
}

it("blocks only the scenario that interacts without change evidence", async () => {
  const f = await fixture({
    plans: [planWith(staticScenario, switchViewScenario("state"))],
  });
  cleanup.push(f.close);
  fakeBrowser();
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(
    result.scenarios.map((item) => [item.scenario.id, item.outcome])
  ).toEqual([
    ["static-banner", "passed"],
    ["switch-view", "blocked"],
  ]);
  expect(result.outcome).toBe("blocked");
  expect(result.diagnostic).toBeUndefined();
  const refused = result.scenarios[1]!;
  expect(refused.diagnostic?.code).toBe("WRITE_EVIDENCE_MISSING");
  expect(refused.error).toContain("switch-view");
  expect(refused.error).toContain("changed/persisted state evidence");
  expect(refused.diagnostic?.hint).toContain(
    "transition or persisted assertion"
  );
  expect(refused.steps).toEqual([]);
  expect(refused.assertions).toEqual([]);
  expect(
    f.outgoing.filter((request) => request.payload.state).at(-1)?.payload
  ).toMatchObject({ state: "error" });
  expect(plannerMessages(f)).toHaveLength(2);
  expect(plannerFeedback(f)).toEqual([expect.stringContaining("switch-view")]);
  expect(plannerFeedback(f)[0]).toContain("transition or persisted assertion");
});

it("re-plans once and executes the repaired plan", async () => {
  const f = await fixture({
    plans: [
      planWith(staticScenario, switchViewScenario("state")),
      planWith(staticScenario, switchViewScenario("transition")),
    ],
  });
  cleanup.push(f.close);
  fakeBrowser();
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(result.outcome).toBe("passed");
  expect(result.scenarios.map((item) => item.outcome)).toEqual([
    "passed",
    "passed",
  ]);
  expect(plannerMessages(f)).toHaveLength(2);
  expect(result.plan?.scenarios[1]?.assertions[0]?.verification).toBe(
    "transition"
  );
});

it("ignores the write-evidence rule when the trusted policy disables it", async () => {
  const f = await fixture({
    plans: [planWith(switchViewScenario("state"))],
    requireWriteEvidence: false,
  });
  cleanup.push(f.close);
  fakeBrowser();
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    f.config
  );
  expect(result.outcome).toBe("passed");
  expect(plannerMessages(f)).toHaveLength(1);
  expect(result.scenarios).toHaveLength(1);
  expect(
    result.scenarios[0]?.steps.some((step) => step.action.type === "click")
  ).toBe(true);
});

it("keeps a write-refused scenario out of the baseline run", async () => {
  const f = await fixture({
    plans: [planWith(staticScenario, switchViewScenario("state"))],
  });
  cleanup.push(f.close);
  // La base précède le diff : elle affiche encore l'ancien message.
  fakeBrowser("Hello Ada");
  const result = await runQa(
    { prUrl: PR_URL, previewUrl: f.baseUrl },
    { ...f.config, QA_BASELINE_URL_TEMPLATE: `${f.baseUrl}/baseline` }
  );
  expect(result.baseline?.sha).toBe(BASE_SHA);
  // La bannière lue par la tête échoue sur la base : comportement modifié.
  expect(
    result.baselineComparison?.changes.map((item) => item.assertionId)
  ).toEqual(["banner"]);
  expect(result.baseline?.scenarios.map((item) => item.scenario.id)).toEqual([
    "static-banner",
  ]);
  expect(
    result.scenarios.map((item) => [item.scenario.id, item.outcome])
  ).toEqual([
    ["static-banner", "passed"],
    ["switch-view", "blocked"],
  ]);
  expect(result.outcome).toBe("blocked");
});
