import { describe, it, expect } from "bun:test";
import { authRoutes } from "./auth.js";

const mockMerchant = {
  id: "merchant-1",
  tenantId: "tenant-1",
  email: "dev@example.com",
  passwordHash: "password123",
};

const mockSession = {
  jti: "old-jti",
  merchantId: "merchant-1",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  revokedAt: null,
};

function makeMockDb(opts: { merchant?: typeof mockMerchant; session?: typeof mockSession } = {}) {
  const { merchant = mockMerchant, session = mockSession } = opts;
  let selectCallCount = 0;
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => {
            selectCallCount++;
            // First select in login/refresh is merchants, second is merchantSessions
            // Distinguish by selectCallCount within a single request
            // For refresh: first call is merchantSessions lookup
            // We use a simple heuristic: if session is provided and this looks like a session query, return session
            if (session && selectCallCount % 2 === 1 && merchant === mockMerchant) {
              // Could be either — return merchant for login flow, session for refresh flow
              // The refresh test overrides merchant to null to force session-only path
              return Promise.resolve(merchant ? [merchant] : [session]);
            }
            return Promise.resolve([session]);
          },
        }),
      }),
    }),
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as any;
}

const mockDeps = {
  db: makeMockDb(),
  jwt: {
    issue: async () => "mock.jwt.token",
    verify: async () => ({
      sub: "merchant-1",
      tenant: "tenant-1",
      jti: "old-jti",
      roles: ["operator"] as const,
    }),
  },
  clock: { now: () => new Date(), nowMs: () => Date.now() },
  verifyPassword: async (plain: string, hashed: string) => plain === hashed,
  cookieSecure: false,
};

// Deps specifically for the refresh test: merchant lookup not needed, session lookup returns mockSession
const refreshDeps = {
  ...mockDeps,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([mockSession]),
        }),
      }),
    }),
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as any,
};

describe("authRoutes cookies", () => {
  it("POST /login sets aonex_token httpOnly cookie", async () => {
    const app = authRoutes(mockDeps);
    const res = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dev@example.com", password: "password123" }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("aonex_token=");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
  });

  it("POST /refresh sets aonex_token httpOnly cookie with rotated token", async () => {
    const app = authRoutes(refreshDeps);
    const res = await app.request("/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mock.jwt.token",
      },
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("aonex_token=");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    const body = await res.json() as { data: { token: string; expiresAt: string } };
    expect(body.data.token).toBe("mock.jwt.token");
  });

  it("POST /logout clears aonex_token cookie", async () => {
    const app = authRoutes(mockDeps);
    const res = await app.request("/logout", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mock.jwt.token",
      },
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("aonex_token=;");
    expect(cookie.toLowerCase()).toMatch(/max-age=0|expires=.*1970/);
  });

  it("POST /login returns 401 on wrong password", async () => {
    const app = authRoutes(mockDeps);
    const res = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dev@example.com", password: "wrong" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
