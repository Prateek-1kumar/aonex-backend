// Audit Plane (HLD §6) — append-only fact log.
// Every state change emits exactly one audit_event. The audit
// emitter is a port; the Postgres impl is the default; tests
// substitute a Spy.

import type { TenantId, MerchantId } from "@aonex/types";

export type ActorType = "user" | "system" | "policy" | "worker" | "nango";

export interface AuditEventInput {
  tenantId: TenantId;
  merchantId?: MerchantId | null;
  actorId?: string | null;
  actorType: ActorType;
  /** Past tense — connection.created, sync.completed, webhook.received. */
  eventType: string;
  entityType?: string;
  entityId?: string;
  requestId?: string;
  traceId?: string;
  payloadHash?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEmitter {
  emit(event: AuditEventInput): Promise<void>;
}

/**
 * Spy-style emitter for tests. Records calls in-memory.
 * Engineering principles: this is a Spy, not a Mock — we observe
 * post-conditions, we don't program return values.
 */
export class InMemoryAuditEmitter implements AuditEmitter {
  readonly events: AuditEventInput[] = [];
  async emit(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
  reset(): void {
    this.events.length = 0;
  }
}
