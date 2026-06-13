// Barrel for the connector contract: re-exports the sub-interfaces and composes
// them into the full ConnectorAdapter union (and its Phase-1 narrowing).

import type { IConnectorAdmin } from "./admin.js";
import type { IConnectorRead } from "./read.js";
import type { IConnectorWrite } from "./write.js";
import type { IWebhookVerifier } from "./webhook.js";
import type { IConnectorInventory } from "./inventory.js";

export * from "./records.js";
export * from "./connection.js";
export * from "./read.js";
export * from "./write.js";
export * from "./admin.js";
export * from "./webhook.js";
export * from "./inventory.js";
export * from "./provider-adapter.js";

/** Full ConnectorAdapter shape: read + admin + webhook + inventory + write. */
export interface ConnectorAdapter
  extends IConnectorRead,
    IConnectorAdmin,
    IWebhookVerifier,
    IConnectorWrite,
    IConnectorInventory {}

/** ConnectorAdapter without the write surface. */
export interface ConnectorAdapterPhase1
  extends IConnectorRead,
    IConnectorAdmin,
    IWebhookVerifier,
    IConnectorInventory {}
