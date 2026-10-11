import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = resolve(__dirname, "../../dist/cli.js");

export interface CliResult {
  code: number;
  stderr: string;
  stdout: string;
}

// Async spawn that does NOT block the event loop, so an in-process fake
// daemon (see startFakeDaemonAtSocket below) can serve requests while the
// child runs.
export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  binary: string = CLI_PATH
): Promise<CliResult> {
  const isJs = binary.endsWith(".js");
  const child = spawn(
    isJs ? process.execPath : binary,
    isJs ? [binary, ...args] : args,
    {
      env: { ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (c) => out.push(c));
  child.stderr.on("data", (c) => err.push(c));
  const code: number = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (c) => resolve(c ?? 0));
  });
  return {
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
    code,
  };
}

export type DaemonHandler = (
  req: Record<string, unknown>
) => Iterable<object> | AsyncIterable<object>;

export interface FakeEnv {
  close(): Promise<void>;
  env: NodeJS.ProcessEnv;
  home: string;
  socketPath: string;
}

export interface CapturingFakeEnv extends FakeEnv {
  // Resolves to the first parsed request line the daemon received, or null
  // if no request arrived before close. Useful for asserting on the exact
  // payload a CLI emitted.
  request(): Promise<Record<string, unknown> | null>;
}

const TEST_TCP_TOKEN = "fake-daemon-test-token-with-at-least-32-characters";
function healthProbe(
  socket: net.Socket,
  req: Record<string, unknown>
): boolean {
  if (process.env.CANARY_TEST_TCP !== "1") {
    return false;
  }
  if (req.transportToken !== TEST_TCP_TOKEN) {
    socket.destroy();
    return true;
  }
  if (req.id !== "transport-health") {
    return false;
  }
  socket.end(
    `${JSON.stringify({ id: req.id, type: "complete", success: true })}\n`
  );
  return true;
}
async function listenFake(
  server: net.Server,
  socketPath: string
): Promise<NodeJS.ProcessEnv> {
  const tcp = process.env.CANARY_TEST_TCP === "1";
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(
      tcp ? { host: "127.0.0.1", port: 0 } : { path: socketPath },
      done
    );
  });
  const address = server.address();
  return tcp && address && typeof address !== "string"
    ? {
        CANARY_DAEMON_PORT: String(address.port),
        CANARY_DAEMON_TOKEN: TEST_TCP_TOKEN,
      }
    : { CANARY_DAEMON_PORT: "", CANARY_DAEMON_TOKEN: "" };
}

// Start a fake daemon listening at <tempHome>/.canary/daemon.sock and
// return an env object pointing the CLI at it. On Windows we skip — CLI's
// pipe name is process-scoped and can't be redirected this way.
export async function startFakeDaemon(
  handler: DaemonHandler
): Promise<FakeEnv | null> {
  if (process.platform === "win32") {
    return null;
  }
  const home = await mkdtemp(join(tmpdir(), "cli-ts-fakedaemon-"));
  const dev = join(home, ".canary");
  await mkdir(dev, { recursive: true });
  const socketPath = join(dev, "daemon.sock");

  const server = net.createServer((socket) => {
    const rl = createInterface({
      input: socket,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    rl.once("line", async (line) => {
      let req: Record<string, unknown> = {};
      try {
        req = JSON.parse(line);
      } catch {
        // ignore malformed
      }
      if (healthProbe(socket, req)) {
        return;
      }
      try {
        for await (const message of handler(req)) {
          socket.write(`${JSON.stringify(message)}\n`);
        }
      } catch {
        // ignore handler errors
      } finally {
        socket.end();
      }
    });
    socket.on("error", () => socket.destroy());
  });
  const transportEnv = await listenFake(server, socketPath);

  return {
    env: { ...process.env, HOME: home, USERPROFILE: home, ...transportEnv },
    home,
    socketPath,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(home, { recursive: true, force: true });
    },
  };
}

// Like startFakeDaemon, but also captures the first request line received so
// tests can assert on the exact payload the CLI emitted. The handler still
// gets to script the response stream.
export async function startFakeDaemonCapturing(
  handler: DaemonHandler
): Promise<CapturingFakeEnv | null> {
  if (process.platform === "win32") {
    return null;
  }
  const home = await mkdtemp(join(tmpdir(), "cli-ts-fakedaemon-cap-"));
  const dev = join(home, ".canary");
  await mkdir(dev, { recursive: true });
  const socketPath = join(dev, "daemon.sock");

  let capturedRequest: Record<string, unknown> | null = null;
  let resolveCaptured: (value: Record<string, unknown> | null) => void =
    () => {};
  const capturedPromise = new Promise<Record<string, unknown> | null>((r) => {
    resolveCaptured = r;
  });

  const server = net.createServer((socket) => {
    const rl = createInterface({
      input: socket,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    rl.once("line", async (line) => {
      let req: Record<string, unknown> = {};
      try {
        req = JSON.parse(line);
      } catch {
        // ignore malformed
      }
      if (healthProbe(socket, req)) {
        return;
      }
      if (capturedRequest === null) {
        capturedRequest = req;
        resolveCaptured(req);
      }
      try {
        for await (const message of handler(req)) {
          socket.write(`${JSON.stringify(message)}\n`);
        }
      } catch {
        // ignore handler errors
      } finally {
        socket.end();
      }
    });
    socket.on("error", () => socket.destroy());
  });
  const transportEnv = await listenFake(server, socketPath);

  return {
    env: { ...process.env, HOME: home, USERPROFILE: home, ...transportEnv },
    home,
    socketPath,
    async request() {
      // Race against a small grace period so close() doesn't hang if the
      // CLI never connected.
      return Promise.race([
        capturedPromise,
        new Promise<Record<string, unknown> | null>((r) =>
          setTimeout(() => r(capturedRequest), 50)
        ),
      ]);
    },
    async close() {
      resolveCaptured(capturedRequest);
      await new Promise<void>((r) => server.close(() => r()));
      await rm(home, { recursive: true, force: true });
    },
  };
}
