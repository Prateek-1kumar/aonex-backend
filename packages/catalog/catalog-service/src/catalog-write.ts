// Catalog redesign — catalog write service (plan §3.5, spec §13).
//
// The single funnel through which all AdapterOutputs land in the catalog.
// Runs end-to-end in one transaction:
//
//   1. Resolve identity (Task 3.2) — attach to an existing product or create a new one.
//   2. Append CanonicalObservations into `catalog_products.values` JSONB
//      (4-axis pattern per spec §7), enforcing the per-leaf observation cap
//      with overflow eviction into the revision row.
//   3. Insert pricing observations into `catalog_pricing_observations` and
//      inventory observations into `catalog_inventory_observations` (side
//      tables — spec §8.1/§9). The caller must map channelCode→channelId
//      via the `channelCodeToId` arg; without it we cannot satisfy the
//      side-table NOT NULL on channel_id.
//   4. Trigger the synchronous reconciler (Task 3.4) over the unique
//      attribute codes touched by this batch. Pricing/inventory go through
//      the async-debounced worker (Task 3.6) — for v1 those are deferred
//      silently here.
//   5. Append a revision row carrying the post-write `values` snapshot,
//      reason, raw_payload, actor, and any overflow-evicted observations
//      (stuffed into `diff.overflow_eviction`).
//   6. Insert a `catalog_events` outbox row (`product.created`/`product.updated`).
//
// All steps run inside the SAME transaction so we either land everything
// (product row + observations + side-tables + revision + event) or nothing.

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { schema, type DrizzleClient } from "@aonex/db";
import type {
  TenantId,
  MerchantId,
  ChannelId,
  ArtifactId
} from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import { classifyArchetype } from "@aonex/archetypes";
import { resolveIdentity, type IdentityMatchPath, type IdentityResolverResult } from "./identity-resolver.js";
import {
  applyIdentityObservation,
  type IdentityField
} from "./identity-policy.js";
import { latestObservationValue } from "./observation-helpers.js";
import { projectSync, type ProjectSyncResult } from "./reconciler/sync.js";

// ---- Public types ----------------------------------------------------------

export interface WriteAdapterOutputInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  adapterOutput: AdapterOutput;
  /** Free-form actor tag — "shopify:connector", "csv:upload", "link:processor", etc. */
  actor: string;
  /** Defaults to 1 (matches Task 1.11 seed). Stamped on the projection meta. */
  rulesVersion?: number;
  /**
   * Per-leaf observation cap. When `values[attr][channel][locale]` exceeds
   * this length the OLDEST observation (by observed_at) is evicted into the
   * revision row's `diff.overflow_eviction`. Defaults to 20.
   * See RETENTION.md for rationale (quorum sizing, calibration runway, JSONB
   * bloat ceiling).
   */
  observationCap?: number;
  /**
   * Map of channelCode → channelId for the channels appearing in
   * pricingObservations / inventoryObservations. The caller (eventual
   * Phase 4 catalog API) resolves these from the channels table. Required
   * iff the AdapterOutput carries pricing or inventory observations.
   */
  channelCodeToId?: Record<string, ChannelId>;
  /**
   * Override the revision_reason written to catalog_product_revisions.
   * When omitted, defaults to "create" for new products and "new_source"
   * for existing ones. The backfill script passes "migration_backfill" so
   * revision provenance is clearly tagged.
   */
  reasonOverride?: string;
  /**
   * Override the source_kind written to catalog_product_revisions.
   * When omitted, source_kind is derived from the actor prefix
   * (e.g. "shopify:connector" → "shopify"). The backfill script passes
   * "legacy:product_versions" so the revision carries the correct lineage
   * literal from plan §7.1 step 5 rather than "backfill".
   */
  sourceOverride?: string;
  /**
   * Skip identity resolution and attach observations to this existing
   * product_id. Used by the anomaly-lab "link to existing" / promotion path
   * when a reviewer has confirmed the match. The product MUST already exist
   * and belong to `tenantId`.
   *
   * Contract when set:
   *   - The result's `created` will always be `false` (no new product row).
   *   - The result/event `matchPath` will be reported as `"gtin"` even though
   *     no GTIN match occurred — it is a placeholder for "operator-forced";
   *     a dedicated `"forced"` member and full event-payload threading is
   *     deferred to the lab-observability follow-on work.
   *   - The identity-policy gate (Task 3.7) still runs for any identity fields
   *     present in the hint: forcing only skips the resolution/match step,
   *     not the downstream identity-field promotion.
   */
  forceProductId?: string;
}

export type WriteMatchPath = IdentityMatchPath | "newly_created";

export interface WriteAdapterOutputResult {
  productId: string;
  /** True when this call inserted a new catalog_products row. */
  created: boolean;
  identityStrength: number;
  matchPath: WriteMatchPath;
  reviewTaskSuggested: boolean;
  revisionId: number;
  eventId: number;
  /** Total count across `observations` after dedup-hint skips. */
  observationsWritten: number;
  pricingObservationsWritten: number;
  inventoryObservationsWritten: number;
  /** Number of observations bumped from `values` JSONB into `diff.overflow_eviction`. */
  overflowEvictions: number;
  /** null when there were no attribute observations (pricing/inventory-only batch). */
  syncReconcilerResult: Pick<
    ProjectSyncResult,
    "attributesProjected" | "changedAttributes"
  > | null;
}

// ---- Internal shapes (mirror of spec §7) -----------------------------------

interface StoredObservation {
  source: string;
  source_record_id: string;
  value: unknown;
  confidence: number;
  observed_at: string; // ISO-8601
  ingested_at?: string;
  artifact_id?: string;
  extras?: Record<string, unknown>;
}

type ValuesJson = Record<
  string,
  Record<string, Record<string, StoredObservation[]>>
>;

// ---- Helpers ---------------------------------------------------------------

export const DEFAULT_OBSERVATION_CAP = 20;

/**
 * Stable identity equality for the dedup hint. Two observations from the
 * same `(source, sourceRecordId)` carrying the same `value` are considered
 * identical and should not stack — the adapter is expected to upgrade
 * `observedAt` if it re-emits with a meaningful change.
 */
function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  // Cheap structural compare — sufficient for canonical typed values
  // (scalars, simple arrays, small objects). JSON serialisation is
  // deterministic for the value shapes we produce; key-order differences
  // only matter for unconstrained JSON which adapters do not emit.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
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
  const leaf = values[attr]![channel]![locale];
  if (!Array.isArray(leaf)) {
    // Defensive: if the on-disk shape is malformed, replace with a fresh
    // array rather than silently dropping the incoming observation.
    values[attr]![channel]![locale] = [];
    return values[attr]![channel]![locale]!;
  }
  return leaf;
}

function stableNonUuidIdentifier(hint: AdapterOutput["identityHint"]): string {
  // For products with no GTIN/MPN we still need a unique
  // `primary_identifier` (the catalog_products unique key per tenant). A
  // random UUID is acceptable for v1 — the proper merge UX (Task 3.8)
  // collapses duplicates later when better signals arrive.
  const seed = hint.titleForFuzzy ?? "";
  const fp = seed
    ? Buffer.from(seed).toString("hex").slice(0, 12)
    : "anon";
  return `catalog:${fp}:${randomUUID()}`;
}

// ---- Public API ------------------------------------------------------------

export async function writeAdapterOutput(
  input: WriteAdapterOutputInput
): Promise<WriteAdapterOutputResult> {
  const {
    db,
    tenantId,
    merchantId,
    adapterOutput,
    actor,
    rulesVersion = 1,
    observationCap = DEFAULT_OBSERVATION_CAP,
    channelCodeToId,
    reasonOverride,
    sourceOverride,
    forceProductId
  } = input;

  const hasSideTableObservations =
    adapterOutput.pricingObservations.length > 0 ||
    adapterOutput.inventoryObservations.length > 0;
  if (hasSideTableObservations && !channelCodeToId) {
    throw new Error(
      "channelCodeToId map required for side-table observations"
    );
  }

  return db.transaction(async (tx) => {
    // ---- 1. Resolve identity --------------------------------------------
    // `resolveIdentity` takes a DrizzleClient — pass the tx so reads see
    // anything we'd already written in this transaction (none yet at this
    // point, but conceptually correct).
    const hintForResolve: {
      gtin?: string;
      mpn?: string;
      brand?: string;
      titleForFuzzy?: string;
      primary_identifier?: string;
    } = {};
    if (adapterOutput.identityHint.gtin)
      hintForResolve.gtin = adapterOutput.identityHint.gtin;
    if (adapterOutput.identityHint.mpn)
      hintForResolve.mpn = adapterOutput.identityHint.mpn;
    if (adapterOutput.identityHint.brand)
      hintForResolve.brand = adapterOutput.identityHint.brand;
    if (adapterOutput.identityHint.titleForFuzzy)
      hintForResolve.titleForFuzzy = adapterOutput.identityHint.titleForFuzzy;
    if (adapterOutput.identityHint.primary_identifier)
      hintForResolve.primary_identifier = adapterOutput.identityHint.primary_identifier;

    const resolveInput: Parameters<typeof resolveIdentity>[0] = {
      db: tx as unknown as DrizzleClient,
      tenantId,
      identityHint: hintForResolve
    };
    if (adapterOutput.identityHint.titleForFuzzy) {
      resolveInput.observationTitle = adapterOutput.identityHint.titleForFuzzy;
    }
    // forceProductId short-circuit: the anomaly-lab "link to existing" path
    // has already confirmed the match via human review. Skip identity
    // resolution entirely and synthesise a max-strength resolution result
    // pointing at the forced product_id. The downstream "existing product"
    // branch (identity.productId non-null) handles everything else unchanged.
    const identity: IdentityResolverResult = forceProductId
      ? {
          productId: forceProductId,
          strength: 1.0,
          reviewTaskSuggested: false,
          // NB: "gtin" is a stand-in — this is actually an operator-forced
          // attachment (anomaly-lab promote/link). IdentityMatchPath has no
          // "forced" member yet; adding one (and threading it into the event
          // payload) is deferred to the lab-observability work. Downstream
          // uses matchPath only informationally.
          matchPath: "gtin",
          candidateProductIds: [forceProductId],
          candidates: [{ productId: forceProductId, score: 1.0, kind: "live" as const }]
        }
      : await resolveIdentity(resolveInput);

    // ---- 2. Create-or-attach to catalog_products ------------------------
    let productId: string;
    let created: boolean;
    let priorValues: ValuesJson;

    if (identity.productId) {
      productId = identity.productId;
      created = false;
      const rows = await tx
        .select({
          values: schema.catalogProducts.values,
          identity: schema.catalogProducts.identity
        })
        .from(schema.catalogProducts)
        .where(eq(schema.catalogProducts.productId, productId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new Error(
          `writeAdapterOutput: resolved productId ${productId} not found mid-transaction`
        );
      }
      priorValues = (row.values ?? {}) as ValuesJson;

      // Bump identity_strength only when the new evidence is at least as
      // strong as what we already have. Identity field updates (gtin / mpn
      // / brand mutations) are NOT performed here — Task 3.7 owns that
      // policy gate.
      const priorIdentity = (row.identity ?? {}) as Record<string, unknown>;
      const priorStrength = Number(
        (priorIdentity["identity_strength"] as number | undefined) ?? 0
      );
      if (identity.strength > priorStrength) {
        await tx
          .update(schema.catalogProducts)
          .set({
            identity: {
              ...priorIdentity,
              identity_strength: identity.strength
            }
          })
          .where(eq(schema.catalogProducts.productId, productId));
      }

      // Identity update policy gate (Task 3.7, spec §6.1). For each identity
      // field present in the hint, route through `applyIdentityObservation`.
      // The gate enforces:
      //   - single priority-1 source can update gtin/mpn unless another
      //     priority-1 source disagrees (then FREEZE + review_task)
      //   - 3 consecutive priority-1 observations required for brand /
      //     model_number
      //   - identity_strength < 0.7 freezes any update
      //   - auto-unfreeze after 5 consecutive matching observations
      //
      // We pull source / sourceRecordId / observedAt from the first
      // observation (or pricing/inventory) in the adapter output. The CREATE
      // branch deliberately skips this gate — first-time identity assignment
      // has no prior state to disagree with.
      const firstSignal =
        adapterOutput.observations[0] ??
        adapterOutput.pricingObservations[0] ??
        adapterOutput.inventoryObservations[0];
      if (firstSignal) {
        const policySource = firstSignal.source;
        const policySourceRecordId = firstSignal.sourceRecordId;
        const policyObservedAt = firstSignal.observedAt;
        const hint = adapterOutput.identityHint;
        const proposedByField: Record<IdentityField, string | undefined> = {
          gtin: hint.gtin,
          mpn: hint.mpn,
          brand: hint.brand,
          model_number: hint.model_number
        };
        const fields: IdentityField[] = ["gtin", "mpn", "brand", "model_number"];
        for (const field of fields) {
          const proposed = proposedByField[field];
          if (typeof proposed !== "string" || proposed.length === 0) continue;
          await applyIdentityObservation({
            db: tx as unknown as DrizzleClient,
            productId,
            field,
            proposedValue: proposed,
            source: policySource,
            sourceRecordId: policySourceRecordId,
            observedAt: policyObservedAt
          });
        }
      }
    } else {
      created = true;
      priorValues = {};
      const primaryIdentifier =
        adapterOutput.identityHint.gtin ??
        adapterOutput.identityHint.mpn ??
        adapterOutput.identityHint.primary_identifier ??
        stableNonUuidIdentifier(adapterOutput.identityHint);
      const identityJson: Record<string, unknown> = {
        identity_strength: identity.strength
      };
      if (adapterOutput.identityHint.gtin)
        identityJson["gtin"] = adapterOutput.identityHint.gtin;
      if (adapterOutput.identityHint.mpn)
        identityJson["mpn"] = adapterOutput.identityHint.mpn;
      if (adapterOutput.identityHint.brand)
        identityJson["brand"] = adapterOutput.identityHint.brand;
      if (adapterOutput.identityHint.primary_identifier)
        identityJson["primary_identifier"] = adapterOutput.identityHint.primary_identifier;

      const classifySignals: { categoryPath?: string; title?: string; brand?: string } = {};
      const categoryPathVal = latestObservationValue(adapterOutput, "category_path") as
        | string
        | undefined;
      if (typeof categoryPathVal === "string") classifySignals.categoryPath = categoryPathVal;
      const titleVal = latestObservationValue(adapterOutput, "title") as string | undefined;
      if (typeof titleVal === "string") classifySignals.title = titleVal;
      if (adapterOutput.identityHint.brand)
        classifySignals.brand = adapterOutput.identityHint.brand;
      const familyId = classifyArchetype(classifySignals);
      const family = familyId === "unknown" ? null : familyId;

      const inserted = await tx
        .insert(schema.catalogProducts)
        .values({
          tenantId,
          merchantId,
          primaryIdentifier,
          identity: identityJson,
          family,
          status: "draft",
          values: {},
          winningValues: {}
        })
        .returning({ productId: schema.catalogProducts.productId });
      const row = inserted[0];
      if (!row) {
        throw new Error(
          "writeAdapterOutput: insert into catalog_products returned no row"
        );
      }
      productId = row.productId;
    }

    // ---- 3. Append CanonicalObservations into values JSONB --------------
    const nextValues: ValuesJson = JSON.parse(JSON.stringify(priorValues));
    const overflowEvicted: Array<{
      attribute_code: string;
      channel_code: string;
      locale_code: string;
      observation: StoredObservation;
    }> = [];
    let observationsWritten = 0;
    const touchedAttributes = new Set<string>();

    for (const obs of adapterOutput.observations) {
      const leaf = ensureLeaf(
        nextValues,
        obs.attributeCode,
        obs.channelCode,
        obs.localeCode
      );

      // Dedup hint: same (source, source_record_id, value) already present
      // → skip silently. The adapter is asserting "nothing new here".
      const isDup = leaf.some(
        (existing) =>
          existing.source === obs.source &&
          existing.source_record_id === obs.sourceRecordId &&
          valueEquals(existing.value, obs.value)
      );
      if (isDup) continue;

      const stored: StoredObservation = {
        source: obs.source,
        source_record_id: obs.sourceRecordId,
        value: obs.value,
        confidence: obs.confidence,
        observed_at: obs.observedAt.toISOString()
      };
      if (obs.extras) stored.extras = obs.extras;

      leaf.push(stored);
      observationsWritten++;
      touchedAttributes.add(obs.attributeCode);

      // Cap-and-overflow: if we now exceed the cap, evict the OLDEST by
      // observed_at. Mutates the leaf in place.
      while (leaf.length > observationCap) {
        let oldestIdx = 0;
        let oldestAt = Date.parse(leaf[0]!.observed_at);
        for (let i = 1; i < leaf.length; i++) {
          const t = Date.parse(leaf[i]!.observed_at);
          if (t < oldestAt) {
            oldestAt = t;
            oldestIdx = i;
          }
        }
        const [evicted] = leaf.splice(oldestIdx, 1);
        if (evicted) {
          overflowEvicted.push({
            attribute_code: obs.attributeCode,
            channel_code: obs.channelCode,
            locale_code: obs.localeCode,
            observation: evicted
          });
        }
      }
    }

    // Persist the updated values JSONB. We always write — even when
    // observationsWritten === 0 — because the touched code still wants a
    // deterministic updated_at bump in the same transaction. But to avoid
    // a no-op rewrite for the pure-pricing/pure-inventory case, only update
    // when something actually changed.
    if (observationsWritten > 0) {
      await tx
        .update(schema.catalogProducts)
        .set({ values: nextValues as Record<string, unknown> })
        .where(eq(schema.catalogProducts.productId, productId));
    }

    // ---- 4. Side-table inserts (pricing / inventory) --------------------
    let pricingObservationsWritten = 0;
    let inventoryObservationsWritten = 0;

    if (adapterOutput.pricingObservations.length > 0) {
      // channelCodeToId is guaranteed present by the precondition above.
      const map = channelCodeToId!;
      const insertRows = adapterOutput.pricingObservations.map((p) => {
        const channelId = map[p.channelCode];
        if (!channelId) {
          throw new Error(
            `writeAdapterOutput: no channelId for pricing channelCode "${p.channelCode}"`
          );
        }
        return {
          productId,
          tenantId,
          channelId,
          locale: p.locale,
          source: p.source,
          sourceRecordId: p.sourceRecordId,
          currency: p.currency,
          tiers: p.tiers,
          pricePerUnit: p.pricePerUnit ?? null,
          observedAt: p.observedAt,
          artifactId: (p.artifactId as ArtifactId | undefined) ?? null,
          extras: p.extras ?? null
        };
      });
      await tx.insert(schema.catalogPricingObservations).values(insertRows);
      pricingObservationsWritten = insertRows.length;
    }

    if (adapterOutput.inventoryObservations.length > 0) {
      const map = channelCodeToId!;
      const insertRows = adapterOutput.inventoryObservations.map((i) => {
        const channelId = map[i.channelCode];
        if (!channelId) {
          throw new Error(
            `writeAdapterOutput: no channelId for inventory channelCode "${i.channelCode}"`
          );
        }
        return {
          productId,
          tenantId,
          channelId,
          locationId: (i.locationId as string | undefined) ?? null,
          qty: i.qty,
          clickCollectEligible: i.clickCollectEligible ?? null,
          purchaseLimit: i.purchaseLimit ?? null,
          backorderAllowed: i.backorderAllowed ?? null,
          source: i.source,
          sourceRecordId: i.sourceRecordId,
          observedAt: i.observedAt,
          artifactId: (i.artifactId as ArtifactId | undefined) ?? null
        };
      });
      await tx.insert(schema.catalogInventoryObservations).values(insertRows);
      inventoryObservationsWritten = insertRows.length;
    }

    // ---- 5. Sync reconciler --------------------------------------------
    // Re-project the touched attribute codes. Pricing/inventory winners
    // ride the async-debounced worker (Task 3.6) — we deliberately exclude
    // them here. Their winning_values projection lands later and is a no-op
    // for this write's outbox event (which carries v1 attribute names only).
    let syncReconcilerResult:
      | Pick<ProjectSyncResult, "attributesProjected" | "changedAttributes">
      | null = null;

    const syncAttributes = Array.from(touchedAttributes);
    if (syncAttributes.length > 0) {
      const projection = await projectSync({
        db: tx as unknown as DrizzleClient,
        productId,
        affectedAttributes: syncAttributes,
        rulesVersion
      });
      syncReconcilerResult = {
        attributesProjected: projection.attributesProjected,
        changedAttributes: projection.changedAttributes
      };
    }
    // Async-tier deferral (v1): pricing / inventory winners would normally
    // enqueue a BullMQ debounced job here. Task 3.6 owns the worker — we
    // skip silently rather than fail the write.

    // ---- 6. Revision row ------------------------------------------------
    // Re-read the freshly updated row so the snapshot captures projectSync's
    // winning_values writes too.
    const after = await tx
      .select({
        values: schema.catalogProducts.values,
        winningValues: schema.catalogProducts.winningValues
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId))
      .limit(1);
    const afterRow = after[0];
    if (!afterRow) {
      throw new Error(
        `writeAdapterOutput: product ${productId} disappeared mid-transaction`
      );
    }

    const sourceKindForRevision = sourceOverride ?? actor.split(":")[0] ?? actor;
    const firstObs = adapterOutput.observations[0];
    const firstPricing = adapterOutput.pricingObservations[0];
    const firstInventory = adapterOutput.inventoryObservations[0];
    const sourceRecordIdForRevision =
      firstObs?.sourceRecordId ??
      firstPricing?.sourceRecordId ??
      firstInventory?.sourceRecordId ??
      null;
    const observedAtForRevision =
      firstObs?.observedAt ??
      firstPricing?.observedAt ??
      firstInventory?.observedAt ??
      null;

    const diffBlock =
      overflowEvicted.length > 0
        ? { overflow_eviction: overflowEvicted }
        : null;

    const revisionRows = await tx
      .insert(schema.catalogProductRevisions)
      .values({
        productId,
        tenantId,
        valuesSnapshot: (afterRow.values ?? {}) as Record<string, unknown>,
        winningSnapshot: (afterRow.winningValues ?? null) as Record<
          string,
          unknown
        > | null,
        diff: diffBlock,
        revisionReason: reasonOverride ?? (created ? "create" : "new_source"),
        sourceKind: sourceKindForRevision,
        sourceRecordId: sourceRecordIdForRevision,
        rawPayload: adapterOutput.rawPayload as Record<string, unknown> | null,
        observedAt: observedAtForRevision,
        actor
      })
      .returning({
        revisionId: schema.catalogProductRevisions.revisionId
      });
    const revisionId = revisionRows[0]?.revisionId;
    if (revisionId === undefined) {
      throw new Error(
        "writeAdapterOutput: revision insert returned no revision_id"
      );
    }

    // ---- 7. Outbox event ------------------------------------------------
    const eventPayload: Record<string, unknown> = {
      productId,
      identityStrength: identity.strength,
      matchPath: (created ? "newly_created" : identity.matchPath) as WriteMatchPath,
      attributesChanged: syncReconcilerResult?.changedAttributes ?? []
    };
    const eventRows = await tx
      .insert(schema.catalogEvents)
      .values({
        eventType: created
          ? "catalog.product.created"
          : "catalog.product.updated",
        productId,
        tenantId,
        payload: eventPayload,
        triggeredBy: actor
      })
      .returning({ eventId: schema.catalogEvents.eventId });
    const eventId = eventRows[0]?.eventId;
    if (eventId === undefined) {
      throw new Error(
        "writeAdapterOutput: event insert returned no event_id"
      );
    }

    // ---- 8. Return ------------------------------------------------------
    return {
      productId,
      created,
      identityStrength: identity.strength,
      matchPath: (created ? "newly_created" : identity.matchPath) as WriteMatchPath,
      reviewTaskSuggested: identity.reviewTaskSuggested,
      revisionId,
      eventId,
      observationsWritten,
      pricingObservationsWritten,
      inventoryObservationsWritten,
      overflowEvictions: overflowEvicted.length,
      syncReconcilerResult
    };
  });
}

