import type { AuditEmitter } from "@aonex/audit";
import type { TenantId } from "@aonex/types";

export interface SelectorFiringInput {
  audit: AuditEmitter;
  selectorId: string;
  domain: string;
  success: boolean;
  parserVersion: string;
  tenantId: TenantId;
}

/**
 * Spec §6.7 + §14.5 — emit one audit event per selector firing.
 * Phase 8's selector-health-scan cron aggregates these into per-(domain × selector)
 * success-rate views. Volume: ~1-5 events per ingestion (one per "rich" parser rung).
 */
export async function recordSelectorFiring(input: SelectorFiringInput): Promise<void> {
  await input.audit.emit({
    tenantId: input.tenantId,
    actorType: "worker",
    eventType: "selector.fired",
    entityType: "selector",
    entityId: input.selectorId,
    metadata: {
      domain: input.domain,
      success: input.success,
      parserVersion: input.parserVersion
    }
  });
}
