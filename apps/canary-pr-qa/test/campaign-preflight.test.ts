import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CampaignPlan,
  campaignPreflight,
  maxCostEstimate,
} from "../src/campaign-preflight.js";
import { loadConfig } from "../src/config.js";
import { QaError } from "../src/diagnostics.js";
import { GitHub } from "../src/github.js";
import { ModelCatalog } from "../src/model-catalog.js";

/**
 * Le préflight doit refuser **avant** toute dépense, avec un code précis et une
 * action corrective. Chaque test neutralise une seule dépendance : la PR, le
 * catalogue du modèle, ou la preuve de SHA de la preview. Aucun réseau.
 */

const preview = vi.hoisted(() => ({
  behaviour: "ok" as "ok" | "missing" | "mismatch",
  sha: "e".repeat(40),
}));

vi.mock("../src/preview.js", () => ({
  verifyPreviewUrl: async (url: string, expected: string) => {
    if (preview.behaviour === "missing") {
      throw new QaError(
        "PREVIEW_UNVERIFIED",
        "Preview SHA mismatch or missing provenance",
        "Expose x-commit-sha"
      );
    }
    const sha = preview.behaviour === "mismatch" ? preview.sha : expected;
    return { evidence: `x-commit-sha: ${sha}`, sha, url };
  },
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  preview.behaviour = "ok";
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function tempDir(prefix = "canary-preflight-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(path, { force: true, recursive: true }));
  return path;
}

/** Un bras réel : un dépôt git sur un commit connu, avec son CLI construit. */
async function arm(name: "reference" | "candidate") {
  const worktree = await tempDir(`canary-arm-${name}-`);
  await mkdir(join(worktree, "apps/canary-pr-qa/dist"), { recursive: true });
  await writeFile(
    join(worktree, "apps/canary-pr-qa/dist/cli.js"),
    "// built\n"
  );
  execFileSync("git", ["init", "-q", worktree]);
  execFileSync("git", ["-C", worktree, "add", "-A"]);
  execFileSync("git", [
    "-C",
    worktree,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "-m",
    name,
  ]);
  const commit = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return { commit, name, worktree };
}

function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    GITHUB_TOKEN: "fixture-github-token-1234567890",
    OPENAI_API_KEY: "fixture-key-1234567890",
    OPENAI_BASE_URL: "https://ai.fixture.test/v1",
    OPENAI_MODEL: "fixture-model",
    PREVIEW_ALLOWED_HOSTS: "preview.fixture.test",
    QA_API_TOKEN: "fixture-api-token-123456789012345",
    QA_DATA_DIR: "/tmp/canary-campaign-data",
    QA_INPUT_COST_PER_MILLION: "1",
    QA_OUTPUT_COST_PER_MILLION: "4",
    ...overrides,
  });
}

async function plan(): Promise<CampaignPlan> {
  const reference = await arm("reference");
  const candidate = await arm("candidate");
  return {
    arms: [reference, candidate],
    dataDir: await tempDir("canary-campaign-data-"),
    headSha: "d".repeat(40),
    previewUrl: "https://preview.fixture.test/",
    prUrl: "https://github.com/fixture/app/pull/1",
  };
}

function stubPr(head: string | Error) {
  return vi.spyOn(GitHub.prototype, "context").mockImplementation(async () => {
    if (head instanceof Error) {
      throw head;
    }
    return { sha: head } as never;
  });
}

function stubCatalog(ids: string[] | Error) {
  return vi
    .spyOn(ModelCatalog.prototype, "list")
    .mockImplementation(async () => {
      if (ids instanceof Error) {
        throw ids;
      }
      return ids;
    });
}

function codes(blockers: { code: string }[]): string[] {
  return blockers.map((blocker) => blocker.code);
}

describe("une dépendance absente bloque avant la dépense", () => {
  it("bloque quand la PR n'est pas lisible avec les credentials de Canary", async () => {
    stubPr(
      new QaError(
        "HTTP_404",
        "HTTP 404 from api.github.com/repos/fixture/app/pulls/1",
        "Check repository access"
      )
    );
    stubCatalog(["fixture-model"]);
    const { blockers, prSha } = await campaignPreflight(await plan(), config());
    expect(codes(blockers)).toContain("PR_UNREADABLE");
    expect(prSha).toBeUndefined();
    const blocker = blockers.find((item) => item.code === "PR_UNREADABLE");
    expect(blocker?.detail).toMatch(/HTTP 404/);
    expect(blocker?.fix).toMatch(/GITHUB_TOKEN|App GitHub/);
  });

  it("bloque quand le head de la PR n'est pas le SHA que la campagne testerait", async () => {
    stubPr("f".repeat(40));
    stubCatalog(["fixture-model"]);
    const { blockers, prSha } = await campaignPreflight(await plan(), config());
    expect(codes(blockers)).toContain("PR_HEAD_MISMATCH");
    expect(prSha).toBe("f".repeat(40));
    expect(
      blockers.find((item) => item.code === "PR_HEAD_MISMATCH")?.detail
    ).toMatch(/La PR est sur f{40}/);
  });

  it("bloque quand la clé du modèle est refusée (401)", async () => {
    stubPr("d".repeat(40));
    stubCatalog(
      new QaError(
        "HTTP_401",
        "HTTP 401 from ai.fixture.test/v1/models",
        "Check token"
      )
    );
    const { blockers } = await campaignPreflight(await plan(), config());
    expect(codes(blockers)).toContain("MODEL_UNAUTHORIZED");
    expect(
      blockers.find((item) => item.code === "MODEL_UNAUTHORIZED")?.detail
    ).toMatch(/HTTP_401/);
  });

  it("bloque quand l'endpoint du modèle ne répond pas", async () => {
    stubPr("d".repeat(40));
    stubCatalog(
      new Error("fetch failed: getaddrinfo ENOTFOUND ai.fixture.test")
    );
    const { blockers } = await campaignPreflight(await plan(), config());
    expect(codes(blockers)).toContain("MODEL_ENDPOINT_UNREACHABLE");
  });

  it("bloque quand le catalogue est vide : aucun modèle de repli n'est inventé", async () => {
    stubPr("d".repeat(40));
    stubCatalog([]);
    const { blockers } = await campaignPreflight(await plan(), config());
    expect(codes(blockers)).toContain("MODEL_CATALOG_EMPTY");
  });

  it("bloque quand les tarifs ne sont pas renseignés", async () => {
    stubPr("d".repeat(40));
    stubCatalog(["fixture-model"]);
    const { blockers, maxCost } = await campaignPreflight(
      await plan(),
      config({
        QA_INPUT_COST_PER_MILLION: "0",
        QA_OUTPUT_COST_PER_MILLION: "0",
      })
    );
    expect(codes(blockers)).toContain("PRICING_MISSING");
    // Sans tarif, aucun coût maximal n'est annoncé : pas de zéro trompeur.
    expect(maxCost).toBeUndefined();
  });

  it("bloque quand la preview n'expose aucun SHA", async () => {
    stubPr("d".repeat(40));
    stubCatalog(["fixture-model"]);
    preview.behaviour = "missing";
    const { blockers } = await campaignPreflight(await plan(), config());
    expect(codes(blockers)).toContain("PREVIEW_UNVERIFIED");
  });

  it("bloque quand la preview expose un autre SHA que le head de la PR", async () => {
    stubPr("d".repeat(40));
    stubCatalog(["fixture-model"]);
    preview.behaviour = "mismatch";
    const { blockers, previewSha } = await campaignPreflight(
      await plan(),
      config()
    );
    expect(codes(blockers)).toContain("PREVIEW_SHA_MISMATCH");
    expect(previewSha).toBe(preview.sha);
  });
});

describe("quand toutes les dépendances répondent, le préflight est vert", () => {
  it("rend ready, le SHA de la PR, celui de la preview et le coût maximal", async () => {
    stubPr("d".repeat(40));
    stubCatalog(["fixture-model"]);
    const { blockers, maxCost, previewSha, prSha } = await campaignPreflight(
      await plan(),
      config()
    );
    expect(blockers).toEqual([]);
    expect(prSha).toBe("d".repeat(40));
    expect(previewSha).toBe("d".repeat(40));
    // 100 runs × plafond par défaut de 1 000 000 tokens (QA_RUN_MAX_TOKENS,
    // relevé pour financer une planification réelle de la PR #20) × 4 $/M (le
    // plus cher des deux tarifs). La borne annoncée suit ce défaut : 400 $.
    expect(maxCost).toEqual({ costUsd: 400, runs: 100, tokens: 100_000_000 });
  });
});

describe("le coût maximal est une borne, pas une prévision", () => {
  it("prend le plafond de tokens du moteur et le plus cher des deux tarifs", () => {
    const bounded = maxCostEstimate(
      config({
        QA_INPUT_COST_PER_MILLION: "1",
        QA_OUTPUT_COST_PER_MILLION: "4",
        QA_RUN_MAX_TOKENS: "200000",
      }),
      100
    );
    expect(bounded).toEqual({
      costUsd: 80,
      runs: 100,
      tokens: 20_000_000,
    });
  });

  it("suit le plafond configuré, sans le redéfinir", () => {
    expect(
      maxCostEstimate(
        config({ QA_RUN_MAX_TOKENS: "50000", QA_OUTPUT_COST_PER_MILLION: "2" }),
        100
      ).costUsd
    ).toBe(10);
  });
});
