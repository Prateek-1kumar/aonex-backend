// Identity update policy gate for catalog_products.identity.{gtin,mpn,brand,model_number}.
// Gates updates by source priority + consecutive-observation rules; freezes on
// disagreement or low strength, auto-unfreezes after sustained agreement.
// Auto-unfreeze counts observations after the last freeze's applied_at (v1 skew is seconds).

import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import { loadActiveRules } from "./reconciler/_internal.js";
import { globMatch, type SourcePriorityRule } from "./reconciler/pick-winner.js";
import { canSourceWrite } from "./identity/authority.js";

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
  /** Set when applied=false to explain why. `"lower_authority"` flags the
   *  per-source authority guard short-circuit. */
  reason?: "lower_authority";
}

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

function readFieldObservations(
  values: ValuesJson,
  field: IdentityField
): StoredObservation[] {
  const leaf = values?.[field]?._unscoped?._unscoped;
  if (!Array.isArray(leaf)) return [];
  return leaf;
}

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
      break;
    }
    if (obs.value !== matchValue) break;
    count++;
  }
  return count;
}

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

async function lastFreezeAppliedAt(
  tx: DrizzleClient,
  productId: string,
  field: IdentityField
): Promise<Date | null> {
  const rows = await tx
    .select({ appliedAt: schema.identityLog.appliedAt })
    .from(schema.identityLog)
    .where(
      and(
        eq(schema.identityLog.productId, productId),
        eq(schema.identityLog.identityField, field),
        sql`${schema.identityLog.rationale} LIKE 'freeze%'`
      )
    )
    .orderBy(desc(schema.identityLog.appliedAt))
    .limit(1);
  return rows[0]?.appliedAt ?? null;
}

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

  let count = 0;
  for (const obs of observations) {
    if (freezeAt && Date.parse(obs.observed_at) <= freezeAt.getTime()) continue;
    if (!isPriorityOne(rules, field, obs.source)) continue;
    if (typeof obs.value !== "string") continue;
    if (obs.value === currentValue) count++;
  }
  if (isPriorityOne(rules, field, incoming.source)) {
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

const VALID_FIELDS: ReadonlySet<IdentityField> = new Set<IdentityField>([
  "gtin",
  "mpn",
  "brand",
  "model_number"
]);

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

  if (!VALID_FIELDS.has(field)) {
    throw new Error(`applyIdentityObservation: invalid field "${field}"`);
  }
  if (!proposedValue || proposedValue.length === 0) {
    throw new Error(
      "applyIdentityObservation: proposedValue must be a non-empty string"
    );
  }

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DrizzleClient;
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

    if (currentValue !== null) {
      const currentSourceRows = await tx
        .select({ source: schema.identityLog.source })
        .from(schema.identityLog)
        .where(
          and(
            eq(schema.identityLog.productId, productId),
            eq(schema.identityLog.identityField, field),
            sql`${schema.identityLog.rationale} NOT LIKE 'freeze%'`
          )
        )
        .orderBy(desc(schema.identityLog.appliedAt))
        .limit(1);
      const currentSource = currentSourceRows[0]?.source ?? null;
      if (!canSourceWrite(currentSource, source)) {
        return { applied: false, frozen: false, reason: "lower_authority" };
      }
    }

    const rules = await loadActiveRules(tx, tenantId, [field]);

    if (row.status === FROZEN_STATUS) {
      const unfrozen = await tryAutoUnfreeze(
        tx,
        productId,
        tenantId,
        field,
        currentValue,
        fieldObservations,
        rules,
        { source, sourceRecordId, observedAt }
      );
      return { applied: false, frozen: !unfrozen };
    }

    if (strength < STRENGTH_FREEZE_THRESHOLD) {
      const { logId } = await freeze(tx, {
        productId,
        tenantId,
        field,
        currentValue,
        incomingValue: proposedValue,
        source,
        sourceRecordId,
        observedAt,
        rationale: "freeze_identity_strength_low"
      });
      return { applied: false, frozen: true, identityLogId: logId };
    }

    const incomingIsPriorityOne = isPriorityOne(rules, field, source);

    if (field === "gtin" || field === "mpn") {
      if (!incomingIsPriorityOne) {
        return { applied: false, frozen: false };
      }

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
        const { logId, reviewTaskId } = await freezeWithReviewTask(tx, {
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
        });
        const result: ApplyIdentityObservationResult = {
          applied: false,
          frozen: true,
          identityLogId: logId
        };
        if (reviewTaskId) result.reviewTaskId = reviewTaskId;
        return result;
      }

      const logId = await applyUpdate(tx, {
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
      });
      return { applied: true, frozen: false, identityLogId: logId };
    }

    if (!incomingIsPriorityOne) {
      return { applied: false, frozen: false };
    }
    if (currentValue === proposedValue) {
      return { applied: false, frozen: false };
    }

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

    const logId = await applyUpdate(tx, {
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
    });
    return { applied: true, frozen: false, identityLogId: logId };
  });
}

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
  console.warn(
    `[catalog-identity-policy] FREEZE product=${args.productId} field=${args.field} rationale=${args.rationale} incomingValue=${args.incomingValue} currentValue=${args.currentValue ?? "<null>"}`
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
