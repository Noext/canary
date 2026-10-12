import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isStopping, setHarnessProcess } from "./harness-process";
import { type HarnessState, harnessStateFile } from "./state";

/** Line the harness prints once the fixture, the server and the worker run. */
const READY = "CANARY_E2E_READY ";
/** Enough of the harness output to explain a startup failure. */
const TAIL = 4000;

const packageRoot = join(import.meta.dirname, "..");
/** The harness runs the PR QA server source, so it needs that workspace's tsx. */
const requireFromPrQa = createRequire(
  join(packageRoot, "..", "canary-pr-qa", "package.json")
);

function startHarness(): Promise<HarnessState> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      requireFromPrQa.resolve("tsx"),
      join(import.meta.dirname, "harness.mjs"),
    ],
    { cwd: packageRoot, stdio: ["pipe", "pipe", "pipe"] }
  );
  setHarnessProcess(child);
  let output = "";
  let settled = false;
  return new Promise<HarnessState>((resolve, reject) => {
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(new Error(`The e2e harness could not start: ${error.message}`));
      }
    });
    child.on("exit", (code, signal) => {
      if (settled) {
        if (!isStopping()) {
          process.stderr.write(
            `e2e harness exited during the run (code ${code}, signal ${signal})\n`
          );
        }
        return;
      }
      settled = true;
      reject(
        new Error(
          `The e2e harness exited before it was ready (code ${code}, signal ${signal}).\n${output.slice(-TAIL)}`
        )
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output
        .split("\n")
        .find((candidate) => candidate.startsWith(READY));
      if (line && !settled) {
        settled = true;
        resolve(JSON.parse(line.slice(READY.length)) as HarnessState);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
  });
}

/**
 * One fixture, one production server and one worker for the whole suite: the
 * specs share the state it creates, and no spec may start its own world.
 */
export default async function globalSetup(): Promise<void> {
  // The server embeds the Vite build, so a stale `dist` would test the wrong
  // dashboard; rebuild before anything connects.
  execFileSync("pnpm", ["run", "build"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  const state = await startHarness();
  mkdirSync(join(import.meta.dirname, ".auth"), { recursive: true });
  writeFileSync(harnessStateFile, `${JSON.stringify(state, null, 2)}\n`);
}
