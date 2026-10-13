import dns from "node:dns/promises";
import { createServer, request } from "node:http";
import { request as secureRequest } from "node:https";
import { connect, isIP, type Socket } from "node:net";
import tls from "node:tls";
import { createLogger } from "@usecanary/logger";
import {
  hostAllowed,
  metadataAddress,
  privateAddress,
} from "../../canary-daemon/src/network-policy.js";
import type { Config } from "./config.js";
import { watchPreviewPolicy } from "./preview-hosts.js";

const logger = createLogger({ name: "qa-egress" });
function denied(error: unknown) {
  logger.warn(
    {
      code: "EGRESS_POLICY_DENIED",
      reason: error instanceof Error ? error.message : "Unknown egress failure",
    },
    "Request blocked; inspect the dashboard host allowlist, private-preview policy and DNS"
  );
}
async function target(input: string, config: Config) {
  const url = new URL(input);
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !hostAllowed(url.host.toLowerCase(), config.allowedHosts)
  ) {
    throw new Error("Egress host denied");
  }
  if (metadataAddress(url.hostname)) {
    throw new Error("Metadata denied");
  }
  const addresses = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ""), {
    all: true,
  });
  if (
    !addresses.length ||
    addresses.some((a) => metadataAddress(a.address)) ||
    (config.QA_ALLOW_PRIVATE_PREVIEWS !== "true" &&
      addresses.some((a) => privateAddress(a.address)))
  ) {
    throw new Error("Private network denied");
  }
  const address = addresses[0]?.address;
  if (!address) {
    throw new Error("No DNS address");
  }
  return { url, address };
}
function secureTarget(url: URL) {
  return url.protocol === "https:" || url.protocol === "wss:";
}
function targetPort(url: URL) {
  return Number(url.port || (secureTarget(url) ? 443 : 80));
}
function connectTarget(url: URL, address: string, ready: () => void): Socket {
  const options = { host: address, port: targetPort(url) };
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return secureTarget(url)
    ? tls.connect(
        { ...options, ...(isIP(hostname) ? {} : { servername: hostname }) },
        ready
      )
    : connect(options, ready);
}
export async function startEgressProxy(config: Config) {
  // The EGRESS proxy is the network boundary: it follows the host list an
  // administrator publishes in the dashboard, not just the boot environment.
  const policy = watchPreviewPolicy(config);
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end('{"ok":true}');
      return;
    }
    void target(req.url ?? "", config)
      .then(({ url, address }) => {
        const upstream = (secureTarget(url) ? secureRequest : request)(
          {
            hostname: address,
            port: targetPort(url),
            ...(secureTarget(url)
              ? { servername: url.hostname.replace(/^\[|\]$/g, "") }
              : {}),
            path: url.pathname + url.search,
            method: req.method,
            headers: {
              ...Object.fromEntries(
                Object.entries(req.headers).filter(
                  ([key]) => !key.startsWith("proxy-")
                )
              ),
              host: url.host,
            },
            timeout: 30_000,
          },
          (remote) => {
            res.writeHead(remote.statusCode ?? 502, remote.headers);
            remote.pipe(res);
          }
        );
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => {
          if (!res.headersSent) {
            res.writeHead(502);
          }
          res.end();
        });
        req.on("aborted", () => upstream.destroy());
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
      })
      .catch((error) => {
        denied(error);
        res.writeHead(403);
        res.end("Egress policy denied");
      });
  });
  server.on("connect", (req, socket, head) => {
    void target(`https://${req.url}`, config)
      .then(({ url, address }) => {
        const upstream = connect(
          { host: address, port: Number(url.port || 443) },
          () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) {
              upstream.write(head);
            }
            socket.pipe(upstream);
            upstream.pipe(socket);
          }
        );
        tunnel(socket as Socket, upstream);
      })
      .catch((error) => {
        denied(error);
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      });
  });
  server.on("upgrade", (req, socket, head) => {
    void target(req.url ?? "", config)
      .then(({ url, address }) => {
        const upstream = connectTarget(url, address, () => {
          upstream.write(
            `${req.method} ${url.pathname + url.search} HTTP/1.1\r\n${req.rawHeaders.reduce((headers, value, index) => headers + (index % 2 ? `${value}\r\n` : `${value}: `), "")}\r\n`
          );
          if (head.length) {
            upstream.write(head);
          }
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        tunnel(socket as Socket, upstream);
      })
      .catch((error) => {
        denied(error);
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      });
  });
  // The first read is awaited: until it succeeds the allowlist is empty, so the
  // proxy never serves one request on the environment list a dashboard edit may
  // already have narrowed.
  await policy.sync();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(3128, "0.0.0.0", resolve);
  });
  server.on("close", () => policy.stop());
  return server;
}
function tunnel(client: Socket, upstream: Socket) {
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.setTimeout(60_000, () => client.destroy());
  upstream.setTimeout(60_000, () => upstream.destroy());
}
