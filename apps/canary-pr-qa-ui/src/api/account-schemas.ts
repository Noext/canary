import { z } from "zod";

/**
 * The accounts endpoints answer shapes no other screen reads: their schemas
 * live here, next to the store that consumes them, because `schemas.ts` sits at
 * the architecture gate's module-complexity limit and takes no new export.
 *
 * `role` mirrors `principalSchema`'s enum and the `Role` contract type; the
 * accounts screen is the only place an account is written, so it parses them.
 */
const accountSchema = z.object({
  createdAt: z.string(),
  id: z.string(),
  repos: z.array(z.string()),
  role: z.enum(["viewer", "operator", "admin"]),
  username: z.string(),
});

export const accountsSchema = z.object({
  accounts: z.array(accountSchema),
});

export const accountPayloadSchema = z.object({ account: accountSchema });
