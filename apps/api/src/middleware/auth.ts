// JWT auth middleware — derives merchantId + tenantId from the
// JWT (NEVER from the request body — Appendix B security).

import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { JwtService } from "../services/jwt.js";

export function authMiddleware(jwt: JwtService): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : getCookie(c, "aonex_token");
    if (!token) {
      return c.json({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token" } }, 401);
    }
    try {
      const claims = await jwt.verify(token);
      c.set("merchantId", claims.sub);
      c.set("tenantId", claims.tenant);
      c.set("jti", claims.jti);
      c.set("roles", claims.roles);
    } catch {
      return c.json({ error: { code: "UNAUTHENTICATED", message: "Invalid or expired token" } }, 401);
    }
    await next();
  };
}
