// Reconciler internals shared between sync.ts and async-debounced.ts.
//
// Both tiers (low-frequency sync attributes; debounced async pricing/inventory)
// run the same projection algorithm under the hood — pure `pickWinner` from
// `pick-winner.ts` — but they share a couple of glue helpers that aren't worth
// duplicating: a deep-equality check for JSONB winning-value comparison, and
// the SELECT against `source_priority` that loads the rules pinned for the
// current tenant + attribute.
//
// Intentionally NOT exported from the package barrel (`src/index.ts`). These
// are reconciler-internal — leading underscore on the filename signals "do
// not import from outside this folder".

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { SourcePriorityRule } from "./pick-winner.js";

/**
 * Deep-equal for the projected JSONB shapes — handles arrays, plain objects,
 * and primitives. Sufficient for `winning_values` leaves which are bounded
 * JSON (no functions, no symbols, no Dates — observedAt is ISO string).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrB = b as unknown[];
    if (a.length !== arrB.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], arrB[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const ka = Object.keys(objA);
  const kb = Object.keys(objB);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

/**
 * Load active `source_priority` rules for the given tenant + attribute codes.
 * A rule applies when:
 *   - `effective_to` IS NULL (still active),
 *   - `tenant_id` is NULL (global) OR matches `tenantId`,
 *   - `attribute_code` is NULL (all attrs) OR appears in `attributeCodes`.
 *
 * Returns `[]` if `attributeCodes` is empty (no work to do).
 */
export async function loadActiveRules(
  tx: DrizzleClient,
  tenantId: string,
  attributeCodes: string[]
): Promise<SourcePriorityRule[]> {
  if (attributeCodes.length === 0) return [];
  const attributeFilter =
    attributeCodes.length === 1
      ? eq(schema.sourcePriority.attributeCode, attributeCodes[0]!)
      : inArray(schema.sourcePriority.attributeCode, attributeCodes);

  const rows = await tx
    .select({
      ruleId: schema.sourcePriority.ruleId,
      attributeCode: schema.sourcePriority.attributeCode,
      sourceGlob: schema.sourcePriority.sourceGlob,
      channelScope: schema.sourcePriority.channelScope,
      priority: schema.sourcePriority.priority
    })
    .from(schema.sourcePriority)
    .where(
      and(
        isNull(schema.sourcePriority.effectiveTo),
        or(
          isNull(schema.sourcePriority.tenantId),
          eq(schema.sourcePriority.tenantId, tenantId)
        ),
        or(isNull(schema.sourcePriority.attributeCode), attributeFilter)
      )
    );
  return rows.map((r) => ({
    ruleId: r.ruleId,
    attributeCode: r.attributeCode,
    sourceGlob: r.sourceGlob,
    channelScope: r.channelScope,
    priority: r.priority
  }));
}
