// Catalog redesign — manual merge + unmerge service (plan §3.8, spec §18.1).
//
// `mergeProducts(winner, [loser1, ...], actor, rationale)` collapses one or
// more duplicate `catalog_products` rows into a single winner while preserving
// every signal the system has ever observed — observations are MOVED (not
// rewritten), side-table rows are RE-PARENTED with a `merged_from_product_id`
// pointer, variants are re-parented, and the loser is TOMBSTONED
// (status='merged_into') rather than deleted. The merge revision row carries
// a full undo recipe in its `diff` jsonb, enabling `unmergeProduct(revisionId)`
// to reverse the operation deterministically.
//
// Reversibility is the load-bearing invariant. Per spec §18.1:
//   - Never DELETE loser rows. status='merged_into' is the permanent tombstone.
//   - Never CASCADE DELETE from loser to its revisions or side-table rows.
//   - Side-table rows carry `merged_from_product_id` so they can be re-attached.
//   - Merge revision carries full undo recipe (loser_ids, observations moved,
//     actor, rationale, prior status/merged_into pointer per loser).
//
// Both `mergeProducts` and `unmergeProduct` run end-to-end in a single
// transaction. After mutating `values`, both call `projectSync` to recompute
// `winning_values` over the union of touched attribute codes. After the txn
// commits, the caller emits the standard observability event via the
// `catalog_events` outbox row inserted inside the txn.
//
// Design decisions (encoded in this file; tests in `merge.test.ts`):
//   1. Undo recipe lives in `revision.diff` as
//      `{ operation: "merge", winnerId, losers: [{ loserId, observationsMoved,
//         priorStatus, priorMergedIntoProductId }], rationale, actor }`.
//      `observationsMoved[]` carries `{ attr, channel, locale, source,
//      sourceRecordId, observedAt }` — enough to identify which observations
//      to peel off winner.values on unmerge without storing the full
//      observation payload.
//   2. Identifying merged-in observations during unmerge: match on the triple
//      `(source, sourceRecordId, observedAt)`. The 2-tuple `(source,
//      sourceRecordId)` is NOT sufficient — catalog-write's dedup is per
//      product per `(source, sourceRecordId, value)`, so two DIFFERENT
//      products' observations can legally share `(source, sourceRecordId)`
//      with different values. After a merge those collide on the same leaf
//      and matching on the 2-tuple alone would remove the winner's original
//      observation. `observedAt` (captured from the StoredObservation row at
//      merge time) disambiguates exact rows; if duplicates ever exist they
//      were genuine duplicates and removing all matches is correct.
//   3. Per-product advisory locks: lock the winner AND every loser, ordered
//      by the lexicographic uuid string. Deterministic ordering avoids the
//      classic two-product deadlock when concurrent merges touch overlapping
//      sets.
//   4. Cross-tenant guard: winner and every loser MUST share `tenantId`. We
//      throw before any mutation. There is no use case for cross-tenant merges
//      in v1 and the consequences would be catastrophic for data isolation.
//   5. Already-merged guard: if any loser has `status='merged_into'` the call
//      throws. Chained merges (merge a tombstone) are not supported in v1 —
//      callers should merge into the tombstone's `merged_into_product_id`
//      target instead. The error message names the offender so the UI can
//      explain.
//   6. Observation cap (10-per-leaf) is intentionally NOT enforced during
//      merge. Merging is an explicit admin action; silently dropping
//      observations to satisfy the cap would lose data and break the undo
//      recipe (the dropped rows could not be restored on unmerge). This is
//      a deliberate spec-aligned divergence from catalog-write.ts.
//   7. Frozen losers: a loser with `status='frozen_pending_review'` is still
//      eligible to be merged; the new `status='merged_into'` supersedes the
//      freeze. The freeze concerns identity-update gating on a still-active
//      product — once the row is tombstoned, the gate is moot. The prior
//      status is captured in the undo recipe so unmerge restores it.
//   8. Outbox events: a single `catalog.product.merged` event (winner +
//      losers[]) and a single `catalog.product.unmerged` event (winner +
//      restoredLosers[]) — NOT one event per loser. Spec §18.1 uses the
//      singular and downstream consumers want a single batch signal.
//   9. Idempotent unmerge: if `unmergeProduct` is called twice with the same
//      `mergeRevisionId`, the second call detects that every recorded loser
//      already has `status='active'` and `mergedIntoProductId=null` and
//      short-circuits with `restoredLosers=[]` (no event, no extra revision).
//      Callers can safely retry on partial failure.
//  10. Loser's revisions stay on `loser.productId` — preserves audit chain.
//      We do NOT rewrite their `productId` during merge (the loser row still
//      exists, just tombstoned). `priorMergedIntoProductId` in the undo
//      recipe is always `null` in v1 because chained merges are blocked at
//      the entry guard (decision 5); captured defensively for the day chained
//      merges are allowed.
//  11. `_current` table reconciliation is deferred to the async-debounced
//      reconciler. Inside the merge txn we DELETE the loser's
//      `catalog_pricing_current` / `catalog_inventory_current` rows (they
//      would otherwise point at a tombstoned product and never get cleaned).
//      We do NOT recompute the winner's `_current` rows here — that rebuild
//      is left to the async reconciler keyed off the moved observations
//      (matching the catalog-write.ts pattern where async enqueue lands in
//      Phase 4). On unmerge we DELETE `_current` rows for BOTH the winner
//      and each restored loser so the async reconciler rebuilds them from
//      the post-unmerge observation layout. Phase 4 will wire
//      `enqueueReconcilerJob` at the tail of merge/unmerge.

import { eq, inArray, sql } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";
import { projectSync } from "./reconciler/sync.js";

// ---- Public types ----------------------------------------------------------

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

// ---- Internal shapes (mirror of spec §7 / catalog-write.ts) ---------------

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
  /** ISO observed_at copied from the StoredObservation at merge time. Used at
   * unmerge to disambiguate observations sharing `(source, sourceRecordId)`
   * with the winner's pre-existing rows. See decision 2. */
  observedAt: string;
}

interface MergeUndoLoserEntry {
  loserId: string;
  observationsMoved: MovedObservationRef[];
  priorStatus: string;
  /** Always null in v1 — chained merges are blocked at the entry guard
   * (decision 5). Captured for forward-compat if v2 allows chained merges. */
  priorMergedIntoProductId: string | null;
}

interface MergeUndoRecipe {
  operation: "merge";
  winnerId: string;
  losers: MergeUndoLoserEntry[];
  rationale: string;
  actor: string;
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Acquire transaction-scoped advisory locks on every product involved in this
 * merge/unmerge. Deterministic ordering on the uuid string avoids deadlocks
 * between concurrent merge calls that touch overlapping product sets.
 */
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

/**
 * Walk a `values` jsonb and yield every observation along with its 4-axis
 * coordinates. Order-stable on a single `Object.entries` walk so the
 * undo-recipe ordering is reproducible.
 */
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

// ---- mergeProducts ---------------------------------------------------------

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

    // 1. Acquire per-product advisory locks in deterministic order.
    await lockProducts(tx, [winnerId, ...loserIds]);

    // 2. Load winner + all losers under the lock.
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

    // 3. Build the new winner.values JSONB by appending each loser's
    //    observations. Note: we deliberately do NOT enforce the per-leaf
    //    observation cap here (decision 6).
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

    // 4. Persist winner.values.
    await tx
      .update(schema.catalogProducts)
      .set({ values: nextValues as Record<string, unknown> })
      .where(eq(schema.catalogProducts.productId, winnerId));

    // 5. Re-parent variant children of every loser onto the winner.
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

    // 6. Move side-table rows: pricing + inventory observations. Each loser's
    //    rows are flipped to product_id=winner with merged_from_product_id=loser
    //    in one UPDATE per (loser, side-table).
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

    // 6b. Delete loser's `_current` rows. They would otherwise be orphans
    //     pointing at a tombstoned product (decision 11). Winner's `_current`
    //     rows are intentionally left to the async-debounced reconciler.
    for (const loser of losers) {
      await tx
        .delete(schema.catalogPricingCurrent)
        .where(eq(schema.catalogPricingCurrent.productId, loser.productId));
      await tx
        .delete(schema.catalogInventoryCurrent)
        .where(eq(schema.catalogInventoryCurrent.productId, loser.productId));
    }

    // 7. Tombstone losers: status='merged_into', merged_into_product_id=winner.
    await tx
      .update(schema.catalogProducts)
      .set({
        status: "merged_into",
        mergedIntoProductId: winnerId
      })
      .where(inArray(schema.catalogProducts.productId, loserIds));

    // 8. Recompute winning_values for the union of touched attribute codes.
    //    `projectSync` opens its own (savepoint) transaction; safe nested.
    if (touchedAttributes.size > 0) {
      await projectSync({
        db: tx,
        productId: winnerId,
        affectedAttributes: Array.from(touchedAttributes),
        rulesVersion
      });
    }

    // 9. Write the revision row on the winner carrying the undo recipe.
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

    // 10. product_lineage rows: one per loser, operation='merge'.
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

    // 11. Outbox event — single `catalog.product.merged` carrying all losers.
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

// ---- unmergeProduct --------------------------------------------------------

export async function unmergeProduct(
  input: UnmergeProductInput
): Promise<UnmergeProductResult> {
  const { db, tenantId, mergeRevisionId, actor, rulesVersion = 1 } = input;

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DrizzleClient;

    // 1. Read the merge revision to recover the undo recipe.
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

    // 2. Lock winner + losers (deterministic order).
    await lockProducts(tx, [winnerId, ...loserIds]);

    // 3. Idempotent short-circuit: every loser already restored?
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

    // 4. Load winner.values once, then remove every
    //    (source, sourceRecordId, observedAt) triple from the leaf identified
    //    by the undo recipe. The triple match (vs the 2-tuple) is critical
    //    when the winner already had an observation sharing `(source,
    //    sourceRecordId)` with a moved-in row — see decision 2.
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

    // 5. Restore loser rows + move side-table rows back.
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

    // 5b. Delete pricing/inventory `_current` rows for the winner AND each
    //     restored loser. The winner's rows are now stale (they reflected the
    //     post-merge state); the losers had none (we deleted them on merge).
    //     The async-debounced reconciler will rebuild both sides from the
    //     restored observation layout (decision 11).
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

    // 6. Recompute winning_values for the union of touched attributes on the
    //    winner (loser winning_values are left as-is — their projection still
    //    reflects their own observations from before the merge).
    if (touchedAttributes.size > 0) {
      await projectSync({
        db: tx,
        productId: winnerId,
        affectedAttributes: Array.from(touchedAttributes),
        rulesVersion
      });
    }

    // 7. Append revision rows. Winner gets one revision_reason='manual_unmerge'
    //    carrying the unmerge actor + reference to the original merge revision.
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

    // Also append a manual_unmerge revision on each loser so their audit chain
    // captures the restoration event.
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

    // 8. product_lineage rows: operation='unmerge'. We record the inverse
    //    direction (productId=loser, originProductId=winner) so the lineage
    //    table reads "this loser was restored FROM winner".
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

    // 9. Outbox event — single `catalog.product.unmerged` carrying all losers.
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
