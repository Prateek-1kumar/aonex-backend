import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { schema, type DrizzleClient } from "@aonex/db";
import type { JwtService } from "../services/jwt.js";
import type { Clock } from "@aonex/lib-utils";

export interface SignupDeps {
  db: DrizzleClient;
  jwt: JwtService;
  clock: Clock;
  hashPassword: (plain: string) => Promise<string>;
  cookieSecure: boolean;
}

const COOKIE_NAME = "aonex_token";
const COOKIE_TTL_SECONDS = 60 * 60;

const SignupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().min(1).max(200),
  tenantName: z.string().min(1).max(200),
});

export function signupRoutes(deps: SignupDeps): Hono {
  const app = new Hono();

  app.post("/signup", async (c) => {
    const body = SignupBody.parse(await c.req.json());

    const existing = await deps.db
      .select({ id: schema.merchants.id })
      .from(schema.merchants)
      .where(eq(schema.merchants.email, body.email))
      .limit(1);

    if (existing[0]) {
      return c.json({ error: { code: "EMAIL_TAKEN", message: "Email already registered" } }, 409);
    }

    const passwordHash = await deps.hashPassword(body.password);

    const { tenant, merchant } = await deps.db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(schema.tenants)
        .values({ name: body.tenantName })
        .returning();
      const [merchant] = await tx
        .insert(schema.merchants)
        .values({
          tenantId: tenant!.id,
          email: body.email,
          passwordHash,
          displayName: body.displayName,
        })
        .returning();
      return { tenant: tenant!, merchant: merchant! };
    });

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
      tenant: tenant.id,
      roles: ["admin"],
    });

    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      maxAge: COOKIE_TTL_SECONDS,
      secure: deps.cookieSecure,
    });

    return c.json({ data: { token, expiresAt: expiresAt.toISOString() } }, 201);
  });

  return app;
}
