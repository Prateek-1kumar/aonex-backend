// HMAC-SHA256 webhook verification.
// LLD §4 — uses `X-Nango-Hmac-Sha256` only; the legacy
// `X-Nango-Signature` is length-extension-vulnerable and deprecated.
// Implemented locally (not via @nangohq/node.verifyIncomingWebhookRequest)
// so the package remains the ONLY caller of @nangohq/node — and we get
// `crypto.timingSafeEqual` semantics under our own control.

import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@aonex/lib-utils";
import { GatewayError, NangoWebhookEventSchema, type NangoWebhookEvent } from "@aonex/types";

export interface VerifyOptions {
  /** Primary secret. */
  secret: string;
  /** Optional second secret accepted during quarterly rotation. */
  secretNext?: string;
  /**
   * Max age (ms) for events that include `startedAt`. Defaults to
   * 5min per LLD §4 freshness check. Auth events lack a timestamp
   * so we rely on processed_webhooks PK alone.
   */
  freshnessWindowMs?: number;
  /** Injected for testability. */
  nowMs?: () => number;
}

const HEADER_HMAC = "x-nango-hmac-sha256";

export function verifyHmac(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  // Length-equality pre-check — timingSafeEqual throws on mismatched length.
  if (expected.length !== header.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(header, "hex"));
  } catch {
    return false;
  }
}

function lookupHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

export interface VerifyResult {
  event: NangoWebhookEvent;
  /** sha256(rawBody) — webhookId. */
  webhookId: string;
}

export async function verifyAndParseWebhook(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  opts: VerifyOptions
): Promise<VerifyResult> {
  const sigHeader = lookupHeader(headers, HEADER_HMAC);

  const valid =
    verifyHmac(rawBody, sigHeader, opts.secret) ||
    (opts.secretNext ? verifyHmac(rawBody, sigHeader, opts.secretNext) : false);

  if (!valid) {
    throw new GatewayError("invalid_signature", "Webhook HMAC verification failed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new GatewayError("invalid_payload", "Webhook body is not valid JSON");
  }

  const result = NangoWebhookEventSchema.safeParse(parsed);
  if (!result.success) {
    throw new GatewayError("invalid_payload", `Webhook payload failed schema: ${result.error.message}`);
  }

  // Optional freshness check for sync events that carry startedAt.
  if (result.data.type === "sync" && result.data.startedAt) {
    const window = opts.freshnessWindowMs ?? 5 * 60 * 1000;
    const startedMs = Date.parse(result.data.startedAt);
    const now = opts.nowMs ? opts.nowMs() : Date.now();
    if (Number.isFinite(startedMs) && now - startedMs > window) {
      throw new GatewayError(
        "invalid_payload",
        `Webhook is older than freshness window (${window}ms)`
      );
    }
  }

  return {
    event: result.data,
    webhookId: sha256Hex(rawBody)
  };
}
