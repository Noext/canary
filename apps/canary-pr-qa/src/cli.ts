import { parseArgs } from "node:util";
import { startBrowserService } from "./browser-service.js";
import { type Config, loadConfig } from "./config.js";
import { diagnose } from "./diagnostics.js";
import { doctor, supportSummary } from "./doctor.js";
import { startEgressProxy } from "./egress-proxy.js";
import { startProductionServer } from "./production-server.js";
import { runQa } from "./runner.js";
import { startServer } from "./server.js";
import { initializeTracing } from "./telemetry.js";
import { startWorker } from "./worker.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      preview: { type: "string" },
      model: { type: "string" },
      "no-publish": { type: "boolean" },
      help: { type: "boolean" },
      json: { type: "boolean" },
      offline: { type: "boolean" },
      "skip-browser": { type: "boolean" },
      pr: { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(
      "canary-pr-qa run <https://github.com/owner/repo/pull/number> [--preview URL] [--model ID] [--no-publish]\ncanary-pr-qa serve\ncanary-pr-qa doctor [--offline] [--skip-browser] [--pr PR_URL] [--preview URL] [--json]\ncanary-pr-qa diagnose RUN_ID\nConfiguration: .env.example at the repository root (Node --env-file=.env)\n"
    );
    return;
  }
  const config = loadConfig();
  const stopTracing = initializeTracing();
  process.once("beforeExit", () => void stopTracing?.());
  if (await serviceCommand(command, config)) {
    return;
  }
  if (command === "doctor" && positionals.length === 1) {
    const result = await doctor(config, {
      offline: values.offline,
      skipBrowser: values["skip-browser"],
      prUrl: values.pr,
      previewUrl: values.preview,
    });
    process.stdout.write(
      values.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${result.checks
            .map(
              (c) =>
                `${c.status.toUpperCase()} ${c.name} (${c.durationMs}ms): ${c.message}${c.diagnostic ? `\n  ${c.diagnostic.code}: ${c.diagnostic.hint}` : ""}`
            )
            .join("\n")}\n`
    );
    process.exitCode = result.healthy ? 0 : 2;
    return;
  }
  if (command === "diagnose" && positionals.length === 2 && positionals[1]) {
    process.stdout.write(
      `${JSON.stringify(await supportSummary(positionals[1], config), null, 2)}\n`
    );
    return;
  }
  if (command === "serve" && positionals.length === 1) {
    const server = config.DATABASE_URL
      ? await startProductionServer(config)
      : await startServer(config);
    let stopping = false;
    const shutdown = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      void server
        .shutdown()
        .then(() => process.exit(0))
        .catch((error) => {
          process.stderr.write(`${diagnose(error, config).message}\n`);
          process.exit(2);
        });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    return;
  }
  if (command !== "run" || positionals.length !== 2 || !positionals[1]) {
    throw new Error("Use run <PR URL> or serve; see --help");
  }
  const result = await runQa(
    {
      prUrl: positionals[1],
      previewUrl: values.preview,
      publish: !values["no-publish"],
      model: values.model,
    },
    config
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 2;
  if (result.outcome === "passed" && !result.error) {
    process.exitCode = 0;
  } else if (result.outcome === "failed") {
    process.exitCode = 1;
  }
}
main().catch((error) => {
  const diagnostic = diagnose(error);
  process.stderr.write(
    `${diagnostic.code}: ${diagnostic.message}\nFix: ${diagnostic.hint}\n`
  );
  process.exitCode = 2;
});

async function serviceCommand(command: string | undefined, config: Config) {
  if (command === "egress-proxy") {
    await startEgressProxy(config);
    return true;
  }
  if (command === "worker") {
    await startWorker(config);
    return true;
  }
  if (command === "browser-service") {
    await startBrowserService(config);
    return true;
  }
  return false;
}
