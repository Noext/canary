import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import { diagnose, QaError } from "./diagnostics.js";
import { GitHub, type PrContext, parsePrUrl } from "./github.js";
import type { Queue } from "./queue.js";
import { reportMarkdown, saveReport, writeJson } from "./report.js";
import type { RunResult } from "./schema.js";

async function repair(result: RunResult, config: Config) {
  result.outcome = "blocked";
  result.error = "Run cancelled or ownership lost after publication";
  result.diagnostic = diagnose(
    new QaError(
      "RUN_OWNERSHIP_LOST",
      result.error,
      "Public results were invalidated; submit an explicit new run."
    ),
    config
  );
  const root = join(config.QA_DATA_DIR, result.id);
  if (result.publication && result.sha) {
    const github = new GitHub(config);
    const ref = parsePrUrl(result.prUrl);
    const context: PrContext = {
      ref,
      sha: result.sha,
      baseSha: "",
      body: "",
      title: "",
      headRepo: ref.repo,
      context: [],
      contextWarnings: [],
      files: [],
    };
    const url = config.ARTIFACT_BASE_URL
      ? `${config.ARTIFACT_BASE_URL.replace(/\/$/, "")}/artifacts/${result.id}/report.html`
      : undefined;
    const repaired = await Promise.allSettled([
      github.status(
        context,
        "error",
        "QA invalidated: run cancelled or ownership lost",
        url
      ),
      github.comment(context, reportMarkdown(result, url)),
    ]);
    result.publication.status =
      repaired[0]?.status === "fulfilled" ? "error" : "failed";
    for (const item of repaired) {
      if (item.status === "rejected") {
        result.error += ` Publication repair failed: ${diagnose(item.reason, config).message}`;
      }
    }
  }
  await saveReport(root, result, config);
  const previous = await readFile(join(root, "progress.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => ({ sequence: 0 }));
  const event = {
    ...previous,
    sequence: Number(previous.sequence ?? 0) + 1,
    runId: result.id,
    at: new Date().toISOString(),
    phase: "done",
    outcome: "blocked",
    diagnostic: result.diagnostic,
  };
  await appendFile(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`, {
    mode: 0o600,
  });
  await writeJson(join(root, "progress.json"), event);
}
export async function completeRun(
  queue: Queue,
  id: string,
  worker: string,
  result: RunResult,
  config: Config
) {
  let state: string;
  try {
    state = await queue.complete(
      id,
      worker,
      result.outcome,
      result.error,
      result.usage
    );
  } catch (error) {
    await repair(result, config);
    throw error;
  }
  if (state === "cancelled") {
    await repair(result, config);
  }
}
