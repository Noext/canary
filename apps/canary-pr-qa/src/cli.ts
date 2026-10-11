import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { runQa } from "./runner.js";
import { startServer } from "./server.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      preview: { type: "string" },
      "no-publish": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(
      "canary-pr-qa run <https://github.com/owner/repo/pull/number> [--preview URL] [--no-publish]\ncanary-pr-qa serve\nConfiguration: .env.example at the repository root (Node --env-file=.env)\n"
    );
    return;
  }
  const config = loadConfig();
  if (command === "serve" && positionals.length === 1) {
    await startServer(config);
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
  process.stderr.write(
    `Error: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 2;
});
