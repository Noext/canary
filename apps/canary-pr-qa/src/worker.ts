import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "@usecanary/logger";
import type { Config } from "./config.js";
import { diagnose } from "./diagnostics.js";
import { Queue } from "./queue.js";
import { retain } from "./retention.js";
import { runScope } from "./run-scope.js";
import { runQa } from "./runner.js";
import { processDelivery } from "./webhook-inbox.js";

const logger = createLogger({ name: "qa-worker" });
export async function startWorker(
  config: Config,
  stop = new AbortController()
) {
  const queue = new Queue(config.DATABASE_URL);
  await queue.migrate();
  const worker = randomUUID();
  let active: AbortController | undefined;
  const shutdown = () => {
    stop.abort();
    active?.abort(new Error("Worker stopping"));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  let lastRetention = 0;
  try {
    while (!stop.signal.aborted) {
      await processDelivery(queue, config).catch((error) =>
        logger.warn(
          { diagnostic: diagnose(error, config) },
          "Webhook inbox retry"
        )
      );
      if (Date.now() - lastRetention > 3_600_000) {
        await retain(queue, config);
        lastRetention = Date.now();
      }
      const job = await queue.claim(worker);
      if (!job) {
        await delay(1000, undefined, { signal: stop.signal }).catch(
          () => undefined
        );
        continue;
      }
      active = new AbortController();
      const controller = active;
      const timer = setTimeout(
        () => controller.abort(new Error("Run deadline exceeded")),
        config.QA_RUN_TIMEOUT_SECONDS * 1000
      );
      const heartbeat = setInterval(() => {
        void queue
          .heartbeat(job.id, worker)
          .then((valid) => {
            if (!valid) {
              controller.abort(new Error("Run cancelled or worker lease lost"));
            }
          })
          .catch(() =>
            controller.abort(new Error("Database heartbeat failed"))
          );
      }, 10_000);
      try {
        const result = await runScope.run(
          {
            id: job.id,
            signal: controller.signal,
            tokens: 0,
            costUsd: 0,
            calls: 0,
            maxTokens: config.QA_RUN_MAX_TOKENS,
            maxCostUsd: config.QA_RUN_MAX_COST_USD,
          },
          () => runQa({ ...job.input, id: job.id }, config)
        );
        await queue.complete(
          job.id,
          worker,
          result.outcome,
          result.error,
          result.usage
        );
      } catch (error) {
        logger.error(
          { runId: job.id, diagnostic: diagnose(error, config) },
          "Worker run failed"
        );
        await queue
          .complete(job.id, worker, "blocked", diagnose(error, config).message)
          .catch(() => undefined);
      } finally {
        clearInterval(heartbeat);
        clearTimeout(timer);
        active = undefined;
      }
    }
  } finally {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    await queue.close();
  }
}
