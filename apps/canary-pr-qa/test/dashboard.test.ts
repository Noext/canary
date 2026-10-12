import { readFile } from "node:fs/promises";
import ts from "typescript";
import { expect, it } from "vitest";
import { dashboard, dashboardAssets } from "../src/dashboard.js";

it("serves real CSS and compiled browser modules through external asset URLs", () => {
  expect(dashboard).toContain('rel="stylesheet"');
  const css = dashboardAssets.get("/dashboard/assets/styles.css")?.body;
  expect(css?.slice(0, 200)).toContain(":root {");
  expect(css).toContain("margin: 0;");
  expect(css).not.toContain("export default");
  expect(dashboardAssets.get("/dashboard/assets/client.js")?.body).toContain(
    "sourceMappingURL="
  );
});

it("keeps typed DOM controls consistent with the HTML template, without duplicate IDs", async () => {
  const source = ts.createSourceFile(
    "dom.ts",
    await readFile(new URL("../src/dashboard/dom.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const elements = source.statements.find(
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === "Elements"
  );
  if (!(elements && ts.isInterfaceDeclaration(elements))) {
    throw new Error("Typed DOM contract missing");
  }
  const controls = elements.members.map((node) =>
    node.name?.getText(source).replaceAll('"', "")
  );
  const ids = [...dashboard.matchAll(/\bid="([^"]+)"/g)].map(
    (match) => match[1]
  );
  expect(new Set(ids).size).toBe(ids.length);
  expect(controls.sort()).toEqual(ids.sort());
});
