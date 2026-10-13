import { describe, expect, it } from "vitest";

import {
  hostAllowed,
  hostEntryMatches,
  hostnameAllowed,
  networkAllowed,
} from "./network-policy.js";

const url = (input: string) => new URL(input);

describe("hostEntryMatches", () => {
  it("matches an exact entry only on the same host and port", () => {
    expect(
      hostEntryMatches(url("http://preview.example.com"), "preview.example.com")
    ).toBe(true);
    expect(
      hostEntryMatches(
        url("http://preview.example.com:8443"),
        "preview.example.com:8443"
      )
    ).toBe(true);
    expect(
      hostEntryMatches(
        url("http://preview.example.com:8443"),
        "preview.example.com"
      )
    ).toBe(false);
    expect(
      hostEntryMatches(url("http://other.example.com"), "preview.example.com")
    ).toBe(false);
    expect(
      hostEntryMatches(url("http://[2001:db8::1]:8443"), "[2001:db8::1]:8443")
    ).toBe(true);
  });

  it("treats the scheme's default port as the port a URL implies", () => {
    // `URL` drops `:443` and `:80`, so an entry that names them must still cover
    // the destination an administrator actually lists in the dashboard.
    const covered: [string, string][] = [
      ["https://api.example.com", "api.example.com:443"],
      ["https://api.example.com:443", "api.example.com:443"],
      ["http://api.example.com", "api.example.com:80"],
      ["https://api.example.com", "*.example.com:443"],
      ["https://api.example.com", "api.example.com"],
      ["http://api.example.com", "api.example.com"],
    ];
    for (const [target, entry] of covered) {
      expect(hostEntryMatches(url(target), entry), `${target} ~ ${entry}`).toBe(
        true
      );
    }
    const refused: [string, string][] = [
      // The other scheme's default is a different port, and an entry without one
      // never covers a port the destination names.
      ["http://api.example.com", "api.example.com:443"],
      ["https://api.example.com", "api.example.com:80"],
      ["https://api.example.com:8443", "api.example.com"],
      ["https://api.example.com", "api.example.com:8443"],
      ["https://api.example.com", "*.example.com:8443"],
    ];
    for (const [target, entry] of refused) {
      expect(hostEntryMatches(url(target), entry), `${target} ~ ${entry}`).toBe(
        false
      );
    }
  });

  it("covers subdomains with a wildcard, never the apex or a sibling suffix", () => {
    expect(
      hostEntryMatches(
        url("https://pr-12.arpilabe.pharmania.fr"),
        "*.arpilabe.pharmania.fr"
      )
    ).toBe(true);
    expect(
      hostEntryMatches(
        url("https://a.b.arpilabe.pharmania.fr"),
        "*.arpilabe.pharmania.fr"
      )
    ).toBe(true);
    for (const target of [
      // The apex is not a subdomain, and a look-alike suffix shares no label
      // boundary with the entry.
      "https://arpilabe.pharmania.fr",
      "https://notarpilabe.pharmania.fr",
      "https://arpilabe.pharmania.fr.evil.test",
    ]) {
      expect(
        hostEntryMatches(url(target), "*.arpilabe.pharmania.fr"),
        target
      ).toBe(false);
    }
  });
});

describe("hostAllowed", () => {
  it("accepts a destination covered by any entry", () => {
    const hosts = ["preview.test", "*.arpilabe.pharmania.fr"];
    expect(hostAllowed(url("http://preview.test"), hosts)).toBe(true);
    expect(hostAllowed(url("https://pr-12.arpilabe.pharmania.fr"), hosts)).toBe(
      true
    );
    expect(hostAllowed(url("https://arpilabe.pharmania.fr"), hosts)).toBe(
      false
    );
    expect(hostAllowed(url("https://evil.test"), hosts)).toBe(false);
    expect(hostAllowed(url("http://preview.test"), [])).toBe(false);
  });
});

describe("hostnameAllowed", () => {
  it("ignores the entries' ports, because a cookie carries none", () => {
    expect(hostnameAllowed("preview.test", ["preview.test:8443"])).toBe(true);
    expect(hostnameAllowed("pr-12.preview.test", ["*.preview.test:8443"])).toBe(
      true
    );
    expect(hostnameAllowed("preview.test", ["*.preview.test"])).toBe(false);
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
