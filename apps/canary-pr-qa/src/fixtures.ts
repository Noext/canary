import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type BrowserAuth, BrowserAuthSchema } from "@usecanary/protocol";
import { z } from "zod";
import { hostAllowed } from "../../canary-daemon/src/network-policy.js";
import type { Config } from "./config.js";
import { QaError } from "./diagnostics.js";
import { fetchText } from "./http.js";
import { runScope } from "./run-scope.js";
import type { Scenario } from "./schema.js";

const schema = z.record(
  z
    .object({
      roles: z.record(z.string()).default({}),
      visuals: z.record(z.string()).default({}),
      visualTolerance: z.number().min(0).max(0.1).default(0.001),
      fixtures: z
        .record(
          z.object({
            seedUrl: z.string().url(),
            cleanupUrl: z.string().url(),
            tokenEnv: z.string(),
            description: z.string(),
          })
        )
        .default({}),
    })
    .strict()
);
export async function fixtureCatalog(config: Config, repo: string) {
  const all = config.QA_FIXTURES_FILE
    ? schema.parse(JSON.parse(await readFile(config.QA_FIXTURES_FILE, "utf8")))
    : {};
  return (
    all[repo.toLowerCase()] ?? {
      roles: {},
      fixtures: {},
      visuals: {},
      visualTolerance: 0.001,
    }
  );
}
export async function prepareScenario(
  scenario: Scenario,
  repo: string,
  config: Config
): Promise<{
  auth?: BrowserAuth;
  cleanup: () => Promise<void>;
  namespace: string;
}> {
  const catalog = await fixtureCatalog(config, repo);
  const namespace = `${runScope.getStore()?.id ?? randomUUID()}-${scenario.id}`;
  const seeded: string[] = [];
  let auth: BrowserAuth | undefined;
  async function call(name: string, cleanup = false) {
    const entry = catalog.fixtures[name];
    if (!entry) {
      throw new Error(`Fixture ${name} not configured`);
    }
    const token = process.env[entry.tokenEnv];
    if (!token) {
      throw new Error(`Fixture token ${entry.tokenEnv} missing`);
    }
    await fetchText(cleanup ? entry.cleanupUrl : entry.seedUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `${namespace}:${cleanup ? "cleanup" : "seed"}`,
      },
      body: JSON.stringify({ namespace, scenario: scenario.id }),
    });
  }
  const cleanup = async () => {
    for (const name of seeded.reverse()) {
      await runScope.exit(() => call(name, true));
    }
  };
  try {
    for (const condition of scenario.preconditions) {
      if (condition.startsWith("fixture:")) {
        const name = condition.slice(8);
        await call(name);
        seeded.push(name);
        continue;
      }
      if (condition.startsWith("role:")) {
        const name = condition.slice(5);
        const env = catalog.roles[name];
        if (!(env && process.env[env])) {
          throw new Error(`Role ${name} missing`);
        }
        auth = BrowserAuthSchema.parse(JSON.parse(process.env[env] ?? ""));
        validateAuth(auth, config);
        continue;
      }
      throw new QaError(
        "PRECONDITION_UNVERIFIED",
        `Unsupported precondition: ${condition}`,
        "Use a trusted fixture:name or role:name declared in QA_FIXTURES_FILE; prose preconditions are never assumed satisfied."
      );
    }
    return { auth, cleanup, namespace };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
function validateAuth(auth: BrowserAuth, config: Config) {
  // Cookies carry no port, so they are matched against the hostnames of the
  // allowlist - wildcards included, which is why a `*.preview.example.com`
  // entry also covers the auth cookie a preview subdomain sets.
  const hosts = config.allowedHosts.map((h) => new URL(`http://${h}`).hostname);
  if (
    auth.cookies.some((c) => !hostAllowed(c.domain.replace(/^\./, ""), hosts))
  ) {
    throw new Error("Auth cookie domain outside approved previews");
  }
  if (
    auth.origins.some(
      (o) => !hostAllowed(new URL(o.origin).host, config.allowedHosts)
    )
  ) {
    throw new Error("Auth localStorage origin outside approved previews");
  }
}
