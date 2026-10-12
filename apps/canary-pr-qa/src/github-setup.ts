import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "./config.js";
import { diagnose, QaError } from "./diagnostics.js";
import { appJwt, githubToken } from "./github-app.js";
import { fetchText } from "./http.js";

export const GITHUB_SETUP_MIGRATION = `
CREATE TABLE IF NOT EXISTS qa_github_app (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), app_id text NOT NULL,
 slug text NOT NULL, origin text NOT NULL, credentials text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS qa_github_state (
 actor text PRIMARY KEY, token_hash text NOT NULL, phase text NOT NULL CHECK(phase IN ('manifest','install')),
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS qa_github_repositories (
 full_name text PRIMARY KEY, repository_id text NOT NULL, installation_id text NOT NULL,
 account text NOT NULL, private boolean NOT NULL, enabled boolean NOT NULL DEFAULT false
);
`;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const slug = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const id = z.number().int().positive().safe();
export const REQUIRED_PERMISSIONS = {
  contents: "read",
  metadata: "read",
  deployments: "read",
  pull_requests: "write",
  statuses: "write",
  checks: "write",
};
const appResponse = z.object({
  id,
  slug,
  pem: z.string().min(100),
  webhook_secret: z.string().min(32),
});
const installationSchema = z.object({
  id,
  app_id: id,
  account: z.object({ login: z.string() }),
  suspended_at: z.string().nullable(),
  permissions: z.record(z.string(), z.string()),
});
const repositoriesSchema = z.object({
  repositories: z.array(
    z.object({
      id,
      full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      private: z.boolean(),
    })
  ),
});
function failure(code: string, message: string) {
  return new QaError(
    code,
    message,
    "Ouvrez les réglages GitHub du dashboard. Vérifiez l'URL HTTPS, l'installation et les permissions de l'App, puis actualisez."
  );
}
function cryptKey(config: Config) {
  if (config.QA_API_TOKEN.length < 24) {
    throw failure(
      "GITHUB_ENCRYPTION_KEY",
      "Le secret serveur QA_API_TOKEN est requis pour protéger la connexion GitHub."
    );
  }
  return Buffer.from(
    hkdfSync("sha256", config.QA_API_TOKEN, "canary-pr-qa", "github-app-v1", 32)
  );
}
function encrypt(value: unknown, config: Config) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cryptKey(config), iv);
  cipher.setAAD(Buffer.from("canary-github-app-v1"));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    data.toString("base64url"),
  ].join(".");
}
function decrypt(
  value: string,
  config: Config
): { pem: string; secret: string } {
  try {
    const [version, iv, tag, data] = value.split(".");
    if (version !== "v1" || !(iv && tag && data)) {
      throw new Error("Invalid envelope");
    }
    const cipher = createDecipheriv(
      "aes-256-gcm",
      cryptKey(config),
      Buffer.from(iv, "base64url")
    );
    cipher.setAAD(Buffer.from("canary-github-app-v1"));
    cipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(data, "base64url")),
        cipher.final(),
      ]).toString()
    );
  } catch {
    throw failure(
      "GITHUB_CREDENTIALS_UNREADABLE",
      "Connexion GitHub illisible : le secret serveur a changé ou la sauvegarde est incomplète."
    );
  }
}
interface Repository {
  account: string;
  fullName: string;
  id: string;
  installation: string;
  private: boolean;
}
interface AppRow {
  app_id: string;
  credentials: string;
  origin: string;
  slug: string;
}
export class GitHubSetup {
  readonly pool: pg.Pool;
  readonly config: Config;
  constructor(pool: pg.Pool, config: Config) {
    this.pool = pool;
    this.config = config;
  }
  async app(): Promise<AppRow | undefined> {
    return (
      await this.pool.query<AppRow>(
        "SELECT * FROM qa_github_app WHERE singleton=true"
      )
    ).rows[0];
  }
  async status() {
    const app = await this.app();
    const repositories = app
      ? (
          await this.pool.query(
            "SELECT full_name,installation_id,account,private,enabled FROM qa_github_repositories ORDER BY full_name"
          )
        ).rows
      : [];
    const delivery = (
      await this.pool.query(
        "SELECT event,status,created_at FROM qa_deliveries ORDER BY created_at DESC LIMIT 1"
      )
    ).rows[0];
    return {
      app: app ? { id: app.app_id, slug: app.slug, origin: app.origin } : null,
      repositories,
      lastDelivery: delivery ?? null,
      legacyConfigured: Boolean(
        this.config.GITHUB_TOKEN || this.config.GITHUB_APP_ID
      ),
      restriction: this.config.allowedRepos,
    };
  }
  async effective(): Promise<Config> {
    const app = await this.app();
    if (!app) {
      return this.config;
    }
    const secret = decrypt(app.credentials, this.config);
    const rows = (
      await this.pool.query(
        "SELECT full_name,installation_id FROM qa_github_repositories WHERE enabled=true"
      )
    ).rows;
    const repositories = rows.filter(
      (row) =>
        !this.config.allowedRepos.length ||
        this.config.allowedRepos.includes(row.full_name.toLowerCase())
    );
    return {
      ...this.config,
      GITHUB_TOKEN: "",
      GITHUB_APP_ID: app.app_id,
      GITHUB_INSTALLATION_ID: "",
      GITHUB_APP_PRIVATE_KEY_FILE: "",
      githubPrivateKey: secret.pem,
      GITHUB_WEBHOOK_SECRET: secret.secret,
      allowedRepos: repositories.map((row) => row.full_name.toLowerCase()),
      githubInstallations: Object.fromEntries(
        repositories.map((row) => [
          row.full_name.toLowerCase(),
          row.installation_id,
        ])
      ),
    };
  }
  async state(actor: string, phase: "manifest" | "install") {
    const token = randomBytes(32).toString("hex");
    await this.pool.query("DELETE FROM qa_github_state WHERE expires_at<now()");
    await this.pool.query(
      "INSERT INTO qa_github_state(actor,token_hash,phase,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes') ON CONFLICT(actor) DO UPDATE SET token_hash=EXCLUDED.token_hash,phase=EXCLUDED.phase,expires_at=EXCLUDED.expires_at",
      [actor, hash(token), phase]
    );
    return token;
  }
  async consumeState(actor: string, token: string, phase: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      throw failure(
        "GITHUB_STATE_INVALID",
        "Retour GitHub invalide ou expiré. Relancez la connexion depuis le dashboard."
      );
    }
    const result = await this.pool.query(
      "DELETE FROM qa_github_state WHERE actor=$1 AND token_hash=$2 AND phase=$3 AND expires_at>now() RETURNING actor",
      [actor, hash(token), phase]
    );
    if (!result.rows.length) {
      throw failure(
        "GITHUB_STATE_INVALID",
        "Retour GitHub invalide, déjà utilisé ou expiré. Relancez la connexion depuis le dashboard."
      );
    }
  }
  async manifest(
    actor: string,
    input: { name: string; organization?: string }
  ) {
    if (await this.app()) {
      throw failure(
        "GITHUB_APP_EXISTS",
        "Une App est déjà connectée à cette instance."
      );
    }
    const origin = new URL(this.config.ARTIFACT_BASE_URL);
    if (
      origin.protocol !== "https:" ||
      origin.pathname !== "/" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash
    ) {
      throw failure(
        "GITHUB_PUBLIC_ORIGIN",
        "Configurez ARTIFACT_BASE_URL avec l'origine HTTPS publique du dashboard."
      );
    }
    const name = z.string().trim().min(3).max(100).parse(input.name);
    const organization = input.organization
      ? z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/)
          .parse(input.organization)
      : "";
    const state = await this.state(actor, "manifest");
    const action = `${organization ? `https://github.com/organizations/${organization}/settings/apps/new` : "https://github.com/settings/apps/new"}?state=${state}`;
    return {
      action,
      manifest: {
        name,
        url: origin.origin,
        hook_attributes: {
          url: `${origin.origin}/github/webhook`,
          active: true,
        },
        redirect_url: `${origin.origin}/github/app/callback`,
        setup_url: `${origin.origin}/github/app/installed`,
        public: false,
        default_permissions: REQUIRED_PERMISSIONS,
        default_events: ["pull_request"],
        setup_on_update: true,
      },
    };
  }
  async convert(actor: string, state: string, code: string) {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(code)) {
      throw failure("GITHUB_CODE_INVALID", "Code de création GitHub invalide.");
    }
    await this.consumeState(actor, state, "manifest");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(9287346)");
      if (
        (await client.query("SELECT app_id FROM qa_github_app")).rows.length
      ) {
        throw failure("GITHUB_APP_EXISTS", "Une App est déjà connectée.");
      }
      // Do not include the temporary code, PEM or remote response in errors/logs.
      let raw: unknown;
      try {
        raw = JSON.parse(
          (
            await fetchText(
              `${this.config.GITHUB_API_URL}/app-manifests/${code}/conversions`,
              {
                method: "POST",
                headers: {
                  Accept: "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2022-11-28",
                },
              }
            )
          ).text
        );
      } catch {
        throw failure(
          "GITHUB_MANIFEST_FAILED",
          "GitHub n'a pas accepté le code de création. Vérifiez le réseau puis relancez le parcours ; si l'App a été créée, conservez-la dans vos réglages GitHub."
        );
      }
      const result = appResponse.safeParse(raw);
      if (!result.success) {
        throw failure(
          "GITHUB_MANIFEST_FAILED",
          "Réponse de création GitHub incomplète."
        );
      }
      const app = result.data;
      try {
        if (createPrivateKey(app.pem).asymmetricKeyType !== "rsa") {
          throw new Error("RSA required");
        }
      } catch {
        throw failure("GITHUB_MANIFEST_FAILED", "Clé GitHub App invalide.");
      }
      await client.query(
        "INSERT INTO qa_github_app(singleton,app_id,slug,origin,credentials) VALUES(true,$1,$2,$3,$4)",
        [
          String(app.id),
          app.slug,
          this.config.ARTIFACT_BASE_URL.replace(/\/$/, ""),
          encrypt({ pem: app.pem, secret: app.webhook_secret }, this.config),
        ]
      );
      await client.query("COMMIT");
      return { id: String(app.id), slug: app.slug };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async install(actor: string) {
    const app = await this.app();
    if (!app) {
      throw failure("GITHUB_NOT_CONNECTED", "Créez d'abord votre App GitHub.");
    }
    return {
      url: `https://github.com/apps/${app.slug}/installations/new?state=${await this.state(actor, "install")}`,
    };
  }
  async refresh() {
    const app = await this.app();
    if (!app) {
      throw failure("GITHUB_NOT_CONNECTED", "Créez d'abord votre App GitHub.");
    }
    const { pem } = decrypt(app.credentials, this.config);
    const installations = await this.installations(app, pem);
    const repos = await this.repositories(app, pem, installations);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(9287346)");
      for (const repo of repos) {
        await client.query(
          "INSERT INTO qa_github_repositories(full_name,repository_id,installation_id,account,private) VALUES($1,$2,$3,$4,$5) ON CONFLICT(full_name) DO UPDATE SET repository_id=EXCLUDED.repository_id,installation_id=EXCLUDED.installation_id,account=EXCLUDED.account,private=EXCLUDED.private",
          [
            repo.fullName,
            repo.id,
            repo.installation,
            repo.account,
            repo.private,
          ]
        );
      }
      await client.query(
        "DELETE FROM qa_github_repositories WHERE NOT(full_name=ANY($1::text[]))",
        [repos.map((repo) => repo.fullName)]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.status();
  }
  private async installations(app: AppRow, pem: string) {
    const installations: z.infer<typeof installationSchema>[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = z
        .array(installationSchema)
        .parse(
          await this.appRequest(
            `/app/installations?per_page=100&page=${page}`,
            app,
            pem
          )
        );
      installations.push(...result);
      if (result.length < 100) {
        break;
      }
      if (page === 100) {
        throw failure(
          "GITHUB_LIMIT",
          "Trop d'installations pour une synchronisation complète."
        );
      }
    }
    return installations;
  }
  private async repositories(
    app: AppRow,
    pem: string,
    installations: z.infer<typeof installationSchema>[]
  ) {
    const repos: Repository[] = [];
    for (const installation of installations) {
      if (
        String(installation.app_id) !== app.app_id ||
        installation.suspended_at
      ) {
        continue;
      }
      if (
        Object.entries(REQUIRED_PERMISSIONS).some(
          ([key, required]) =>
            installation.permissions[key] !== "write" &&
            installation.permissions[key] !== required
        )
      ) {
        throw failure(
          "GITHUB_PERMISSIONS",
          `Permissions incomplètes sur ${installation.account.login}. Acceptez les permissions de l'App sur GitHub.`
        );
      }
      const token = await githubToken({
        ...this.config,
        GITHUB_APP_ID: app.app_id,
        GITHUB_INSTALLATION_ID: String(installation.id),
        githubPrivateKey: pem,
      });
      for (let page = 1; page <= 100; page++) {
        const result = repositoriesSchema.parse(
          await this.api(
            `/installation/repositories?per_page=100&page=${page}`,
            token
          )
        );
        repos.push(
          ...result.repositories.map((repo) => ({
            fullName: repo.full_name.toLowerCase(),
            id: String(repo.id),
            installation: String(installation.id),
            account: installation.account.login,
            private: repo.private,
          }))
        );
        if (result.repositories.length < 100) {
          break;
        }
        if (page === 100) {
          throw failure(
            "GITHUB_LIMIT",
            "Trop de dépôts pour une synchronisation complète."
          );
        }
      }
    }
    return repos;
  }
  async select(repos: string[]) {
    const requested = z
      .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
      .max(10_000)
      .parse(repos)
      .map((repo) => repo.toLowerCase());
    // Revalidate GitHub authorization before committing the selection.
    await this.refresh();
    const available = (
      await this.pool.query("SELECT full_name FROM qa_github_repositories")
    ).rows.map((row) => row.full_name);
    if (
      requested.some(
        (repo) =>
          !available.includes(repo) ||
          (this.config.allowedRepos.length &&
            !this.config.allowedRepos.includes(repo))
      )
    ) {
      throw failure(
        "GITHUB_REPOSITORY_DENIED",
        "Un dépôt sélectionné est indisponible ou interdit par la restriction serveur."
      );
    }
    await this.pool.query(
      "UPDATE qa_github_repositories SET enabled=(full_name=ANY($1::text[]))",
      [requested]
    );
    return this.status();
  }
  /**
   * Removes the GitHub App connection. GitHub is asked first so a refusal is
   * reported as a warning instead of stranding the instance with credentials
   * it can no longer use; the local rows are always deleted.
   */
  async disconnect(options: { deleteApp?: boolean } = {}) {
    const app = await this.app();
    if (!app) {
      throw failure(
        "GITHUB_NOT_CONNECTED",
        "Aucune App GitHub n'est connectée à cette instance."
      );
    }
    const deleteApp = Boolean(options.deleteApp);
    const uninstalled: string[] = [];
    const warnings: string[] = [];
    let appDeleted = false;
    try {
      const { pem } = decrypt(app.credentials, this.config);
      if (deleteApp) {
        // GitHub also removes every installation of that App.
        await this.appDelete("/app", app, pem);
        appDeleted = true;
      } else {
        for (const installation of await this.installations(app, pem)) {
          await this.appDelete(
            `/app/installations/${installation.id}`,
            app,
            pem
          );
          uninstalled.push(installation.account.login);
        }
      }
    } catch (error) {
      warnings.push(
        `${deleteApp ? "La suppression de l'App" : "La désinstallation sur GitHub"} a échoué (${diagnose(error, this.config).message}). Terminez l'opération depuis les réglages GitHub.`
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(9287346)");
      await client.query("DELETE FROM qa_github_app");
      await client.query("DELETE FROM qa_github_repositories");
      // A pending manifest/install callback must not recreate the connection.
      await client.query("DELETE FROM qa_github_state");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return {
      ...(await this.status()),
      disconnected: { appDeleted, deleteApp, uninstalled, warnings },
    };
  }
  appRequest(path: string, app: AppRow, pem: string) {
    return this.api(path, appJwt(app.app_id, pem));
  }
  /**
   * GitHub answers 204 No Content on a successful delete, which `fetchText`
   * reports as an empty body: that exact error is the success shape here, and
   * every non-2xx status keeps its HTTP_* diagnostic.
   */
  private async appDelete(path: string, app: AppRow, pem: string) {
    try {
      await fetchText(
        `${this.config.GITHUB_API_URL}${path}`,
        {
          method: "DELETE",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${appJwt(app.app_id, pem)}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
        15_000
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Empty HTTP response") {
        return;
      }
      throw error;
    }
  }
  async api(path: string, token: string) {
    return JSON.parse(
      (
        await fetchText(`${this.config.GITHUB_API_URL}${path}`, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        })
      ).text
    );
  }
}
