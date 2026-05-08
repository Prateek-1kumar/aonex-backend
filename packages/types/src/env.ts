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

  // JWT — HS256, ≥32 bytes
  JWT_SECRET: z.string().min(32),

  // Observability
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional()
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse process.env into a typed Env. Call once at the top of the
 * composition root. Throws ZodError with the failing keys on bad config.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
