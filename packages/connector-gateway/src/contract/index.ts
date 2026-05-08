// HLD §17 — the union ConnectorAdapter type. Adapters implement
// the three sub-interfaces; the composition root passes the union
// to consumers that need everything (the API gateway).

import type { IConnectorAdmin } from "./admin.js";
import type { IConnectorRead } from "./read.js";
import type { IConnectorWrite } from "./write.js";
import type { IWebhookVerifier } from "./webhook.js";

export * from "./records.js";
export * from "./connection.js";
export * from "./read.js";
export * from "./write.js";
export * from "./admin.js";
export * from "./webhook.js";

/**
 * Full HLD §17 ConnectorAdapter shape — read + admin + webhook
 * are Phase 1 contracts; write is Phase 5+.
 */
export interface ConnectorAdapter
  extends IConnectorRead,
    IConnectorAdmin,
    IWebhookVerifier,
    IConnectorWrite {}

/** Phase 1 narrowed surface. */
export interface ConnectorAdapterPhase1
  extends IConnectorRead,
    IConnectorAdmin,
    IWebhookVerifier {}
