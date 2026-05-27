// Shared Hono environment type for the API.
//
// These context variables are populated by middleware:
//   - middleware/auth.ts sets merchantId, tenantId, jti, roles
//   - middleware/request-id.ts sets requestId
//
// Route apps that read them via `c.get(...)` should be typed with this env
// (`new Hono<AppEnv>()`) so the keys are known and the values are typed.

export type AppRole = "admin" | "operator" | "reviewer" | "analyst" | "auditor";

export interface AppEnv {
  Variables: {
    merchantId: string;
    tenantId: string;
    jti: string;
    roles: AppRole[];
    requestId: string;
  };
}
