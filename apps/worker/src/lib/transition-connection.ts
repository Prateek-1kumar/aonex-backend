// Connection state machine — LLD §6.1. Direct status updates
// from any other module are forbidden; this helper validates
// and applies the transition + writes audit.
//
// HLD §17: structured connection lifecycle.

import { eq } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import type { Marketplace, MerchantId, TenantId } from "@aonex/types";

type Status = "pending" | "pending_failed" | "active" | "refresh_failing" | "revoked" | "deleted";

const LEGAL_TRANSITIONS: Record<Status, readonly Status[]> = {
  pending: ["active", "pending_failed"],
  pending_failed: ["pending", "deleted"],
  active: ["refresh_failing", "revoked"],
  refresh_failing: ["active", "revoked"],
  revoked: ["deleted"],
  deleted: []
};

export class IllegalTransitionError extends Error {
  constructor(public readonly from: Status, public readonly to: Status) {
    super(`Illegal connection transition ${from} → ${to}`);
  }
}

export interface TransitionInput {
  tenantId: TenantId;
  merchantId: MerchantId;
  marketplace: Marketplace;
  to: Status;
  reason?: string;
  /** Optional metadata stamped on connection. */
  patch?: Partial<{ connectedAt: Date; lastTokenRefreshAt: Date; lastError: string }>;
}

export async function transitionConnectionStatus(
  deps: { db: DrizzleClient; audit: AuditEmitter },
  input: TransitionInput
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.marketplaceConnections)
      .where(eq(schema.marketplaceConnections.merchantId, input.merchantId))
      .for("update");
    const conn = rows.find((r) => r.marketplace === input.marketplace);
    if (!conn) {
      throw new Error(
        `No marketplace_connection for merchant=${input.merchantId} marketplace=${input.marketplace}`
      );
    }
    const legal = LEGAL_TRANSITIONS[conn.status as Status];
    if (!legal.includes(input.to)) {
      throw new IllegalTransitionError(conn.status as Status, input.to);
    }
    await tx
      .update(schema.marketplaceConnections)
      .set({
        status: input.to,
        ...(input.to === "active" && !conn.connectedAt ? { connectedAt: new Date() } : {}),
        ...(input.patch?.connectedAt ? { connectedAt: input.patch.connectedAt } : {}),
        ...(input.patch?.lastTokenRefreshAt
          ? { lastTokenRefreshAt: input.patch.lastTokenRefreshAt }
          : {}),
        ...(input.patch?.lastError ? { lastError: input.patch.lastError } : {}),
        ...(input.to === "revoked" ? { revokedAt: new Date() } : {}),
        updatedAt: new Date()
      })
      .where(eq(schema.marketplaceConnections.id, conn.id));
  });

  await deps.audit.emit({
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    actorType: "worker",
    eventType: `connection.${input.to}`,
    entityType: "marketplace_connection",
    entityId: `${input.merchantId}:${input.marketplace}`,
    metadata: input.reason ? { reason: input.reason } : {}
  });
}
