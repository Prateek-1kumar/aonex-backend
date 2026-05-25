// Anomaly Lab — Task 8. promoteStagedProduct: promotes a pending staged row
// into the catalog after reviewer fills satisfy the readiness gate.
//
// Atomicity contract:
//   All writes (catalog_products, reconciliation_overrides, staged_products
//   status update) happen inside ONE outer db.transaction(). writeAdapterOutput
//   opens its own db.transaction() internally — when called with a `tx` handle,
//   drizzle-orm/node-postgres issues a SAVEPOINT instead of a nested BEGIN,
//   so writeAdapterOutput's work participates in the outer transaction and is
//   rolled back together on failure. The non-negotiable invariant: a
//   StillIncompleteError or any other failure writes NOTHING (no product,
//   no pins, staged row stays pending).
//
// Channel resolution:
//   The staged row's `observations` column holds the original AdapterOutput
//   (serialised as JSONB). Pricing/inventory observations carry channelCodes
//   that must be mapped to channelIds for the side-table NOT NULL constraint.
//   We collect distinct channelCodes, then query the `channels` table for this
//   tenant and match by deriving `${channelKind}-${region}` or `${channelKind}`,
//   mirroring the approach in apps/worker/src/services/new-catalog-link-path.ts.
//
// See spec §7.1 for the reconciliation_overrides pinning semantics.

import { eq, and } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId, ChannelId, MerchantId } from "@aonex/types";
import type { AdapterOutput, CanonicalObservation } from "@aonex/catalog-source-adapters";
import { evaluateGate } from "../gate/evaluate-gate.js";
import { writeAdapterOutput } from "../catalog-write.js";

// ---- Error class -----------------------------------------------------------

export class StillIncompleteError extends Error {
  constructor(public readonly stillMissing: string[]) {
    super(`Still missing required fields: ${stillMissing.join(", ")}`);
    this.name = "StillIncompleteError";
  }
}

// ---- Public types ----------------------------------------------------------

export interface PromoteStagedInput {
  db: DrizzleClient;
  tenantId: TenantId;
  stagedProductId: string;
  resolvedBy: string;
  fills: Record<string, unknown>;
  confirmedMatchProductId?: string;
}

export interface PromoteStagedResult {
  productId: string | null;
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Resolve channelCode → channelId for any pricing/inventory observations.
 * Queries all channels for the tenant, then matches each code using the
 * same derivation as resolveChannelByCode: `${channelKind}-${region}` or
 * `${channelKind}` for rows without a region.
 */
async function resolveChannelCodeToId(
  tx: DrizzleClient,
  tenantId: TenantId,
  channelCodes: string[]
): Promise<Record<string, ChannelId>> {
  if (channelCodes.length === 0) return {};

  const rows = await tx
    .select({
      channelId: schema.channels.channelId,
      channelKind: schema.channels.channelKind,
      region: schema.channels.region
    })
    .from(schema.channels)
    .where(eq(schema.channels.tenantId, tenantId as unknown as string));

  const result: Record<string, ChannelId> = {};

  for (const code of channelCodes) {
    // Derive the canonical form for each row — `${channelKind}-${region}` when
    // the row has a region, or bare `${channelKind}` for region-null rows.
    // Match ONLY against the derived form: the bare `|| code === r.channelKind`
    // fallback was removed because it is non-deterministic when a tenant has
    // multiple region rows for the same kind (e.g. "shopify-au" + "shopify-us")
    // and the caller passes a bare "shopify" code. Channel codes at ingest are
    // always region-suffixed (e.g. "shopify-au") via channelCodeFromShopDomain /
    // channelCodeFromUrl, mirroring how resolveChannelByCode in
    // new-catalog-link-path.ts derives the kind but always matches against the
    // full code rather than the bare kind.
    const matched = rows.find((r) => {
      const derivedCode = r.region != null
        ? `${r.channelKind}-${r.region}`
        : r.channelKind;
      return code === derivedCode;
    });
    if (matched) {
      result[code] = matched.channelId as ChannelId;
    }
  }

  return result;
}

/**
 * Deserialise an AdapterOutput stored as JSONB — restores `Date` objects
 * from the ISO-8601 strings that Postgres stores in JSONB.
 */
function deserialiseAdapterOutput(raw: unknown): AdapterOutput {
  const r = raw as {
    observations: Array<Record<string, unknown>>;
    pricingObservations: Array<Record<string, unknown>>;
    inventoryObservations: Array<Record<string, unknown>>;
    identityHint: AdapterOutput["identityHint"];
    rawPayload: unknown;
  };

  return {
    identityHint: r.identityHint,
    rawPayload: r.rawPayload,
    observations: r.observations.map((o) => ({
      ...(o as Omit<CanonicalObservation, "observedAt">),
      observedAt: new Date(o["observedAt"] as string)
    })) as CanonicalObservation[],
    pricingObservations: r.pricingObservations.map((p) => ({
      ...p,
      observedAt: new Date(p["observedAt"] as string)
    })) as AdapterOutput["pricingObservations"],
    inventoryObservations: r.inventoryObservations.map((i) => ({
      ...i,
      observedAt: new Date(i["observedAt"] as string)
    })) as AdapterOutput["inventoryObservations"]
  };
}

/**
 * Apply reviewer fills to a cloned AdapterOutput (never mutates the original).
 *
 *   - `brand` / `gtin` / `mpn` fills  →  set on identityHint
 *   - any other fill key               →  append a synthetic CanonicalObservation
 *     (source "manual:lab", confidence 1.0, channelCode from staged row or
 *     "_unscoped" if none, localeCode "_unscoped")
 */
function applyFills(
  original: AdapterOutput,
  fills: Record<string, unknown>,
  stagedChannelCode: string | null
): AdapterOutput {
  // Deep clone via JSON round-trip — safe for our value shapes.
  const cloned = JSON.parse(JSON.stringify(original)) as {
    observations: Array<Record<string, unknown>>;
    pricingObservations: Array<Record<string, unknown>>;
    inventoryObservations: Array<Record<string, unknown>>;
    identityHint: AdapterOutput["identityHint"];
    rawPayload: unknown;
  };

  const channelCode = stagedChannelCode ?? "_unscoped";
  const now = new Date();

  const identityFillKeys = new Set(["brand", "gtin", "mpn"]);

  for (const [key, value] of Object.entries(fills)) {
    if (identityFillKeys.has(key)) {
      if (key === "brand") cloned.identityHint.brand = value as string;
      else if (key === "gtin") cloned.identityHint.gtin = value as string;
      else if (key === "mpn") cloned.identityHint.mpn = value as string;
    } else {
      cloned.observations.push({
        attributeCode: key,
        target: "parent",
        channelCode,
        localeCode: "_unscoped",
        source: "manual:lab",
        sourceRecordId: `manual:lab:fill:${key}`,
        value,
        confidence: 1.0,
        observedAt: now.toISOString()
      });
    }
  }

  // Restore Date objects before returning.
  return {
    identityHint: cloned.identityHint,
    rawPayload: cloned.rawPayload,
    observations: cloned.observations.map((o) => ({
      ...(o as Omit<CanonicalObservation, "observedAt">),
      observedAt: new Date(o["observedAt"] as string)
    })) as CanonicalObservation[],
    pricingObservations: cloned.pricingObservations.map((p) => ({
      ...p,
      observedAt: new Date(p["observedAt"] as string)
    })) as AdapterOutput["pricingObservations"],
    inventoryObservations: cloned.inventoryObservations.map((i) => ({
      ...i,
      observedAt: new Date(i["observedAt"] as string)
    })) as AdapterOutput["inventoryObservations"]
  };
}

// ---- Public function -------------------------------------------------------

export async function promoteStagedProduct(
  input: PromoteStagedInput
): Promise<PromoteStagedResult> {
  const {
    db,
    tenantId,
    stagedProductId,
    resolvedBy,
    fills,
    confirmedMatchProductId
  } = input;

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as DrizzleClient;

    // ---- Step 1: Load staged row FOR UPDATE (optimistic lock) ---------------
    // SELECT FOR UPDATE locks the row. If a concurrent promote is in-flight,
    // this waits until that transaction commits/rolls back, then the status
    // check below catches the already-promoted row.
    const rows = await txDb
      .select()
      .from(schema.stagedProducts)
      .where(
        and(
          eq(schema.stagedProducts.stagedProductId, stagedProductId),
          eq(schema.stagedProducts.tenantId, tenantId as unknown as string)
        )
      )
      .for("update");

    const staged = rows[0];
    if (!staged) {
      throw new Error(
        `promoteStagedProduct: staged row not found (id=${stagedProductId}, tenantId=${tenantId as string})`
      );
    }
    if (staged.status !== "pending") {
      throw new Error(
        `promoteStagedProduct: staged row is not pending (status=${staged.status}, id=${stagedProductId})`
      );
    }

    // ---- Step 2: Deserialise + apply fills ----------------------------------
    const originalOutput = deserialiseAdapterOutput(staged.observations);
    const filledOutput = applyFills(
      originalOutput,
      fills,
      staged.channelCode ?? null
    );

    // ---- Step 3: Re-run the gate (always, even when confirmedMatchProductId) --
    const verdict = evaluateGate({ adapterOutput: filledOutput, signals: [] });
    if (!verdict.admit) {
      // StillIncompleteError causes the transaction to roll back — no product,
      // no pins, staged row stays pending.
      throw new StillIncompleteError(verdict.missingFields);
    }

    // ---- Step 4: Resolve channelCodes for pricing/inventory side tables -----
    const allChannelCodes = Array.from(
      new Set([
        ...filledOutput.pricingObservations.map((p) => p.channelCode),
        ...filledOutput.inventoryObservations.map((i) => i.channelCode)
      ])
    );
    const hasSideTableObs =
      filledOutput.pricingObservations.length > 0 ||
      filledOutput.inventoryObservations.length > 0;

    const channelCodeToId: Record<string, ChannelId> | undefined =
      hasSideTableObs
        ? await resolveChannelCodeToId(txDb, tenantId, allChannelCodes)
        : undefined;

    // Guard: every channelCode in pricing/inventory observations must have
    // resolved to a channelId. An unresolved code means the channel row was
    // removed after the product was staged — throw a clear error inside the
    // transaction so it rolls back cleanly. This is NOT a StillIncompleteError
    // (which signals a missing reviewer fill); it is a channel-resolution
    // failure that requires operator intervention (re-add the channel row).
    if (channelCodeToId !== undefined) {
      const unresolved = allChannelCodes.filter(
        (code) => !(code in channelCodeToId)
      );
      if (unresolved.length > 0) {
        throw new Error(
          `promoteStagedProduct: cannot resolve channel "${unresolved[0]}" for staged product ${stagedProductId}'s pricing/inventory; the channel may have been removed`
        );
      }
    }

    // ---- Step 5: Write the product via writeAdapterOutput -------------------
    // writeAdapterOutput calls tx.transaction() internally; since we are already
    // inside a transaction, drizzle-orm/node-postgres issues a SAVEPOINT — the
    // write participates in the outer transaction atomically.
    const writeResult = await writeAdapterOutput({
      db: txDb,
      tenantId,
      merchantId: staged.merchantId as unknown as MerchantId,
      adapterOutput: filledOutput,
      actor: "manual:lab",
      ...(channelCodeToId !== undefined ? { channelCodeToId } : {}),
      ...(confirmedMatchProductId !== undefined
        ? { forceProductId: confirmedMatchProductId }
        : {})
    });

    const { productId } = writeResult;

    // ---- Step 6: Pin all fills as reconciliation_overrides ------------------
    // Per spec §7.1: pin ALL fills (identity fills + attribute fills).
    //
    // Identity fills (brand/gtin/mpn) are pinned here for a durable audit trail
    // of the human decision — the pin records WHEN and by WHOM the identity was
    // confirmed. Note: these identity pins are INERT to the sync reconciler,
    // which only consumes overrides for value-attributes (via pickWinner);
    // identity fields are governed by the identity-policy gate, not by pins.
    const fillEntries = Object.entries(fills);
    if (fillEntries.length > 0) {
      await txDb.insert(schema.reconciliationOverrides).values(
        fillEntries.map(([attributeCode, frozenValue]) => ({
          productId,
          attributeCode,
          channelCode: "_unscoped",
          localeCode: "_unscoped",
          frozenValue: frozenValue as unknown,
          actor: "manual:lab",
          rationale: `anomaly-lab promotion of staged ${stagedProductId} by ${resolvedBy}`
        }))
      );
    }

    // ---- Step 7: Flip staged row to promoted --------------------------------
    // WHERE includes tenantId for defense-in-depth, matching the FOR UPDATE
    // select above.
    await txDb
      .update(schema.stagedProducts)
      .set({
        status: "promoted",
        resolvedBy,
        resolvedAt: new Date(),
        humanFills: fills as unknown,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(schema.stagedProducts.stagedProductId, stagedProductId),
          eq(schema.stagedProducts.tenantId, tenantId as unknown as string)
        )
      );

    return { productId };
  });
}
