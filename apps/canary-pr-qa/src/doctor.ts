import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Canary } from "./canary.js";
import { type Config, validateConfiguration } from "./config.js";
import { type Diagnostic, diagnose, QaError, redact } from "./diagnostics.js";
import { GitHub, type PrContext } from "./github.js";
import { GitHubSetup } from "./github-setup.js";
import { Model } from "./model.js";
import { resolvePreview } from "./preview.js";
import {
  applyPreviewHosts,
  PreviewHosts,
  verifyPreviewPolicyTarget,
} from "./preview-hosts.js";
import { Queue, SCHEMA_VERSION } from "./queue.js";
import type { RunResult } from "./schema.js";

interface Check {
  diagnostic?: Diagnostic;
  durationMs: number;
  message: string;
  name: string;
  status: "passed" | "failed" | "skipped";
}
export function configSummary(config: Config) {
  return {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    github: {
      origin: new URL(config.GITHUB_API_URL).origin,
      tokenConfigured: Boolean(config.GITHUB_TOKEN || config.GITHUB_APP_ID),
      repos: config.allowedRepos,
    },
    model: {
      origin: new URL(config.OPENAI_BASE_URL).origin,
      name: config.OPENAI_MODEL,
      keyConfigured: Boolean(config.OPENAI_API_KEY),
      jsonMode: config.OPENAI_JSON_MODE,
    },
    previewHosts: config.allowedHosts,
    dataDir: config.QA_DATA_DIR,
    cliPath: config.CANARY_CLI_PATH,
    apiTokenConfigured: Boolean(config.QA_API_TOKEN),
    artifactPublic: config.ARTIFACT_PUBLIC,
  };
}
export async function doctor(
  initialConfig: Config,
  options: {
    offline?: boolean;
    skipBrowser?: boolean;
    prUrl?: string;
    previewUrl?: string;
  } = {}
) {
  let config = initialConfig;
  const checks: Check[] = [];
  const check = async (
    name: string,
    operation: () => Promise<string> | string
  ) => {
    const started = Date.now();
    try {
      checks.push({
        name,
        status: "passed",
        message: redact(await operation(), config),
        durationMs: Date.now() - started,
      });
      return true;
    } catch (error) {
      const diagnostic = diagnose(error, config);
      checks.push({
        name,
        status: "failed",
        message: diagnostic.message,
        diagnostic,
        durationMs: Date.now() - started,
      });
      return false;
    }
  };
  const skip = (name: string, message: string) =>
    checks.push({ name, status: "skipped", message, durationMs: 0 });
  const valid = await check("configuration", () => {
    validateConfiguration(config, true);
    return "Configuration is complete; secret values are omitted";
  });
  await check("node", () => {
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 12)) {
      throw new QaError(
        "NODE_VERSION",
        "Node 22.12+ is required",
        "Use the supplied Docker image or update Node before installing."
      );
    }
    return process.version;
  });
  await check("storage", async () => {
    await mkdir(config.QA_DATA_DIR, { recursive: true });
    const probe = join(config.QA_DATA_DIR, `.doctor-${randomUUID()}`);
    try {
      await writeFile(probe, "storage-probe", { flag: "wx", mode: 0o600 });
      if ((await readFile(probe, "utf8")) !== "storage-probe") {
        throw new Error("Storage readback differs from the written data");
      }
    } finally {
      await unlink(probe).catch(() => undefined);
    }
    const disk = await statfs(config.QA_DATA_DIR);
    return `Read/write verified; ${Math.floor((disk.bavail * disk.bsize) / 1024 / 1024)} MiB available`;
  });
  await check("preview-policy", () => verifyPreviewPolicyTarget(config));
  if (config.DATABASE_URL && !options.offline) {
    await check("postgresql", async () => {
      const queue = new Queue(config.DATABASE_URL);
      try {
        const schema = await queue.pool.query(
          "SELECT max(version)::int AS version FROM qa_schema"
        );
        if (schema.rows[0]?.version !== SCHEMA_VERSION) {
          throw new Error(
            `Database schema is not at supported version ${SCHEMA_VERSION}; start the API migration first`
          );
        }
        await queue.pool.query("SELECT count(*)::int AS count FROM qa_jobs");
        config = await new GitHubSetup(queue.pool, config).effective();
        // Doctor verifies the host list in force, which is the dashboard list when
        // an administrator saved one.
        applyPreviewHosts(
          config,
          await new PreviewHosts(queue.pool, config).effective()
        );
        return `PostgreSQL connection, schema version ${SCHEMA_VERSION} and job-table read verified`;
      } finally {
        await queue.close();
      }
    });
  }
  const canary = new Canary(config);
  const built = await check("canary-cli", async () => {
    if (!(await stat(config.CANARY_CLI_PATH)).isFile()) {
      throw new Error("CANARY_CLI_PATH is not a file");
    }
    const version = await canary.command(["--version"]);
    if (version.code !== 0) {
      throw new Error(version.stderr);
    }
    return version.stdout.trim();
  });
  if (options.skipBrowser || !built) {
    skip(
      "chromium-evidence",
      "Browser smoke test explicitly skipped or CLI unavailable; browser operation is not verified"
    );
  } else {
    await check("chromium-evidence", async () => {
      const session = await canary.start(
        "Canary PR QA installation smoke test"
      );
      const destination = join(config.QA_DATA_DIR, "_doctor", randomUUID());
      const html = `<!doctype html><html lang="en"><title>Canary smoke test</title><label>Name<input id="name"></label><button onclick="document.getElementById('result').textContent=document.getElementById('name').value">Save</button><p id="result"></p></html>`;
      try {
        const observed = await canary.act(
          session,
          "installation-smoke",
          `const page = await browser.getPage("qa");
await page.setContent(${JSON.stringify(html)});
await page.locator("#name").fill("Canary installation verified");
await page.getByRole("button", { name: "Save" }).click();
await page.waitForTimeout(250);
console.log("CANARY_PR_QA_OBSERVATION:" + JSON.stringify({ url: page.url(), snapshot: (await page.snapshotForAI({ depth: 8 })).full, actual: await page.locator("#result").innerText() }));`
        );
        if (observed.actual !== "Canary installation verified") {
          throw new Error(
            "Chromium form assertion failed during installation smoke test"
          );
        }
        const files = await canary.end(session, destination);
        return `Real Chromium form assertion passed; ${files.length} evidence files verified and temporary captures removed`;
      } catch (error) {
        await canary.abort(session);
        throw error;
      } finally {
        await rm(destination, { recursive: true, force: true });
      }
    });
  }
  if (options.offline || !valid) {
    skip(
      "github",
      "Network check skipped (--offline or invalid configuration); token permissions not verified"
    );
    skip(
      "model",
      "Network check skipped; actual model generation not verified"
    );
    skip("preview", "Preview provenance not verified");
  } else {
    const github = new GitHub(config);
    if (githubOnboardingPending(config)) {
      skip(
        "github-setup",
        "GitHub onboarding pending: create/install the App and select repositories in the dashboard; no GitHub run is validated yet"
      );
    }
    for (const repo of config.allowedRepos) {
      await check(`github:${repo}`, async () => {
        await github.request(`/repos/${repo}`);
        await github.request(`/repos/${repo}/contents`);
        await github.request(`/repos/${repo}/deployments?per_page=1`);
        return "Repository, Contents and Deployments reads accepted. Write permissions require a real published run; doctor makes no GitHub writes";
      });
    }
    await check("model", async () => {
      await new Model(config).json(
        'You are a connection diagnostic. Return only the JSON object {"ok":true}.',
        { purpose: "installation connectivity check" },
        z.object({ ok: z.literal(true) }).strict(),
        config.QA_DOCTOR_MAX_TOKENS
      );
      return "Actual /chat/completions request and structured JSON response succeeded (a small billable request)";
    });
    if (options.prUrl) {
      let context: PrContext | undefined;
      await check("pr-context", async () => {
        context = await github.context(options.prUrl ?? "");
        return `Pinned ${context.sha}; ${context.files.length} changed files`;
      });
      if (context) {
        const pinned = context;
        await check("preview", async () => {
          const preview = await resolvePreview(
            pinned,
            github,
            config,
            options.previewUrl
          );
          return `SHA ${preview.sha} verified: ${preview.evidence}`;
        });
      } else {
        skip("preview", "PR context unavailable");
      }
    } else {
      skip(
        "preview",
        "Supply --pr PR_URL [--preview URL] to verify the exact commit; no PR test was executed"
      );
    }
  }
  return {
    healthy: !checks.some((item) => item.status === "failed"),
    at: new Date().toISOString(),
    config: configSummary(config),
    checks,
  };
}
export async function supportSummary(id: string, config: Config) {
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    throw new QaError(
      "RUN_ID_INVALID",
      "Expected a run UUID",
      "Use the id returned by POST /runs."
    );
  }
  const root = join(config.QA_DATA_DIR, id);
  const optional = async (file: string) => {
    try {
      return JSON.parse(await readFile(join(root, file), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  };
  const [job, progress, value] = await Promise.all([
    optional("job.json"),
    optional("progress.json"),
    optional("result.json"),
  ]);
  if (!(job || progress || value)) {
    throw new QaError(
      "RUN_NOT_FOUND",
      "Run not found in QA_DATA_DIR",
      "Check the run id and that this command uses the same Compose project/volume as the service."
    );
  }
  const result = value as RunResult | undefined;
  const summary = {
    runId: id,
    config: configSummary(config),
    job: job
      ? {
          status: job.status,
          outcome: job.outcome,
          error: job.error,
          diagnostic: job.diagnostic,
        }
      : undefined,
    progress,
    result: result
      ? {
          outcome: result.outcome,
          sha: result.sha,
          startedAt: result.startedAt,
          endedAt: result.endedAt,
          error: result.error,
          diagnostic: result.diagnostic,
          publication: result.publication,
          scenarios: result.scenarios.map((s) => ({
            id: s.scenario.id,
            outcome: s.outcome,
            steps: s.steps.length,
            assertions: s.assertions.map((a) => ({
              id: a.id,
              passed: a.passed,
            })),
            error: s.error,
            diagnostic: s.diagnostic,
            evidenceFiles: s.artifacts.length,
          })),
        }
      : undefined,
    note: "This summary omits browser snapshots, typed values, assertion actual values, HAR, traces, cookies and environment secret values. Review before sharing.",
  };
  return JSON.parse(redact(JSON.stringify(summary), config));
}

function githubOnboardingPending(config: Config) {
  return !(
    config.allowedRepos.length &&
    (config.GITHUB_TOKEN || config.GITHUB_APP_ID)
  );
}
