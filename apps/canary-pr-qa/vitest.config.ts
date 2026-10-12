import { defineConfig } from "vitest/config";
import { readUiAssets } from "./scripts/ui-assets.mjs";

export default defineConfig({
  plugins: [
    {
      enforce: "pre",
      name: "dashboard-ui-assets",
      async load(id) {
        if (!id.endsWith("?ui")) {
          return;
        }
        return `export default ${JSON.stringify(await readUiAssets())}`;
      },
    },
  ],
  test: { css: true, include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
