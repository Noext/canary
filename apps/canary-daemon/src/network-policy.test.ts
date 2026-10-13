import { describe, expect, it } from "vitest";

import {
  hostAllowed,
  hostEntryMatches,
  networkAllowed,
} from "./network-policy.js";

describe("hostEntryMatches", () => {
  it("matches an exact entry only on the same host and port", () => {
    expect(hostEntryMatches("preview.example.com", "preview.example.com")).toBe(
      true
    );
    expect(
      hostEntryMatches("preview.example.com:8443", "preview.example.com:8443")
    ).toBe(true);
    expect(
      hostEntryMatches("preview.example.com:8443", "preview.example.com")
    ).toBe(false);
    expect(hostEntryMatches("other.example.com", "preview.example.com")).toBe(
      false
    );
    expect(hostEntryMatches("[2001:db8::1]:8443", "[2001:db8::1]:8443")).toBe(
      true
    );
  });

  it("covers subdomains with a wildcard, never the apex or a sibling suffix", () => {
    expect(
      hostEntryMatches("pr-12.arpilabe.pharmania.fr", "*.arpilabe.pharmania.fr")
    ).toBe(true);
    expect(
      hostEntryMatches("a.b.arpilabe.pharmania.fr", "*.arpilabe.pharmania.fr")
    ).toBe(true);
    for (const host of [
      // The apex is not a subdomain, and a look-alike suffix shares no label
      // boundary with the entry.
      "arpilabe.pharmania.fr",
      "notarpilabe.pharmania.fr",
      "arpilabe.pharmania.fr.evil.test",
    ]) {
      expect(hostEntryMatches(host, "*.arpilabe.pharmania.fr"), host).toBe(
        false
      );
    }
  });

  it("keeps the entry port authoritative for a wildcard too", () => {
    expect(
      hostEntryMatches("pr-12.preview.test:8443", "*.preview.test:8443")
    ).toBe(true);
    expect(hostEntryMatches("pr-12.preview.test", "*.preview.test:8443")).toBe(
      false
    );
    expect(hostEntryMatches("pr-12.preview.test:8443", "*.preview.test")).toBe(
      false
    );
  });
});

describe("hostAllowed", () => {
  it("accepts a destination covered by any entry", () => {
    const hosts = ["preview.test", "*.arpilabe.pharmania.fr"];
    expect(hostAllowed("preview.test", hosts)).toBe(true);
    expect(hostAllowed("pr-12.arpilabe.pharmania.fr", hosts)).toBe(true);
    expect(hostAllowed("arpilabe.pharmania.fr", hosts)).toBe(false);
    expect(hostAllowed("evil.test", hosts)).toBe(false);
    expect(hostAllowed("preview.test", [])).toBe(false);
  });
});

describe("networkAllowed", () => {
  it("applies the wildcard to the whole request policy", async () => {
    const hosts = ["*.arpilabe.pharmania.fr"];
    // `dnsAtProxy` is how the browser container starts: the egress proxy
    // resolves and pins the address, so no lookup happens here.
    expect(
      await networkAllowed(
        "https://pr-12.arpilabe.pharmania.fr/dashboard",
        hosts,
        false,
        true
      )
    ).toBe(true);
    expect(
      await networkAllowed("https://arpilabe.pharmania.fr/", hosts, false, true)
    ).toBe(false);
    // A wildcard covers domain labels only: it never authorizes an IP literal.
    expect(
      await networkAllowed("http://169.254.169.254/latest", hosts, true, true)
    ).toBe(false);
  });
});
