// Catalog redesign — synchronous reconciler wrapper (plan §3.4, spec §13.4).
//
// Wraps the pure `pickWinner` projection (Task 3.3) with DB I/O:
//   1. Per-product advisory lock inside a transaction.
//   2. Loads the catalog_products row + active source_priority rules for the
//      tenant scoped to the attribute codes the caller cares about.
//   3. For each (attribute, channel, locale) leaf under `values`, calls
//      `pickWinner` and writes the result into `winning_values`.
//   4. Stamps a `_meta` block (reconciler_version, rules_version, computed_at)
//      at `winning_values._meta` — sibling to the per-attribute leaves.
//   5. Atomically UPDATE-s `catalog_products.winning_values` in the same txn.
//
// Sync vs async tier (spec §13.4): this wrapper handles the sync tier (low-
// frequency attributes like title, brand, description, identity, etc.).
// Pricing/inventory go through the debounced async worker (Task 3.6). The
// `projectSync` function itself is attribute-agnostic — the caller decides
// which codes to pass; tier selection lives in the catalog write service
// (Task 3.5) which consults `attribute_definitions.reconciliation_path`.
//
// `_meta` placement choice for v1: nested under `winning_values._meta`
// (sibling to per-attribute keys). This keeps the schema additive — no
// extra column. The leading underscore is reserved across the codebase for
// sentinel/meta keys (see spec §7 `_unscoped` / `_primary`), so an attribute
// named `_meta` would already be illegal. Future iterations may promote
// this to a dedicated column if read patterns demand it.

import { eq, sql } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import {
  RECONCILER_VERSION,
  pickWinner,
  type PickWinnerObservation
} from "./pick-winner.js";
import { deepEqual, loadActiveRules } from "./_internal.js";
import { computeCompletenessScore } from "../completeness-score.js";

// ---- Public types ----------------------------------------------------------

export interface ProjectSyncInput {
  db: DrizzleClient;
  productId: string;
  /**
   * Which attribute codes to recompute. Allows targeted reconciliation:
   * when a new pricing observation lands, we only need to recompute
   * pricing — not title, brand, etc.
   */
  affectedAttributes: string[];
  /**
   * Pinned at call time so the result is reproducible even if the
   * source_priority table changes mid-flight. Stamped into `_meta`.
   */
  rulesVersion: number;
}

export interface ProjectSyncResult {
  productId: string;
  /** Attribute codes that were actually present in `values` and got projected. */
  attributesProjected: string[];
  /** Attribute codes whose winning value flipped vs the prior winning_values. */
  changedAttributes: string[];
  computedAt: Date;
}

// ---- Internal shapes -------------------------------------------------------

/** Shape of one observation as it lives at a leaf of `values[attr][channel][locale]`. */
interface ValuesObservation {
  source: string;
  source_record_id: string;
  value: unknown;
  confidence: number;
  observed_at: string; // ISO-8601
  ingested_at?: string;
  artifact_id?: string;
  extras?: Record<string, unknown>;
}

/**
 * The `values` JSONB shape per spec §7:
 *   { [attr]: { [channel]: { [locale]: ValuesObservation[] } } }
 *
 * Leaves are arrays of observations — `pickWinner` consumes the whole list.
 */
type ValuesJson = Record<
  string,
  Record<string, Record<string, ValuesObservation[]>>
>;

/**
 * The `winning_values` JSONB shape: a sibling `_meta` block plus
 *   { [attr]: { [channel]: { [locale]: <winning value> } } }
 * The leaf is the projected scalar/compound — NOT an observation.
 */
type WinningValuesJson = Record<string, unknown> & {
  _meta?: WinningValuesMeta;
};

interface WinningValuesMeta {
  reconciler_version: string;
  rules_version: number;
  computed_at: string;
}

// ---- Helpers ---------------------------------------------------------------

function toPickWinnerObservation(o: ValuesObservation): PickWinnerObservation {
  return {
    source: o.source,
    sourceRecordId: o.source_record_id,
    value: o.value,
    confidence: o.confidence,
    observedAt: new Date(o.observed_at)
  };
}

// ---- Public API ------------------------------------------------------------

/**
 * Recompute `winning_values` for the given product across the listed
 * affected attribute codes. Synchronous (in-band) — for low-frequency
 * attributes. Uses a transaction-scoped advisory lock so concurrent
 * reconciliations of the same product serialize safely.
 */
export async function projectSync(
  input: ProjectSyncInput
): Promise<ProjectSyncResult> {
  const { db, productId, affectedAttributes, rulesVersion } = input;

  return db.transaction(async (tx) => {
    // 1. Per-product advisory lock — released on commit/rollback. hashtext
    //    gives us an int4 from a uuid string; collisions are acceptable here
    //    (worst case: occasional false serialization of unrelated products).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${productId}))`
    );

    // 2. Load the product row. SELECT FOR UPDATE not needed — the advisory
    //    lock already serializes concurrent projectSync calls for the same
    //    product, and we don't care about contention with non-reconciler
    //    writers (they touch `values`, not `winning_values`).
    const rows = await tx
      .select({
        productId: schema.catalogProducts.productId,
        tenantId: schema.catalogProducts.tenantId,
        family: schema.catalogProducts.family,
        identifiers: schema.catalogProducts.identifiers,
        values: schema.catalogProducts.values,
        winningValues: schema.catalogProducts.winningValues,
        // Commerce facts live outside winning_values — read the generated columns
        // (migration 0009) cheaply from the same row for the completeness score.
        genPrice: sql<string | null>`gen_primary_price`,
        genCurrency: sql<string | null>`gen_primary_currency`,
        genGtin: sql<string | null>`gen_gtin`,
        genTitle: sql<string | null>`gen_title`
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new Error(`projectSync: product ${productId} not found`);
    }

    const valuesJson = (row.values ?? {}) as ValuesJson;
    const priorWinningValues = (row.winningValues ?? {}) as WinningValuesJson;

    // 3. Load active rules for this tenant + relevant attributes. Shared
    //    helper handles the filter shape (single eq vs inArray) and the
    //    empty-attributes short-circuit.
    const rules = await loadActiveRules(
      tx as unknown as DrizzleClient,
      row.tenantId,
      affectedAttributes
    );

    // 4. Walk each affected attribute. Build the new `winning_values` block
    //    incrementally so we keep prior projections for any attribute we did
    //    not touch this round.
    const nextWinningValues: WinningValuesJson = { ...priorWinningValues };
    delete nextWinningValues._meta; // we'll restamp below

    const attributesProjected: string[] = [];
    const changedAttributes: string[] = [];

    for (const attr of affectedAttributes) {
      const attrValues = valuesJson[attr];
      // Skip attributes not present in values JSONB (e.g. ghost attributes
      // the caller listed defensively).
      if (!attrValues || typeof attrValues !== "object") continue;

      attributesProjected.push(attr);

      const priorForAttr =
        (priorWinningValues[attr] as
          | Record<string, Record<string, unknown>>
          | undefined) ?? {};
      const nextForAttr: Record<string, Record<string, unknown>> = {};

      let attrChanged = false;

      for (const [channel, byLocale] of Object.entries(attrValues)) {
        if (!byLocale || typeof byLocale !== "object") continue;
        const nextChannel: Record<string, unknown> = {};

        for (const [locale, observations] of Object.entries(byLocale)) {
          if (!Array.isArray(observations) || observations.length === 0) {
            continue;
          }

          const result = pickWinner({
            observations: observations.map(toPickWinnerObservation),
            rules,
            channel,
            attributeCode: attr
          });
          if (result === null) continue;

          nextChannel[locale] = result.value;

          const priorValue = priorForAttr?.[channel]?.[locale];
          if (!deepEqual(priorValue, result.value)) {
            attrChanged = true;
          }
        }

        if (Object.keys(nextChannel).length > 0) {
          nextForAttr[channel] = nextChannel;
        }
      }

      // If prior had channels/locales we no longer have data for, that's
      // also a change — they get dropped from the new projection.
      const priorChannelKeys = Object.keys(priorForAttr ?? {});
      const nextChannelKeys = Object.keys(nextForAttr);
      if (
        !attrChanged &&
        (priorChannelKeys.length !== nextChannelKeys.length ||
          priorChannelKeys.some((k) => !(k in nextForAttr)))
      ) {
        attrChanged = true;
      }

      nextWinningValues[attr] = nextForAttr;
      if (attrChanged) changedAttributes.push(attr);
    }

    // 5. Stamp `_meta` and atomically UPDATE.
    const computedAt = new Date();
    const meta: WinningValuesMeta = {
      reconciler_version: RECONCILER_VERSION,
      rules_version: rulesVersion,
      computed_at: computedAt.toISOString()
    };
    nextWinningValues._meta = meta;

    // Recompute the server-authoritative completeness score from the fresh winners
    // plus commerce facts. Additive: folded into the same UPDATE, never throws
    // (computeCompletenessScore falls back to the generic archetype).
    const identifiers = row.identifiers;
    const hasIdentifier =
      row.genGtin != null || (Array.isArray(identifiers) && identifiers.length > 0);
    const score = computeCompletenessScore({
      family: row.family ?? null,
      winningValues: nextWinningValues,
      hasPrice: row.genPrice != null,
      hasCurrency: row.genCurrency != null,
      hasIdentifier,
      hasTitle: row.genTitle != null || "title" in nextWinningValues
    });

    await tx
      .update(schema.catalogProducts)
      .set({
        winningValues: nextWinningValues,
        completenessScore: score.percent.toFixed(2),
        scoreBreakdown: score,
        updatedAt: computedAt
      })
      .where(eq(schema.catalogProducts.productId, productId));

    return {
      productId,
      attributesProjected,
      changedAttributes,
      computedAt
    };
  });
}
