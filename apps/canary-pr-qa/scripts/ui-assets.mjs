import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reads the built React dashboard (`@usecanary/pr-qa-ui`) and turns it into the
 * HTML shell plus the asset map the PR QA server serves.
 *
 * The UI is a separate workspace on purpose: it has its own Vite build, its own
 * tests and its own lint, and `@usecanary/pr-qa` embeds its output so the
 * published CLI stays a single self-contained file.
 */

const UI_ROOT = fileURLToPath(
  new URL("../../canary-pr-qa-ui/", import.meta.url)
);
/** `QA_UI_DIST` lets tooling embed an already-built dashboard (fixtures, CI). */
const DIST = process.env.QA_UI_DIST
  ? path.resolve(process.env.QA_UI_DIST)
  : path.join(UI_ROOT, "dist");

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function buildUi() {
  execFileSync("pnpm", ["--filter", "@usecanary/pr-qa-ui", "build"], {
    cwd: UI_ROOT,
    stdio: "inherit",
  });
}

export async function readUiAssets() {
  if (!existsSync(path.join(DIST, "index.html"))) {
    buildUi();
  }
  const html = await readFile(path.join(DIST, "index.html"), "utf8");
  const names = (await readdir(DIST)).filter((name) => name !== "index.html");
  const assets = [];
  for (const name of [...names].sort()) {
    const type = MIME_TYPES.get(path.extname(name));
    if (!type) {
      continue;
    }
    assets.push({
      body: await readFile(path.join(DIST, name), "utf8"),
      path: `/dashboard/assets/${name}`,
      type,
    });
  }
  if (assets.length === 0) {
    throw new Error(
      `No dashboard asset found in ${DIST}. Run: pnpm --filter @usecanary/pr-qa-ui build`
    );
  }
  return { assets, html };
}
