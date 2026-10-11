import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import { parsePrUrl } from "./github.js";
import type { Queue } from "./queue.js";
export async function importLegacy(queue: Queue, config: Config) {
  for (const id of await readdir(config.QA_DATA_DIR)) {
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      continue;
    }
    const path = join(config.QA_DATA_DIR, id);
    const job = await readFile(join(path, "job.json"), "utf8")
      .then(JSON.parse)
      .catch(() => undefined);
    if (!job?.input?.prUrl) {
      continue;
    }
    const ref = parsePrUrl(job.input.prUrl);
    if (!config.allowedRepos.includes(ref.repo.toLowerCase())) {
      continue;
    }
    const result = await readFile(join(path, "result.json"), "utf8")
      .then(JSON.parse)
      .catch(() => ({}));
    const status = ["queued", "running"].includes(job.status)
      ? "interrupted"
      : "completed";
    await queue.pool.query(
      "INSERT INTO qa_jobs(id,repo,pr,sha,owner,input,idempotency_key,status,outcome,error) VALUES($1,$2,$3,$4,'bootstrap-admin',$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
      [
        id,
        ref.repo,
        ref.number,
        result.sha ?? "unknown",
        JSON.stringify(job.input),
        `legacy:${id}`,
        status,
        result.outcome ?? null,
        status === "interrupted"
          ? "Legacy run not replayed; submit a new run"
          : (result.error ?? null),
      ]
    );
  }
}
