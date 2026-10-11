import { readFile } from "node:fs/promises";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Config } from "./config.js";
import { fixtureCatalog } from "./fixtures.js";
export async function compareVisual(
  actual: unknown,
  baseline: string,
  repo: string,
  config: Config
) {
  const catalog = await fixtureCatalog(config, repo);
  const path = catalog.visuals[baseline];
  if (!path) {
    throw new Error(`Trusted visual baseline ${baseline} is not configured`);
  }
  if (typeof actual !== "string" || actual.length > 4_000_000) {
    throw new Error("Invalid screenshot evidence");
  }
  const image = PNG.sync.read(Buffer.from(actual, "base64"));
  const expected = PNG.sync.read(await readFile(path));
  if (image.width !== expected.width || image.height !== expected.height) {
    return { passed: false, mismatchRatio: 1 };
  }
  const difference = pixelmatch(
    image.data,
    expected.data,
    undefined,
    image.width,
    image.height,
    { threshold: 0.1 }
  );
  const mismatchRatio = difference / (image.width * image.height);
  return { passed: mismatchRatio <= catalog.visualTolerance, mismatchRatio };
}
