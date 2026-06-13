// Invariant I1: the ONLY module in the monorepo that may import @nangohq/node.
// All product code must reach Nango through @aonex/connector-gateway instead;
// enforced by ESLint no-restricted-imports and dependency-cruiser.


import { Nango } from "@nangohq/node";

export type NangoClient = Nango;

export function createNangoClient(opts: { secretKey: string; host: string }): NangoClient {
  return new Nango({
    secretKey: opts.secretKey,
    host: opts.host
  });
}
