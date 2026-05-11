import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { schema, type DrizzleClient } from "@aonex/db";
import type { JwtService } from "../services/jwt.js";
import type { Clock } from "@aonex/lib-utils";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleAuthDeps {
  db: DrizzleClient;
  jwt: JwtService;
  clock: Clock;
  googleConfig: GoogleConfig;
  pendingSecret: string;
  cookieSecure: boolean;
  frontendUrl: string;
}

const COOKIE_NAME = "aonex_token";
const STATE_COOKIE = "google_oauth_state";
const COOKIE_TTL_SECONDS = 60 * 60;
const PENDING_TTL_SECONDS = 60 * 10;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const GoogleTokenResponse = z.object({ access_token: z.string() });
const GoogleUserInfo = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

const PendingPayload = z.object({
  type: z.literal("google_pending"),
  email: z.string().email(),
  displayName: z.string(),
});

const CompleteBody = z.object({
  tenantName: z.string().min(1).max(200),
  pendingToken: z.string().min(1),
});

export function googleAuthRoutes(deps: GoogleAuthDeps): Hono {
  const app = new Hono();
  const pendingKey = new TextEncoder().encode(deps.pendingSecret);
  const { googleConfig, frontendUrl, cookieSecure } = deps;

  app.get("/google", (c) => {
    const state = randomBytes(16).toString("hex");
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      maxAge: PENDING_TTL_SECONDS,
      secure: cookieSecure,
    });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", googleConfig.clientId);
    url.searchParams.set("redirect_uri", googleConfig.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");

    return c.redirect(url.toString());
  });

  app.get("/google/callback", async (c) => {
    const fail = (reason: string) =>
      c.redirect(`${frontendUrl}/login?error=${encodeURIComponent(reason)}`);

    const { code, state, error } = c.req.query();
    if (error || !code || !state) return fail("google_denied");

    const storedState = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    if (!storedState || storedState !== state) return fail("state_mismatch");

    // Exchange code for access token
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: googleConfig.clientId,
        client_secret: googleConfig.clientSecret,
        redirect_uri: googleConfig.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokenParsed = GoogleTokenResponse.safeParse(await tokenRes.json());
    if (!tokenParsed.success) return fail("google_token_failed");

    // Fetch user info
    const userInfoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenParsed.data.access_token}` },
    });
    const userInfoParsed = GoogleUserInfo.safeParse(await userInfoRes.json());
    if (!userInfoParsed.success) return fail("google_userinfo_failed");

    const { email, name } = userInfoParsed.data;
    const displayName = name ?? email.split("@")[0]!;

    // Existing merchant → log them in
    const [merchant] = await deps.db
      .select()
      .from(schema.merchants)
      .where(eq(schema.merchants.email, email))
      .limit(1);

    if (merchant) {
      const jti = randomBytes(32).toString("hex");
      const expiresAt = new Date(deps.clock.nowMs() + COOKIE_TTL_SECONDS * 1000);
      await deps.db.insert(schema.merchantSessions).values({ jti, merchantId: merchant.id, expiresAt });
      const token = await deps.jwt.issue({ jti, sub: merchant.id, tenant: merchant.tenantId, roles: ["admin"] });
      setCookie(c, COOKIE_NAME, token, {
        httpOnly: true, path: "/", sameSite: "Lax", maxAge: COOKIE_TTL_SECONDS, secure: cookieSecure,
      });
      return c.redirect(`${frontendUrl}/connections`);
    }

    // New user → issue pending token, send to workspace-naming screen
    const iat = Math.floor(deps.clock.nowMs() / 1000);
    const pendingToken = await new SignJWT({ type: "google_pending", email, displayName })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(iat)
      .setExpirationTime(iat + PENDING_TTL_SECONDS)
      .sign(pendingKey);

    return c.redirect(`${frontendUrl}/signup/workspace?token=${encodeURIComponent(pendingToken)}`);
  });

  app.post("/google/complete", async (c) => {
    const body = CompleteBody.parse(await c.req.json());

    let pending: z.infer<typeof PendingPayload>;
    try {
      const { payload } = await jwtVerify(body.pendingToken, pendingKey, { algorithms: ["HS256"] });
      pending = PendingPayload.parse(payload);
    } catch {
      return c.json({ error: { code: "INVALID_PENDING_TOKEN", message: "Token expired or invalid" } }, 401);
    }

    const existing = await deps.db
      .select({ id: schema.merchants.id })
      .from(schema.merchants)
      .where(eq(schema.merchants.email, pending.email))
      .limit(1);

    if (existing[0]) {
      return c.json({ error: { code: "EMAIL_TAKEN", message: "Email already registered" } }, 409);
    }

    const { tenant, merchant } = await deps.db.transaction(async (tx) => {
      const [tenant] = await tx.insert(schema.tenants).values({ name: body.tenantName }).returning();
      const [merchant] = await tx.insert(schema.merchants).values({
        tenantId: tenant!.id,
        email: pending.email,
        passwordHash: "",
        displayName: pending.displayName,
      }).returning();
      return { tenant: tenant!, merchant: merchant! };
    });

    const jti = randomBytes(32).toString("hex");
    const expiresAt = new Date(deps.clock.nowMs() + COOKIE_TTL_SECONDS * 1000);
    await deps.db.insert(schema.merchantSessions).values({ jti, merchantId: merchant.id, expiresAt });

    const token = await deps.jwt.issue({ jti, sub: merchant.id, tenant: tenant.id, roles: ["admin"] });
    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true, path: "/", sameSite: "Lax", maxAge: COOKIE_TTL_SECONDS, secure: cookieSecure,
    });

    return c.json({ data: { token, expiresAt: expiresAt.toISOString() } }, 201);
  });

  return app;
}
