import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAMPAIGN_BLOCKS,
  CAMPAIGN_RUNS_PER_BLOCK,
  runCampaign,
} from "../src/campaign.js";
import type { RecordedRun } from "../src/campaign-metrics.js";
import {
  type CampaignPlan,
  campaignPreflight,
} from "../src/campaign-preflight.js";
import {
  appendRunRecord,
  readRunRecords,
  recordAssertion,
  recordScenario,
} from "../src/campaign-run.js";
import { loadConfig } from "../src/config.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const SHA_REFERENCE = "8143ac9".padEnd(40, "0");
const SHA_CANDIDATE = "22b415b".padEnd(40, "0");
const HEAD = "d".repeat(40);

async function tempDir(prefix = "canary-campaign-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(path, { force: true, recursive: true }));
  return path;
}

function config() {
  return loadConfig({
    OPENAI_API_KEY: "fixture-key-1234567890",
    OPENAI_BASE_URL: "https://ai.fixture.test/v1",
    OPENAI_MODEL: "fixture-model",
    PREVIEW_ALLOWED_HOSTS: "preview.fixture.test",
    QA_API_TOKEN: "fixture-api-token-123456789012345",
    QA_DATA_DIR: "/tmp/canary-campaign-data",
    QA_INPUT_COST_PER_MILLION: "1",
    QA_OUTPUT_COST_PER_MILLION: "4",
  });
}

function plan(
  dataDir: string,
  overrides: Partial<CampaignPlan> = {}
): CampaignPlan {
  return {
    arms: [
      {
        commit: SHA_REFERENCE,
        name: "reference",
        worktree: "/nonexistent/reference",
      },
      {
        commit: SHA_CANDIDATE,
        name: "candidate",
        worktree: "/nonexistent/candidate",
      },
    ],
    dataDir,
    headSha: HEAD,
    // L'hôte n'est pas dans PREVIEW_ALLOWED_HOSTS : la vérification échoue sans
    // aucun accès réseau, ce qui garde ce test hors ligne.
    previewUrl: "https://preview.elsewhere.invalid/",
    prUrl: "https://github.com/fixture/app/pull/1",
    ...overrides,
  };
}

function codes(blockers: { code: string }[]): string[] {
  return blockers.map((blocker) => blocker.code);
}

describe("le préflight refuse de démarrer sans ses dépendances", () => {
  it("nomme chaque dépendance manquante, pas seulement la première", async () => {
    const empty = loadConfig({});
    const { blockers } = await campaignPreflight(plan(await tempDir()), empty);
    const found = codes(blockers);
    expect(found).toContain("CONFIG_INVALID");
    expect(found).toContain("MODEL_CREDENTIALS_MISSING");
    expect(found).toContain("GITHUB_CREDENTIALS_MISSING");
    expect(found).toContain("PREVIEW_UNVERIFIED");
    expect(found).toContain("ARM_WORKTREE_MISSING");
    expect(found).toContain("ARM_CLI_MISSING");
    // Chaque blocage nomme ce qu'il faut faire : un opérateur ne devine rien.
    for (const blocker of blockers) {
      expect(blocker.fix.length).toBeGreaterThan(10);
    }
  });

  it("refuse un bras dont le commit n'est pas un SHA complet", async () => {
    const { blockers } = await campaignPreflight(
      plan(await tempDir(), {
        arms: [
          {
            commit: "8143ac9",
            name: "reference",
            worktree: "/nonexistent/ref",
          },
          {
            commit: SHA_CANDIDATE,
            name: "candidate",
            worktree: "/nonexistent/cand",
          },
        ],
      }),
      config()
    );
    expect(codes(blockers)).toContain("ARM_COMMIT_INVALID");
  });

  it("refuse un dépôt de travail qui n'est pas sur le commit du bras", async () => {
    const worktree = await tempDir("canary-campaign-git-");
    execFileSync("git", ["init", "-q", worktree]);
    execFileSync("git", [
      "-C",
      worktree,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    ]);
    const head = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    // Le dépôt existe et son HEAD est lisible : c'est bien le SHA qui diverge.
    expect(head).not.toBe(SHA_REFERENCE);
    const { blockers } = await campaignPreflight(
      plan(await tempDir(), {
        arms: [
          { commit: SHA_REFERENCE, name: "reference", worktree },
          { commit: SHA_CANDIDATE, name: "candidate", worktree },
        ],
      }),
      config()
    );
    expect(codes(blockers)).toContain("ARM_SHA_MISMATCH");
  });

  it("refuse un dossier de runs qui serait versionnable", async () => {
    // `process.cwd()` est le dossier de l'application : un sous-dossier est dans
    // le dépôt, donc ses runs pourraient être commités.
    const inside = await tempDir("canary-campaign-inside-");
    const { blockers } = await campaignPreflight(plan(inside), config());
    // mkdtemp crée hors du dépôt par défaut : le cas « dedans » est couvert par
    // un chemin relatif au cwd, construit sans écrire dans le dépôt.
    const relative = join(process.cwd(), "campaign-data-should-not-exist");
    const nested = await campaignPreflight(plan(relative), config());
    expect(codes(nested.blockers)).toContain("DATA_DIR_INSIDE_REPO");
    expect(codes(blockers)).not.toContain("DATA_DIR_INSIDE_REPO");
  });
});

describe("le protocole est celui du document, sans réglage", () => {
  it("alterne les bras dans l'ordre, 5 blocs de 10 runs par bras", async () => {
    const calls: string[] = [];
    const fake = async (input: {
      arm: { name: string };
      block: number;
      index: number;
      runId: string;
    }): Promise<RecordedRun> => {
      calls.push(`${input.block}:${input.index}:${input.arm.name}`);
      return {
        arm: input.arm.name,
        assertions: [
          { passed: true, changed: true, verification: "transition" },
        ],
        block: input.block,
        outcome: "passed",
        runId: input.runId,
        scenarios: [{ outcome: "passed" }],
        sha: SHA_REFERENCE,
      };
    };
    const result = await runCampaign({
      config: config(),
      execute: fake,
      plan: plan(await tempDir()),
    });
    expect(CAMPAIGN_BLOCKS).toBe(5);
    expect(CAMPAIGN_RUNS_PER_BLOCK).toBe(10);
    expect(result.runs).toHaveLength(
      CAMPAIGN_BLOCKS * CAMPAIGN_RUNS_PER_BLOCK * 2
    );
    // Référence puis candidat, pour chaque position, bloc après bloc.
    expect(calls.slice(0, 4)).toEqual([
      "1:1:reference",
      "1:1:candidate",
      "1:2:reference",
      "1:2:candidate",
    ]);
    expect(calls.at(-1)).toBe("5:10:candidate");
    expect(result.verdict).toBe("not-demonstrated");
  });

  it("n'enregistre jamais un run incomplet comme un succès", async () => {
    const fake = async (input: {
      arm: { name: string };
      block: number;
      index: number;
      runId: string;
    }): Promise<RecordedRun> => ({
      arm: input.arm.name,
      assertions: [],
      block: input.block,
      incomplete: true,
      outcome: "incomplete",
      runId: input.runId,
      scenarios: [],
      sha: SHA_REFERENCE,
    });
    const result = await runCampaign({
      config: config(),
      execute: fake,
      plan: plan(await tempDir()),
    });
    expect(result.reference.incompleteRuns).toBe(50);
    expect(result.reference.evaluableRuns).toBe(0);
    expect(result.reference.greenRuns).toBe(0);
    expect(result.reference.greenRate).toBeUndefined();
    expect(result.verdict).toBe("not-run");
  });

  it("écrit les runs au fil de l'eau et les relit sans relancer", async () => {
    const dataDir = await tempDir();
    const record: RecordedRun = {
      arm: "candidate",
      assertions: [
        {
          passed: false,
          preMatched: true,
          changed: false,
          verification: "state",
        },
      ],
      block: 1,
      outcome: "blocked",
      runId: "run-1",
      scenarios: [
        { code: "STATE_ALREADY_SATISFIED", outcome: "blocked", refused: false },
      ],
      sha: SHA_CANDIDATE,
    };
    await appendRunRecord(dataDir, record);
    await appendRunRecord(dataDir, { ...record, runId: "run-2" });
    const reloaded = await readRunRecords(dataDir);
    expect(reloaded.map((item) => item.runId)).toEqual(["run-1", "run-2"]);
    expect(await readRunRecords(await tempDir())).toEqual([]);
  });
});

describe("la projection d'un artefact ne recopie aucune valeur de page", () => {
  it("garde le type, la pré-satisfaction, la preuve et le résultat", () => {
    expect(
      recordAssertion({
        changed: false,
        passed: false,
        preMatched: true,
        verification: "state",
      })
    ).toEqual({
      changed: false,
      passed: false,
      preMatched: true,
      verification: "state",
    });
    // Un type inconnu n'est pas inventé.
    expect(recordAssertion({ passed: true, verification: "visual" })).toEqual({
      passed: true,
    });
  });

  it("marque un scénario sans étape jouée comme refusé avant exécution", () => {
    expect(
      recordScenario({
        diagnostic: { code: "WRITE_EVIDENCE_MISSING" },
        outcome: "blocked",
        steps: [],
      })
    ).toEqual({
      code: "WRITE_EVIDENCE_MISSING",
      outcome: "blocked",
      refused: true,
    });
    expect(recordScenario({ outcome: "passed", steps: [{}, {}] })).toEqual({
      outcome: "passed",
      refused: false,
    });
  });
});

describe("l'artefact de campagne reste hors du dépôt", () => {
  it("écrit uniquement dans le dossier de données demandé", async () => {
    const dataDir = await tempDir();
    await appendRunRecord(dataDir, {
      arm: "reference",
      assertions: [],
      block: 1,
      outcome: "passed",
      runId: "r",
      scenarios: [],
      sha: SHA_REFERENCE,
    });
    const content = await readFile(
      join(dataDir, "campaign-runs.jsonl"),
      "utf8"
    );
    expect(content.trim().split("\n")).toHaveLength(1);
    await mkdir(join(dataDir, "nested"), { recursive: true });
    await writeFile(join(dataDir, "nested", "probe.txt"), "ok");
    expect(await readFile(join(dataDir, "nested", "probe.txt"), "utf8")).toBe(
      "ok"
    );
  });
});
