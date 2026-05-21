// Catalog redesign — identity update policy gate (plan §3.7, spec §6.1).
//
// Gates updates to `catalog_products.identity.{gtin, mpn, brand, model_number}`
// based on source priority and consecutive-observation requirements.
//
// Per-field rules (spec §6.1):
//   - gtin / mpn        — append-only set, canonical = highest-priority source.
//                         Two disagreeing priority-1 sources → FREEZE +
//                         emit `value_conflict` review_task.
//   - brand / model_number — require 3 consecutive priority-1 observations
//                            matching the new value before update; single
//                            observation never shifts.
//
// Cross-field rules:
//   - identity_strength < 0.7 → FREEZE identity updates (any field).
//   - Frozen products: identity updates blocked; value observations
//     (pricing, inventory, title, ...) continue landing normally. The freeze
//     status is `catalog_products.status='frozen_pending_review'`.
//   - Auto-unfreeze: after 5 consecutive priority-1 observations matching the
//     CURRENT identity value (system has stabilised) the freeze releases. The
//     unfreeze itself appends an identity_log row.
//
// Design decisions:
//   1. "Priority-1 observation" = the observation's source matches a
//      source_priority rule (active, tenant or global, for this attribute_code
//      or null=all) whose priority value is 1. We reuse
//      reconciler/_internal.loadActiveRules and reconciler/pick-winner's
//      globMatch — same source-priority semantics as the reconciler.
//   2. The auto-unfreeze counter starts from after the most-recent freeze
//      row in identity_log (rationale starts with `freeze`). Counting all
//      historical matching observations would let a long-quiet product
//      unfreeze on stale data; counting from the freeze ensures the unfreeze
//      reflects fresh agreement.
//   3. Single-priority-1 update for gtin/mpn: if the field is currently null
//      (or matches the new value) we apply on a single priority-1 observation.
//      If the field is set to a DIFFERENT value AND another priority-1
//      observation in `values.{field}._unscoped._unscoped[]` disagrees with
//      the incoming, we freeze.
//   4. The function takes a `DrizzleClient` and runs in its own transaction.
//      When called from catalog-write.ts the transaction is the parent's
//      (passed as `tx as unknown as DrizzleClient` per established convention)
//      — Drizzle's nested-transaction semantics save-point safely.
//   5. Per-tenant alerting (spec §6.1) — for v1 we emit a single console.warn
//      per freeze. Observability wiring lands in Phase 5.

import { and, desc, eq, isNotNull } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import { loadActiveRules } from "./reconciler/_internal.js";
import { globMatch, type SourcePriorityRule } from "./reconciler/pick-winner.js";

// ---- Public types ----------------------------------------------------------

export type IdentityField = "gtin" | "mpn" | "brand" | "model_number";

export interface ApplyIdentityObservationInput {
  db: DrizzleClient;
  productId: string;
  field: IdentityField;
  proposedValue: string;
  source: string;
  sourceRecordId: string;
  observedAt: Date;
}

export interface ApplyIdentityObservationResult {
  applied: boolean;
  frozen: boolean;
  identityLogId?: number;
  reviewTaskId?: string;
}

// ---- Internal shapes -------------------------------------------------------

/** Constants matching spec §6.1. */
const STRENGTH_FREEZE_THRESHOLD = 0.7;
const BRAND_CONSECUTIVE_REQUIRED = 3;
const AUTO_UNFREEZE_CONSECUTIVE = 5;
const FROZEN_STATUS = "frozen_pending_review";
const ACTIVE_STATUS = "active";

interface StoredObservation {
  source: string;
  source_record_id: string;
  value: unknown;
  confidence: number;
  observed_at: string;
}

type ValuesJson = Record<
  string,
  Record<string, Record<string, StoredObservation[]>>
>;

// ---- Helpers ---------------------------------------------------------------

/**
 * Find the BEST matching rule's priority for (attributeCode, source). Returns
 * null when no rule matches at all (treat as not-priority-1). Mirrors
 * pick-winner's rule-match semantics (channelScope=null matches any channel,
 * and rules with attributeCode=null apply universally).
 *
 * Identity observations are channel-agnostic (`_unscoped` in the values
 * JSONB), so we use an empty channel for matching — any rule with a
 * channelScope glob that does NOT match an empty string will be filtered out,
 * which is fine: identity rules in practice should have channelScope=null.
 */
function bestRulePriority(
  rules: SourcePriorityRule[],
  field: IdentityField,
  source: string
): number | null {
  const applicable = rules.filter(
    (r) => r.attributeCode === null || r.attributeCode === field
  );
  const matching = applicable.filter((r) => {
    if (!globMatch(r.sourceGlob, source)) return false;
    // Identity observations have no channel — only rules with a null scope
    // (or a wildcard "*") qualify. We treat "*" globs as universal-channel
    // for consistency with pick-winner.
    if (r.channelScope !== null && r.channelScope !== "*") return false;
    return true;
  });
  if (matching.length === 0) return null;
  matching.sort((a, b) => a.priority - b.priority);
  return matching[0]!.priority;
}

function isPriorityOne(
  rules: SourcePriorityRule[],
  field: IdentityField,
  source: string
): boolean {
  const p = bestRulePriority(rules, field, source);
  return p !== null && p === 1;
}

/** Read existing observations from `values.{field}._unscoped._unscoped[]`. */
function readFieldObservations(
  values: ValuesJson,
  field: IdentityField
): StoredObservation[] {
  const leaf = values?.[field]?._unscoped?._unscoped;
  if (!Array.isArray(leaf)) return [];
  return leaf;
}

/**
 * Count consecutive priority-1 observations matching `proposedValue` walking
 * newest-first. Stops at the first non-matching observation (consecutive is
 * by recency, not total). Non-priority-1 observations are skipped silently —
 * they neither break the streak nor count toward it (the spec is about
 * priority-1 consensus, lower-priority signals are noise here).
 */
function countConsecutiveMatching(
  observations: StoredObservation[],
  rules: SourcePriorityRule[],
  field: IdentityField,
  matchValue: string
): number {
  const sorted = [...observations].sort(
    (a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at)
  );
  let count = 0;
  for (const obs of sorted) {
    if (!isPriorityOne(rules, field, obs.source)) continue;
    if (typeof obs.value !== "string") {
      // Non-string identity values are malformed; treat as non-matching.
      break;
    }
    if (obs.value !== matchValue) break;
    count++;
  }
  return count;
}

/**
 * Detect if there is a DIFFERENT priority-1 observation already on record
 * for this field — used to flag a gtin/mpn disagreement with the incoming
 * priority-1 observation. Returns the conflicting value (string) or null.
 */
function findConflictingPriorityOne(
  observations: StoredObservation[],
  rules: SourcePriorityRule[],
  field: IdentityField,
  incomingValue: string
): { value: string; source: string } | null {
  for (const obs of observations) {
    if (!isPriorityOne(rules, field, obs.source)) continue;
    if (typeof obs.value !== "string") continue;
    if (obs.value !== incomingValue) {
      return { value: obs.value, source: obs.source };
    }
  }
  return null;
}

/**
 * Find the applied_at of the most recent freeze identity_log row for this
 * product+field. Returns null if no prior freeze.
 */
async function lastFreezeAppliedAt(
  tx: DrizzleClient,
  productId: string,
  field: IdentityField
): Promise<Date | null> {
  const rows = await tx
    .select({
      appliedAt: schema.identityLog.appliedAt,
      rationale: schema.identityLog.rationale
    })
    .from(schema.identityLog)
    .where(
      and(
        eq(schema.identityLog.productId, productId),
        eq(schema.identityLog.identityField, field),
        isNotNull(schema.identityLog.rationale)
      )
    )
    .orderBy(desc(schema.identityLog.appliedAt))
    .limit(20);
  for (const r of rows) {
    if (r.rationale && r.rationale.startsWith("freeze")) {
      return r.appliedAt;
    }
  }
  return null;
}

/**
 * Auto-unfreeze check: count priority-1 observations of `field` whose value
 * matches `currentValue` and were observed AFTER the last freeze's
 * applied_at. If ≥5, unfreeze and append the unfreeze log row. Returns true
 * when unfrozen here, false otherwise.
 */
async function tryAutoUnfreeze(
  tx: DrizzleClient,
  productId: string,
  tenantId: string,
  field: IdentityField,
  currentValue: string | null,
  observations: StoredObservation[],
  rules: SourcePriorityRule[],
  incoming: { source: string; sourceRecordId: string; observedAt: Date }
): Promise<boolean> {
  if (currentValue === null) return false;

  const freezeAt = await lastFreezeAppliedAt(tx, productId, field);

  // Count matching priority-1 observations observed AFTER the freeze cut-off.
  // Including the incoming observation by adding 1 if it qualifies — the
  // incoming hasn't been written to `values` yet at the time this is called
  // from catalog-write's attach branch.
  let count = 0;
  for (const obs of observations) {
    if (freezeAt && Date.parse(obs.observed_at) <= freezeAt.getTime()) continue;
    if (!isPriorityOne(rules, field, obs.source)) continue;
    if (typeof obs.value !== "string") continue;
    if (obs.value === currentValue) count++;
  }
  // Add the incoming observation if it matches and is priority-1. We do not
  // double-count: catalog-write may or may not have already pushed it; this
  // function is the source of truth for the count and is called by tests
  // that DON'T push to values, so we must add 1 here. The duplicate-count
  // risk is bounded by `>= AUTO_UNFREEZE_CONSECUTIVE` being a strict
  // threshold — an extra count only ever triggers unfreeze faster, which is
  // acceptable for the rare case where catalog-write pre-writes.
  if (
    isPriorityOne(rules, field, incoming.source) &&
    currentValue !== null
  ) {
    // Only add 1 if no existing observation has this source_record_id (would
    // mean catalog-write already pushed it).
    const alreadyPushed = observations.some(
      (o) =>
        o.source === incoming.source &&
        o.source_record_id === incoming.sourceRecordId
    );
    if (!alreadyPushed) count++;
  }

  if (count < AUTO_UNFREEZE_CONSECUTIVE) return false;

  await tx
    .update(schema.catalogProducts)
    .set({ status: ACTIVE_STATUS })
    .where(eq(schema.catalogProducts.productId, productId));

  await tx.insert(schema.identityLog).values({
    productId,
    tenantId,
    identityField: field,
    oldValue: currentValue,
    newValue: currentValue,
    source: incoming.source,
    sourceRecordId: incoming.sourceRecordId,
    observedAt: incoming.observedAt,
    rationale: "auto_unfrozen_after_consistent_signal"
  });
  return true;
}

// ---- Public API ------------------------------------------------------------

/**
 * Apply an identity observation through the policy gate. Returns whether the
 * observation was applied to `catalog_products.identity` and whether the
 * product was frozen as a result. Always runs in a transaction. Side-effects
 * (status update, identity_log insert, review_task insert) commit atomically.
 */
export async function applyIdentityObservation(
  input: ApplyIdentityObservationInput
): Promise<ApplyIdentityObservationResult> {
  const {
    db,
    productId,
    field,
    proposedValue,
    source,
    sourceRecordId,
    observedAt
  } = input;

  return db.transaction(async (tx) => {
    // 1. Load product row.
    const rows = await tx
      .select({
        productId: schema.catalogProducts.productId,
        tenantId: schema.catalogProducts.tenantId,
        merchantId: schema.catalogProducts.merchantId,
        identity: schema.catalogProducts.identity,
        status: schema.catalogProducts.status,
        values: schema.catalogProducts.values
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new Error(
        `applyIdentityObservation: product ${productId} not found`
      );
    }
    const tenantId = row.tenantId;
    const merchantId = row.merchantId;
    const identity = (row.identity ?? {}) as Record<string, unknown>;
    const currentValue =
      typeof identity[field] === "string"
        ? (identity[field] as string)
        : null;
    const strength = Number(
      (identity.identity_strength as number | undefined) ?? 0
    );
    const values = (row.values ?? {}) as ValuesJson;
    const fieldObservations = readFieldObservations(values, field);

    // 2. Load active source_priority rules for this field. Using the same
    //    helper as the reconciler so semantics are aligned.
    const rules = await loadActiveRules(
      tx as unknown as DrizzleClient,
      tenantId,
      [field]
    );

    // 3. If the product is currently frozen, attempt auto-unfreeze. If we
    //    don't unfreeze here, the call is a no-op (identity blocked).
    if (row.status === FROZEN_STATUS) {
      const unfrozen = await tryAutoUnfreeze(
        tx as unknown as DrizzleClient,
        productId,
        tenantId,
        field,
        currentValue,
        fieldObservations,
        rules,
        { source, sourceRecordId, observedAt }
      );
      // Whether or not we unfroze, this observation is matching the prior
      // value — there's no identity update to perform.
      return { applied: false, frozen: !unfrozen };
    }

    // 4. Strength gate: identity_strength < 0.7 freezes any identity update.
    if (strength < STRENGTH_FREEZE_THRESHOLD) {
      const { logId } = await freeze(
        tx as unknown as DrizzleClient,
        {
          productId,
          tenantId,
          field,
          currentValue,
          incomingValue: proposedValue,
          source,
          sourceRecordId,
          observedAt,
          rationale: "freeze_identity_strength_low"
        }
      );
      return { applied: false, frozen: true, identityLogId: logId };
    }

    // 5. Per-field gate.
    const incomingIsPriorityOne = isPriorityOne(rules, field, source);

    if (field === "gtin" || field === "mpn") {
      // GTIN/MPN: single priority-1 observation can update, BUT only when
      // no other priority-1 observation on record disagrees.
      if (!incomingIsPriorityOne) {
        // Non-priority-1 observations do not shift identity on their own.
        return { applied: false, frozen: false };
      }

      // If the current value matches the proposed, this is a no-op (the
      // observation reaffirms current state).
      if (currentValue === proposedValue) {
        return { applied: false, frozen: false };
      }

      const conflict = findConflictingPriorityOne(
        fieldObservations,
        rules,
        field,
        proposedValue
      );
      if (conflict) {
        const { logId, reviewTaskId } = await freezeWithReviewTask(
          tx as unknown as DrizzleClient,
          {
            productId,
            tenantId,
            merchantId,
            field,
            currentValue,
            incomingValue: proposedValue,
            incomingSource: source,
            sourceRecordId,
            observedAt,
            conflict
          }
        );
        const result: ApplyIdentityObservationResult = {
          applied: false,
          frozen: true,
          identityLogId: logId
        };
        if (reviewTaskId) result.reviewTaskId = reviewTaskId;
        return result;
      }

      // Apply the update.
      const logId = await applyUpdate(
        tx as unknown as DrizzleClient,
        {
          productId,
          tenantId,
          field,
          identity,
          oldValue: currentValue,
          newValue: proposedValue,
          source,
          sourceRecordId,
          observedAt,
          rationale: "single_priority_one_source"
        }
      );
      return { applied: true, frozen: false, identityLogId: logId };
    }

    // field === "brand" || field === "model_number"
    if (!incomingIsPriorityOne) {
      return { applied: false, frozen: false };
    }
    if (currentValue === proposedValue) {
      return { applied: false, frozen: false };
    }

    // Count existing priority-1 matching observations. The incoming
    // observation is conceptually the (existing+1)-th. We add 1 unless
    // catalog-write has already pushed it to values (detect via
    // source+source_record_id de-dup).
    const incomingAlreadyPushed = fieldObservations.some(
      (o) => o.source === source && o.source_record_id === sourceRecordId
    );
    const existingMatching = countConsecutiveMatching(
      fieldObservations,
      rules,
      field,
      proposedValue
    );
    const totalCount = incomingAlreadyPushed
      ? existingMatching
      : existingMatching + 1;

    if (totalCount < BRAND_CONSECUTIVE_REQUIRED) {
      return { applied: false, frozen: false };
    }

    const logId = await applyUpdate(
      tx as unknown as DrizzleClient,
      {
        productId,
        tenantId,
        field,
        identity,
        oldValue: currentValue,
        newValue: proposedValue,
        source,
        sourceRecordId,
        observedAt,
        rationale: "three_consecutive_priority_one_observations"
      }
    );
    return { applied: true, frozen: false, identityLogId: logId };
  });
}

// ---- Side-effect helpers ---------------------------------------------------

interface ApplyArgs {
  productId: string;
  tenantId: string;
  field: IdentityField;
  identity: Record<string, unknown>;
  oldValue: string | null;
  newValue: string;
  source: string;
  sourceRecordId: string;
  observedAt: Date;
  rationale: string;
}

async function applyUpdate(
  tx: DrizzleClient,
  args: ApplyArgs
): Promise<number> {
  const nextIdentity = { ...args.identity, [args.field]: args.newValue };
  await tx
    .update(schema.catalogProducts)
    .set({ identity: nextIdentity })
    .where(eq(schema.catalogProducts.productId, args.productId));

  const inserted = await tx
    .insert(schema.identityLog)
    .values({
      productId: args.productId,
      tenantId: args.tenantId,
      identityField: args.field,
      oldValue: args.oldValue,
      newValue: args.newValue,
      source: args.source,
      sourceRecordId: args.sourceRecordId,
      observedAt: args.observedAt,
      rationale: args.rationale
    })
    .returning({ logId: schema.identityLog.logId });
  const logId = inserted[0]?.logId;
  if (logId === undefined) {
    throw new Error("applyIdentityObservation: identity_log insert returned no row");
  }
  return logId;
}

interface FreezeArgs {
  productId: string;
  tenantId: string;
  field: IdentityField;
  currentValue: string | null;
  incomingValue: string;
  source: string;
  sourceRecordId: string;
  observedAt: Date;
  rationale: string;
}

async function freeze(
  tx: DrizzleClient,
  args: FreezeArgs
): Promise<{ logId: number }> {
  await tx
    .update(schema.catalogProducts)
    .set({ status: FROZEN_STATUS })
    .where(eq(schema.catalogProducts.productId, args.productId));

  const inserted = await tx
    .insert(schema.identityLog)
    .values({
      productId: args.productId,
      tenantId: args.tenantId,
      identityField: args.field,
      oldValue: args.currentValue,
      newValue: null,
      source: args.source,
      sourceRecordId: args.sourceRecordId,
      observedAt: args.observedAt,
      rationale: args.rationale
    })
    .returning({ logId: schema.identityLog.logId });
  const logId = inserted[0]?.logId;
  if (logId === undefined) {
    throw new Error("applyIdentityObservation: identity_log freeze insert returned no row");
  }
  // Per-tenant alerting (spec §6.1): v1 emits a log line per freeze. Real
  // paging integration lands in Phase 5 observability.
  console.warn(
    `[catalog-identity-policy] FREEZE product=${args.productId} field=${args.field} rationale=${args.rationale}`
  );
  return { logId };
}

interface FreezeWithReviewArgs {
  productId: string;
  tenantId: string;
  merchantId: string;
  field: IdentityField;
  currentValue: string | null;
  incomingValue: string;
  incomingSource: string;
  sourceRecordId: string;
  observedAt: Date;
  conflict: { value: string; source: string };
}

async function freezeWithReviewTask(
  tx: DrizzleClient,
  args: FreezeWithReviewArgs
): Promise<{ logId: number; reviewTaskId?: string }> {
  const { logId } = await freeze(tx, {
    productId: args.productId,
    tenantId: args.tenantId,
    field: args.field,
    currentValue: args.currentValue,
    incomingValue: args.incomingValue,
    source: args.incomingSource,
    sourceRecordId: args.sourceRecordId,
    observedAt: args.observedAt,
    rationale: `freeze_${args.field}_disagreement`
  });

  // Severity "high" — disagreement between two priority-1 sources is a
  // high-confidence signal that one source is wrong; this is more severe
  // than a low-confidence fuzzy match (medium) but not catastrophic data
  // loss (critical).
  const reviewRow = await tx
    .insert(schema.reviewTasks)
    .values({
      tenantId: args.tenantId,
      merchantId: args.merchantId,
      taskType: "value_conflict",
      signalKind: "identity_disagreement",
      signalPayload: {
        field: args.field,
        observedValues: [args.conflict.value, args.incomingValue],
        sources: [args.conflict.source, args.incomingSource]
      },
      fieldName: args.field,
      severity: "high"
    })
    .returning({ id: schema.reviewTasks.id });
  const reviewTaskId = reviewRow[0]?.id;
  const result: { logId: number; reviewTaskId?: string } = { logId };
  if (reviewTaskId) result.reviewTaskId = reviewTaskId;
  return result;
}
