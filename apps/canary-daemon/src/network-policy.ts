import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { BrowserContext } from "playwright";
export function privateAddress(input: string): boolean {
  const ip = input.replace(/^\[|\]$/g, "").toLowerCase();
  if (ip.includes(":")) {
    return (
      ip === "::" ||
      ip === "::1" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      ip.startsWith("fe8") ||
      ip.startsWith("fe9") ||
      ip.startsWith("fea") ||
      ip.startsWith("feb") ||
      (ip.startsWith("::ffff:") && privateAddress(ip.slice(7)))
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
export async function networkAllowed(
  input: string,
  hosts: string[],
  allowPrivate = false
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
    !hosts.includes(url.host.toLowerCase())
  ) {
    return false;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  // Metadata endpoints are forbidden even when private test environments are opted in.
  if (
    ["169.254.169.254", "169.254.170.2", "metadata.google.internal"].includes(
      hostname
    )
  ) {
    return false;
  }
  if (allowPrivate) {
    return true;
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true });
  return (
    addresses.length > 0 && addresses.every((a) => !privateAddress(a.address))
  );
}
export async function installNetworkPolicy(
  context: BrowserContext,
  hosts: string[],
  allowPrivate: boolean
) {
  await context.route("**/*", async (route) => {
    if (
      await networkAllowed(route.request().url(), hosts, allowPrivate).catch(
        () => false
      )
    ) {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
  await context.routeWebSocket("**/*", async (socket) => {
    if (
      await networkAllowed(socket.url(), hosts, allowPrivate).catch(() => false)
    ) {
      socket.connectToServer();
    } else {
      socket.close({ code: 1008, reason: "Canary network policy" });
    }
  });
}
