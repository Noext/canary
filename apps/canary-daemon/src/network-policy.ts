import dns from "node:dns/promises";
import { isIP } from "node:net";
import type { BrowserContext } from "playwright";
export function metadataAddress(input: string): boolean {
  const ip = input.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    [
      "169.254.169.254",
      "169.254.170.2",
      "metadata.google.internal",
      "100.100.100.200",
      "fd00:ec2::254",
    ].includes(ip) ||
    ip.startsWith("64:ff9b:") ||
    ip === "::ffff:a9fe:a9fe" ||
    ip === "::ffff:a9fe:aa02" ||
    (ip.startsWith("::ffff:") && metadataAddress(ip.slice(7)))
  );
}
export function privateAddress(input: string): boolean {
  const ip = input.replace(/^\[|\]$/g, "").toLowerCase();
  if (ip.includes(":")) {
    return (
      ip === "::" ||
      ip === "::1" ||
      ip.startsWith("ff") ||
      ip.startsWith("fec") ||
      ip.startsWith("64:ff9b:") ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      ip.startsWith("fe8") ||
      ip.startsWith("fe9") ||
      ip.startsWith("fea") ||
      ip.startsWith("feb") ||
      (ip.startsWith("::ffff:") &&
        (() => {
          const tail = ip.slice(7);
          if (tail.includes(".")) {
            return privateAddress(tail);
          }
          const parts = tail.split(":");
          if (parts.length !== 2) {
            return true;
          }
          const value =
            Number.parseInt(parts[0] ?? "", 16) * 65_536 +
            Number.parseInt(parts[1] ?? "", 16);
          return privateAddress(
            [24, 16, 8, 0]
              .map((shift) => Math.floor(value / 2 ** shift) % 256)
              .join(".")
          );
        })())
    );
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}
/** Splits `name` or `name:port`; a bracketed IPv6 literal keeps its brackets. */
function splitPort(value: string): { name: string; port: string } {
  const start = value.startsWith("[") ? value.indexOf("]") + 1 : 0;
  const separator = value.indexOf(":", start);
  return separator === -1
    ? { name: value, port: "" }
    : { name: value.slice(0, separator), port: value.slice(separator + 1) };
}
/** The port a scheme implies when the URL does not name one. */
function defaultPort(protocol: string): number | undefined {
  if (protocol === "http:" || protocol === "ws:") {
    return 80;
  }
  if (protocol === "https:" || protocol === "wss:") {
    return 443;
  }
  return;
}
function matchesName(hostname: string, pattern: string): boolean {
  return pattern.startsWith("*.")
    ? hostname.endsWith(`.${pattern.slice(2)}`)
    : hostname === pattern;
}
/**
 * Whether one allowlist entry covers a destination URL.
 *
 * An entry is an exact `host` or `host:port` match, or a leading-label wildcard
 * (`*.example.com`, `*.example.com:8443`). The wildcard covers subdomains at any
 * depth but never the bare domain.
 *
 * `URL` drops the port a scheme implies, so the comparison uses the effective
 * one: an entry without a port still covers only destinations that name no port
 * (the default of `http` or `https`), while `*.example.com:443` covers
 * `https://api.example.com` as well as a spelled-out `:443` - but not
 * `http://api.example.com`, nor another port.
 */
export function hostEntryMatches(url: URL, entry: string): boolean {
  const { name, port } = splitPort(entry);
  if (!matchesName(url.hostname, name)) {
    return false;
  }
  if (port === "") {
    return url.port === "";
  }
  const effective =
    url.port === "" ? defaultPort(url.protocol) : Number(url.port);
  return Number(port) === effective;
}
/** Whether any allowlist entry covers a destination URL. */
export function hostAllowed(url: URL, hosts: string[]): boolean {
  return hosts.some((entry) => hostEntryMatches(url, entry));
}
/**
 * Whether a trusted cookie's domain belongs to the allowlist.
 *
 * A browser sends a cookie to its domain and to every subdomain of it, so an
 * entry may be the cookie's own domain or one of its parents: `example.com`
 * covers a `login.example.com` cookie. A `*.example.com` entry additionally
 * covers a cookie scoped to the bare `example.com`, which is not an allowed
 * destination but is exactly the cookie a preview subdomain receives.
 */
export function cookieDomainAllowed(domain: string, hosts: string[]): boolean {
  return hosts.some((entry) => {
    const name = splitPort(entry).name;
    return (
      matchesName(domain, name) ||
      domain.endsWith(`.${name}`) ||
      (name.startsWith("*.") && domain === name.slice(2))
    );
  });
}
export async function networkAllowed(
  input: string,
  hosts: string[],
  allowPrivate = false,
  dnsAtProxy = false
): Promise<boolean> {
  const url = new URL(input);
  if (
    url.protocol === "about:" ||
    url.protocol === "data:" ||
    url.protocol === "blob:"
  ) {
    return true;
  }
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !hostAllowed(url, hosts)
  ) {
    return false;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  // Metadata endpoints are forbidden even when private test environments are opted in.
  if (metadataAddress(hostname)) {
    return false;
  }
  // The isolated browser has no external DNS. The configured egress proxy resolves,
  // validates and pins the actual address; still validate literal IPs here.
  if (dnsAtProxy && !isIP(hostname)) {
    return true;
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true });
  return (
    addresses.length > 0 &&
    addresses.every(
      (a) =>
        !metadataAddress(a.address) &&
        (allowPrivate || !privateAddress(a.address))
    )
  );
}
export async function installNetworkPolicy(
  context: BrowserContext,
  hosts: string[],
  allowPrivate: boolean,
  dnsAtProxy = false
) {
  await context.route("**/*", async (route) => {
    if (
      await networkAllowed(
        route.request().url(),
        hosts,
        allowPrivate,
        dnsAtProxy
      ).catch(() => false)
    ) {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
  await context.routeWebSocket("**/*", async (socket) => {
    if (
      await networkAllowed(socket.url(), hosts, allowPrivate, dnsAtProxy).catch(
        () => false
      )
    ) {
      socket.connectToServer();
    } else {
      socket.close({ code: 1008, reason: "Canary network policy" });
    }
  });
}
