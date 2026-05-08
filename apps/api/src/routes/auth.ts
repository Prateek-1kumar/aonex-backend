// /api/auth/{login,refresh,logout}. Phase 1 single-tenant-style
// signup outside scope — assume merchants seeded by admin tooling.
// LLD §4 surface 1.

import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID, randomBytes } from "node:crypto";
import { schema, type DrizzleClient } from "@aonex/db";
import type { JwtService } from "../services/jwt.js";
import type { Clock } from "@aonex/lib-utils";

export interface AuthDeps {
  db: DrizzleClient;
  jwt: JwtService;
  clock: Clock;
  /** Pluggable for tests. */
  verifyPassword: (plain: string, hashed: string) => Promise<boolean>;
}

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });

export function authRoutes(deps: AuthDeps): Hono {
  const app = new Hono();

  app.post("/login", async (c) => {
    const body = LoginBody.parse(await c.req.json());

    const merchantRow = await deps.db
      .select()
      .from(schema.merchants)
      .where(eq(schema.merchants.email, body.email))
      .limit(1);
    const merchant = merchantRow[0];
    if (!merchant) {
      return c.json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } }, 401);
    }
    const ok = await deps.verifyPassword(body.password, merchant.passwordHash);
    if (!ok) {
      return c.json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } }, 401);
    }

    const jti = randomBytes(32).toString("hex");
    const expiresAt = new Date(deps.clock.nowMs() + 60 * 60 * 1000);
    await deps.db.insert(schema.merchantSessions).values({
      jti,
      merchantId: merchant.id,
      expiresAt
    });

    const token = await deps.jwt.issue({
      jti,
      sub: merchant.id,
      tenant: merchant.tenantId,
      roles: ["operator"]
    });
    return c.json({ data: { token, expiresAt: expiresAt.toISOString() } });
  });

  app.post("/refresh", async (c) => {
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) return c.json({ error: { code: "UNAUTHENTICATED" } }, 401);
    const claims = await deps.jwt.verify(auth.slice("Bearer ".length).trim());
    // Verify the session is still valid + not revoked.
    const session = await deps.db
      .select()
      .from(schema.merchantSessions)
      .where(
        and(eq(schema.merchantSessions.jti, claims.jti), isNull(schema.merchantSessions.revokedAt))
      )
      .limit(1);
    if (!session[0] || session[0].expiresAt < deps.clock.now()) {
      return c.json({ error: { code: "UNAUTHENTICATED", message: "Session expired" } }, 401);
    }
    // Issue a fresh JWT with a new jti (rotate).
    const newJti = randomBytes(32).toString("hex");
    const expiresAt = new Date(deps.clock.nowMs() + 60 * 60 * 1000);
    await deps.db.insert(schema.merchantSessions).values({
      jti: newJti,
      merchantId: claims.sub,
      expiresAt
    });
    await deps.db
      .update(schema.merchantSessions)
      .set({ revokedAt: deps.clock.now() })
      .where(eq(schema.merchantSessions.jti, claims.jti));
    const token = await deps.jwt.issue({
      jti: newJti,
      sub: claims.sub,
      tenant: claims.tenant,
      roles: claims.roles
    });
    return c.json({ data: { token, expiresAt: expiresAt.toISOString() } });
  });

  app.post("/logout", async (c) => {
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) return c.json({ data: { ok: true } });
    try {
      const claims = await deps.jwt.verify(auth.slice("Bearer ".length).trim());
      await deps.db
        .update(schema.merchantSessions)
        .set({ revokedAt: deps.clock.now() })
        .where(eq(schema.merchantSessions.jti, claims.jti));
    } catch {
      // already invalid — logout is idempotent
    }
    return c.json({ data: { ok: true } });
  });

  return app;
}
