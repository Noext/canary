import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { z } from "zod";
import { Canary } from "./canary.js";
import type { Config } from "./config.js";
import { diagnose } from "./diagnostics.js";
import { watchPreviewPolicy } from "./preview-hosts.js";

const commandSchema = z
  .object({
    args: z.array(z.string().max(2000)).max(20),
    script: z.string().max(100_000).optional(),
  })
  .strict();
export async function startBrowserService(config: Config) {
  if (config.QA_BROWSER_SERVICE_TOKEN.length < 32) {
    throw new Error(
      "QA_BROWSER_SERVICE_TOKEN must have at least 32 characters"
    );
  }
  // The dashboard host list also feeds the daemon's own network policy, which is
  // the fallback when a session is started without an explicit host list.
  const policy = watchPreviewPolicy(config);
  const native = new Canary({ ...config, QA_BROWSER_SERVICE_URL: "" });
  let active = 0;
  const server = createServer((req, res) => {
    void handle().catch((error) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: diagnose(error, config).message }));
    });
    async function handle() {
      if (req.method === "GET" && req.url === "/health") {
        res.end(JSON.stringify({ ok: true, active }));
        return;
      }
      if (!authorized(req.headers.authorization, config)) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method !== "POST" || req.url !== "/command" || active >= 16) {
        res.writeHead(429);
        res.end();
        return;
      }
      const input = await readCommand(req);
      if (input.args[0] === "purge") {
        await native.purge(input.args[1] ?? "");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ code: 0, stdout: "", stderr: "" }));
        return;
      }
      active++;
      try {
        const result = await native.command(input.args, input.script);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } finally {
        active--;
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.QA_BROWSER_PORT, config.QA_BROWSER_HOST, resolve);
  });
  server.on("close", () => policy.stop());
  return server;
}

function authorized(header: string | undefined, config: Config) {
  const actual = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${config.QA_BROWSER_SERVICE_TOKEN}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readCommand(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 110_000) {
      throw new Error("Command too large");
    }
    chunks.push(Buffer.from(chunk));
  }
  const input = commandSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString())
  );
  if (
    !(
      input.args[0] === "purge" ||
      input.args[0] === "run" ||
      (input.args[0] === "session" &&
        ["start", "end", "abort"].includes(input.args[1] ?? "")) ||
      input.args[0] === "--version"
    )
  ) {
    throw new Error("Browser service command is not allowed");
  }
  return input;
}
