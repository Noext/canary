import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "@usecanary/logger";
import { completeRun } from "./completion.js";
import type { Config } from "./config.js";
import { diagnose } from "./diagnostics.js";
import { GitHubSetup } from "./github-setup.js";
import { PreviewHosts } from "./preview-hosts.js";
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
  const setup = new GitHubSetup(queue.pool, config);
  const previewHosts = new PreviewHosts(queue.pool, config);
  await previewHosts
    .load()
    .catch((error) =>
      logger.warn(
        { diagnostic: diagnose(error, config) },
        "Preview host list refresh failed"
      )
    );
  const worker = randomUUID();
  let active: AbortController | undefined;
  const shutdown = () => {
    stop.abort();
    active?.abort(new Error("Worker stopping"));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  let lastRetention = 0;
  let lastGitHubSync = 0;
  let lastPreviewHosts = 0;
  try {
    while (!stop.signal.aborted) {
      if (Date.now() - lastGitHubSync > 60_000) {
        lastGitHubSync = Date.now();
        if (await setup.app()) {
          await setup
            .refresh()
            .catch((error) =>
              logger.warn(
                { diagnostic: diagnose(error, config) },
                "GitHub installation sync failed"
              )
            );
        }
      }
      if (Date.now() - lastPreviewHosts > 15_000) {
        lastPreviewHosts = Date.now();
        await previewHosts
          .load()
          .catch((error) =>
            logger.warn(
              { diagnostic: diagnose(error, config) },
              "Preview host list refresh failed"
            )
          );
      }
      await processDelivery(queue, await setup.effective()).catch((error) =>
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
      let effective = config;
      try {
        // A list edited just before this run applies to this run, not to the next
        // worker iteration: preview validation must see the current hosts.
        await previewHosts
          .load()
          .catch((error) =>
            logger.warn(
              { diagnostic: diagnose(error, config) },
              "Preview host list refresh failed"
            )
          );
        effective = await setup.effective();
        if (!effective.allowedRepos.includes(job.repo.toLowerCase())) {
          throw new Error("Repository is no longer connected or allowed");
        }
        const result = await runScope.run(
          {
            id: job.id,
            signal: controller.signal,
            tokens: 0,
            costUsd: 0,
            reservedTokens: 0,
            reservedCostUsd: 0,
            calls: 0,
            maxTokens: config.QA_RUN_MAX_TOKENS,
            maxCostUsd: config.QA_RUN_MAX_COST_USD,
            verifyOwnership: async () => {
              controller.signal.throwIfAborted();
              if (
                !(await setup.effective()).allowedRepos.includes(
                  job.repo.toLowerCase()
                )
              ) {
                throw new Error("Repository disconnected before publication");
              }
              if (!(await queue.heartbeat(job.id, worker))) {
                controller.abort(
                  new Error(
                    "Run cancelled or worker lease lost before publication"
                  )
                );
                controller.signal.throwIfAborted();
              }
            },
          },
          () => runQa({ ...job.input, id: job.id }, effective)
        );
        await completeRun(queue, job.id, worker, result, effective);
      } catch (error) {
        logger.error(
          { runId: job.id, diagnostic: diagnose(error, effective) },
          "Worker run failed"
        );
        await queue
          .complete(
            job.id,
            worker,
            "blocked",
            diagnose(error, effective).message
          )
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
