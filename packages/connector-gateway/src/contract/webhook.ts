// Webhook verification port. Belongs to the gateway because
// signature scheme + secret are vendor concerns; the result is
// a typed Aonex domain event.

import type { NangoWebhookEvent } from "@aonex/types";

export interface VerifyAndParseInput {
  rawBody: string;
  /** Header lookup — case-insensitive matching done by impl. */
  headers: Record<string, string | string[] | undefined>;
}

export interface VerifyAndParseResult {
  event: NangoWebhookEvent;
  /** sha256(rawBody) — drives processed_webhooks PK + BullMQ jobId. */
  webhookId: string;
}

export interface IWebhookVerifier {
  verifyAndParseWebhook(input: VerifyAndParseInput): Promise<VerifyAndParseResult>;
}
