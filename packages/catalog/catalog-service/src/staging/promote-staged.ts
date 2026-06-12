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
 * Reserved channel code for Lab-fill PricingObservations. When `applyFills`
 * can't determine a real channel (e.g. ingest's channel lookup returned null,
 * so no PricingObservation was emitted), it tags the synthetic price with
 * this code. `resolveChannelCodeToId` ensures a matching channel row exists
 * for the tenant — auto-creating one on first use so the Lab promote always
 * has a valid FK target.
 */
const MANUAL_CHANNEL_CODE = "manual";

/**
 * Ensure a per-tenant `channels` row with kind="manual" exists for Lab fills.
 * Idempotent — returns the existing row's id when one is already present.
 * Created on demand rather than in a migration so we don't backfill the row
 * for tenants that never touch the Lab.
 */
async function ensureManualChannel(
  tx: DrizzleClient,
  tenantId: TenantId
): Promise<ChannelId> {
  const existing = await tx
    .select({ channelId: schema.channels.channelId })
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.tenantId, tenantId as unknown as string),
        eq(schema.channels.channelKind, MANUAL_CHANNEL_CODE)
      )
    )
    .limit(1);
  const found = existing[0];
  if (found) return found.channelId as ChannelId;

  // Insert + return. ON CONFLICT DO NOTHING handles concurrent creates:
  // the unique key is (tenant_id, channel_kind, region, account_ref) with
  // NULLS NOT DISTINCT, so a second concurrent insert returns zero rows
  // (which means another tx beat us) and we re-select.
  const inserted = await tx
    .insert(schema.channels)
    .values({
      tenantId: tenantId as unknown as string,
      channelKind: MANUAL_CHANNEL_CODE,
      displayName: "Manual (Lab fills)"
    })
    .onConflictDoNothing()
    .returning({ channelId: schema.channels.channelId });
  const created = inserted[0];
  if (created) return created.channelId as ChannelId;

  // Concurrent insert won; re-read.
  const reread = await tx
    .select({ channelId: schema.channels.channelId })
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.tenantId, tenantId as unknown as string),
        eq(schema.channels.channelKind, MANUAL_CHANNEL_CODE)
      )
    )
    .limit(1);
  const winner = reread[0];
  if (!winner) {
    throw new Error(
      `ensureManualChannel: failed to find or create manual channel for tenant ${tenantId}`
    );
  }
  return winner.channelId as ChannelId;
}

/**
 * Ensure a per-host `direct` channel exists for a channel-less link product
 * (kind="direct", region=<channelCode>). Mirrors resolveOrCreateDirectChannel
 * in the ingest path so a product that admitted to a 'direct' channel can be
 * promoted from the Lab without the pricing observation FK-tripping. Idempotent.
 */
async function ensureDirectChannel(
  tx: DrizzleClient,
  tenantId: TenantId,
  code: string
): Promise<ChannelId> {
  const find = async () => {
    const rows = await tx
      .select({ channelId: schema.channels.channelId })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.tenantId, tenantId as unknown as string),
          eq(schema.channels.channelKind, "direct"),
          eq(schema.channels.region, code)
        )
      )
      .limit(1);
    return rows[0]?.channelId as ChannelId | undefined;
  };
  const existing = await find();
  if (existing) return existing;
  await tx
    .insert(schema.channels)
    .values({
      tenantId: tenantId as unknown as string,
      channelKind: "direct",
      region: code,
      displayName: code
    })
    .onConflictDoNothing();
  const winner = await find();
  if (!winner) {
    throw new Error(`ensureDirectChannel: failed to find or create direct channel ${code} for tenant ${tenantId}`);
  }
  return winner;
}

/**
 * Resolve channelCode → channelId for any pricing/inventory observations.
 * Queries all channels for the tenant, then matches each code using the
 * same derivation as resolveChannelByCode: `${channelKind}-${region}` or
 * `${channelKind}` for rows without a region. The reserved `"manual"` code
 * auto-creates a tenant-scoped Lab-fill channel on demand.
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
    // Reserved Lab-fill channel — auto-create on first use so promote never
    // FK-trips on the synthetic pricing observation applyFills emits.
    if (code === MANUAL_CHANNEL_CODE) {
      result[code] = await ensureManualChannel(tx, tenantId);
      continue;
    }
    // Resolve the SAME way the ingest-time resolver (resolveChannelByCode in
    // apps/worker/src/services/new-catalog-link-path.ts) does: by channel KIND
    // — the prefix before the first "-". A channelCode is "<kind>-<urlTld>"
    // (e.g. "amazon-in" from channelCodeFromUrl) or a bare "<kind>". Among rows
    // of that kind, prefer one whose region matches the code's suffix
    // case-INSENSITIVELY (region is stored upper-case e.g. "IN" while the code
    // carries the lower-case URL tld "in"); otherwise fall back to the first
    // row of that kind.
    //
    // The previous implementation required an exact `${kind}-${region}` match
    // and was the cause of approve 500s: it never matched "amazon-in" against
    // an ("amazon","IN") row (case differs), so a product that resolved fine at
    // ingest (kind-only match) failed channel resolution at promote and threw.
    const kind = code.split("-")[0] ?? code;
    const suffix = code.slice(kind.length + 1).toLowerCase(); // "" for a bare kind
    const kindMatches = rows.filter((r) => r.channelKind === kind);
    const regionMatch = suffix
      ? kindMatches.find((r) => (r.region ?? "").toLowerCase() === suffix)
      : undefined;
    const matched = regionMatch ?? kindMatches[0];
    if (matched) {
      result[code] = matched.channelId as ChannelId;
      continue;
    }
    // No marketplace channel for this code — it's a channel-less link product
    // that admitted (or would admit) under a per-host 'direct' channel. Resolve
    // (or create) that same direct channel so promote doesn't 500 on the
    // pricing observation. This is the fix for the Lab "Push to Catalog"
    // INTERNAL error on decathlon.in-style products.
    result[code] = await ensureDirectChannel(tx, tenantId, code);
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
 *   - `identifier` fill                →  set identityHint.primary_identifier
 *     (the anomaly-lab form's "Identifier (GTIN, MPN, or your SKU)" field is a
 *     generic hard ID; primary_identifier is the catch-all the gate's
 *     hasIdentifier() accepts and what becomes the product's primary_identifier)
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

  const identityFillKeys = new Set(["brand", "gtin", "mpn", "identifier"]);

  for (const [key, value] of Object.entries(fills)) {
    if (identityFillKeys.has(key)) {
      if (key === "brand") cloned.identityHint.brand = value as string;
      else if (key === "gtin") cloned.identityHint.gtin = value as string;
      else if (key === "mpn") cloned.identityHint.mpn = value as string;
      // The UI's "identifier" field is a generic hard ID (GTIN, MPN, or SKU);
      // map it to primary_identifier — the bucket hasIdentifier() accepts and
      // that catalog-write uses as the product's primary_identifier.
      else if (key === "identifier") cloned.identityHint.primary_identifier = value as string;
    } else if (key === "price") {
      const amount = parseFloat(String(value).replace(/[^\d.]/g, ""));
      if (Number.isFinite(amount)) {
        // Pricing FKs to channels.channel_id, so we need a code that
        // resolveChannelCodeToId can map to a real row. Fall back through:
        // staged row's channel → caller-provided → any EXISTING pricing
        // observation's channel (already proven to resolve at ingest) →
        // "manual" (a per-tenant Lab-fill channel that resolveChannelCodeToId
        // auto-creates on demand). We deliberately do NOT fall through to a
        // canonical observation's channelCode — those can carry an
        // unresolved derived code (e.g. "nike-in" when the ingest's channel
        // lookup returned null and pricing was stripped).
        const existingPricingChannel = cloned.pricingObservations[0]?.channelCode;
        const resolvedChannel =
          stagedChannelCode ??
          (fills["channelCode"] as string | undefined) ??
          existingPricingChannel ??
          MANUAL_CHANNEL_CODE;
        cloned.pricingObservations.push({
          productHint: "",
          channelCode: resolvedChannel,
          locale: "_unscoped",
          source: "manual:lab",
          sourceRecordId: `manual:lab:fill:price`,
          currency: (fills["currency"] as string | undefined) ?? "USD",
          tiers: [{ kind: "list", amount }],
          observedAt: now.toISOString()
        });
      }
    } else if (key === "currency" || key === "channelCode") {
      // consumed alongside price; do not emit a synthetic observation
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

    // ---- Step 3: Re-run the gate (skip when linking to a confirmed existing product) --
    const verdict = evaluateGate({ adapterOutput: filledOutput, signals: [] });
    // When linking to a confirmed existing product (confirmedMatchProductId set),
    // the target already passed the gate; the incoming staged item may be partial,
    // so we skip the completeness re-check and enrich the existing product.
    if (!confirmedMatchProductId && !verdict.admit) {
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
      // Carry the category the spine auto-assigned at ingestion through to the
      // admitted product (only applied on create, never overrides an existing
      // product's category — see writeAdapterOutput). Preserves categorization
      // across the staged → approve path.
      ...(staged.categoryNodeId ? { categoryNodeId: staged.categoryNodeId } : {}),
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

export const __applyFillsForTest = applyFills;

