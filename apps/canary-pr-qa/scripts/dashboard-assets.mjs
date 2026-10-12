import path from "node:path";
import { readUiAssets } from "./ui-assets.mjs";

/**
 * Build-time only: embeds the compiled React dashboard into the single CLI
 * artifact. `import ui from "...?ui"` resolves to the built HTML shell and the
 * asset map the server exposes under /dashboard/assets/.
 */
export function dashboardAssets() {
  return {
    name: "dashboard-assets",
    setup(builder) {
      builder.onResolve({ filter: /\?ui$/ }, (args) => ({
        namespace: "dashboard-assets",
        path: path.resolve(args.resolveDir, args.path),
      }));
      builder.onLoad(
        { filter: /./, namespace: "dashboard-assets" },
        async () => ({
          contents: JSON.stringify(await readUiAssets()),
          loader: "json",
        })
      );
    },
  };
}
