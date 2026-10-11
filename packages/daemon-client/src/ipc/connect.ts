import net from "node:net";
import { createInterface } from "node:readline";
import {
  daemonTcpConfig,
  type Request,
  type Response,
} from "@usecanary/protocol";
import { daemonEndpoint } from "../paths.js";

// 5s write timeout on the socket.
const WRITE_TIMEOUT_MS = 5000;
// Generous frame ceiling so large screenshots / result payloads don't truncate.
const MAX_LINE_BYTES = 64 * 1024 * 1024;

export class DaemonConnectionClosed extends Error {
  constructor() {
    super("Daemon connection closed unexpectedly");
    this.name = "DaemonConnectionClosed";
  }
}

export interface DaemonConnection {
  reader: AsyncIterableIterator<string>;
  socket: net.Socket;
}

export async function connectToDaemon(): Promise<DaemonConnection> {
  const endpoint = daemonEndpoint();
  const tcp = daemonTcpConfig(process.env);
  const socket = net.createConnection(
    tcp ? { host: tcp.host, port: tcp.port } : { path: endpoint }
  );

  await new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      socket.removeListener("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      socket.removeListener("connect", onConnect);
      reject(err);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });

  socket.setNoDelay(true);
  socket.setTimeout(WRITE_TIMEOUT_MS);

  return { socket, reader: readLines(socket) };
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const conn = await connectToDaemon();
    try {
      if (!daemonTcpConfig(process.env)) {
        return true;
      }
      conn.socket.setTimeout(1000, () => conn.socket.destroy());
      // A listening TCP port alone does not prove it is our authenticated daemon.
      await sendMessage(conn.socket, {
        id: "transport-health",
        type: "status",
      });
      for await (const line of conn.reader) {
        const response = JSON.parse(line) as Response;
        if (response.type === "complete") {
          return true;
        }
        if (response.type === "error") {
          return false;
        }
      }
      return false;
    } finally {
      conn.socket.destroy();
    }
  } catch {
    return false;
  }
}

// Newline-delimited JSON framing.
export async function sendMessage(
  socket: net.Socket,
  message: Request
): Promise<void> {
  const tcp = daemonTcpConfig(process.env);
  const json = JSON.stringify(
    tcp ? { ...message, transportToken: tcp.token } : message
  );
  await write(socket, json);
  await write(socket, "\n");
}

function write(socket: net.Socket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function* readLines(socket: net.Socket): AsyncIterableIterator<string> {
  const rl = createInterface({
    input: socket,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let bytes = 0;
  try {
    for await (const line of rl) {
      bytes += line.length;
      if (bytes > MAX_LINE_BYTES) {
        throw new Error(`Daemon message exceeds ${MAX_LINE_BYTES} bytes`);
      }
      yield line;
    }
  } finally {
    rl.close();
  }
}

// Renderer for the daemon's `result` payload — supplied by callers so the
// IPC layer doesn't need to know about result formatting.
export type ResultRenderer = (
  data: unknown,
  stdout: NodeJS.WritableStream
) => void;

export interface StreamHandlers {
  // Called with the daemon's terminal `error` message (if any), separately from
  // the merged stderr stream. Lets callers reliably detect a daemon-level
  // rejection without substring-matching teed stderr (which also carries the
  // executed script's own stderr output).
  onError?: (message: string) => void;
  renderResult?: ResultRenderer;
  stderr: NodeJS.WritableStream;
  stdout: NodeJS.WritableStream;
}

// Stream responses until `complete` or `error`. Returns the process exit
// code (0 for complete, 1 for error).
export async function streamResponses(
  conn: DaemonConnection,
  handlers: StreamHandlers
): Promise<number> {
  let sawTerminal = false;
  try {
    for await (const line of conn.reader) {
      let message: Response;
      try {
        message = JSON.parse(line) as Response;
      } catch (err) {
        throw new Error(`malformed response from daemon: ${describe(err)}`);
      }

      switch (message.type) {
        case "stdout":
          handlers.stdout.write(message.data);
          break;
        case "stderr":
          handlers.stderr.write(message.data);
          break;
        case "result":
          handlers.renderResult?.(message.data, handlers.stdout);
          break;
        case "complete":
          sawTerminal = true;
          return 0;
        case "error": {
          sawTerminal = true;
          const text = message.message ?? "Unknown daemon error";
          handlers.onError?.(text);
          handlers.stderr.write(`${text}\n`);
          return 1;
        }
        default:
          // Unknown message types are ignored (matches Rust + Go).
          break;
      }
    }
  } finally {
    conn.socket.destroy();
  }

  if (!sawTerminal) {
    throw new DaemonConnectionClosed();
  }
  return 0;
}

// Convenience helper: open, send, stream, return exit code.
export async function sendRequest(
  message: Request,
  renderResult: ResultRenderer | undefined,
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
  onError?: (message: string) => void
): Promise<number> {
  const conn = await connectToDaemon();
  try {
    await sendMessage(conn.socket, message);
  } catch (err) {
    conn.socket.destroy();
    throw err;
  }
  return await streamResponses(conn, { stdout, stderr, renderResult, onError });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type { BrowserSummary, StatusSummary } from "@usecanary/protocol";
