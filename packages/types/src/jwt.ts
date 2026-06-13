// HS256 JWT claims carried wherever a merchant identity travels.

import { z } from "zod";

export const AonexJWTClaimsSchema = z.object({
  /** JWT ID, used for revocation (merchant_sessions.jti). */
  jti: z.string().min(1),
  /** Merchant UUID. */
  sub: z.string().uuid(),
  /** Tenant UUID; every business operation carries tenant_id. */
  tenant: z.string().uuid(),
  /** Issued-at (seconds). */
  iat: z.number().int().nonnegative(),
  /** Expiry (seconds). */
  exp: z.number().int().nonnegative(),
  /** RBAC roles. */
  roles: z.array(z.enum(["admin", "operator", "reviewer", "analyst", "auditor"])).default([])
});

export type AonexJWTClaims = z.infer<typeof AonexJWTClaimsSchema>;
