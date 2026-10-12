import ui from "./dashboard/ui-assets?ui";

/**
 * The compiled dashboard: one HTML shell plus the assets it references.
 * The shell and every asset come from the `@usecanary/pr-qa-ui` Vite build,
 * embedded here at build time so `dist/cli.js` remains self-contained.
 */
export const dashboard = ui.html;

export const dashboardAssets = new Map(
  ui.assets.map((asset) => [asset.path, { body: asset.body, type: asset.type }])
);
