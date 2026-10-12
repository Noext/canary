import { expect, it } from "vitest";
import { dashboard } from "../src/dashboard.js";

// The dashboard ships one inline script: a syntax error or a `$('id')` without a
// matching element would break every interaction, including the GitHub App
// onboarding and removal controls, without any server-side test noticing.
const html = dashboard;
const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";

it("compiles the dashboard script and references only existing elements", () => {
  expect(script).not.toBe("");
  expect(() => new Function(script)).not.toThrow();
  const ids = new Set(
    [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1])
  );
  const referenced = new Set(
    [...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1])
  );
  expect([...referenced].filter((id) => !ids.has(id))).toEqual([]);
  expect(script).toContain("DELETE");
});

it("exposes both GitHub App removal controls to the administrator", () => {
  expect(html).toContain('id="githubDanger"');
  expect(html).toContain('id="githubUninstall"');
  expect(html).toContain('id="githubDeleteApp"');
});
