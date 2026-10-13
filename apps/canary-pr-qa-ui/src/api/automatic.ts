import { z } from "zod";

/**
 * The shapes of the automatic-attempt surface. They live beside it rather than
 * in the shared response registry, which keeps the endpoints of the instance.
 */

const automaticStateSchema = z.enum([
  "waiting",
  "expired",
  "rate_limited",
  "promoted",
  "discarded",
  "disabled",
]);

const automaticAttemptSchema = z.object({
  attempts: z.number(),
  deadlineAt: z.string(),
  id: z.string(),
  lastError: z.string().nullish(),
  reason: z.string(),
  pr: z.number(),
  repo: z.string(),
  runId: z.string().nullable(),
  sha: z.string(),
  state: automaticStateSchema,
  updatedAt: z.string(),
});

/** One recorded step of an attempt, oldest first. */
const automaticTimelineEntrySchema = z.object({
  action: z.string(),
  at: z.string(),
  seconds: z.number().nullish(),
});

export const automaticDetailSchema = z.object({
  attempt: automaticAttemptSchema,
  preview: z
    .object({
      shaHeader: z.string(),
      shaPath: z.string().nullish(),
      template: z.string().nullish(),
    })
    .nullish(),
  timeline: z.array(automaticTimelineEntrySchema),
});

export const automaticStatusSchema = z.object({
  attempts: z.array(automaticAttemptSchema),
  enabledRepos: z.array(z.string()),
  summary: z.object({
    expired: z.number(),
    rateLimited: z.number(),
    waiting: z.number(),
  }),
});
