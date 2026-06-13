// Env schema, parsed once at the composition root (parse-don't-validate at the
// trust boundary): bad config crashes loud rather than failing later.

import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  NANGO_SECRET_KEY: z.string().min(1),
  NANGO_WEBHOOK_SECRET: z.string().min(1),
  NANGO_WEBHOOK_SECRET_NEXT: z.string().min(1).optional(),
  NANGO_HOST: z.string().url().default("https://api.nango.dev"),

  TOKEN_ENCRYPTION_KEY: z.string().length(64).regex(/^[0-9a-f]+$/, 'must be lowercase hex'),

  NANGO_CONNECT_BASE_URL: z.string().url().default('https://connect.nango.dev'),
  EBAY_API_BASE_URL: z.string().url().default('https://api.ebay.com'),

  JWT_SECRET: z.string().min(32),

  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  FRONTEND_URL: z.string().url().default("http://localhost:3000"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional()
  ),

  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_MODEL: z.string().min(1).optional(),

  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_BASE_URL: z.string().url().optional(),
  GROQ_MODEL_GAP_FILL: z.string().min(1).optional(),
  GROQ_MODEL_CLASSIFIER: z.string().min(1).optional(),
  GROQ_MODEL_VISION: z.string().min(1).optional(),

  GROQ_MODEL_ENRICH: z.string().min(1).optional(),
  GROQ_MODEL_FALLBACK: z.string().min(1).optional(),

  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_BASE_URL: z.string().url().optional(),
  GEMINI_MODEL_ENRICH: z.string().min(1).optional(),

  PLAYWRIGHT_POOL_SIZE: z.coerce.number().int().positive().optional(),

  SCRAPINGBEE_API_KEY: z.string().min(1).optional(),
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
