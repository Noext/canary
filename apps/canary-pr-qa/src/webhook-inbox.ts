import { randomUUID } from "node:crypto";
import { createLogger } from "@usecanary/logger";
import type { Config } from "./config.js";
import { QaError, redact } from "./diagnostics.js";
import { GitHub } from "./github.js";
import { resolvePreview } from "./preview.js";
import type { DeliveryPayload, DeliveryRow, Job, Queue } from "./queue.js";

const logger = createLogger({ name: "qa-webhook" });
/** Probe backoff between two attempts to see a preview proving the exact SHA. */
const BACKOFF_SECONDS: readonly number[] = [30, 60, 120, 300];
/**
 * Claim lease: a delivery stays owned by its worker at least this long, which
 * covers the GitHub reads plus the preview request, so two workers do not probe
 * the same row in parallel.
 */
const CLAIM_LEASE_SECONDS = 90;

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

async function processed(queue: Queue, id: string, token: string) {
  if (!(await queue.processed(id, token))) {
    // Another worker re-claimed the row while this one was reading it.
    logger.debug(
      { code: "CLAIM_LOST", delivery: id },
      "Delivery claim was taken over before it could be closed"
    );
  }
}

/**
 * Claims one due delivery for the given ownership token. The row lock is released
 * on commit, so the lease in `retry_at` only delays a second worker; the token is
 * what decides who may still write.
 */
function claimDelivery(queue: Queue, token: string) {
  return queue.claimDelivery(token, CLAIM_LEASE_SECONDS);
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

/**
 * Expires the attempt the caller owns. `queue.failDelivery` is conditional on the
 * ownership token, so a worker whose lease expired stays silent instead of
 * overwriting the state of the worker that took the delivery over.
 */
async function expire(queue: Queue, row: DeliveryRow, token: string) {
  const pr = row.payload.number ?? 0;
  const sha = row.payload.sha ?? "";
  const scope = { delivery: row.id, repo: row.payload.repo };
  if (
    !(await queue.failDelivery(
      row.id,
      token,
      "expired",
      row.reason ?? "PREVIEW_UNAVAILABLE"
    ))
  ) {
    logger.debug(
      { code: "CLAIM_LOST", ...scope, pr, sha },
      "Delivery claim was taken over before the attempt could expire"
    );
    return;
  }
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
}

interface ReadyDelivery {
  delivery: string;
  token: string;
  /** The record always carries a PR URL once `readyDelivery` accepted it. */
  value: DeliveryPayload & { prUrl: string };
}

async function readyDelivery(
  queue: Queue,
  config: Config
): Promise<ReadyDelivery | undefined> {
  const token = randomUUID();
  const row = await claimDelivery(queue, token);
  if (!row) {
    return;
  }
  const value = row.payload;
  const repo = value.repo ?? "";
  const pr = value.number ?? 0;
  const sha = value.sha ?? "";
  const scope = { delivery: row.id, repo };
  if (value.ignored || !value.prUrl) {
    await processed(queue, row.id, token);
    return;
  }
  if (!config.allowedRepos.includes(repo.toLowerCase())) {
    await processed(queue, row.id, token);
    return;
  }
  const refused = refusal(config, repo.toLowerCase());
  if (refused) {
    if (
      await queue.failDelivery(row.id, token, "auto_disabled", refused.code)
    ) {
      await queue.audit("webhook", refused.audit, undefined, {
        ...scope,
        pr,
        sha,
      });
      logger.warn(
        { code: refused.code, ...scope, pr, sha, hint: refused.hint },
        refused.message
      );
    }
    return;
  }
  if (pastDeadline(row, config)) {
    await expire(queue, row, token);
    return;
  }
  const backoff = probeBackoff(row.attempts);
  try {
    const github = new GitHub(config);
    const latest = await github.pr(value.prUrl);
    await queue.pool.query(
      "UPDATE qa_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=now() WHERE lower(repo)=lower($1) AND pr=$2 AND sha<>$3 AND status IN ('queued','running')",
      [repo, pr, latest.data.head.sha]
    );
    if (latest.data.head.sha !== sha || latest.data.state !== "open") {
      await processed(queue, row.id, token);
      return;
    }
    await resolvePreview(
      {
        ref: latest.ref,
        sha: latest.data.head.sha,
        baseSha: latest.data.base.sha,
        headRepo: latest.data.head.repo?.full_name ?? repo,
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
      token,
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
  // The guard above proved the PR URL: carry that proof into the return type.
  return { delivery: row.id, token, value: { ...value, prUrl: value.prUrl } };
}

export async function processDelivery(queue: Queue, config: Config) {
  const ready = await readyDelivery(queue, config);
  if (!ready) {
    return;
  }
  const { token, value, delivery } = ready;
  const repo = value.repo ?? "";
  const pr = value.number ?? 0;
  const sha = value.sha ?? "";
  // Verifying a preview outlives the claim lease, so the owner re-reads its row
  // before creating anything: a delivery another worker took over (or one whose
  // deadline passed during the probe) must not leave a run behind.
  const claim = await queue.deliveryClaim(delivery, token);
  if (!claim) {
    logger.warn(
      { code: "CLAIM_LOST", delivery, pr, repo, sha },
      "Preview verified after another worker took the delivery over; no run created"
    );
    return;
  }
  if (pastDeadline(claim, config)) {
    await expire(queue, claim, token);
    return;
  }
  let job: Job;
  try {
    job = await queue.enqueue(
      repo,
      pr,
      sha,
      "github-app",
      { prUrl: value.prUrl, publish: true, model: config.OPENAI_MODEL },
      `webhook:${repo.toLowerCase()}:${pr}:${sha}`,
      {
        global: config.QA_WEBHOOK_MAX_RUNS_PER_HOUR,
        repository: config.QA_WEBHOOK_REPO_MAX_RUNS_PER_HOUR,
      }
    );
  } catch (error) {
    if (!(error instanceof QaError) || error.code !== "WEBHOOK_RATE_LIMIT") {
      throw error;
    }
    const refused = await queue.failDelivery(
      delivery,
      token,
      "rate_limited",
      error.code,
      safeError(error, config)
    );
    if (refused) {
      await queue.audit("webhook", "automatic.rate_limited", undefined, {
        delivery,
        pr,
        repo,
        sha,
      });
      await queue.audit("webhook", "webhook.rate_limited", undefined, {
        delivery,
        repo,
        sha,
      });
      logger.warn(
        { code: error.code, delivery, hint: error.hint, pr, repo, sha },
        "Automatic run refused by durable hourly budget"
      );
    }
    return;
  }
  if (
    !(await queue.promoteDelivery(
      delivery,
      token,
      job.id,
      config.QA_AUTO_PREVIEW_WAIT_SECONDS
    ))
  ) {
    // The deadline closed or another worker took over while the run was being
    // created: the delivery is no longer this worker's to promote, and the run
    // must not survive as an orphan of a refused attempt.
    await queue.cancel(job.id, "webhook");
    logger.warn(
      { code: "PROMOTION_REFUSED", delivery, pr, repo, runId: job.id, sha },
      "Attempt was no longer promotable; the created run was cancelled"
    );
    return;
  }
  await queue.audit("webhook", "automatic.promoted", job.id, {
    delivery,
    pr,
    repo,
    sha,
  });
}
