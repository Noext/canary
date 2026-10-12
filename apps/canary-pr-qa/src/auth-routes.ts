import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";
import {
  AdminSetup,
  Credentials,
  type LocalAuth,
  localCookie,
} from "./local-auth.js";
import type { Queue } from "./queue.js";

export function authRoutes(
  accounts: LocalAuth,
  queue: Queue,
  config: Config,
  read: (req: IncomingMessage) => Promise<Buffer>,
  json: (res: ServerResponse, status: number, value: unknown) => void
) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (req.method === "GET" && url.pathname === "/auth/status") {
      json(res, 200, await accounts.status());
      return true;
    }
    if (
      !(
        req.method === "POST" &&
        ["/auth/setup", "/auth/login"].includes(url.pathname)
      )
    ) {
      return false;
    }
    const input = JSON.parse((await read(req)).toString());
    const user =
      url.pathname === "/auth/setup"
        ? await accounts.setup(AdminSetup.parse(input), config.allowedRepos)
        : await accounts.login(Credentials.parse(input));
    if (!user) {
      json(res, 401, { error: "Identifiant ou mot de passe incorrect." });
      return true;
    }
    const token = await accounts.session(user);
    res.setHeader("Set-Cookie", localCookie(token, config, req));
    await queue.audit(
      user.id,
      url.pathname === "/auth/setup" ? "account.bootstrap" : "account.login"
    );
    json(res, 200, {
      id: user.id,
      username: user.username,
      role: user.role,
      repos:
        user.role === "admin"
          ? config.allowedRepos
          : user.repos.filter((repo) =>
              config.allowedRepos.includes(repo.toLowerCase())
            ),
    });
    return true;
  };
}
