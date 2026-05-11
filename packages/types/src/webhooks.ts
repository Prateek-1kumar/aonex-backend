// Discriminated union of inbound Nango → Aonex webhook events.
// We do NOT model the full Nango payload — only the fields we route on.
// The full raw body is preserved on `processed_webhooks` and replayable.
//
// LLD §4.2 / §15-Q8 — queue-first ordering applies regardless of type.

import { z } from "zod";

const AuthSuccess = z.object({
  type: z.literal("auth"),
  operation: z.literal("creation").or(z.literal("override")),
  success: z.literal(true),
  endUser: z.object({ endUserId: z.string() }).optional(),
  connectionId: z.string(),
  providerConfigKey: z.string(),
  provider: z.string()
});

const AuthFailure = z.object({
  type: z.literal("auth"),
  operation: z.literal("creation").or(z.literal("override")),
  success: z.literal(false),
  connectionId: z.string(),
  providerConfigKey: z.string(),
  provider: z.string(),
  error: z.object({ type: z.string(), description: z.string().optional() }).optional()
});

const SyncEvent = z.object({
  type: z.literal("sync"),
  syncType: z.enum(["INITIAL", "INCREMENTAL", "FULL"]),
  syncName: z.string(),
  model: z.string(),
  connectionId: z.string(),
  providerConfigKey: z.string(),
  startedAt: z.string().datetime().optional(),
  modifiedAfter: z.string().datetime().optional(),
  responseResults: z
    .object({
      added: z.number().int().nonnegative(),
      updated: z.number().int().nonnegative(),
      deleted: z.number().int().nonnegative()
    })
    .optional()
});

export const NangoWebhookEventSchema = z.union([AuthSuccess, AuthFailure, SyncEvent]);

export type NangoWebhookEvent = z.infer<typeof NangoWebhookEventSchema>;
export type NangoAuthEvent = z.infer<typeof AuthSuccess> | z.infer<typeof AuthFailure>;
export type NangoSyncEvent = z.infer<typeof SyncEvent>;
