import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const daemonDir = fileURLToPath(new URL("../../../", import.meta.url));

export async function ensureSandboxClientBundle(): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/bundle-sandbox-client.ts"],
    {
      cwd: daemonDir,
    }
  );
}
