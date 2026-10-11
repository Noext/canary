import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";
import { fetchText } from "./http.js";

const cache = new Map<string, { token: string; expires: number }>();
export async function githubToken(config: Config): Promise<string> {
  if (!config.GITHUB_APP_ID) {
    return config.GITHUB_TOKEN;
  }
  const key = `${config.GITHUB_APP_ID}:${config.GITHUB_INSTALLATION_ID}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now() + 60_000) {
    return cached.token;
  }
  if (!(config.GITHUB_INSTALLATION_ID && config.GITHUB_APP_PRIVATE_KEY_FILE)) {
    throw new Error(
      "GitHub App installation ID and private key file are required"
    );
  }
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: config.GITHUB_APP_ID })}`;
  const signature = createSign("RSA-SHA256")
    .update(input)
    .sign(await readFile(config.GITHUB_APP_PRIVATE_KEY_FILE, "utf8"))
    .toString("base64url");
  const response = await fetchText(
    `${config.GITHUB_API_URL}/app/installations/${config.GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input}.${signature}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  const body = JSON.parse(response.text) as {
    token: string;
    expires_at: string;
  };
  if (!(body.token && Number.isFinite(Date.parse(body.expires_at)))) {
    throw new Error("GitHub returned invalid installation credentials");
  }
  cache.set(key, { token: body.token, expires: Date.parse(body.expires_at) });
  return body.token;
}
export function verifyWebhook(
  raw: Buffer,
  signature: string,
  secret: string
): boolean {
  if (secret.length < 32 || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
    return false;
  }
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
  );
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
