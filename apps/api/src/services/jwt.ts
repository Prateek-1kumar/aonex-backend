// JWT service — HS256, jti-based revocation via merchant_sessions.
// LLD §4: HS256 chosen over RS256 (no third-party verifier; faster).
// Composition root constructs with the resolved Env.

import { SignJWT, jwtVerify } from "jose";
import { AonexJWTClaimsSchema, type AonexJWTClaims, type Clock } from "@aonex/types";
import type { Clock as IClock } from "@aonex/lib-utils";

export interface JwtServiceDeps {
  secret: string;
  clock: IClock;
  /** Default 1h per LLD §4. */
  expiresInSeconds?: number;
}

export class JwtService {
  private readonly key: Uint8Array;
  private readonly expiresIn: number;

  constructor(private readonly deps: JwtServiceDeps) {
    this.key = new TextEncoder().encode(deps.secret);
    this.expiresIn = deps.expiresInSeconds ?? 60 * 60;
  }

  async issue(claims: Omit<AonexJWTClaims, "iat" | "exp">): Promise<string> {
    const iat = Math.floor(this.deps.clock.nowMs() / 1000);
    return new SignJWT({ tenant: claims.tenant, roles: claims.roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.sub)
      .setJti(claims.jti)
      .setIssuedAt(iat)
      .setExpirationTime(iat + this.expiresIn)
      .sign(this.key);
  }

  async verify(token: string): Promise<AonexJWTClaims> {
    const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"] });
    return AonexJWTClaimsSchema.parse(payload);
  }
}
