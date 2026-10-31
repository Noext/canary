import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claimUnixSocket, socketAnswers } from "./socket-claim.js";

const servers: net.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function socketPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "canary-socket-claim-"));
  dirs.push(dir);
  return path.join(dir, "daemon.sock");
}

/** Un « démon » qui répond son nom à chaque connexion. */
function daemon(name: string): net.Server {
  const server = net.createServer((socket) => {
    socket.end(name);
  });
  servers.push(server);
  return server;
}

function whoAnswers(socket: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const client = net.connect({ path: socket });
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      data += chunk;
    });
    client.on("end", () => resolve(data));
    client.on("error", reject);
  });
}

describe("claimUnixSocket", () => {
  it("écoute sur un chemin libre", async () => {
    const socket = await socketPath();
    expect(await claimUnixSocket(daemon("a"), socket)).toBe("listening");
    expect(await whoAnswers(socket)).toBe("a");
  });

  it("ne vole jamais le socket d'un démon vivant", async () => {
    const socket = await socketPath();
    expect(await claimUnixSocket(daemon("first"), socket)).toBe("listening");
    // Avant le correctif, le second démon supprimait ce socket puis écoutait
    // dessus : le premier devenait injoignable et restait en vie.
    expect(await claimUnixSocket(daemon("second"), socket)).toBe(
      "owned-by-another"
    );
    expect(await whoAnswers(socket)).toBe("first");
  });

  it("remplace un fichier périmé qu'aucun processus ne sert", async () => {
    const socket = await socketPath();
    await writeFile(socket, "stale");
    expect(await socketAnswers(socket)).toBe(false);
    expect(await claimUnixSocket(daemon("fresh"), socket)).toBe("listening");
    expect((await stat(socket)).isSocket()).toBe(true);
    expect(await whoAnswers(socket)).toBe("fresh");
  });

  it("deux démarrages simultanés : un seul gagne, l'autre se retire", async () => {
    const socket = await socketPath();
    const claims = await Promise.all([
      claimUnixSocket(daemon("left"), socket),
      claimUnixSocket(daemon("right"), socket),
    ]);
    expect([...claims].sort()).toEqual(["listening", "owned-by-another"]);
    const winner = claims[0] === "listening" ? "left" : "right";
    expect(await whoAnswers(socket)).toBe(winner);
  });
});
