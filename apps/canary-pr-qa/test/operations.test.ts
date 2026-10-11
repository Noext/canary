import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const wrapper = fileURLToPath(
  new URL("../../../scripts/pr-qa", import.meta.url)
);
async function commands() {
  const directory = await mkdtemp(join(tmpdir(), "canary-operations-test-"));
  const log = join(directory, "commands.log");
  const envFile = join(directory, "fixture.env");
  await writeFile(envFile, "# fixture only\n");
  await writeFile(
    join(directory, "docker"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$QA_WRAPPER_TEST_LOG"\n',
    { mode: 0o755 }
  );
  return {
    directory,
    log,
    envFile,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      QA_ENV_FILE: envFile,
      QA_WRAPPER_TEST_LOG: log,
    },
  };
}
describe.skipIf(process.platform === "win32")(
  "VPS command wrapper wiring (Docker stub, not a deployment test)",
  () => {
    it("builds and preflights before starting, then executes the live doctor", async () => {
      const f = await commands();
      await exec(
        "bash",
        [wrapper, "up", "--pr", "https://github.com/fixture/app/pull/1"],
        { env: f.env }
      );
      const lines = (await readFile(f.log, "utf8")).trim().split("\n");
      const build = lines.findIndex((line) => line.endsWith("build pr-qa"));
      const preflight = lines.findIndex((line) =>
        line.endsWith(
          "run --rm --no-deps -T pr-qa doctor --offline --skip-browser"
        )
      );
      const up = lines.findIndex((line) =>
        line.endsWith("up -d --wait --wait-timeout 120 pr-qa")
      );
      expect(build).toBeGreaterThanOrEqual(0);
      expect(preflight).toBeGreaterThan(build);
      expect(up).toBeGreaterThan(preflight);
      expect(lines.at(-1)).toContain(
        "canary-pr-qa doctor --pr https://github.com/fixture/app/pull/1"
      );
    });
    it("routes diagnosis and stop through the same project without deleting volumes", async () => {
      const f = await commands();
      await exec(
        "bash",
        [wrapper, "diagnose", "12345678-1234-1234-1234-123456789012"],
        { env: f.env }
      );
      await exec("bash", [wrapper, "stop"], { env: f.env });
      const log = await readFile(f.log, "utf8");
      expect(log).toContain(
        "canary-pr-qa diagnose 12345678-1234-1234-1234-123456789012"
      );
      expect(log).toContain("stop pr-qa");
      expect(log).not.toContain("--volumes");
    });
  }
);
