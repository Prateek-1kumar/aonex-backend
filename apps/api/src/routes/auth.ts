// /api/auth/{login,refresh,logout}. Phase 1 single-tenant-style
// signup outside scope — assume merchants seeded by admin tooling.
// LLD §4 surface 1.

import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { schema, type DrizzleClient } from "@aonex/db";
import type { JwtService } from "../services/jwt.js";
import type { Clock } from "@aonex/lib-utils";

export interface AuthDeps {
  db: DrizzleClient;
  jwt: JwtService;
  clock: Clock;
  verifyPassword: (plain: string, hashed: string) => Promise<boolean>;
  /** true in production (HTTPS). false for local dev (HTTP). */
  cookieSecure: boolean;
}

const COOKIE_NAME = "aonex_token";
const COOKIE_TTL_SECONDS = 60 * 60;

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
    const expiresAt = new Date(deps.clock.nowMs() + COOKIE_TTL_SECONDS * 1000);
    await deps.db.insert(schema.merchantSessions).values({
      jti,
      merchantId: merchant.id,
      expiresAt,
    });

    const token = await deps.jwt.issue({
      jti,
      sub: merchant.id,
      tenant: merchant.tenantId,
      roles: ["operator"],
    });

    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      maxAge: COOKIE_TTL_SECONDS,
      secure: deps.cookieSecure,
    });

    return c.json({ data: { token, expiresAt: expiresAt.toISOString() } });
  });

  app.post("/refresh", async (c) => {
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) return c.json({ error: { code: "UNAUTHENTICATED" } }, 401);
    const claims = await deps.jwt.verify(auth.slice("Bearer ".length).trim());
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
    const newJti = randomBytes(32).toString("hex");
    const expiresAt = new Date(deps.clock.nowMs() + COOKIE_TTL_SECONDS * 1000);
    await deps.db.insert(schema.merchantSessions).values({
      jti: newJti,
      merchantId: claims.sub,
      expiresAt,
    });
    await deps.db
      .update(schema.merchantSessions)
      .set({ revokedAt: deps.clock.now() })
      .where(eq(schema.merchantSessions.jti, claims.jti));
    const token = await deps.jwt.issue({
      jti: newJti,
      sub: claims.sub,
      tenant: claims.tenant,
      roles: claims.roles,
    });

    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      maxAge: COOKIE_TTL_SECONDS,
      secure: deps.cookieSecure,
    });

    return c.json({ data: { token, expiresAt: expiresAt.toISOString() } });
  });

  app.get("/me", async (c) => {
    // Accept Bearer token OR httpOnly cookie so both email-login and
    // Google OAuth flows (which only set a cookie) work without extra steps.
    const auth = c.req.header("authorization");
    let token: string | undefined;
    if (auth?.startsWith("Bearer ")) {
      token = auth.slice("Bearer ".length).trim();
    } else {
      token = getCookie(c, COOKIE_NAME);
    }
    if (!token) return c.json({ error: { code: "UNAUTHENTICATED", message: "Not authenticated" } }, 401);

    let claims: Awaited<ReturnType<typeof deps.jwt.verify>>;
    try {
      claims = await deps.jwt.verify(token);
    } catch {
      return c.json({ error: { code: "UNAUTHENTICATED", message: "Invalid or expired token" } }, 401);
    }

    const [merchantRow] = await deps.db
      .select({
        id: schema.merchants.id,
        email: schema.merchants.email,
        displayName: schema.merchants.displayName,
        tenantId: schema.merchants.tenantId,
      })
      .from(schema.merchants)
      .where(eq(schema.merchants.id, claims.sub))
      .limit(1);

    if (!merchantRow) return c.json({ error: { code: "NOT_FOUND", message: "Merchant not found" } }, 404);

    const [tenantRow] = await deps.db
      .select({ name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, merchantRow.tenantId))
      .limit(1);

    return c.json({
      data: {
        id: merchantRow.id,
        email: merchantRow.email,
        displayName: merchantRow.displayName,
        role: claims.roles[0] ?? "member",
        tenantName: tenantRow?.name ?? "",
      },
    });
  });

  app.post("/logout", async (c) => {
    const auth = c.req.header("authorization");
    if (auth?.startsWith("Bearer ")) {
      try {
        const claims = await deps.jwt.verify(auth.slice("Bearer ".length).trim());
        await deps.db
          .update(schema.merchantSessions)
          .set({ revokedAt: deps.clock.now() })
          .where(eq(schema.merchantSessions.jti, claims.jti));
      } catch {
        // already invalid — logout is idempotent
      }
    }
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.json({ data: { ok: true } });
  });

  return app;
}
