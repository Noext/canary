/**
 * Node module hooks for the dashboard end-to-end harness.
 *
 * `@usecanary/pr-qa` reaches its dashboard build through the `?ui` suffix
 * (`apps/canary-pr-qa/src/dashboard.ts`), a specifier only its own bundlers and
 * the Vitest plugin understand. The harness runs the same server source under
 * tsx, so this hook resolves that one specifier to exactly the assets the
 * server embeds in production (`scripts/ui-assets.mjs`, the shared reader).
 */
const UI_ASSETS = new URL(
  "../../canary-pr-qa/scripts/ui-assets.mjs",
  import.meta.url
);

/** @type {import("node:module").ResolveHook} */
export function resolve(specifier, context, next) {
  if (!specifier.endsWith("?ui")) {
    return next(specifier, context);
  }
  const target = new URL(specifier, context.parentURL);
  target.search = "";
  return { format: "module", shortCircuit: true, url: `${target.href}?ui` };
}

/** @type {import("node:module").LoadHook} */
export async function load(url, context, next) {
  if (!url.endsWith("?ui")) {
    return next(url, context);
  }
  const { readUiAssets } = await import(UI_ASSETS.href);
  const ui = await readUiAssets();
  return {
    format: "module",
    shortCircuit: true,
    source: `export default ${JSON.stringify(ui)};`,
  };
}
