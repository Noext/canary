import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Principal } from "./access.js";
import type { GitHubSetup } from "./github-setup.js";
import type { Queue } from "./queue.js";

export function githubSetupRoutes(
  setup: GitHubSetup,
  queue: Queue,
  read: (req: IncomingMessage) => Promise<Buffer>,
  json: (res: ServerResponse, status: number, value: unknown) => void
) {
  async function callback(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal
  ) {
    if (`${req.method} ${url.pathname}` === "GET /github/app/callback") {
      await setup.convert(
        user.id,
        url.searchParams.get("state") ?? "",
        url.searchParams.get("code") ?? ""
      );
      await queue.audit(user.id, "github.app.created");
      res.writeHead(303, { Location: "/?github=created" });
      res.end();
      return true;
    }
    if (`${req.method} ${url.pathname}` === "GET /github/app/installed") {
      // Never trust installation_id supplied by the browser. The authenticated admin
      // synchronizes only installations enumerated by this instance's App JWT.
      const state = url.searchParams.get("state");
      if (state) {
        await setup.consumeState(user.id, state, "install");
        await setup.refresh();
        await queue.audit(user.id, "github.installations.synced");
      }
      res.writeHead(303, { Location: "/?github=installed" });
      res.end();
      return true;
    }
    return false;
  }
  async function remove(req: IncomingMessage, user: Principal) {
    const payload = (await read(req)).toString().trim();
    const input = payload
      ? z
          .object({ deleteApp: z.boolean().optional() })
          .strict()
          .parse(JSON.parse(payload))
      : {};
    const status = await setup.disconnect(input);
    await queue.audit(user.id, "github.app.disconnected", undefined, {
      appDeleted: status.disconnected.appDeleted,
      uninstalled: status.disconnected.uninstalled.length,
      warnings: status.disconnected.warnings.length,
    });
    return status;
  }
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: Principal
  ) => {
    if (!url.pathname.startsWith("/github/app")) {
      return false;
    }
    if (user.role !== "admin") {
      json(res, 403, { error: "Administrator required" });
      return true;
    }
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    if (`${req.method} ${url.pathname}` === "GET /github/app") {
      json(res, 200, await setup.status());
      return true;
    }
    if (await callback(req, res, url, user)) {
      return true;
    }
    if (`${req.method} ${url.pathname}` === "POST /github/app/manifest") {
      const input = z
        .object({ name: z.string(), organization: z.string().optional() })
        .strict()
        .parse(JSON.parse((await read(req)).toString()));
      json(res, 200, await setup.manifest(user.id, input));
      return true;
    }
    if (`${req.method} ${url.pathname}` === "POST /github/app/install") {
      json(res, 200, await setup.install(user.id));
      return true;
    }
    if (`${req.method} ${url.pathname}` === "POST /github/app/refresh") {
      json(res, 200, await setup.refresh());
      await queue.audit(user.id, "github.installations.synced");
      return true;
    }
    if (`${req.method} ${url.pathname}` === "DELETE /github/app") {
      json(res, 200, await remove(req, user));
      return true;
    }
    if (`${req.method} ${url.pathname}` === "PUT /github/app/repositories") {
      const input = z
        .object({ repositories: z.array(z.string()) })
        .strict()
        .parse(JSON.parse((await read(req)).toString()));
      json(res, 200, await setup.select(input.repositories));
      await queue.audit(user.id, "github.repositories.selected", undefined, {
        repositories: input.repositories,
      });
      return true;
    }
    json(res, 404, { error: "Not found" });
    return true;
  };
}
