// Env schema — parsed once at startup (parse-don't-validate at trust
// boundary). HLD §22 / Appendix B: bad config crashes loud.

import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Nango
  NANGO_SECRET_KEY: z.string().min(1),
  NANGO_WEBHOOK_SECRET: z.string().min(1),
  // Optional during quarterly rotation overlap
  NANGO_WEBHOOK_SECRET_NEXT: z.string().min(1).optional(),
  // Cloud unless overridden — the self-host exit ramp is one env var.
  NANGO_HOST: z.string().url().default("https://api.nango.dev"),

  // Token encryption — 64-char hex = 32 bytes AES-256-GCM key
  // Generate with: openssl rand -hex 32
  TOKEN_ENCRYPTION_KEY: z.string().length(64).regex(/^[0-9a-f]+$/, 'must be lowercase hex'),

  // Nango Connect UI base URL — where merchants land to connect their store
  NANGO_CONNECT_BASE_URL: z.string().url().default('https://connect.nango.dev'),

  // JWT — HS256, ≥32 bytes
  JWT_SECRET: z.string().min(32),

  // Google OAuth — optional; server starts without them, but /api/auth/google routes won't be mounted
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  // Frontend origin — used by Google OAuth callback redirect
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),

  // Observability
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional()
  ),

  // LLM Provider Config (supports OpenAI, OpenRouter, Groq, etc.)
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_MODEL: z.string().min(1).optional(),

  // Phase 3 — Groq overrides for LLM extraction + schema drafting.
  // When set, the LLM extractor prefers GROQ_MODEL_GAP_FILL over OPENAI_MODEL,
  // and the (future) classifier path uses GROQ_MODEL_CLASSIFIER (cheaper 8B).
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_BASE_URL: z.string().url().optional(),
  GROQ_MODEL_GAP_FILL: z.string().min(1).optional(),
  GROQ_MODEL_CLASSIFIER: z.string().min(1).optional(),
  GROQ_MODEL_VISION: z.string().min(1).optional(),

  // Phase 6 Layer C — Playwright pool size for browser fallback.
  PLAYWRIGHT_POOL_SIZE: z.coerce.number().int().positive().optional(),

  // Phase 6 Layer D — ScrapingBee anti-bot vendor.
  // Presence flips the unblock layer ON in the link-adapter escalation ladder.
  SCRAPINGBEE_API_KEY: z.string().min(1).optional(),
  // Per-ingestion USD ceiling for paid escalations (default $0.05 in cost-ceiling.ts).
  EXTRACTION_COST_CEILING_USD: z.coerce.number().positive().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse process.env into a typed Env. Call once at the top of the
 * composition root. Throws ZodError with the failing keys on bad config.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
