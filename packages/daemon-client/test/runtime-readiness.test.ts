import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_RUNTIME_DEPENDENCIES } from "@usecanary/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { embeddedRuntimeInstalled } from "../src/daemon/extract.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function runtime() {
  const root = await mkdtemp(join(tmpdir(), "canary-runtime-readiness-"));
  directories.push(root);
  for (const [name, version] of Object.entries(DAEMON_RUNTIME_DEPENDENCIES)) {
    const path = join(root, "node_modules", name);
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({ name, version: version.replace(/^\^/, "") })
    );
  }
  return root;
}
describe("embedded runtime compatibility", () => {
  it("accepts installed dependencies matching the pinned Playwright protocol", async () => {
    expect(await embeddedRuntimeInstalled(await runtime())).toBe(true);
  });
  it("rejects a present but incompatible Playwright package", async () => {
    const root = await runtime();
    await writeFile(
      join(root, "node_modules/playwright/package.json"),
      JSON.stringify({ version: "1.0.0" })
    );
    expect(await embeddedRuntimeInstalled(root)).toBe(false);
  });
  it("rejects missing or corrupt runtime manifests", async () => {
    const root = await runtime();
    await writeFile(
      join(root, "node_modules/pino/package.json"),
      "invalid-json"
    );
    expect(await embeddedRuntimeInstalled(root)).toBe(false);
    await rm(join(root, "node_modules/playwright-core"), { recursive: true });
    expect(await embeddedRuntimeInstalled(root)).toBe(false);
  });
});
