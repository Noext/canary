import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

/** Build-time only: keeps readable source files and embeds assets in the single CLI artifact. */
export function dashboardAssets() {
  return {
    name: "dashboard-assets",
    setup(builder) {
      builder.onResolve({ filter: /\?(raw|browser)$/ }, (args) => ({
        path: path.resolve(args.resolveDir, args.path),
        namespace: "dashboard-assets",
      }));
      builder.onLoad(
        { filter: /./, namespace: "dashboard-assets" },
        async ({ path: specifier }) => {
          const [file, kind] = specifier.split("?");
          if (kind === "raw") {
            return { contents: await readFile(file, "utf8"), loader: "text" };
          }
          return {
            contents: JSON.stringify(await bundleDashboard(file)),
            loader: "json",
          };
        }
      );
    },
  };
}
export async function bundleDashboard(file) {
  const output = await build({
    entryPoints: [file],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    write: false,
    sourcemap: "inline",
  });
  return output.outputFiles[0].text;
}
