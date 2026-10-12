import { createLogger } from "@usecanary/logger";
import type { Config } from "./config.js";
import { QaError, redact } from "./diagnostics.js";
import { GitHub } from "./github.js";
import { resolvePreview } from "./preview.js";
import type { Job, Queue } from "./queue.js";

const logger = createLogger({ name: "qa-webhook" });
/** Probe backoff between two attempts to see a preview proving the exact SHA. */
const BACKOFF_SECONDS: readonly number[] = [30, 60, 120, 300];

interface DeliveryPayload {
  ignored?: boolean;
  number: number;
  prUrl: string;
  repo: string;
  sha: string;
}
interface DeliveryRow {
  attempts: number;
  created_at: Date;
  deadline_at: Date | null;
  id: string;
  payload: DeliveryPayload;
  reason: string | null;
}

function probeBackoff(attempts: number) {
  const index = Math.min(Math.max(attempts, 0), BACKOFF_SECONDS.length - 1);
  return BACKOFF_SECONDS[index] ?? 300;
}

/** No token and no query string from a failing endpoint may be stored or logged. */
function safeError(error: unknown, config: Config) {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message, config)
    .replace(/\?[^\s"']*/g, "")
    .slice(0, 300);
}

/** A delivery accepted before `deadline_at` existed starts waiting at acceptance. */
function pastDeadline(row: DeliveryRow, config: Config) {
  const deadline =
    row.deadline_at?.getTime() ??
    row.created_at.getTime() + config.QA_AUTO_PREVIEW_WAIT_SECONDS * 1000;
  return Date.now() >= deadline;
}

async function processed(queue: Queue, id: string) {
  await queue.pool.query(
    "UPDATE qa_deliveries SET status='processed',updated_at=now() WHERE id=$1",
    [id]
  );
}

/**
 * Claims one pending delivery by pushing its retry window forward: a probe that
 * dies on the network is retried after one backoff step instead of spinning, and
 * two workers cannot probe the same row.
 */
function claimDelivery(queue: Queue) {
  return queue.pool
    .query<DeliveryRow>(
      `UPDATE qa_deliveries SET retry_at=now()+make_interval(secs => $1::double precision)
       WHERE id=(SELECT id FROM qa_deliveries WHERE status='pending' AND retry_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`,
      [probeBackoff(0)]
    )
    .then((result) => result.rows[0]);
}

interface DeliveryRefusal {
  audit: string;
  code: string;
  hint: string;
  message: string;
}

/**
 * Master switch and per-repository opt-in both end the attempt before any probe:
 * the delivery stays recorded, no run is created and no further probe is scheduled.
 */
function refusal(config: Config, repo: string): DeliveryRefusal | undefined {
  if (!config.autoRuns) {
    return {
      audit: "automatic.disabled",
      code: "AUTO_RUNS_DISABLED",
      hint: "Set QA_AUTO_RUNS=true to resume automatic runs, or start this run explicitly from the dashboard.",
      message: "Automatic PR QA runs are disabled",
    };
  }
  if (config.automaticRepos && !config.automaticRepos.includes(repo)) {
    return {
      audit: "automatic.repo_disabled",
      code: "AUTO_REPO_DISABLED",
      hint: "Switch this repository back on in the dashboard GitHub settings to resume automatic runs.",
      message: "Automatic runs are switched off for this repository",
    };
  }
  return;
}

async function readyDelivery(queue: Queue, config: Config) {
  const row = await claimDelivery(queue);
  if (!row) {
    return;
  }
  const value = row.payload;
  const pr = value.number ?? 0;
  const sha = value.sha ?? "";
  const scope = { delivery: row.id, repo: value.repo };
  if (value.ignored || !value.prUrl) {
    await processed(queue, row.id);
    return;
  }
  if (!config.allowedRepos.includes(value.repo.toLowerCase())) {
    await processed(queue, row.id);
    return;
  }
  const refused = refusal(config, value.repo.toLowerCase());
  if (refused) {
    await queue.failDelivery(row.id, "auto_disabled", refused.code);
    await queue.audit("webhook", refused.audit, undefined, {
      ...scope,
      pr,
      sha,
    });
    logger.warn(
      { code: refused.code, ...scope, pr, sha, hint: refused.hint },
      refused.message
    );
    return;
  }
  if (pastDeadline(row, config)) {
    await queue.failDelivery(
      row.id,
      "expired",
      row.reason ?? "PREVIEW_UNAVAILABLE"
    );
    await queue.audit("webhook", "automatic.preview_expired", undefined, {
      ...scope,
      attempts: row.attempts,
      deadline: row.deadline_at?.toISOString() ?? null,
      pr,
      sha,
    });
    logger.warn(
      {
        code: "PREVIEW_EXPIRED",
        ...scope,
        attempts: row.attempts,
        pr,
        sha,
        hint: "Deploy the exact head SHA with its full SHA exposed, set PREVIEW_URL_TEMPLATE when the deployment metadata cannot prove it, and raise QA_AUTO_PREVIEW_WAIT_SECONDS if the deploy needs longer. An expired attempt is never replayed automatically: push a new commit or start the run from the dashboard.",
      },
      "Automatic attempt expired without a preview proving the exact SHA"
    );
    return;
  }
  const backoff = probeBackoff(row.attempts);
  try {
    const github = new GitHub(config);
    const latest = await github.pr(value.prUrl);
    await queue.pool.query(
      "UPDATE qa_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=now() WHERE lower(repo)=lower($1) AND pr=$2 AND sha<>$3 AND status IN ('queued','running')",
      [value.repo, pr, latest.data.head.sha]
    );
    if (latest.data.head.sha !== sha || latest.data.state !== "open") {
      await processed(queue, row.id);
      return;
    }
    await resolvePreview(
      {
        ref: latest.ref,
        sha: latest.data.head.sha,
        baseSha: latest.data.base.sha,
        headRepo: latest.data.head.repo?.full_name ?? value.repo,
        body: "",
        title: "",
        context: [],
        contextWarnings: [],
        files: [],
      },
      github,
      config
    );
  } catch (error) {
    const reason =
      error instanceof QaError ? error.code : "PREVIEW_UNAVAILABLE";
    // One audit per change of cause; repeated probes stay at debug level.
    const transition = row.attempts === 0 || row.reason !== reason;
    await queue.holdDelivery(
      row.id,
      reason,
      backoff,
      config.QA_AUTO_PREVIEW_WAIT_SECONDS
    );
    if (transition) {
      await queue.audit("webhook", "automatic.preview_wait", undefined, {
        ...scope,
        backoffSeconds: backoff,
        pr,
        reason,
        sha,
      });
    }
    logger.debug(
      {
        code: reason,
        ...scope,
        backoffSeconds: backoff,
        lastError: safeError(error, config),
        pr,
        sha,
        transition,
      },
      "Automatic attempt is waiting for a preview proving the exact SHA"
    );
    return;
  }
  return { value, delivery: row.id };
}

export async function processDelivery(queue: Queue, config: Config) {
  const ready = await readyDelivery(queue, config);
  if (!ready) {
    return;
  }
  const { value, delivery } = ready;
  const pr = value.number ?? 0;
  const sha = value.sha ?? "";
  let job: Job;
  try {
    job = await queue.enqueue(
      value.repo,
      pr,
      sha,
      "github-app",
      { prUrl: value.prUrl, publish: true, model: config.OPENAI_MODEL },
      `webhook:${value.repo.toLowerCase()}:${pr}:${sha}`,
      {
        global: config.QA_WEBHOOK_MAX_RUNS_PER_HOUR,
        repository: config.QA_WEBHOOK_REPO_MAX_RUNS_PER_HOUR,
      }
    );
  } catch (error) {
    if (!(error instanceof QaError) || error.code !== "WEBHOOK_RATE_LIMIT") {
      throw error;
    }
    await queue.failDelivery(
      delivery,
      "rate_limited",
      error.code,
      safeError(error, config)
    );
    await queue.audit("webhook", "automatic.rate_limited", undefined, {
      delivery,
      pr,
      repo: value.repo,
      sha,
    });
    await queue.audit("webhook", "webhook.rate_limited", undefined, {
      delivery,
      repo: value.repo,
      sha,
    });
    logger.warn(
      {
        code: error.code,
        delivery,
        hint: error.hint,
        pr,
        repo: value.repo,
        sha,
      },
      "Automatic run refused by durable hourly budget"
    );
    return;
  }
  await queue.promoteDelivery(delivery, job.id);
  await queue.audit("webhook", "automatic.promoted", job.id, {
    delivery,
    pr,
    repo: value.repo,
    sha,
  });
}
