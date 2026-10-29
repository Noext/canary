import { parseArgs } from "node:util";
import { startBrowserService } from "./browser-service.js";
import { type Config, loadConfig } from "./config.js";
import { diagnose } from "./diagnostics.js";
import { doctor, supportSummary } from "./doctor.js";
import { startEgressProxy } from "./egress-proxy.js";
import { LocalAuth } from "./local-auth.js";
import { startProductionServer } from "./production-server.js";
import { Queue } from "./queue.js";
import { runReplay } from "./replay.js";
import { runQa } from "./runner.js";
import { startServer } from "./server.js";
import { initializeTracing } from "./telemetry.js";
import { startWorker } from "./worker.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      origin: { type: "string" },
      preview: { type: "string" },
      model: { type: "string" },
      "no-publish": { type: "boolean" },
      help: { type: "boolean" },
      json: { type: "boolean" },
      offline: { type: "boolean" },
      "skip-browser": { type: "boolean" },
      mode: { type: "string" },
      pr: { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(
      "canary-pr-qa run <https://github.com/owner/repo/pull/number> [--preview URL] [--model ID] [--no-publish]\ncanary-pr-qa replay <bundle.json> [--mode gate|plan]\ncanary-pr-qa serve\ncanary-pr-qa doctor [--offline] [--skip-browser] [--pr PR_URL] [--preview URL] [--json]\ncanary-pr-qa diagnose RUN_ID\ncanary-pr-qa setup-admin [--origin https://qa.example.com]\ncanary-pr-qa reset-password USERNAME (password from stdin)\nConfiguration: .env.example at the repository root (Node --env-file=.env)\n"
    );
    return;
  }
  const config = loadConfig();
  if (command === "replay" && positionals.length === 2 && positionals[1]) {
    const mode = values.mode ?? "gate";
    if (mode !== "gate" && mode !== "plan") {
      throw new Error("Replay mode must be gate or plan");
    }
    const result = await runReplay(positionals[1], mode, config);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.refusals.length === 0 ? 0 : 1;
    return;
  }
  const stopTracing = initializeTracing();
  process.once("beforeExit", () => void stopTracing?.());
  if (
    (await accountCommand(command, positionals, values.origin, config)) ||
    (await serviceCommand(command, config))
  ) {
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
  process.exitCode = resultExitCode(result);
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

async function accountCommand(
  command: string | undefined,
  args: string[],
  origin: string | undefined,
  config: Config
) {
  if (!["setup-admin", "reset-password"].includes(command ?? "")) {
    return false;
  }
  if (!config.DATABASE_URL) {
    throw new Error("PostgreSQL is required for local accounts.");
  }
  const queue = new Queue(config.DATABASE_URL);
  try {
    await queue.migrate();
    const auth = new LocalAuth(queue.pool);
    if (command === "setup-admin") {
      const url = new URL(
        origin ??
          (config.ARTIFACT_BASE_URL || `http://127.0.0.1:${config.QA_PORT}`)
      );
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      ) {
        throw new Error(
          "Supply a dashboard origin, e.g. --origin https://canary.pharmania.fr"
        );
      }
      const ticket = await auth.issueSetupTicket();
      url.hash = `setup=${ticket}`;
      process.stdout.write(
        `Open this private setup link within 15 minutes:\n${url.href}\n`
      );
    } else {
      if (!args[1]) {
        throw new Error(
          "Use reset-password USERNAME; send the new password via stdin."
        );
      }
      const password = await stdinPassword();
      await auth.resetPassword(args[1], password);
      process.stdout.write("Password updated. All local sessions revoked.\n");
    }
  } finally {
    await queue.close();
  }
  return true;
}

async function stdinPassword() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024) {
      throw new Error("Password input exceeds limit.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

function resultExitCode(result: { outcome: string; error?: string }) {
  if (result.outcome === "passed" && !result.error) {
    return 0;
  }
  return result.outcome === "failed" ? 1 : 2;
}
