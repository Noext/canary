import { parseArgs } from "node:util";
import { startBrowserService } from "./browser-service.js";
import { type Config, loadConfig } from "./config.js";
import { type Diagnostic, diagnose } from "./diagnostics.js";
import { doctor, supportSummary } from "./doctor.js";
import { startEgressProxy } from "./egress-proxy.js";
import { LocalAuth } from "./local-auth.js";
import { startProductionServer } from "./production-server.js";
import { Queue } from "./queue.js";
import { replayExitCode, runReplay } from "./replay.js";
import { runQa } from "./runner.js";
import { startServer } from "./server.js";
import { initializeTracing } from "./telemetry.js";
import { startWorker } from "./worker.js";

interface CliValues {
  help?: boolean;
  json?: boolean;
  mode?: string;
  model?: string;
  "no-publish"?: boolean;
  offline?: boolean;
  origin?: string;
  pr?: string;
  preview?: string;
  "skip-browser"?: boolean;
}

const USAGE =
  "canary-pr-qa run <https://github.com/owner/repo/pull/number> [--preview URL] [--model ID] [--no-publish]\ncanary-pr-qa replay <bundle.json> [--mode gate|plan]\ncanary-pr-qa serve\ncanary-pr-qa doctor [--offline] [--skip-browser] [--pr PR_URL] [--preview URL] [--json]\ncanary-pr-qa diagnose RUN_ID\ncanary-pr-qa setup-admin [--origin https://qa.example.com]\ncanary-pr-qa reset-password USERNAME (password from stdin)\nConfiguration: .env.example at the repository root (Node --env-file=.env)\n";

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
    process.stdout.write(USAGE);
    return;
  }
  const config = loadConfig();
  if (await replayCommand(command, positionals, values.mode, config)) {
    return;
  }
  const stopTracing = initializeTracing();
  process.once("beforeExit", () => void stopTracing?.());
  if (
    (await accountCommand(command, positionals, values.origin, config)) ||
    (await serviceCommand(command, config)) ||
    (await doctorCommand(command, positionals, values, config)) ||
    (await diagnoseCommand(command, positionals, config)) ||
    (await serveCommand(command, positionals, config))
  ) {
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

async function replayCommand(
  command: string | undefined,
  args: string[],
  requestedMode: string | undefined,
  config: Config
) {
  if (command !== "replay" || args.length !== 2 || !args[1]) {
    return false;
  }
  const mode = requestedMode ?? "gate";
  if (mode !== "gate" && mode !== "plan") {
    throw new Error("Replay mode must be gate or plan");
  }
  const result = await runReplay(args[1], mode, config);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // Le code de sortie suit le verdict, pas la liste des refus : `unproven`
  // (preuve de page absente ou coupée) n'a rien refusé et n'a pourtant rien
  // prouvé, donc il ne peut pas sortir en succès.
  process.exitCode = replayExitCode(result.verdict);
  return true;
}

function checkLines(
  checks: readonly {
    diagnostic?: Diagnostic;
    durationMs: number;
    message: string;
    name: string;
    status: string;
  }[]
) {
  return checks
    .map(
      (check) =>
        `${check.status.toUpperCase()} ${check.name} (${check.durationMs}ms): ${check.message}${check.diagnostic ? `\n  ${check.diagnostic.code}: ${check.diagnostic.hint}` : ""}`
    )
    .join("\n");
}

async function doctorCommand(
  command: string | undefined,
  args: string[],
  values: CliValues,
  config: Config
) {
  if (command !== "doctor" || args.length !== 1) {
    return false;
  }
  const result = await doctor(config, {
    offline: values.offline,
    skipBrowser: values["skip-browser"],
    prUrl: values.pr,
    previewUrl: values.preview,
  });
  process.stdout.write(
    values.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${checkLines(result.checks)}\n`
  );
  process.exitCode = result.healthy ? 0 : 2;
  return true;
}

async function diagnoseCommand(
  command: string | undefined,
  args: string[],
  config: Config
) {
  if (command !== "diagnose" || args.length !== 2 || !args[1]) {
    return false;
  }
  process.stdout.write(
    `${JSON.stringify(await supportSummary(args[1], config), null, 2)}\n`
  );
  return true;
}

async function serveCommand(
  command: string | undefined,
  args: string[],
  config: Config
) {
  if (command !== "serve" || args.length !== 1) {
    return false;
  }
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
  return true;
}

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
