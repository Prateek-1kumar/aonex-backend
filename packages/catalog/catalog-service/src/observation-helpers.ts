// Shared observation selectors for the staging gate. Pure, no I/O.
import type { AdapterOutput } from "@aonex/catalog-source-adapters";

/**
 * Latest observation value for an attribute code (max observedAt; on equal
 * timestamps the first-seen wins). The gate only needs presence/value, not
 * "best value" ordering — keep this simpler than the reconciler's pick-winner.
 */
export function latestObservationValue(out: AdapterOutput, attributeCode: string): unknown {
  let latest: { observedAt: Date; value: unknown } | undefined;
  for (const o of out.observations) {
    if (o.attributeCode !== attributeCode) continue;
    if (!latest || o.observedAt > latest.observedAt) latest = o;
  }
  return latest?.value;
}
