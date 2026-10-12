import { defineConfig } from "vitest/config";
import { bundleDashboard } from "./scripts/dashboard-assets.mjs";

export default defineConfig({
  plugins: [
    {
      name: "dashboard-browser",
      enforce: "pre",
      async load(id) {
        if (!id.endsWith("?browser")) {
          return;
        }
        return (
          "export default " +
          JSON.stringify(await bundleDashboard(id.slice(0, -8)))
        );
      },
    },
  ],
  test: { css: true, include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
