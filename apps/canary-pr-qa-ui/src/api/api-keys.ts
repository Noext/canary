import { z } from "zod";

/**
 * The API-key answers the dashboard validates. They live beside the feature
 * rather than in the shared response registry, which already carries every
 * endpoint of the instance: a new surface adds its shapes here.
 */

const apiKeyRowSchema = z.object({
  createdAt: z.string(),
  id: z.string(),
  lastUsedAt: z.string().nullable(),
  name: z.string(),
  prefix: z.string(),
  repos: z.array(z.string()),
  revokedAt: z.string().nullable(),
  // Une clé n'est jamais administrateur : le serveur refuse toute autre portée.
  role: z.enum(["viewer", "operator"]),
});

export const apiKeyListSchema = z.array(apiKeyRowSchema);

/** A creation answers the token in clear text; no other answer ever carries it. */
export const apiKeyCreatedSchema = apiKeyRowSchema.extend({
  token: z.string(),
});

export const apiKeySecretSchema = z.object({ token: z.string() });

export const apiKeyRevokedSchema = z.object({
  id: z.string(),
  revokedAt: z.string(),
});
