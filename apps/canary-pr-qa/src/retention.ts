import { readdir, realpath, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Config } from "./config.js";
import type { Job, Queue } from "./queue.js";

async function bytes(root: string): Promise<number> {
  let size = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const path = join(root, entry.name);
    size += entry.isDirectory() ? await bytes(path) : (await stat(path)).size;
  }
  return size;
}
export async function purgeRun(
  queue: Queue,
  config: Config,
  job: Job,
  actor: string
) {
  if (["queued", "running"].includes(job.status)) {
    throw new Error("Cannot delete an active run");
  }
  const root = await realpath(config.QA_DATA_DIR);
  const target = join(root, job.id);
  const actual = await realpath(target).catch(() => target);
  if (relative(root, actual).startsWith("..")) {
    throw new Error("Unsafe run symlink");
  }
  await rm(target, { recursive: true, force: true });
  await queue.audit(actor, "run.delete", job.id, {
    repo: job.repo,
    sha: job.sha,
  });
  await queue.pool.query(
    "DELETE FROM qa_jobs WHERE id=$1 AND status NOT IN ('queued','running')",
    [job.id]
  );
}
export async function retain(queue: Queue, config: Config) {
  const jobs = (
    await queue.pool.query<Job>(
      "SELECT * FROM qa_jobs WHERE status NOT IN ('queued','running') ORDER BY created_at ASC"
    )
  ).rows;
  let used = await bytes(config.QA_DATA_DIR);
  let removed = 0;
  for (const job of jobs) {
    if (
      Date.parse(job.created_at) >
        Date.now() - config.QA_RETENTION_DAYS * 86_400_000 &&
      used <= config.QA_STORAGE_MAX_GB * 1e9
    ) {
      continue;
    }
    const size = await bytes(join(config.QA_DATA_DIR, job.id)).catch(() => 0);
    await purgeRun(queue, config, job, "retention");
    used -= size;
    removed++;
  }
  await queue.pool.query(
    "DELETE FROM qa_deliveries WHERE status='processed' AND created_at < now()-interval '30 days'"
  );
  return { removed, bytes: used };
}
