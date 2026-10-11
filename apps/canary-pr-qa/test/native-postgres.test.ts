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
        await q.enqueue(
          repo,
          2,
          BASE_SHA,
          "ci",
          { prUrl: PR_URL },
          `${namespace}:updated`
        );
        expect((await q.get(jobs[1]!.id))?.cancel_requested).toBe(true);
      } finally {
        await q.pool.query("DELETE FROM qa_jobs WHERE repo=$1", [repo]);
        await q.close();
      }
    }, 60_000);
  }
);
