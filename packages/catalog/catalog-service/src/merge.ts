// Manual merge / split / unmerge service for catalog_products, each in one txn.
// Reversibility is load-bearing: observations are MOVED and losers TOMBSTONED
// (status='merged_into'), never deleted; the merge revision's diff holds a full undo
// recipe keyed on (source, sourceRecordId, observedAt) — the 2-tuple alone collides.

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";
import { deepEqual } from "./reconciler/_internal.js";
import { projectSync } from "./reconciler/sync.js";

export interface MergeProductsInput {
  db: DrizzleClient;
  tenantId: TenantId;
  winnerId: string;
  loserIds: string[];
  actor: string;
  rationale: string;
  /** Stamped onto `projectSync` for the winning_values recompute. Defaults to 1. */
  rulesVersion?: number;
}

export interface MergeProductsResult {
  winnerId: string;
  losers: string[];
  revisionId: number;
  eventId: number;
  /** One product_lineage.lineage_id per loser. */
  lineageIds: number[];
  /** Total observations appended into winner.values across all losers. */
  observationsMoved: number;
  pricingObservationsMoved: number;
  inventoryObservationsMoved: number;
  variantsReparented: number;
}

/**
 * Typed observation filter for `splitProduct`.
 *
 * Semantics: ALL specified fields must match (AND across set fields). An empty
 * filter (no fields set) is rejected — splits must always identify the
 * observations to move. Use `mergeProducts` for the inverse "collapse two
 * products" operation; there is no "move everything to a new product" path.
 *
 * Filter scope per field:
 *   - `sources` — applied to BOTH `values` JSONB observations and side-table
 *     rows (matches `source` column / `source` field).
 *   - `sourceRecordIds` — applied to both (matches `source_record_id`).
 *   - `attributeCodes` — JSONB ONLY. Side-table rows have no attribute_code
 *     column. If set, side-table rows are NOT moved (callers wanting to also
 *     move pricing/inventory must split via source/channel/locale).
 *   - `valueEquals` — JSONB ONLY (deep-equal on stored observation `value`).
 *   - `channelCodes` — JSONB ONLY (matches the channel-coordinate string key
 *     in `values[attr][channel][locale]`). Side-tables key channels by uuid;
 *     to filter side-tables by channel use `channelIds`.
 *   - `channelIds` — side-table rows ONLY (uuid match on `channel_id`).
 *   - `localeCodes` — applied to both (matches the locale JSONB key AND the
 *     `locale` text column on pricing rows).
 */
export interface ObservationFilter {
  sources?: string[];
  sourceRecordIds?: string[];
  attributeCodes?: string[];
  valueEquals?: unknown;
  channelCodes?: string[];
  channelIds?: string[];
  localeCodes?: string[];
}

export interface SplitProductInput {
  db: DrizzleClient;
  tenantId: TenantId;
  sourceProductId: string;
  observationFilter: ObservationFilter;
  newIdentity: {
    primaryIdentifier: string;
    identity: Record<string, unknown>;
    family?: string | null;
    status?: string;
  };
  actor: string;
  rationale: string;
  /** Stamped onto `projectSync` for the winning_values recompute. Defaults to 1. */
  rulesVersion?: number;
}

export interface SplitProductResult {
  sourceProductId: string;
  newProductId: string;
  /** Both manual_split revisions written in the txn (source + new). */
  splitRevisionIds: { source: number; new: number };
  eventId: number;
  lineageId: number;
  observationsMoved: number;
  pricingObservationsMoved: number;
  inventoryObservationsMoved: number;
}

export interface UnmergeProductInput {
  db: DrizzleClient;
  tenantId: TenantId;
  mergeRevisionId: number;
  actor: string;
  rulesVersion?: number;
}

export interface UnmergeProductResult {
  winnerId: string;
  /** Empty when unmerge is a no-op (already-unmerged short-circuit). */
  restoredLosers: string[];
  /** `0` when short-circuiting. */
  unmergeRevisionId: number;
  /** `0` when short-circuiting. */
  eventId: number;
  lineageIds: number[];
  observationsRemoved: number;
  pricingObservationsRestored: number;
  inventoryObservationsRestored: number;
}

interface StoredObservation {
  source: string;
  source_record_id: string;
  value: unknown;
  confidence: number;
  observed_at: string;
  ingested_at?: string;
  artifact_id?: string;
  extras?: Record<string, unknown>;
}

type ValuesJson = Record<
  string,
  Record<string, Record<string, StoredObservation[]>>
>;

interface MovedObservationRef {
  attr: string;
  channel: string;
  locale: string;
  source: string;
  sourceRecordId: string;
  observedAt: string;
}

interface MergeUndoLoserEntry {
  loserId: string;
  observationsMoved: MovedObservationRef[];
  priorStatus: string;
  priorMergedIntoProductId: string | null;
}

interface MergeUndoRecipe {
  operation: "merge";
  winnerId: string;
  losers: MergeUndoLoserEntry[];
  rationale: string;
  actor: string;
}

async function lockProducts(
  tx: DrizzleClient,
  productIds: string[]
): Promise<void> {
  const ordered = [...productIds].sort();
  for (const id of ordered) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
  }
}

function ensureLeaf(
  values: ValuesJson,
  attr: string,
  channel: string,
  locale: string
): StoredObservation[] {
  if (!values[attr]) values[attr] = {};
  if (!values[attr]![channel]) values[attr]![channel] = {};
  if (!values[attr]![channel]![locale]) values[attr]![channel]![locale] = [];
  return values[attr]![channel]![locale]!;
}

function *iterateValues(values: ValuesJson): Generator<{
  attr: string;
  channel: string;
  locale: string;
  observation: StoredObservation;
}> {
  for (const [attr, byChannel] of Object.entries(values)) {
    if (!byChannel || typeof byChannel !== "object") continue;
    for (const [channel, byLocale] of Object.entries(byChannel)) {
      if (!byLocale || typeof byLocale !== "object") continue;
      for (const [locale, observations] of Object.entries(byLocale)) {
        if (!Array.isArray(observations)) continue;
        for (const observation of observations) {
          if (!observation || typeof observation !== "object") continue;
          yield { attr, channel, locale, observation };
        }
      }
    }
  }
}

export async function mergeProducts(
  input: MergeProductsInput
): Promise<MergeProductsResult> {
  const {
    db,
    tenantId,
    winnerId,
    loserIds,
    actor,
    rationale,
    rulesVersion = 1
  } = input;

  if (loserIds.length === 0) {
    throw new Error("mergeProducts: loserIds must be non-empty");
  }
  if (loserIds.includes(winnerId)) {
    throw new Error("mergeProducts: winnerId cannot also be a loser");
  }

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DrizzleClient;

    await lockProducts(tx, [winnerId, ...loserIds]);

    const allIds = [winnerId, ...loserIds];
    const productRows = await tx
      .select()
      .from(schema.catalogProducts)
      .where(inArray(schema.catalogProducts.productId, allIds));

    const byId = new Map(productRows.map((r) => [r.productId, r]));
    const winner = byId.get(winnerId);
    if (!winner) {
      throw new Error(`mergeProducts: winner ${winnerId} not found`);
    }
    if (winner.tenantId !== (tenantId as unknown as string)) {
      throw new Error(
        `mergeProducts: winner ${winnerId} does not belong to tenant ${tenantId}`
      );
    }

    const losers = [];
    for (const id of loserIds) {
      const row = byId.get(id);
      if (!row) {
        throw new Error(`mergeProducts: loser ${id} not found`);
      }
      if (row.tenantId !== winner.tenantId) {
        throw new Error(
          `mergeProducts: loser ${id} (tenant ${row.tenantId}) and winner ${winnerId} (tenant ${winner.tenantId}) belong to different tenants`
        );
      }
      if (row.status === "merged_into") {
        throw new Error(
          `mergeProducts: loser ${id} is already merged (status='merged_into') — chained merges are not supported in v1`
        );
      }
      losers.push(row);
    }

    const nextValues: ValuesJson = JSON.parse(
      JSON.stringify(winner.values ?? {})
    ) as ValuesJson;

    const undoLosers: MergeUndoLoserEntry[] = [];
    const touchedAttributes = new Set<string>();
    let observationsMoved = 0;

    for (const loser of losers) {
      const loserValues = (loser.values ?? {}) as ValuesJson;
      const movedRefs: MovedObservationRef[] = [];

      for (const { attr, channel, locale, observation } of iterateValues(
        loserValues
      )) {
        const leaf = ensureLeaf(nextValues, attr, channel, locale);
        leaf.push(observation);
        movedRefs.push({
          attr,
          channel,
          locale,
          source: observation.source,
          sourceRecordId: observation.source_record_id,
          observedAt: observation.observed_at
        });
        touchedAttributes.add(attr);
        observationsMoved++;
      }

      undoLosers.push({
        loserId: loser.productId,
        observationsMoved: movedRefs,
        priorStatus: loser.status,
        priorMergedIntoProductId: loser.mergedIntoProductId ?? null
      });
    }

    await tx
      .update(schema.catalogProducts)
      .set({ values: nextValues as Record<string, unknown> })
      .where(eq(schema.catalogProducts.productId, winnerId));

    let variantsReparented = 0;
    if (loserIds.length > 0) {
      const reparented = await tx
        .update(schema.catalogProducts)
        .set({ parentProductId: winnerId })
        .where(
          inArray(schema.catalogProducts.parentProductId, loserIds)
        )
        .returning({ productId: schema.catalogProducts.productId });
      variantsReparented = reparented.length;
    }

    let pricingObservationsMoved = 0;
    let inventoryObservationsMoved = 0;
    for (const loser of losers) {
      const pricing = await tx
        .update(schema.catalogPricingObservations)
        .set({
          productId: winnerId,
          mergedFromProductId: loser.productId
        })
        .where(eq(schema.catalogPricingObservations.productId, loser.productId))
        .returning({
          observationId: schema.catalogPricingObservations.observationId
        });
      pricingObservationsMoved += pricing.length;

      const inv = await tx
        .update(schema.catalogInventoryObservations)
        .set({
          productId: winnerId,
          mergedFromProductId: loser.productId
        })
        .where(
          eq(schema.catalogInventoryObservations.productId, loser.productId)
        )
        .returning({
          observationId: schema.catalogInventoryObservations.observationId
        });
      inventoryObservationsMoved += inv.length;
    }

    for (const loser of losers) {
      await tx
        .delete(schema.catalogPricingCurrent)
        .where(eq(schema.catalogPricingCurrent.productId, loser.productId));
      await tx
        .delete(schema.catalogInventoryCurrent)
        .where(eq(schema.catalogInventoryCurrent.productId, loser.productId));
    }

    await tx
      .update(schema.catalogProducts)
      .set({
        status: "merged_into",
        mergedIntoProductId: winnerId
      })
      .where(inArray(schema.catalogProducts.productId, loserIds));

    if (touchedAttributes.size > 0) {
      await projectSync({
        db: tx,
        productId: winnerId,
        affectedAttributes: Array.from(touchedAttributes),
        rulesVersion
      });
    }

    const afterRows = await tx
      .select({
        values: schema.catalogProducts.values,
        winningValues: schema.catalogProducts.winningValues
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId))
      .limit(1);
    const afterRow = afterRows[0]!;

    const undoRecipe: MergeUndoRecipe = {
      operation: "merge",
      winnerId,
      losers: undoLosers,
      rationale,
      actor
    };

    const revInserted = await tx
      .insert(schema.catalogProductRevisions)
      .values({
        productId: winnerId,
        tenantId,
        valuesSnapshot: (afterRow.values ?? {}) as Record<string, unknown>,
        winningSnapshot: (afterRow.winningValues ?? null) as
          | Record<string, unknown>
          | null,
        diff: undoRecipe as unknown as Record<string, unknown>,
        revisionReason: "manual_merge",
        sourceKind: "merge",
        sourceRecordId: null,
        rawPayload: null,
        observedAt: new Date(),
        actor
      })
      .returning({
        revisionId: schema.catalogProductRevisions.revisionId
      });
    const revisionId = revInserted[0]!.revisionId;

    const lineageInserted = await tx
      .insert(schema.productLineage)
      .values(
        loserIds.map((loserId) => ({
          productId: winnerId,
          originProductId: loserId,
          operation: "merge",
          splitFilter: null,
          rationale,
          actor
        }))
      )
      .returning({ lineageId: schema.productLineage.lineageId });
    const lineageIds = lineageInserted.map((r) => r.lineageId);

    const eventInserted = await tx
      .insert(schema.catalogEvents)
      .values({
        eventType: "catalog.product.merged",
        productId: winnerId,
        tenantId,
        payload: {
          winnerId,
          losers: loserIds,
          actor,
          rationale,
          revisionId
        },
        triggeredBy: actor
      })
      .returning({ eventId: schema.catalogEvents.eventId });
    const eventId = eventInserted[0]!.eventId;

    return {
      winnerId,
      losers: loserIds,
      revisionId,
      eventId,
      lineageIds,
      observationsMoved,
      pricingObservationsMoved,
      inventoryObservationsMoved,
      variantsReparented
    };
  });
}

function isObservationFilterEmpty(f: ObservationFilter): boolean {
  return (
    (f.sources == null || f.sources.length === 0) &&
    (f.sourceRecordIds == null || f.sourceRecordIds.length === 0) &&
    (f.attributeCodes == null || f.attributeCodes.length === 0) &&
    f.valueEquals === undefined &&
    (f.channelCodes == null || f.channelCodes.length === 0) &&
    (f.channelIds == null || f.channelIds.length === 0) &&
    (f.localeCodes == null || f.localeCodes.length === 0)
  );
}

function matchesValuesObservation(
  filter: ObservationFilter,
  attr: string,
  channel: string,
  locale: string,
  observation: StoredObservation
): boolean {
  if (filter.attributeCodes && filter.attributeCodes.length > 0) {
    if (!filter.attributeCodes.includes(attr)) return false;
  }
  if (filter.channelCodes && filter.channelCodes.length > 0) {
    if (!filter.channelCodes.includes(channel)) return false;
  }
  if (filter.localeCodes && filter.localeCodes.length > 0) {
    if (!filter.localeCodes.includes(locale)) return false;
  }
  if (filter.sources && filter.sources.length > 0) {
    if (!filter.sources.includes(observation.source)) return false;
  }
  if (filter.sourceRecordIds && filter.sourceRecordIds.length > 0) {
    if (!filter.sourceRecordIds.includes(observation.source_record_id)) {
      return false;
    }
  }
  if (filter.valueEquals !== undefined) {
    // Structural deep-equal, NOT JSON.stringify: jsonb does not preserve object
    // key order on round-trip, so the byte forms can differ for equal values.
    if (!deepEqual(observation.value, filter.valueEquals)) {
      return false;
    }
  }
  return true;
}

/**
 * Split a product by MOVING observations matching a typed filter from source to
 * a newly created product. Cardinal invariant: revisions are NEVER physically
 * moved — they stay on their origin product_id forever (moving them would
 * corrupt the immutability guarantee); a `product_lineage` row carries provenance.
 */
export async function splitProduct(
  input: SplitProductInput
): Promise<SplitProductResult> {
  const {
    db,
    tenantId,
    sourceProductId,
    observationFilter,
    newIdentity,
    actor,
    rationale,
    rulesVersion = 1
  } = input;

  if (isObservationFilterEmpty(observationFilter)) {
    throw new Error(
      "splitProduct: observationFilter is empty — must specify at least one of sources, sourceRecordIds, attributeCodes, valueEquals, channelCodes, channelIds, localeCodes"
    );
  }

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DrizzleClient;

    await lockProducts(tx, [sourceProductId]);

    const sourceRows = await tx
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, sourceProductId));
    const source = sourceRows[0];
    if (!source) {
      throw new Error(`splitProduct: source ${sourceProductId} not found`);
    }
    if (source.tenantId !== (tenantId as unknown as string)) {
      throw new Error(
        `splitProduct: source ${sourceProductId} does not belong to tenant ${tenantId}`
      );
    }

    const sourceValues = (source.values ?? {}) as ValuesJson;
    const keptValues: ValuesJson = {};
    const movedValues: ValuesJson = {};
    const touchedAttributes = new Set<string>();
    let observationsMoved = 0;

    for (const [attr, byChannel] of Object.entries(sourceValues)) {
      if (!byChannel || typeof byChannel !== "object") continue;
      for (const [channel, byLocale] of Object.entries(byChannel)) {
        if (!byLocale || typeof byLocale !== "object") continue;
        for (const [locale, observations] of Object.entries(byLocale)) {
          if (!Array.isArray(observations)) continue;
          for (const observation of observations) {
            if (!observation || typeof observation !== "object") continue;
            if (
              matchesValuesObservation(
                observationFilter,
                attr,
                channel,
                locale,
                observation as StoredObservation
              )
            ) {
              const leaf = ensureLeaf(movedValues, attr, channel, locale);
              leaf.push(observation as StoredObservation);
              touchedAttributes.add(attr);
              observationsMoved++;
            } else {
              const leaf = ensureLeaf(keptValues, attr, channel, locale);
              leaf.push(observation as StoredObservation);
            }
          }
        }
      }
    }

    const attributeCodesSet =
      observationFilter.attributeCodes != null &&
      observationFilter.attributeCodes.length > 0;
    const valueEqualsSet = observationFilter.valueEquals !== undefined;
    const sideTableEligible = !attributeCodesSet && !valueEqualsSet;

    const pricingPredicates: SQL[] = [
      eq(schema.catalogPricingObservations.productId, sourceProductId)
    ];
    const inventoryPredicates: SQL[] = [
      eq(schema.catalogInventoryObservations.productId, sourceProductId)
    ];
    if (sideTableEligible) {
      if (observationFilter.sources && observationFilter.sources.length > 0) {
        pricingPredicates.push(
          inArray(
            schema.catalogPricingObservations.source,
            observationFilter.sources
          )
        );
        inventoryPredicates.push(
          inArray(
            schema.catalogInventoryObservations.source,
            observationFilter.sources
          )
        );
      }
      if (
        observationFilter.sourceRecordIds &&
        observationFilter.sourceRecordIds.length > 0
      ) {
        pricingPredicates.push(
          inArray(
            schema.catalogPricingObservations.sourceRecordId,
            observationFilter.sourceRecordIds
          )
        );
        inventoryPredicates.push(
          inArray(
            schema.catalogInventoryObservations.sourceRecordId,
            observationFilter.sourceRecordIds
          )
        );
      }
      if (
        observationFilter.channelIds &&
        observationFilter.channelIds.length > 0
      ) {
        pricingPredicates.push(
          inArray(
            schema.catalogPricingObservations.channelId,
            observationFilter.channelIds
          )
        );
        inventoryPredicates.push(
          inArray(
            schema.catalogInventoryObservations.channelId,
            observationFilter.channelIds
          )
        );
      }
      if (
        observationFilter.localeCodes &&
        observationFilter.localeCodes.length > 0
      ) {
        pricingPredicates.push(
          inArray(
            schema.catalogPricingObservations.locale,
            observationFilter.localeCodes
          )
        );
      }
    }

    let pricingMatchCount = 0;
    let inventoryMatchCount = 0;
    if (sideTableEligible) {
      const pricingCountRows = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(schema.catalogPricingObservations)
        .where(and(...pricingPredicates));
      pricingMatchCount = pricingCountRows[0]?.c ?? 0;
      const inventoryCountRows = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(schema.catalogInventoryObservations)
        .where(and(...inventoryPredicates));
      inventoryMatchCount = inventoryCountRows[0]?.c ?? 0;
    }

    if (
      observationsMoved === 0 &&
      pricingMatchCount === 0 &&
      inventoryMatchCount === 0
    ) {
      throw new Error(
        `splitProduct: filter matched zero observations on sourceProductId=${sourceProductId}. ` +
          `Refusing to create a phantom new product. Verify the filter against the source's ` +
          `values + side-tables.`
      );
    }

    await tx
      .update(schema.catalogProducts)
      .set({ values: keptValues as Record<string, unknown> })
      .where(eq(schema.catalogProducts.productId, sourceProductId));

    const newInserted = await tx
      .insert(schema.catalogProducts)
      .values({
        tenantId: source.tenantId,
        merchantId: source.merchantId,
        parentProductId: null,
        primaryIdentifier: newIdentity.primaryIdentifier,
        identity: newIdentity.identity,
        family: newIdentity.family ?? null,
        status: newIdentity.status ?? "draft",
        values: movedValues as Record<string, unknown>
      })
      .returning({ productId: schema.catalogProducts.productId });
    const newProductId = newInserted[0]!.productId;

    let pricingObservationsMoved = 0;
    let inventoryObservationsMoved = 0;
    if (sideTableEligible) {
      const movedPricing = await tx
        .update(schema.catalogPricingObservations)
        .set({ productId: newProductId })
        .where(and(...pricingPredicates))
        .returning({
          observationId: schema.catalogPricingObservations.observationId
        });
      pricingObservationsMoved = movedPricing.length;

      const movedInv = await tx
        .update(schema.catalogInventoryObservations)
        .set({ productId: newProductId })
        .where(and(...inventoryPredicates))
        .returning({
          observationId: schema.catalogInventoryObservations.observationId
        });
      inventoryObservationsMoved = movedInv.length;
    }

    await tx
      .delete(schema.catalogPricingCurrent)
      .where(eq(schema.catalogPricingCurrent.productId, sourceProductId));
    await tx
      .delete(schema.catalogInventoryCurrent)
      .where(eq(schema.catalogInventoryCurrent.productId, sourceProductId));

    if (touchedAttributes.size > 0) {
      const attrs = Array.from(touchedAttributes);
      await projectSync({
        db: tx,
        productId: sourceProductId,
        affectedAttributes: attrs,
        rulesVersion
      });
      await projectSync({
        db: tx,
        productId: newProductId,
        affectedAttributes: attrs,
        rulesVersion
      });
    }

    const sourceAfterRows = await tx
      .select({
        values: schema.catalogProducts.values,
        winningValues: schema.catalogProducts.winningValues
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, sourceProductId))
      .limit(1);
    const sourceAfterRow = sourceAfterRows[0]!;

    const sourceRevInserted = await tx
      .insert(schema.catalogProductRevisions)
      .values({
        productId: sourceProductId,
        tenantId,
        valuesSnapshot: (sourceAfterRow.values ?? {}) as Record<string, unknown>,
        winningSnapshot: (sourceAfterRow.winningValues ?? null) as
          | Record<string, unknown>
          | null,
        diff: {
          operation: "split",
          new_product_id: newProductId,
          split_filter: observationFilter as unknown as Record<string, unknown>,
          actor,
          rationale
        },
        revisionReason: "manual_split",
        sourceKind: "split",
        sourceRecordId: null,
        rawPayload: null,
        observedAt: new Date(),
        actor
      })
      .returning({
        revisionId: schema.catalogProductRevisions.revisionId
      });
    const sourceRevisionId = sourceRevInserted[0]!.revisionId;

    const newAfterRows = await tx
      .select({
        values: schema.catalogProducts.values,
        winningValues: schema.catalogProducts.winningValues
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, newProductId))
      .limit(1);
    const newAfterRow = newAfterRows[0]!;

    const newRevInserted = await tx
      .insert(schema.catalogProductRevisions)
      .values({
        productId: newProductId,
        tenantId,
        valuesSnapshot: (newAfterRow.values ?? {}) as Record<string, unknown>,
        winningSnapshot: (newAfterRow.winningValues ?? null) as
          | Record<string, unknown>
          | null,
        diff: {
          operation: "split",
          origin: sourceProductId,
          split_filter: observationFilter as unknown as Record<string, unknown>,
          lineage_pointer: {
            source_revision: sourceRevisionId
          },
          actor,
          rationale
        },
        revisionReason: "manual_split",
        sourceKind: "split",
        sourceRecordId: null,
        rawPayload: null,
        observedAt: new Date(),
        actor
      })
      .returning({
        revisionId: schema.catalogProductRevisions.revisionId
      });
    const newRevisionId = newRevInserted[0]!.revisionId;

    const lineageInserted = await tx
      .insert(schema.productLineage)
      .values({
        productId: newProductId,
        originProductId: sourceProductId,
        operation: "split",
        splitFilter: observationFilter as unknown as Record<string, unknown>,
        rationale,
        actor
      })
      .returning({ lineageId: schema.productLineage.lineageId });
    const lineageId = lineageInserted[0]!.lineageId;

    const eventInserted = await tx
      .insert(schema.catalogEvents)
      .values({
        eventType: "catalog.product.split",
        productId: newProductId,
        tenantId,
        payload: {
          sourceProductId,
          newProductId,
          splitFilter: observationFilter as unknown as Record<string, unknown>,
          actor,
          rationale,
          lineageId,
          sourceRevisionId,
          newRevisionId
        },
        triggeredBy: actor
      })
      .returning({ eventId: schema.catalogEvents.eventId });
    const eventId = eventInserted[0]!.eventId;

    return {
      sourceProductId,
      newProductId,
      splitRevisionIds: { source: sourceRevisionId, new: newRevisionId },
      eventId,
      lineageId,
      observationsMoved,
      pricingObservationsMoved,
      inventoryObservationsMoved
    };
  });
}

/**
 * Reverse a merge from its revision's undo recipe: peel the moved observations
 * off the winner, restore each loser's prior status, and move side-table rows
 * back. Idempotent — re-calling with the same revision id short-circuits to a
 * no-op (empty restoredLosers, no event/revision) once every loser is restored.
 */
export async function unmergeProduct(
  input: UnmergeProductInput
): Promise<UnmergeProductResult> {
  const { db, tenantId, mergeRevisionId, actor, rulesVersion = 1 } = input;

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DrizzleClient;

    const revRows = await tx
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.revisionId, mergeRevisionId))
      .limit(1);
    const revRow = revRows[0];
    if (!revRow) {
      throw new Error(
        `unmergeProduct: merge revision ${mergeRevisionId} not found`
      );
    }
    if (revRow.revisionReason !== "manual_merge") {
      throw new Error(
        `unmergeProduct: revision ${mergeRevisionId} is not a manual_merge (reason=${revRow.revisionReason})`
      );
    }
    if (revRow.tenantId !== (tenantId as unknown as string)) {
      throw new Error(
        `unmergeProduct: revision ${mergeRevisionId} belongs to a different tenant`
      );
    }

    const undo = revRow.diff as unknown as MergeUndoRecipe | null;
    if (!undo || undo.operation !== "merge") {
      throw new Error(
        `unmergeProduct: revision ${mergeRevisionId} carries no merge undo recipe`
      );
    }

    const winnerId = undo.winnerId;
    const loserIds = undo.losers.map((l) => l.loserId);

    await lockProducts(tx, [winnerId, ...loserIds]);

    const loserCurrent = await tx
      .select({
        productId: schema.catalogProducts.productId,
        status: schema.catalogProducts.status,
        mergedIntoProductId: schema.catalogProducts.mergedIntoProductId
      })
      .from(schema.catalogProducts)
      .where(inArray(schema.catalogProducts.productId, loserIds));
    const alreadyRestored = loserCurrent.every(
      (l) =>
        l.status !== "merged_into" && l.mergedIntoProductId === null
    );
    if (alreadyRestored) {
      return {
        winnerId,
        restoredLosers: [],
        unmergeRevisionId: 0,
        eventId: 0,
        lineageIds: [],
        observationsRemoved: 0,
        pricingObservationsRestored: 0,
        inventoryObservationsRestored: 0
      };
    }

    const winnerRows = await tx
      .select({ values: schema.catalogProducts.values })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId))
      .limit(1);
    const winnerRow = winnerRows[0];
    if (!winnerRow) {
      throw new Error(`unmergeProduct: winner ${winnerId} not found`);
    }
    const nextValues: ValuesJson = JSON.parse(
      JSON.stringify(winnerRow.values ?? {})
    ) as ValuesJson;
    let observationsRemoved = 0;
    const touchedAttributes = new Set<string>();

    for (const loser of undo.losers) {
      for (const ref of loser.observationsMoved) {
        const leaf =
          nextValues[ref.attr]?.[ref.channel]?.[ref.locale];
        if (!Array.isArray(leaf)) continue;
        const before = leaf.length;
        const filtered = leaf.filter(
          (o) =>
            !(
              o.source === ref.source &&
              o.source_record_id === ref.sourceRecordId &&
              o.observed_at === ref.observedAt
            )
        );
        observationsRemoved += before - filtered.length;
        nextValues[ref.attr]![ref.channel]![ref.locale] = filtered;
        touchedAttributes.add(ref.attr);
      }
    }

    await tx
      .update(schema.catalogProducts)
      .set({ values: nextValues as Record<string, unknown> })
      .where(eq(schema.catalogProducts.productId, winnerId));

    let pricingObservationsRestored = 0;
    let inventoryObservationsRestored = 0;
    for (const loser of undo.losers) {
      await tx
        .update(schema.catalogProducts)
        .set({
          status: loser.priorStatus,
          mergedIntoProductId: loser.priorMergedIntoProductId
        })
        .where(eq(schema.catalogProducts.productId, loser.loserId));

      const pricing = await tx
        .update(schema.catalogPricingObservations)
        .set({ productId: loser.loserId, mergedFromProductId: null })
        .where(eq(schema.catalogPricingObservations.mergedFromProductId, loser.loserId))
        .returning({
          observationId: schema.catalogPricingObservations.observationId
        });
      pricingObservationsRestored += pricing.length;

      const inv = await tx
        .update(schema.catalogInventoryObservations)
        .set({ productId: loser.loserId, mergedFromProductId: null })
        .where(
          eq(schema.catalogInventoryObservations.mergedFromProductId, loser.loserId)
        )
        .returning({
          observationId: schema.catalogInventoryObservations.observationId
        });
      inventoryObservationsRestored += inv.length;
    }

    await tx
      .delete(schema.catalogPricingCurrent)
      .where(eq(schema.catalogPricingCurrent.productId, winnerId));
    await tx
      .delete(schema.catalogInventoryCurrent)
      .where(eq(schema.catalogInventoryCurrent.productId, winnerId));
    for (const loser of undo.losers) {
      await tx
        .delete(schema.catalogPricingCurrent)
        .where(eq(schema.catalogPricingCurrent.productId, loser.loserId));
      await tx
        .delete(schema.catalogInventoryCurrent)
        .where(eq(schema.catalogInventoryCurrent.productId, loser.loserId));
    }

    if (touchedAttributes.size > 0) {
      await projectSync({
        db: tx,
        productId: winnerId,
        affectedAttributes: Array.from(touchedAttributes),
        rulesVersion
      });
    }

    const winnerAfter = await tx
      .select({
        values: schema.catalogProducts.values,
        winningValues: schema.catalogProducts.winningValues
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId))
      .limit(1);
    const winnerAfterRow = winnerAfter[0]!;

    const unmergeDiff = {
      operation: "unmerge",
      winnerId,
      restoredLosers: loserIds,
      mergeRevisionId,
      actor
    };

    const winnerRevInserted = await tx
      .insert(schema.catalogProductRevisions)
      .values({
        productId: winnerId,
        tenantId,
        valuesSnapshot: (winnerAfterRow.values ?? {}) as Record<string, unknown>,
        winningSnapshot: (winnerAfterRow.winningValues ?? null) as
          | Record<string, unknown>
          | null,
        diff: unmergeDiff,
        revisionReason: "manual_unmerge",
        sourceKind: "merge",
        sourceRecordId: String(mergeRevisionId),
        rawPayload: null,
        observedAt: new Date(),
        actor
      })
      .returning({
        revisionId: schema.catalogProductRevisions.revisionId
      });
    const unmergeRevisionId = winnerRevInserted[0]!.revisionId;

    for (const loser of undo.losers) {
      const loserAfter = await tx
        .select({
          values: schema.catalogProducts.values,
          winningValues: schema.catalogProducts.winningValues
        })
        .from(schema.catalogProducts)
        .where(eq(schema.catalogProducts.productId, loser.loserId))
        .limit(1);
      const loserAfterRow = loserAfter[0]!;
      await tx.insert(schema.catalogProductRevisions).values({
        productId: loser.loserId,
        tenantId,
        valuesSnapshot: (loserAfterRow.values ?? {}) as Record<string, unknown>,
        winningSnapshot: (loserAfterRow.winningValues ?? null) as
          | Record<string, unknown>
          | null,
        diff: { operation: "unmerge", mergeRevisionId, actor },
        revisionReason: "manual_unmerge",
        sourceKind: "merge",
        sourceRecordId: String(mergeRevisionId),
        rawPayload: null,
        observedAt: new Date(),
        actor
      });
    }

    const lineageInserted = await tx
      .insert(schema.productLineage)
      .values(
        loserIds.map((loserId) => ({
          productId: loserId,
          originProductId: winnerId,
          operation: "unmerge",
          splitFilter: null,
          rationale: `unmerge of revision ${mergeRevisionId}`,
          actor
        }))
      )
      .returning({ lineageId: schema.productLineage.lineageId });
    const lineageIds = lineageInserted.map((r) => r.lineageId);

    const eventInserted = await tx
      .insert(schema.catalogEvents)
      .values({
        eventType: "catalog.product.unmerged",
        productId: winnerId,
        tenantId,
        payload: {
          winnerId,
          restoredLosers: loserIds,
          actor,
          mergeRevisionId
        },
        triggeredBy: actor
      })
      .returning({ eventId: schema.catalogEvents.eventId });
    const eventId = eventInserted[0]!.eventId;

    return {
      winnerId,
      restoredLosers: loserIds,
      unmergeRevisionId,
      eventId,
      lineageIds,
      observationsRemoved,
      pricingObservationsRestored,
      inventoryObservationsRestored
    };
  });
}
