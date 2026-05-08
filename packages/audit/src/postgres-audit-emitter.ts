// Postgres-backed AuditEmitter. Constructed in the composition root.
// HLD §23: required IDs (tenant_id, merchant_id, request_id, trace_id,
// entity_type, entity_id, payload_hash) are first-class columns.
//
// Future hardening (Phase 7): if this insert fails (audit DB down),
// fall back to a local durable queue per HLD §6 — "Audit queue must
// not drop silently." Phase 1 throws and lets the caller decide.

import { schema, type DrizzleClient } from "@aonex/db";
import type { AuditEmitter, AuditEventInput } from "./audit-emitter.js";

export class PostgresAuditEmitter implements AuditEmitter {
  constructor(private readonly db: DrizzleClient) {}

  async emit(event: AuditEventInput): Promise<void> {
    await this.db.insert(schema.auditEvents).values({
      tenantId: event.tenantId,
      merchantId: event.merchantId ?? null,
      actorId: event.actorId ?? null,
      actorType: event.actorType,
      eventType: event.eventType,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
      requestId: event.requestId ?? null,
      traceId: event.traceId ?? null,
      payloadHash: event.payloadHash ?? null,
      metadata: event.metadata ?? {}
    });
  }
}
