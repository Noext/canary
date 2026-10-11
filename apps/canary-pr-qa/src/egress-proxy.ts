import { lookup } from "node:dns/promises";
import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import { privateAddress } from "../../canary-daemon/src/network-policy.js";
import type { Config } from "./config.js";

async function target(input: string, config: Config) {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !config.allowedHosts.includes(url.host.toLowerCase())
  ) {
    throw new Error("Egress host denied");
  }
  if (
    ["169.254.169.254", "169.254.170.2", "metadata.google.internal"].includes(
      url.hostname
    )
  ) {
    throw new Error("Metadata denied");
  }
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), {
    all: true,
  });
  if (
    !addresses.length ||
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
export async function startEgressProxy(config: Config) {
  const server = createServer((req, res) => {
    void target(req.url ?? "", config)
      .then(({ url, address }) => {
        const upstream = request(
          {
            hostname: address,
            port: url.port || 80,
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
      .catch(() => {
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
      .catch(() => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  });
  server.on("upgrade", (req, socket, head) => {
    void target(req.url ?? "", config)
      .then(({ url, address }) => {
        const upstream = connect(
          { host: address, port: Number(url.port || 80) },
          () => {
            upstream.write(
              `${req.method} ${url.pathname + url.search} HTTP/1.1\r\n${req.rawHeaders.reduce((headers, value, index) => headers + (index % 2 ? `${value}\r\n` : `${value}: `), "")}\r\n`
            );
            if (head.length) {
              upstream.write(head);
            }
            socket.pipe(upstream);
            upstream.pipe(socket);
          }
        );
        tunnel(socket as Socket, upstream);
      })
      .catch(() => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(3128, "0.0.0.0", resolve);
  });
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
