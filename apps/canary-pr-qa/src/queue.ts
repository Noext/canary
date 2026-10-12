import { randomUUID } from "node:crypto";
import { createLogger } from "@usecanary/logger";
import pg from "pg";
import { QaError } from "./diagnostics.js";
import { LOCAL_AUTH_MIGRATION } from "./local-auth.js";
import type { RunOptions } from "./runner.js";

interface AutomaticRunLimits {
  global: number;
  repository: number;
}
export interface Job {
  cancel_requested: boolean;
  created_at: string;
  id: string;
  input: RunOptions;
  outcome?: string;
  owner: string;
  pr: number;
  repo: string;
  sha: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  updated_at: string;
  worker?: string;
}
export const SCHEMA_VERSION = 4;
export const MIGRATION = `
CREATE TABLE IF NOT EXISTS qa_jobs (
 id uuid PRIMARY KEY, repo text NOT NULL, pr integer NOT NULL, sha text NOT NULL,
 owner text NOT NULL, idempotency_key text NOT NULL UNIQUE,
 input jsonb NOT NULL, status text NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),
 usage jsonb NOT NULL DEFAULT '{}', outcome text, error text, worker text, lease_until timestamptz, cancel_requested boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qa_claim ON qa_jobs(status,created_at);
CREATE INDEX IF NOT EXISTS qa_project ON qa_jobs(repo,created_at DESC);
CREATE INDEX IF NOT EXISTS qa_auto_budget ON qa_jobs(created_at,lower(repo)) WHERE owner='github-app';
CREATE TABLE IF NOT EXISTS qa_deliveries (id text PRIMARY KEY, event text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', retry_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS qa_delivery_pr_sha ON qa_deliveries ((lower(payload->>'repo')), (payload->>'number'), (payload->>'sha'));
CREATE TABLE IF NOT EXISTS qa_audit (id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, run_id uuid, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS qa_schema (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO qa_schema(version) VALUES(1) ON CONFLICT DO NOTHING;
ALTER TABLE qa_jobs ADD COLUMN IF NOT EXISTS usage jsonb NOT NULL DEFAULT '{}';
ALTER TABLE qa_deliveries ADD COLUMN IF NOT EXISTS retry_at timestamptz NOT NULL DEFAULT now();
INSERT INTO qa_schema(version) VALUES(2) ON CONFLICT DO NOTHING;
INSERT INTO qa_schema(version) VALUES(3) ON CONFLICT DO NOTHING;
${LOCAL_AUTH_MIGRATION}
INSERT INTO qa_schema(version) VALUES(${SCHEMA_VERSION}) ON CONFLICT DO NOTHING;
`;
export class Queue {
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10_000,
    });
    this.pool.on("error", () => {
      // Deliberately omit connection details and database error text: both may contain secrets.
      createLogger({ name: "pr-qa-db" }).error(
        { code: "DB_POOL_ERROR" },
        "Idle database connection failed; pool will reconnect on the next request"
      );
    });
  }
  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(9287342)");
      await client.query(MIGRATION);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async audit(
    actor: string,
    action: string,
    id?: string,
    details: unknown = {}
  ) {
    await this.pool.query(
      "INSERT INTO qa_audit(actor,action,run_id,details) VALUES($1,$2,$3,$4)",
      [actor, action, id ?? null, JSON.stringify(details)]
    );
  }
  async enqueue(
    repo: string,
    pr: number,
    sha: string,
    owner: string,
    input: RunOptions,
    key: string,
    automaticLimits?: AutomaticRunLimits
  ): Promise<Job> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(9287341)");
      const duplicate = await client.query<Job>(
        "SELECT * FROM qa_jobs WHERE idempotency_key=$1 OR ($2 AND owner='github-app' AND lower(repo)=lower($3) AND pr=$4 AND sha=$5) ORDER BY created_at LIMIT 1",
        [key, Boolean(automaticLimits), repo, pr, sha]
      );
      if (duplicate.rows[0]) {
        await client.query("COMMIT");
        return duplicate.rows[0];
      }
      if (automaticLimits) {
        const recent = await client.query(
          "SELECT count(*)::int AS total, count(*) FILTER (WHERE lower(repo)=lower($1))::int AS repository FROM qa_jobs WHERE owner='github-app' AND created_at>now()-interval '1 hour'",
          [repo]
        );
        if (
          recent.rows[0].total >= automaticLimits.global ||
          recent.rows[0].repository >= automaticLimits.repository
        ) {
          throw new QaError(
            "WEBHOOK_RATE_LIMIT",
            "Automatic QA hourly run limit reached",
            "Inspect webhook.rate_limited audit events; wait for the next window or submit an explicit authorized dashboard run. Adjust QA_WEBHOOK_MAX_RUNS_PER_HOUR and QA_WEBHOOK_REPO_MAX_RUNS_PER_HOUR only after checking usage."
          );
        }
      }
      const count = await client.query(
        "SELECT count(*)::int AS count FROM qa_jobs WHERE status IN ('queued','running')"
      );
      if (count.rows[0].count >= 200) {
        throw new Error("Job queue is full (200)");
      }
      await client.query(
        "UPDATE qa_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=now() WHERE lower(repo)=lower($1) AND pr=$2 AND sha<>$3 AND status IN ('queued','running')",
        [repo, pr, sha]
      );
      const result = await client.query<Job>(
        "INSERT INTO qa_jobs(id,repo,pr,sha,owner,input,idempotency_key,status) VALUES($1,$2,$3,$4,$5,$6,$7,'queued') RETURNING *",
        [
          randomUUID(),
          repo,
          pr,
          sha,
          owner,
          JSON.stringify({ ...input, expectedSha: sha }),
          key,
        ]
      );
      const job = result.rows[0];
      if (!job) {
        throw new Error("Job insert returned no row");
      }
      await client.query(
        "INSERT INTO qa_audit(actor,action,run_id) VALUES($1,'enqueue',$2)",
        [owner, job.id]
      );
      await client.query("COMMIT");
      return job;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async claim(worker: string): Promise<Job | undefined> {
    // Expired running jobs are interrupted, never replayed: browser writes are not generally idempotent.
    await this.pool.query(
      "UPDATE qa_jobs SET status='interrupted',error='Worker lease expired; submit an explicit new run',updated_at=now() WHERE status='running' AND lease_until < now()"
    );
    const result = await this.pool.query<Job>(
      `WITH candidate AS (SELECT id FROM qa_jobs WHERE status='queued' AND NOT cancel_requested ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE qa_jobs j SET status='running',worker=$1,lease_until=now()+interval '45 seconds',updated_at=now() FROM candidate WHERE j.id=candidate.id RETURNING j.*`,
      [worker]
    );
    return result.rows[0];
  }
  async heartbeat(id: string, worker: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE qa_jobs SET lease_until=now()+interval '45 seconds',updated_at=now() WHERE id=$1 AND worker=$2 AND status='running' AND lease_until>now() AND NOT cancel_requested RETURNING id",
      [id, worker]
    );
    return result.rowCount === 1;
  }
  async complete(
    id: string,
    worker: string,
    outcome: string,
    error?: string,
    usage: unknown = {}
  ) {
    const result = await this.pool.query(
      "UPDATE qa_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'completed' END,outcome=CASE WHEN cancel_requested THEN 'blocked' ELSE $3 END,error=CASE WHEN cancel_requested THEN 'Run cancelled during completion' ELSE $4 END,usage=$5,lease_until=NULL,updated_at=now() WHERE id=$1 AND worker=$2 AND status='running' AND lease_until>now() RETURNING status",
      [id, worker, outcome, error ?? null, JSON.stringify(usage)]
    );
    if (!result.rowCount) {
      throw new Error("Worker lost job ownership; completion rejected");
    }
    return result.rows[0].status as string;
  }
  async cancel(id: string, actor: string) {
    await this.pool.query(
      "UPDATE qa_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=now() WHERE id=$1 AND status IN ('queued','running')",
      [id]
    );
    await this.audit(actor, "cancel", id);
  }
  async get(id: string): Promise<Job | undefined> {
    return (
      await this.pool.query<Job>("SELECT * FROM qa_jobs WHERE id=$1", [id])
    ).rows[0];
  }
  async list(repos: string[], status = "", search = "") {
    return (
      await this.pool.query<Job>(
        "SELECT * FROM qa_jobs WHERE lower(repo)=ANY($1::text[]) AND ($2='' OR status=$2) AND ($3='' OR repo ILIKE '%'||$3||'%' OR sha ILIKE $3||'%') ORDER BY created_at DESC LIMIT 200",
        [repos.map((repo) => repo.toLowerCase()), status, search]
      )
    ).rows;
  }
  async acceptDelivery(
    id: string,
    event: string,
    payload: { repo: string; number?: number; sha?: string; ignored?: boolean }
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(9287343)");
      const saved = await client.query(
        `INSERT INTO qa_deliveries(id,event,payload) SELECT $1,$2,$3::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM qa_deliveries WHERE $4 AND lower(payload->>'repo')=lower($5) AND payload->>'number'=$6 AND payload->>'sha'=$7)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          id,
          event,
          JSON.stringify(payload),
          !payload.ignored,
          payload.repo,
          String(payload.number ?? ""),
          payload.sha ?? "",
        ]
      );
      await client.query("COMMIT");
      return saved.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}
