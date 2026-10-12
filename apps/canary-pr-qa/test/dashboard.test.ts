import { describe, expect, it } from "vitest";
import { dashboard, dashboardAssets } from "../src/dashboard.js";

describe("compiled dashboard", () => {
  it("serves a shell that loads the external bundle and stylesheet", () => {
    expect(dashboard).toContain('rel="stylesheet"');
    expect(dashboard).toContain('src="/dashboard/assets/client.js"');
    expect(dashboard).toContain('<div id="root">');
  });

  it("never inlines executable script, so the CSP can stay strict", () => {
    expect(dashboard).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(dashboard).not.toContain("unsafe-inline");
    expect(dashboard).not.toMatch(/\son[a-z]+=/);
  });

  it("exposes every referenced asset under /dashboard/assets/", () => {
    expect([...dashboardAssets.keys()].sort()).toEqual([
      "/dashboard/assets/client.css",
      "/dashboard/assets/client.js",
      "/dashboard/assets/client.js.map",
    ]);
    for (const [key, asset] of dashboardAssets) {
      expect(key.startsWith("/dashboard/assets/")).toBe(true);
      expect(key).not.toContain("..");
      expect(asset.type).toMatch(/^(text\/|application\/)/);
      expect(asset.body.length).toBeGreaterThan(0);
    }
  });

  it("ships readable types and source maps for the browser bundle", () => {
    const script = dashboardAssets.get("/dashboard/assets/client.js");
    const styles = dashboardAssets.get("/dashboard/assets/client.css");
    expect(script?.type).toBe("text/javascript; charset=utf-8");
    expect(script?.body).toContain("sourceMappingURL=");
    expect(styles?.type).toBe("text/css; charset=utf-8");
    expect(styles?.body).toContain(":root");
  });

  it("references only assets it actually serves", () => {
    for (const match of dashboard.matchAll(
      /(?:href|src)="(\/dashboard\/assets\/[^"]+)"/g
    )) {
      expect(dashboardAssets.has(match[1] ?? "")).toBe(true);
    }
  });
});
