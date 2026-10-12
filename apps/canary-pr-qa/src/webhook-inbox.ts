import { createLogger } from "@usecanary/logger";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import { GitHub } from "./github.js";
import { resolvePreview } from "./preview.js";
import type { Queue } from "./queue.js";

async function readyDelivery(queue: Queue, config: Config) {
  const client = await queue.pool.connect();
  try {
    await client.query("BEGIN");
    const row = (
      await client.query(
        "SELECT * FROM qa_deliveries WHERE status='pending' AND retry_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1"
      )
    ).rows[0];
    if (!row) {
      await client.query("COMMIT");
      return;
    }
    const value = row.payload as {
      ignored?: boolean;
      prUrl: string;
      repo: string;
      number: number;
      sha: string;
    };
    if (value.ignored) {
      await client.query(
        "UPDATE qa_deliveries SET status='processed' WHERE id=$1",
        [row.id]
      );
      await client.query("COMMIT");
      return;
    }
    const github = new GitHub(config);
    const latest = await github.pr(value.prUrl);
    await client.query(
      "UPDATE qa_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE lower(repo)=lower($1) AND pr=$2 AND sha<>$3 AND status IN ('queued','running')",
      [value.repo, value.number, latest.data.head.sha]
    );
    if (latest.data.head.sha !== value.sha || latest.data.state !== "open") {
      await client.query(
        "UPDATE qa_deliveries SET status='processed' WHERE id=$1",
        [row.id]
      );
      await client.query("COMMIT");
      return;
    }
    try {
      const context = {
        ref: latest.ref,
        sha: latest.data.head.sha,
        baseSha: latest.data.base.sha,
        headRepo: latest.data.head.repo?.full_name ?? value.repo,
        body: "",
        title: "",
        context: [],
        contextWarnings: [],
        files: [],
      };
      await resolvePreview(context, github, config);
    } catch {
      const expired =
        Date.now() - Date.parse(row.created_at) >
        config.QA_PREVIEW_WAIT_SECONDS * 1000;
      await client.query(
        "UPDATE qa_deliveries SET status=$2,retry_at=now()+interval '30 seconds' WHERE id=$1",
        [row.id, expired ? "expired" : "pending"]
      );
      await client.query("COMMIT");
      if (expired) {
        await queue.audit("webhook", "preview.expired", undefined, {
          delivery: row.id,
          repo: value.repo,
        });
      }
      return;
    }
    // Return metadata after releasing the transaction connection.
    await client.query("COMMIT");
    return { value, delivery: row.id as string };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function processDelivery(queue: Queue, config: Config) {
  const ready = await readyDelivery(queue, config);
  if (!ready) {
    return;
  }
  const { value, delivery } = ready;
  try {
    await queue.enqueue(
      value.repo,
      value.number,
      value.sha,
      "github-app",
      { prUrl: value.prUrl, publish: true },
      `webhook:${value.repo.toLowerCase()}:${value.number}:${value.sha}`,
      {
        global: config.QA_WEBHOOK_MAX_RUNS_PER_HOUR,
        repository: config.QA_WEBHOOK_REPO_MAX_RUNS_PER_HOUR,
      }
    );
  } catch (error) {
    if (!(error instanceof QaError) || error.code !== "WEBHOOK_RATE_LIMIT") {
      throw error;
    }
    await queue.pool.query(
      "UPDATE qa_deliveries SET status='rate_limited' WHERE id=$1",
      [delivery]
    );
    await queue.audit("webhook", "webhook.rate_limited", undefined, {
      delivery,
      repo: value.repo,
      sha: value.sha,
    });
    createLogger({ name: "qa-webhook" }).warn(
      {
        code: error.code,
        delivery,
        repo: value.repo,
        sha: value.sha,
        hint: error.hint,
      },
      "Automatic run refused by durable hourly budget"
    );
    return;
  }
  await queue.pool.query(
    "UPDATE qa_deliveries SET status='processed' WHERE id=$1",
    [delivery]
  );
}
