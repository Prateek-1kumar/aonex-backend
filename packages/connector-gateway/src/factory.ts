// Gateway factory — composition-root callers select implementation
// via env. The self-host vs cloud switch is a single env var.

import type { Env } from "@aonex/types";
import type { ConnectorAdapterPhase1 } from "./contract/index.js";
import { createNangoClient } from "./adapters/nango/client.js";
import {
  NangoConnectorAdapter,
  type ConnectionLookupPort
} from "./adapters/nango/adapter.js";
import { MockConnectorAdapter } from "./adapters/mock/adapter.js";

export interface BuildGatewayDeps {
  env: Env;
  /** Real impl in api/worker; in-memory impl in tests. */
  lookup: ConnectionLookupPort;
}

export function buildGateway(deps: BuildGatewayDeps): ConnectorAdapterPhase1 {
  if (deps.env.NODE_ENV === "test") {
    return new MockConnectorAdapter({ webhookSecret: deps.env.NANGO_WEBHOOK_SECRET });
  }
  const client = createNangoClient({
    secretKey: deps.env.NANGO_SECRET_KEY,
    host: deps.env.NANGO_HOST
  });
  return new NangoConnectorAdapter({
    client,
    lookup: deps.lookup,
    webhookSecret: deps.env.NANGO_WEBHOOK_SECRET,
    ...(deps.env.NANGO_WEBHOOK_SECRET_NEXT
      ? { webhookSecretNext: deps.env.NANGO_WEBHOOK_SECRET_NEXT }
      : {})
  });
}
