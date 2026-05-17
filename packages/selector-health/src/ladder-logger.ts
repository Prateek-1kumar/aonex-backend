import type { AuditEmitter } from "@aonex/audit";
import type { TenantId } from "@aonex/types";

/**
 * Spec §6.7 / §14.5 — extraction-pack ladder rungs.
 * Used by selector-health-scan cron to detect "silent LLM-rescue" patterns:
 * if a normally-strong rung's share drops and LLM-rescue rate spikes,
 * something broke on that rung.
 */
export type LadderRung =
  | "json_ld"
  | "microdata"
  | "opengraph"
  | "nuxt"
  | "next_data"
  | "initial_state"
  | "shopify_probe"
  | "shopify_products_json"
  | "magento"
  | "woocommerce"
  | "algolia"
  | "rdfa"
  | "breadcrumb_list"
  | "dom_heuristic"
  | "per_site_parser"
  | "llm_gap_fill"
  | "vision_llm";

export interface LadderRungInput {
  audit: AuditEmitter;
  field: string;
  rung: LadderRung;
  domain: string;
  parserVersion: string;
  tenantId: TenantId;
}

/**
 * Log which rung produced a given field. One event per fact per ingestion;
 * ~10-50 events per ingestion at steady state. Phase 8 dashboards aggregate
 * by (domain × field × rung).
 */
export async function recordLadderRung(input: LadderRungInput): Promise<void> {
  await input.audit.emit({
    tenantId: input.tenantId,
    actorType: "worker",
    eventType: "ladder.rung_fired",
    entityType: "field",
    entityId: input.field,
    metadata: {
      rung: input.rung,
      domain: input.domain,
      parserVersion: input.parserVersion
    }
  });
}
