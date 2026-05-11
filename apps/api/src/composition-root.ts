// Composition Root (Seemann) — the ONE file that hand-wires the
// entire api process. Everywhere else imports ports.
//
// HLD enforcement: this file is exempt from `no-restricted-imports`
// (per .eslintrc) so concrete classes — Pool, IORedis, Nango, Queue —
// may be instantiated here and only here.

import { Hono } from "hono";
import { cors } from "hono/cors";
import IORedis from "ioredis";
import pino from "pino";
import { Queue } from "bullmq";
import { createDb } from "@aonex/db";
import { buildGateway, type ConnectorAdapterPhase1 } from "@aonex/connector-gateway";
import { PostgresAuditEmitter } from "@aonex/audit";
import { parseEnv, QUEUE, type Env } from "@aonex/types";
import { SystemClock } from "@aonex/lib-utils";

import { JwtService } from "./services/jwt.js";
import { PostgresConnectionRegistry } from "./services/connection-registry.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { authRoutes } from "./routes/auth.js";
import { connectionsRoutes } from "./routes/connections.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { syncRoutes } from "./routes/sync.js";
import { healthRoutes } from "./routes/health.js";

export interface ApiContainer {
  app: Hono;
  env: Env;
  shutdown: () => Promise<void>;
}

/** Trivial bcrypt-style verifier. Replaced with @node-rs/bcrypt or argon2 in prod. */
async function defaultVerifyPassword(plain: string, hashed: string): Promise<boolean> {
  // Phase 1 placeholder. The bcrypt/argon2 impl plugs in here without
  // touching auth.ts. KEEP this swappable — it's dependency-injected.
  return plain.length > 0 && hashed.length > 0 && plain === hashed;
}

export function buildContainer(env: Env): ApiContainer {
  const logger = pino({
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        "*.password",
        "*.passwordHash",
        "*.authorization",
        "*.cookie",
        "req.headers.authorization",
        "req.headers.cookie",
        "*.NANGO_SECRET_KEY",
        "*.NANGO_WEBHOOK_SECRET",
        "*.JWT_SECRET"
      ],
      censor: "[REDACTED]"
    }
  });

  const db = createDb(env.DATABASE_URL);
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const connectionRegistry = new PostgresConnectionRegistry(db.client);
  const gateway: ConnectorAdapterPhase1 = buildGateway({ env, lookup: connectionRegistry });
  const audit = new PostgresAuditEmitter(db.client);
  const jwt = new JwtService({ secret: env.JWT_SECRET, clock: SystemClock });

  // BullMQ queues — same redis connection for now.
  const nangoAuthQueue = new Queue(QUEUE.NANGO_AUTH, { connection: redis });
  const nangoSyncQueue = new Queue(QUEUE.NANGO_SYNC, { connection: redis });
  const nangoTriggerQueue = new Queue(QUEUE.NANGO_TRIGGER, { connection: redis });

  // ---- Hono app -------------------------------------------------
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: env.NODE_ENV === "production" ? [] : "http://localhost:3000",
      credentials: true,
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    })
  );
  app.use("*", requestIdMiddleware());
  app.use("*", loggerMiddleware(logger));
  app.onError(errorHandler);

  // Public
  app.route("/", healthRoutes({ pool: db.pool, redis }));
  app.route(
    "/api/auth",
    authRoutes({
      db: db.client,
      jwt,
      clock: SystemClock,
      verifyPassword: defaultVerifyPassword,
      cookieSecure: env.NODE_ENV === "production",
    })
  );
  // Webhooks — public but HMAC-protected, NOT JWT-protected.
  app.route(
    "/webhooks",
    webhookRoutes({
      gateway,
      db: db.client,
      queues: {
        [QUEUE.NANGO_AUTH]: nangoAuthQueue,
        [QUEUE.NANGO_SYNC]: nangoSyncQueue
      }
    })
  );

  // Authenticated
  const protectedApp = new Hono();
  protectedApp.use("*", authMiddleware(jwt));
  protectedApp.route("/connections", connectionsRoutes({ gateway, audit }));
  protectedApp.route(
    "/sync",
    syncRoutes({ queues: { [QUEUE.NANGO_TRIGGER]: nangoTriggerQueue }, audit })
  );
  app.route("/api", protectedApp);

  return {
    app,
    env,
    shutdown: async () => {
      await Promise.all([
        nangoAuthQueue.close(),
        nangoSyncQueue.close(),
        nangoTriggerQueue.close()
      ]);
      await redis.quit();
      await db.close();
    }
  };
}

/** Convenience for `bun run src/index.ts`. */
export function buildContainerFromEnv(): ApiContainer {
  return buildContainer(parseEnv());
}
