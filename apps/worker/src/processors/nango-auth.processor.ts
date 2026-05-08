// nango.auth queue processor. Handles auth/creation + auth/override
// webhooks from Nango. Activates the connection record and enqueues
// the initial sync.

import { eq } from "drizzle-orm";
import { JOB_KIND, QUEUE, STANDARD_RETRY, type NangoAuthEvent, MerchantId, TenantId } from "@aonex/types";
import type { Job, Queue } from "bullmq";
import { schema, type DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import { fromProviderKey } from "@aonex/connector-gateway";
import { transitionConnectionStatus } from "../lib/transition-connection.js";

export interface NangoAuthProcessorDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
  triggerQueue: Queue;
}

export function makeNangoAuthProcessor(deps: NangoAuthProcessorDeps) {
  return async (job: Job<NangoAuthEvent>) => {
    const event = job.data;
    const marketplace = fromProviderKey(event.providerConfigKey);
    if (!marketplace) {
      // Unknown marketplace — drop with audit, do not retry.
      await deps.audit.emit({
        tenantId: TenantId.unsafeFrom("00000000-0000-0000-0000-000000000000"),
        actorType: "nango",
        eventType: "webhook.unknown_provider",
        metadata: { providerConfigKey: event.providerConfigKey }
      });
      return;
    }

    // Find the merchant from the connection record. The endUserId
    // sent on the Nango webhook is our merchantId (we set it when
    // calling createConnectSession).
    const merchantId = MerchantId.unsafeFrom(
      "endUser" in event && event.endUser?.endUserId ? event.endUser.endUserId : ""
    );

    if (!event.success) {
      // auth failed — record for telemetry, don't retry.
      await deps.audit.emit({
        actorType: "nango",
        tenantId: TenantId.unsafeFrom("00000000-0000-0000-0000-000000000000"),
        merchantId,
        eventType: "connection.auth_failed",
        entityType: "marketplace_connection",
        entityId: `${merchantId}:${marketplace}`,
        metadata: { providerConnectionId: event.connectionId, error: event.error }
      });
      return;
    }

    // Upsert the marketplace_connection. We look up tenantId via merchants.
    const merchant = (
      await deps.db.select().from(schema.merchants).where(eq(schema.merchants.id, merchantId)).limit(1)
    )[0];
    if (!merchant) {
      throw new Error(`Auth webhook for unknown merchant=${merchantId}`);
    }
    const tenantId = TenantId.unsafeFrom(merchant.tenantId);

    await deps.db
      .insert(schema.marketplaceConnections)
      .values({
        tenantId: merchant.tenantId,
        merchantId: merchant.id,
        marketplace,
        provider: "nango",
        providerConnectionId: event.connectionId,
        status: "pending",
        connectedAt: new Date()
      })
      .onConflictDoUpdate({
        target: [schema.marketplaceConnections.merchantId, schema.marketplaceConnections.marketplace],
        set: {
          providerConnectionId: event.connectionId,
          updatedAt: new Date()
        }
      });

    await transitionConnectionStatus(
      { db: deps.db, audit: deps.audit },
      {
        tenantId,
        merchantId,
        marketplace,
        to: "active",
        patch: { connectedAt: new Date() }
      }
    );

    // Enqueue an initial sync — Nango will pull all records on this run.
    await deps.triggerQueue.add(
      JOB_KIND.INITIAL_SYNC,
      { merchantId, marketplace, tenantId },
      {
        jobId: `initial:${merchantId}:${marketplace}`,
        ...STANDARD_RETRY
      }
    );
  };
}

export const PROCESSOR_QUEUE = QUEUE.NANGO_AUTH;
