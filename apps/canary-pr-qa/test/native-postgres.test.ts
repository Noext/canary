import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { GitHubSetup } from "../src/github-setup.js";
import { LocalAuth } from "../src/local-auth.js";
import { Queue } from "../src/queue.js";
import { BASE_SHA, PR_URL, SHA } from "./fixture.js";
import { githubSetupFixture } from "./github-setup-fixture.js";

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

it.skipIf(!process.env.QA_TEST_DATABASE_URL)(
  "admits only one first admin under native PostgreSQL contention",
  async () => {
    const base = new Queue(process.env.QA_TEST_DATABASE_URL!);
    const namespace = `auth_test_${randomUUID().replaceAll("-", "")}`;
    await base.pool.query(`CREATE SCHEMA ${namespace}`);
    const url = new URL(process.env.QA_TEST_DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${namespace}`);
    const isolated = new Queue(url.href);
    try {
      await isolated.migrate();
      const auth = new LocalAuth(isolated.pool);
      const setupCode = await auth.issueSetupTicket();
      const results = await Promise.allSettled(
        ["admin-one", "admin-two"].map((username) =>
          auth.setup(
            { username, password: "native-password-long-2026", setupCode },
            ["fixture/app"]
          )
        )
      );
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1);
      expect(
        (await isolated.pool.query("SELECT id FROM qa_local_users")).rows
      ).toHaveLength(1);
      await expect(auth.issueSetupTicket()).rejects.toThrow("existe déjà");
    } finally {
      await isolated.close();
      await base.pool.query(`DROP SCHEMA ${namespace} CASCADE`);
      await base.close();
    }
  },
  30_000
);

describe.skipIf(!process.env.QA_TEST_DATABASE_URL)(
  "native PostgreSQL GitHub App removal race",
  () => {
    it("never lets an already-consumed manifest callback recreate the App after a disconnect", async () => {
      const q = new Queue(process.env.QA_TEST_DATABASE_URL!);
      await q.migrate();
      const f = await githubSetupFixture();
      const setup = new GitHubSetup(q.pool, {
        ...f.config,
        DATABASE_URL: process.env.QA_TEST_DATABASE_URL!,
      });
      // Waiters on the GitHub App serialization lock, in request order.
      const waiters = async (minimum: number) => {
        for (let attempt = 0; attempt < 400; attempt++) {
          const row = await q.pool.query(
            "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted"
          );
          if (row.rows[0].count >= minimum) {
            return true;
          }
          await delay(25);
        }
        return false;
      };
      const blocker = await q.pool.connect();
      try {
        // A second admin starts a manifest flow while the instance is still
        // unconnected, then another admin connects the App with its own state.
        const registration = await setup.manifest("second-admin", {
          name: "Canary team QA",
        });
        const state = new URL(registration.action).searchParams.get("state")!;
        await setup.convert(
          "admin",
          await setup.state("admin", "manifest"),
          "fixture-manifest-code"
        );
        expect((await setup.status()).app?.id).toBe("95001");
        // The pending callback and a disconnect are now queued behind a held
        // lock, disconnect first: consuming that state outside the lock could
        // let the callback insert a new App after the removal commits.
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(9287346)");
        const removal = setup.disconnect({});
        expect(await waiters(1)).toBe(true);
        const conversion = setup
          .convert("second-admin", state, "fixture-manifest-code")
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(await waiters(2)).toBe(true);
        await blocker.query("ROLLBACK");
        await removal;
        expect(await conversion).toMatchObject({
          code: "GITHUB_STATE_INVALID",
        });
        expect(f.state.conversionCount).toBe(1);
        expect((await setup.status()).app).toBeNull();
        expect((await setup.status()).repositories).toEqual([]);
        expect(
          (
            await q.pool.query(
              "SELECT count(*)::int AS count FROM qa_github_app"
            )
          ).rows[0].count
        ).toBe(0);
        expect(
          (
            await q.pool.query(
              "SELECT count(*)::int AS count FROM qa_github_repositories"
            )
          ).rows[0].count
        ).toBe(0);
      } finally {
        await q.pool.query("DELETE FROM qa_github_app");
        await q.pool.query("DELETE FROM qa_github_state");
        await q.pool.query("DELETE FROM qa_github_repositories");
        await blocker.release();
        await f.close();
        await q.close();
      }
    }, 60_000);
  }
);
