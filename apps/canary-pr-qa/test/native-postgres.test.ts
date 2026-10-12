import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";
import { BASE_SHA, PR_URL, SHA } from "./fixture.js";

// Dedicated disposable CI database only; this suite creates/deletes its own namespaced rows.
describe.skipIf(!process.env.QA_TEST_DATABASE_URL)(
  "native PostgreSQL concurrent workers and fault injection",
  () => {
    it("claims each job once under concurrent workers and recovers expired leases without replay", async () => {
      const q = new Queue(process.env.QA_TEST_DATABASE_URL!);
      await q.migrate();
      const namespace = `load-${randomUUID()}`;
      const repo = `test/${namespace}`;
      try {
        const jobs = await Promise.all(
          Array.from({ length: 50 }, (_, index) =>
            q.enqueue(
              repo,
              index + 1,
              SHA,
              "ci",
              { prUrl: PR_URL },
              `${namespace}:${index}`
            )
          )
        );
        const claims = await Promise.all(
          Array.from({ length: 50 }, (_, index) =>
            q.claim(`${namespace}:${index}`)
          )
        );
        expect(new Set(claims.map((c) => c?.id)).size).toBe(50);
        expect(claims.every((c) => jobs.some((j) => j.id === c?.id))).toBe(
          true
        );
        const victim = claims[0]!;
        await q.pool.query(
          "UPDATE qa_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",
          [victim.id]
        );
        expect(await q.heartbeat(victim.id, victim.worker!)).toBe(false);
        await expect(
          q.complete(victim.id, victim.worker!, "passed")
        ).rejects.toThrow();
        await q.claim(namespace);
        expect((await q.get(victim.id))?.status).toBe("interrupted");
        await expect(
          q.complete(victim.id, victim.worker!, "passed")
        ).rejects.toThrow();
        // Concurrent claim order is intentionally unspecified: cancel a different job from the expired victim.
        const updated = jobs.find((job) => job.id !== victim.id)!;
        await q.enqueue(
          repo,
          updated.pr,
          BASE_SHA,
          "ci",
          { prUrl: PR_URL },
          `${namespace}:updated`
        );
        expect((await q.get(updated.id))?.cancel_requested).toBe(true);
      } finally {
        await q.pool.query("DELETE FROM qa_jobs WHERE repo=$1", [repo]);
        await q.close();
      }
    }, 60_000);
  }
);

describe.skipIf(!process.env.QA_TEST_DATABASE_URL)(
  "native PostgreSQL webhook contention",
  () => {
    it("admits one inbox row and one automatic run per SHA, enforcing repository budget atomically", async () => {
      const q = new Queue(process.env.QA_TEST_DATABASE_URL!);
      await q.migrate();
      const repo = `test/webhook-${randomUUID()}`;
      const payload = { repo, number: 1, sha: SHA };
      const limits = { global: 10_000, repository: 1 };
      try {
        const accepted = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            q.acceptDelivery(`${repo}-${index}`, "pull_request", payload)
          )
        );
        expect(accepted.filter(Boolean)).toHaveLength(1);
        const jobs = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            q.enqueue(
              repo,
              1,
              SHA,
              "github-app",
              { prUrl: PR_URL },
              `webhook:${repo}:delivery-${index}`,
              limits
            )
          )
        );
        expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
        const rejected = await Promise.allSettled(
          Array.from({ length: 12 }, (_, index) =>
            q.enqueue(
              repo,
              index + 2,
              SHA,
              "github-app",
              { prUrl: PR_URL },
              `webhook:${repo}:other-pr-${index}`,
              limits
            )
          )
        );
        expect(
          rejected.every(
            (result) =>
              result.status === "rejected" &&
              result.reason.code === "WEBHOOK_RATE_LIMIT"
          )
        ).toBe(true);
        expect(await q.list([repo.toUpperCase()])).toHaveLength(1);
      } finally {
        await q.pool.query(
          "DELETE FROM qa_deliveries WHERE payload->>'repo'=$1",
          [repo]
        );
        await q.pool.query("DELETE FROM qa_jobs WHERE repo=$1", [repo]);
        await q.close();
      }
    }, 60_000);
  }
);
