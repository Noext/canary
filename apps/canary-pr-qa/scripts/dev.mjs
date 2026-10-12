import { spawn } from "node:child_process";
import "./build.mjs";

// Match production compilation; pnpm may forward its argument separator.
const args = process.argv.slice(2);
if (args[0] === "--") {
  args.shift();
}
const child = spawn(process.execPath, ["dist/cli.js", ...args], {
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (failure) => {
  process.stderr.write(`${failure.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 128 : (code ?? 1);
});
