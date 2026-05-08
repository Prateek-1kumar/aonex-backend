// ============================================================
// THIS IS THE ONLY FILE IN THE WHOLE MONOREPO THAT IMPORTS
// @nangohq/node. Verified by ESLint `no-restricted-imports` and
// dependency-cruiser `nango-only-in-gateway` rule.
//
// HLD §17: "The Connector Gateway is the only boundary between
// product services and external integration vendors."
// LLD I1: zero direct coupling.
// ============================================================

// eslint-disable-next-line no-restricted-imports
import { Nango } from "@nangohq/node";

export type NangoClient = Nango;

export function createNangoClient(opts: { secretKey: string; host: string }): NangoClient {
  return new Nango({
    secretKey: opts.secretKey,
    host: opts.host
  });
}
