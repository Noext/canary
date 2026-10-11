import { spawn } from "node:child_process";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import type { Action, Assertion, Locator } from "./schema.js";

const MARKER = "CANARY_PR_QA_OBSERVATION:";
const observationSchema = z.object({
  url: z.string(),
  snapshot: z.string(),
  actual: z.unknown().optional(),
});
export type Observation = z.infer<typeof observationSchema>;

export function locatorExpression(locator: Locator): string {
  const value = JSON.stringify(locator.value);
  switch (locator.by) {
    case "css":
      return `page.locator(${value})`;
    case "role":
      return `page.getByRole(${value}, { name: ${JSON.stringify(locator.name)}, exact: true })`;
    case "text":
      return `page.getByText(${value}, { exact: true })`;
    case "label":
      return `page.getByLabel(${value}, { exact: true })`;
    case "placeholder":
      return `page.getByPlaceholder(${value}, { exact: true })`;
    case "testId":
      return `page.getByTestId(${value})`;
    default:
      throw new Error("Unsupported locator");
  }
}

export function assertionMatches(
  assertion: Assertion,
  actual: unknown
): boolean {
  if (assertion.kind === "visible") {
    return actual === true;
  }
  if (assertion.kind === "hidden") {
    return actual === false;
  }
  if (assertion.kind === "text") {
    return (
      typeof actual === "string" &&
      actual
        .replace(/\s+/g, " ")
        .trim()
        .includes(assertion.expected.replace(/\s+/g, " ").trim())
    );
  }
  return actual === assertion.expected;
}

function readAssertion(assertion: Assertion, locator?: Locator): string {
  if (assertion.kind === "url") {
    return "page.url()";
  }
  if (!locator) {
    throw new Error("A locator is required for this assertion");
  }
  const loc = locatorExpression(locator);
  switch (assertion.kind) {
    case "text":
      return `await ${loc}.innerText({ timeout: 5000 })`;
    case "value":
      return `await ${loc}.inputValue({ timeout: 5000 })`;
    case "count":
      return `await ${loc}.count()`;
    default:
      return `await ${loc}.isVisible()`;
  }
}
function compileAssertion(
  action: Extract<Action, { type: "assert" }>,
  assertion?: Assertion
): string {
  if (!assertion || assertion.id !== action.assertionId) {
    throw new Error("Unknown planned assertion");
  }
  const read = readAssertion(assertion, action.locator);
  const expected =
    "expected" in assertion ? assertion.expected : assertion.kind === "visible";
  const matches =
    assertion.kind === "text"
      ? `typeof actual === "string" && actual.replace(/\\s+/g, " ").trim().includes(${JSON.stringify(String(expected).replace(/\s+/g, " ").trim())})`
      : `actual === ${JSON.stringify(expected)}`;
  return `for (let attempt = 0; attempt < 30; attempt++) { actual = ${read}; if (${matches}) break; await page.waitForTimeout(100); }`;
}
function compileInteraction(action: Action): string {
  if (!("locator" in action && action.locator)) {
    throw new Error("Not a browser action");
  }
  const loc = locatorExpression(action.locator);
  switch (action.type) {
    case "click":
      return `await ${loc}.click({ timeout: 10000 });`;
    case "fill":
      return `await ${loc}.fill(${JSON.stringify(action.value)}, { timeout: 10000 });`;
    case "press":
      return `await ${loc}.press(${JSON.stringify(action.key)}, { timeout: 10000 });`;
    case "select":
      return `await ${loc}.selectOption(${JSON.stringify(action.value)}, { timeout: 10000 });`;
    case "check":
      return `await ${loc}.setChecked(${action.checked}, { timeout: 10000 });`;
    default:
      throw new Error("Unsupported browser action");
  }
}
export function compileAction(
  action: Action,
  previewUrl: string,
  assertion?: Assertion
): string {
  const preview = new URL(previewUrl);
  let command = "";
  if (action.type === "goto") {
    const target = new URL(action.path, preview);
    if (
      target.origin !== preview.origin ||
      target.username ||
      target.password
    ) {
      throw new Error("Navigation must remain on the preview origin");
    }
    command = `await page.goto(${JSON.stringify(target.href)}, { waitUntil: "domcontentloaded", timeout: 15000 });`;
  } else if (action.type === "assert") {
    command = compileAssertion(action, assertion);
  } else if (action.type !== "observe") {
    command = compileInteraction(action);
  }
  return `const page = await browser.getPage("qa");
let actual;
${command}
const url = page.url();
if (url !== "about:blank" && !url.startsWith(${JSON.stringify(`${preview.origin}/`)})) throw new Error("Page left the allowed preview origin");
console.log(${JSON.stringify(MARKER)} + JSON.stringify({ url, snapshot: (await page.snapshotForAI({ depth: 12 })).full.slice(0, 14000), actual }));`;
}

export class Canary {
  private readonly config: Config;
  constructor(config: Config) {
    this.config = config;
  }
  command(
    args: string[],
    script?: string
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [this.config.CANARY_CLI_PATH, "--json", ...args],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      let stdout = "";
      let stderr = "";
      let exceeded = false;
      const timer = setTimeout(
        () => {
          exceeded = true;
          child.kill("SIGKILL");
        },
        (this.config.QA_STEP_TIMEOUT_SECONDS + 30) * 1000
      );
      const collect = (channel: "stdout" | "stderr", data: Buffer) => {
        if (channel === "stdout") {
          stdout += data.toString();
        } else {
          stderr += data.toString();
        }
        if (stdout.length + stderr.length > 4_000_000) {
          exceeded = true;
          child.kill("SIGKILL");
        }
      };
      child.stdout.on("data", (data: Buffer) => collect("stdout", data));
      child.stderr.on("data", (data: Buffer) => collect("stderr", data));
      child.stdin.on("error", () => {
        /* child may fail before consuming stdin */
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (exceeded) {
          reject(
            new QaError(
              "CANARY_COMMAND_LIMIT",
              "Canary command timed out or exceeded output budget",
              "Run doctor and inspect ~/.canary/daemon.log. Check Chromium resources and timeout settings before increasing limits."
            )
          );
        } else {
          resolve({ code: code ?? 1, stdout, stderr });
        }
      });
      child.stdin.end(script);
    });
  }
  async start(name: string): Promise<string> {
    const result = await this.command([
      "session",
      "start",
      "--headless",
      "--name",
      name.slice(0, 180),
    ]);
    if (result.code !== 0) {
      throw new QaError(
        "CANARY_START_FAILED",
        `Canary session start failed: ${result.stderr.slice(-2000)}`,
        "Run doctor, inspect ~/.canary/daemon.log and verify the installed Chromium/runtime, its system libraries and session volume permissions. Rebuild the supplied image for missing dependencies."
      );
    }
    return z.object({ sessionId: z.string() }).parse(JSON.parse(result.stdout))
      .sessionId;
  }
  async act(id: string, label: string, script: string): Promise<Observation> {
    const result = await this.command(
      [
        "run",
        "--session",
        id,
        "--step",
        label,
        "--timeout",
        String(this.config.QA_STEP_TIMEOUT_SECONDS),
      ],
      script
    );
    if (result.code !== 0) {
      throw new Error(`Canary action failed: ${result.stderr.slice(-2000)}`);
    }
    const line = result.stdout
      .split("\n")
      .find((item) => item.startsWith(MARKER));
    if (!line) {
      throw new Error(
        "Canary returned no observation; refusing unverified action"
      );
    }
    return observationSchema.parse(JSON.parse(line.slice(MARKER.length)));
  }
  async end(id: string, destination: string): Promise<string[]> {
    const result = await this.command(["session", "end", id]);
    if (result.code !== 0) {
      await this.command(["session", "abort", id]).catch(() => undefined);
      throw new Error(
        `Canary could not finalize evidence: ${result.stderr.slice(-1000)}`
      );
    }
    const data = z
      .object({
        artifactsDir: z.string(),
        artifacts: z.array(
          z.object({ kind: z.string(), path: z.string(), bytes: z.number() })
        ),
      })
      .parse(JSON.parse(result.stdout));
    const videos = data.artifacts.filter(
      (artifact) => artifact.kind === "video" && artifact.bytes > 0
    );
    if (!videos.length) {
      throw new QaError(
        "EVIDENCE_VIDEO_MISSING",
        "Canary produced no non-empty video; evidence is incomplete",
        "Check daemon.log, free space, ffmpeg/browser installation and session finalization. This run cannot be passed without a recorded video."
      );
    }
    if (
      !(
        data.artifacts.some(
          (artifact) => artifact.kind === "trace" && artifact.bytes > 0
        ) &&
        data.artifacts.some(
          (artifact) => artifact.kind === "screenshot" && artifact.bytes > 0
        )
      )
    ) {
      throw new Error("Canary produced no complete trace/screenshot evidence");
    }
    await mkdir(destination, { recursive: true });
    // Never export browser profiles, cookies databases or arbitrary files from ~/.canary.
    const files = [
      "report.html",
      "results.json",
      ...data.artifacts.map((artifact) =>
        artifact.path.slice(data.artifactsDir.length + 1)
      ),
    ];
    for (const file of files) {
      if (file.includes("..") || !file || file.startsWith("/")) {
        throw new Error("Unsafe Canary artifact path");
      }
      const source = join(data.artifactsDir, file);
      await mkdir(join(destination, file, ".."), { recursive: true });
      await cp(source, join(destination, file));
    }
    return await listFiles(destination);
  }
  async abort(id: string) {
    await this.command(["session", "abort", id]).catch(() => undefined);
  }
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) {
      files.push(...(await listFiles(path, `${prefix}${basename(name)}/`)));
    } else {
      files.push(`${prefix}${name}`);
    }
  }
  return files;
}
