// Catalog write service: the single funnel through which all AdapterOutputs
// land in the catalog (identity resolve, observation append, side-table
// inserts, sync reconcile, revision + outbox event). Every step runs in ONE
// transaction so we land everything or nothing; async reconcile enqueues post-commit.

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
import type { Queue } from "bullmq";
import { enqueueReconcilerJob } from "./reconciler/async-debounced.js";

export interface WriteAdapterOutputInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  adapterOutput: AdapterOutput;
  /** Free-form actor tag — "shopify:connector", "csv:upload", "link:processor", etc. */
  actor: string;
  /** Defaults to 1. Stamped on the projection meta. */
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
   * pricingObservations / inventoryObservations. The caller resolves these
   * from the channels table. Required iff the AdapterOutput carries pricing
   * or inventory observations.
   */
  channelCodeToId?: Record<string, ChannelId>;
  /**
   * Per-tenant BullMQ reconcile queue (`recon.<tenantId>`). When provided, a
   * debounced pricing/inventory reconcile job is enqueued AFTER the write
   * transaction commits, so the async worker projects the side-table
   * observations into catalog_*_current + winning_values.{pricing,inventory}.
   * Omitted by tests/back-compat callers → enqueue is a no-op.
   */
  reconcilerQueue?: Queue;
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
   * literal rather than "backfill".
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
   *   - The identity-policy gate still runs for any identity fields
   *     present in the hint: forcing only skips the resolution/match step,
   *     not the downstream identity-field promotion.
   */
  forceProductId?: string;
  /**
   * Canonical taxonomy node resolved at ingestion. Stamped on the row ONLY when
   * this call CREATES a new product (category_source='auto'); never overrides an
   * existing product's category (which may be human-set). Null/omitted leaves
   * category_node_id null (the classify sweep is the backstop).
   */
  categoryNodeId?: string | null;
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

export const DEFAULT_OBSERVATION_CAP = 20;

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
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
    values[attr]![channel]![locale] = [];
    return values[attr]![channel]![locale]!;
  }
  return leaf;
}

function stableNonUuidIdentifier(hint: AdapterOutput["identityHint"]): string {
  const seed = hint.titleForFuzzy ?? "";
  const fp = seed
    ? Buffer.from(seed).toString("hex").slice(0, 12)
    : "anon";
  return `catalog:${fp}:${randomUUID()}`;
}

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
    reconcilerQueue,
    reasonOverride,
    sourceOverride,
    forceProductId,
    categoryNodeId
  } = input;

  const hasSideTableObservations =
    adapterOutput.pricingObservations.length > 0 ||
    adapterOutput.inventoryObservations.length > 0;
  if (hasSideTableObservations && !channelCodeToId) {
    throw new Error(
      "channelCodeToId map required for side-table observations"
    );
  }

  const result = await db.transaction(async (tx) => {
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
    const identity: IdentityResolverResult = forceProductId
      ? {
          productId: forceProductId,
          strength: 1.0,
          reviewTaskSuggested: false,
          matchPath: "gtin",
          candidateProductIds: [forceProductId],
          candidates: [{ productId: forceProductId, score: 1.0, kind: "live" as const }]
        }
      : await resolveIdentity(resolveInput);

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
          pipelineVersion: 2,
          status: "draft",
          values: {},
          winningValues: {},
          ...(categoryNodeId
            ? { categoryNodeId, categorySource: "auto" as const }
            : {})
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

    if (observationsWritten > 0) {
      await tx
        .update(schema.catalogProducts)
        .set({ values: nextValues as Record<string, unknown> })
        .where(eq(schema.catalogProducts.productId, productId));
    }

    let pricingObservationsWritten = 0;
    let inventoryObservationsWritten = 0;

    if (adapterOutput.pricingObservations.length > 0) {
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

  if (reconcilerQueue) {
    try {
      if (adapterOutput.pricingObservations.length > 0) {
        await enqueueReconcilerJob(reconcilerQueue, {
          tenantId,
          productId: result.productId,
          attributeCode: "pricing",
          rulesVersion,
        });
      }
      if (adapterOutput.inventoryObservations.length > 0) {
        await enqueueReconcilerJob(reconcilerQueue, {
          tenantId,
          productId: result.productId,
          attributeCode: "inventory",
          rulesVersion,
        });
      }
    } catch (err) {
      console.error("writeAdapterOutput: post-commit reconcile enqueue failed (non-fatal)", err);
    }
  }
  return result;
}

