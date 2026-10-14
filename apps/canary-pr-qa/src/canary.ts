import { spawn } from "node:child_process";
import { cp, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import type { BrowserAuth } from "@usecanary/protocol";
import { z } from "zod";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import { fetchText } from "./http.js";
import { verifyPreviewUrl } from "./preview.js";
import { checkBudget, runScope } from "./run-scope.js";
import type { Action, Assertion, Locator } from "./schema.js";

/** Budget d'instantané transmis au modèle : la planification et l'exécution gardent cette taille. */
export const MODEL_SNAPSHOT_CHARS = 14_000;
/**
 * Plafond de l'instantané conservé comme évidence de validation du plan. Au
 * plafond, l'instantané est coupé : le contrôle d'évidence est « non concluant »
 * et ne refuse aucun scénario.
 */
export const PLAN_EVIDENCE_SNAPSHOT_CHARS = 200_000;

const MARKER = "CANARY_PR_QA_OBSERVATION:";
const observationSchema = z.object({
  url: z.string(),
  snapshot: z.string(),
  actual: z.unknown().optional(),
  evidence: z.string().optional(),
  provenanceUrls: z.array(z.string().url()).max(5).optional(),
});
export type Observation = z.infer<typeof observationSchema>;

/**
 * `getByLabel` compare le texte du libellé associé, pas le nom accessible du
 * contrôle : ce texte est la concaténation de tous les nœuds texte du `<label>`
 * englobant, donc aussi celle des `option` d'un `<select>` — dont le rôle
 * implicite est `listbox` pour un `<select multiple>` — ou du contenu initial
 * d'un `<textarea>`. Un libellé réduit à un `sr-only` — « Pharmacie active »,
 * run e6df6014 — ne correspond plus exactement et le locator ne résout rien.
 *
 * Le nom accessible, lui, reste juste : on garde le libellé exact comme cible,
 * avec son attente automatique complète, et l'union par nom accessible n'est
 * tentée qu'après un échec de *résolution* de celui-ci. Décider à partir d'un
 * `count()` immédiat serait faux : un contrôle homonyme déjà monté gagnerait
 * contre le contrôle visé qui n'est pas encore monté.
 */
function labelTargets(value: string): { strict: string; fallback: string } {
  const name = JSON.stringify(value);
  const exact = `{ name: ${name}, exact: true }`;
  const strict = `page.getByLabel(${name}, { exact: true })`;
  const fallback = ["combobox", "listbox", "textbox"].reduce(
    (expression, role) =>
      `${expression}.or(page.getByRole(${JSON.stringify(role)}, ${exact}))`,
    strict
  );
  return { strict, fallback };
}

/**
 * Émis dans le script compilé par `locatorCall` : rejoue l'appel sur le nom
 * accessible uniquement si le libellé exact n'a rien résolu — s'il a résolu un
 * contrôle non actionnable, l'erreur remonte au lieu de viser un autre contrôle.
 */
/**
 * Émis dans le script compilé par `locatorCall` : rejoue l'appel sur le nom
 * accessible uniquement si le libellé exact n'a rien résolu — s'il a résolu un
 * contrôle non actionnable, l'erreur remonte au lieu de viser un autre contrôle.
 *
 * Déclaré en fonction, et non en `const` : `compileProbe` injecte sa lecture
 * juste après `let actual;`, avant cette déclaration, et une liaison `const`
 * serait dans sa zone morte temporelle à cet endroit.
 */
const RESOLVE_LABEL_HELPER = `async function resolveLabel(strict, fallback, act) {
  try {
    return await act(strict);
  } catch (error) {
    if (!/Timeout \\d+ms exceeded|strict mode violation/.test(String(error))) throw error;
    if (await strict.count()) throw error;
    return await act(fallback);
  }
}`;

/**
 * Appel Playwright sur le contrôle visé, `call` étant un suffixe de méthode
 * (`click({ timeout: 10000 })`). Un locator `by:"label"` reçoit le repli par nom
 * accessible ; les autres sont appelés directement.
 */
export function locatorCall(locator: Locator, call: string): string {
  const target = locatorExpression(locator);
  if (locator.by !== "label") {
    return `${target}.${call}`;
  }
  const { strict, fallback } = labelTargets(locator.value);
  return `resolveLabel(${strict}, ${fallback}, (locator) => locator.${call})`;
}

/**
 * Même repli, pour un corps de plusieurs instructions : `body` manipule le
 * locator reçu sous le nom `locator`.
 */
function locatorRun(locator: Locator, body: string): string {
  const target = locatorExpression(locator);
  if (locator.by !== "label") {
    return `(async (locator) => { ${body} })( ${target} )`;
  }
  const { strict, fallback } = labelTargets(locator.value);
  return `resolveLabel(${strict}, ${fallback}, async (locator) => { ${body} })`;
}

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
      return labelTargets(locator.value).strict;
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
  if (assertion.kind === "visual") {
    if (!locator) {
      throw new Error("Visual assertion requires target");
    }
    return `Buffer.from(await ${locatorCall(locator, `screenshot({ animations: "disabled", timeout: 5000 })`)}).toString("base64")`;
  }
  if (assertion.kind === "url") {
    return "page.url()";
  }
  if (!locator) {
    throw new Error("A locator is required for this assertion");
  }
  switch (assertion.kind) {
    case "text":
      return `await ${locatorCall(locator, "innerText({ timeout: 5000 })")}`;
    case "value":
      return `await ${locatorCall(locator, "inputValue({ timeout: 5000 })")}`;
    case "count":
      return `await ${locatorCall(locator, "count()")}`;
    default:
      return `await ${locatorCall(locator, "isVisible()")}`;
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
  if (assertion.kind === "visual") {
    return `actual = ${read};`;
  }
  const expected =
    "expected" in assertion ? assertion.expected : assertion.kind === "visible";
  const matches =
    assertion.kind === "text"
      ? `typeof actual === "string" && actual.replace(/\\s+/g, " ").trim().includes(${JSON.stringify(String(expected).replace(/\s+/g, " ").trim())})`
      : `actual === ${JSON.stringify(expected)}`;
  return `for (let attempt = 0; attempt < 30; attempt++) { actual = ${read}; if (${matches}) break; await page.waitForTimeout(100); }`;
}
export function compileProbe(
  assertion: Assertion,
  preview: string,
  reload = false
): string {
  const read = readAssertion(assertion, assertion.target);
  return compileAction({ type: "observe" }, preview).replace(
    "let actual;",
    `let actual; ${reload ? 'await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });' : ""} actual = ${read};`
  );
}
function compileInteraction(action: Action): string {
  if (!("locator" in action && action.locator)) {
    throw new Error("Not a browser action");
  }
  switch (action.type) {
    case "click":
      return `await ${locatorCall(action.locator, "click({ timeout: 10000 })")};`;
    case "fill":
      return `await ${locatorCall(action.locator, `fill(${JSON.stringify(action.value)}, { timeout: 10000 })`)};`;
    case "press":
      return `await ${locatorCall(action.locator, `press(${JSON.stringify(action.key)}, { timeout: 10000 })`)};`;
    case "select":
      return `await ${locatorCall(action.locator, `selectOption(${JSON.stringify(action.value)}, { timeout: 10000 })`)};`;
    case "check":
      return `await ${locatorCall(action.locator, `setChecked(${action.checked}, { timeout: 10000 })`)};`;
    default:
      throw new Error("Unsupported browser action");
  }
}
export interface CompileOptions {
  /**
   * Budget de l'instantané joint comme évidence de validation du plan. Le même
   * relevé alimente l'instantané du modèle, tronqué à MODEL_SNAPSHOT_CHARS.
   */
  evidenceSnapshotChars?: number;
}
export function compileAction(
  action: Action,
  previewUrl: string,
  assertion?: Assertion,
  options: CompileOptions = {}
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
  } else if (action.type === "download") {
    command = `await ${locatorRun(
      action.locator,
      `const waiting = page.waitForEvent("download", { timeout: 10000 });
await locator.click({ timeout: 10000 });
const download = await waiting;
if (await download.failure()) throw new Error("Download failed");
actual = download.suggestedFilename();`
    )};`;
  } else if (action.type === "popup") {
    command = `await ${locatorRun(
      action.locator,
      `const waiting = page.waitForEvent("popup", { timeout: 10000 });
await locator.click({ timeout: 10000 });
const popup = await waiting;
await popup.waitForLoadState("domcontentloaded");
actual = popup.url();
provenanceUrls.push(actual);
if (!actual.startsWith(${JSON.stringify(`${preview.origin}/`)})) throw new Error("Popup left approved origin");
await popup.close();`
    )};`;
  } else if (action.type === "assert") {
    command = compileAssertion(action, assertion);
  } else if (action.type !== "observe") {
    command = compileInteraction(action);
  }
  // Un seul relevé de l'arbre d'accessibilité : l'instantané du modèle reste
  // tronqué comme avant, l'évidence de validation du plan est jointe à part.
  const evidence = options.evidenceSnapshotChars
    ? `, evidence: ariaSnapshot.slice(0, ${options.evidenceSnapshotChars})`
    : "";
  return `const page = await browser.getPage("qa");
let actual;
const provenanceUrls = [];
${RESOLVE_LABEL_HELPER}
${command}
const url = page.url();
if (url !== "about:blank" && !url.startsWith(${JSON.stringify(`${preview.origin}/`)})) throw new Error("Page left the allowed preview origin");
const ariaSnapshot = (await page.snapshotForAI({ depth: 12 })).full;
console.log(${JSON.stringify(MARKER)} + JSON.stringify({ url, snapshot: ariaSnapshot.slice(0, ${MODEL_SNAPSHOT_CHARS})${evidence}, actual, provenanceUrls }));`;
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
    if (
      args[0] === "session" &&
      ["end", "abort"].includes(args[1] ?? "") &&
      runScope.getStore()
    ) {
      return runScope.exit(() => this.command(args, script));
    }
    checkBudget();
    if (this.config.QA_BROWSER_SERVICE_URL) {
      return fetchText(
        `${this.config.QA_BROWSER_SERVICE_URL}/command`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.QA_BROWSER_SERVICE_TOKEN}`,
          },
          body: JSON.stringify({ args, script }),
        },
        (this.config.QA_STEP_TIMEOUT_SECONDS + 45) * 1000
      ).then((r) =>
        z
          .object({ code: z.number(), stdout: z.string(), stderr: z.string() })
          .parse(JSON.parse(r.text))
      );
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [this.config.CANARY_CLI_PATH, "--json", ...args],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: browserEnvironment(this.config),
        }
      );
      const signal = runScope.getStore()?.signal;
      const cancel = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", cancel, { once: true });
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
        signal?.removeEventListener("abort", cancel);
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
  async start(name: string, auth?: BrowserAuth): Promise<string> {
    const result = await this.command(
      [
        "session",
        "start",
        "--headless",
        "--name",
        name.slice(0, 180),
        "--network-hosts",
        // The Canary CLI takes the list as one comma-separated argument.
        // `applyPreviewHosts` keeps this string and `allowedHosts` in sync, so a
        // dashboard list reaches the session policy without a restart.
        this.config.PREVIEW_ALLOWED_HOSTS,
        ...(this.config.QA_ALLOW_PRIVATE_PREVIEWS === "true"
          ? ["--allow-private"]
          : []),
        ...(auth ? ["--auth-stdin"] : []),
      ],
      auth ? JSON.stringify(auth) : undefined
    );
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
    const observation = observationSchema.parse(
      JSON.parse(line.slice(MARKER.length))
    );
    const sha = runScope.getStore()?.previewSha;
    if (sha) {
      for (const url of new Set([
        observation.url,
        ...(observation.provenanceUrls ?? []),
      ])) {
        if (url.startsWith("http")) {
          await verifyPreviewUrl(url, sha, this.config);
        }
      }
    }
    return observation;
  }
  async end(id: string, destination: string): Promise<string[]> {
    const result = await this.command(["session", "end", id]);
    if (result.code !== 0) {
      await this.command(["session", "abort", id]).catch(() => undefined);
      await this.purge(id).catch(() => undefined);
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
    const copied = await listFiles(destination);
    await this.purge(id);
    return copied;
  }
  async purge(id: string) {
    if (!/^(?!.*\.\.)[A-Za-z0-9._-]{1,128}$/.test(id)) {
      throw new Error("Invalid session ID for purge");
    }
    if (this.config.QA_BROWSER_SERVICE_URL) {
      await runScope.exit(() => this.command(["purge", id]));
      return;
    }
    const root = join(homedir(), ".canary", "sessions");
    const path = join(root, id);
    const actual = await realpath(path).catch(() => path);
    if (relative(root, actual).startsWith("..")) {
      throw new Error("Session symlink escaped root");
    }
    await rm(path, { recursive: true, force: true });
  }
  async abort(id: string) {
    await this.command(["session", "abort", id]).catch(() => undefined);
    await this.purge(id).catch(() => undefined);
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

export function browserEnvironment(config: Config): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "NODE_USE_ENV_PROXY",
    "PLAYWRIGHT_BROWSERS_PATH",
    "CANARY_DAEMON_PORT",
    "CANARY_DAEMON_TOKEN",
    "CANARY_LOG_LEVEL",
    "CANARY_EGRESS_PROXY",
  ];
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    allowed.flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : []
    )
  );
  env.CANARY_NETWORK_ALLOWED_HOSTS = config.PREVIEW_ALLOWED_HOSTS;
  env.CANARY_NETWORK_ALLOW_PRIVATE = config.QA_ALLOW_PRIVATE_PREVIEWS;
  return env;
}
