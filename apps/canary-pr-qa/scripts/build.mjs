import { chmod } from "node:fs/promises";
import { build } from "esbuild";
import { dashboardAssets } from "./dashboard-assets.mjs";

await build({
  entryPoints: ["src/cli.ts"],
  plugins: [dashboardAssets()],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await chmod("dist/cli.js", 0o755);
