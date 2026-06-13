// Tests for mergeProducts + unmergeProduct against the real dev DB. Each test
// seeds catalog_products rows scoped to TEST_TENANT_ID with synthetic
// observations, then asserts the merge/unmerge invariants: observations moved,
// variants re-parented, side-tables moved, loser tombstoned, undo + idempotency.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  TEST_CHANNEL_ID,
  TEST_LOCATION_ID,
  TEST_MERCHANT_ID,
  TEST_TENANT_ID,
  closeTestDb,
  connectTestDb,
  ensureTestChannel,
  ensureTestInventoryLocation,
  ensureTestMerchant,
  ensureTestTenant
} from "@aonex/db/testing";
import type { TenantId } from "@aonex/types";
import { mergeProducts, splitProduct, unmergeProduct } from "./merge.js";

const TENANT = TEST_TENANT_ID as unknown as TenantId;
const TEST_ACTOR = "test:catalog-merge";

interface StoredObservation {
  source: string;
  source_record_id: string;
  value: unknown;
  confidence: number;
  observed_at: string;
}

function obsRow(
  source: string,
  value: unknown,
  recordId: string,
  observedAtIso = "2026-05-21T10:00:00Z"
): StoredObservation {
  return {
    source,
    source_record_id: recordId,
    value,
    confidence: 0.95,
    observed_at: observedAtIso
  };
}

async function seedProduct(
  db: DrizzleClient,
  opts: {
    primaryIdentifier: string;
    status?: string;
    values?: Record<string, unknown>;
    identity?: Record<string, unknown>;
    parentProductId?: string | null;
    tenantId?: string;
  }
): Promise<string> {
  const insertValues: typeof schema.catalogProducts.$inferInsert = {
    tenantId: opts.tenantId ?? TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    primaryIdentifier: opts.primaryIdentifier,
    identity: opts.identity ?? { brand: "TestBrand" },
    status: opts.status ?? "active",
    values: opts.values ?? {}
  };
  if (opts.parentProductId !== undefined) {
    insertValues.parentProductId = opts.parentProductId;
  }
  const rows = await db
    .insert(schema.catalogProducts)
    .values(insertValues)
    .returning({ productId: schema.catalogProducts.productId });
  return rows[0]!.productId;
}

async function seedRules(db: DrizzleClient): Promise<void> {
  await db.insert(schema.sourcePriority).values([
    {
      tenantId: null,
      attributeCode: null,
      sourceGlob: "premium:*",
      channelScope: null,
      priority: 1,
      rulesVersion: 1,
      actor: TEST_ACTOR
    },
    {
      tenantId: null,
      attributeCode: null,
      sourceGlob: "*",
      channelScope: null,
      priority: 100,
      rulesVersion: 1,
      actor: TEST_ACTOR
    }
  ]);
}

async function cleanup(db: DrizzleClient): Promise<void> {
  await db.execute(sql`
    DELETE FROM product_lineage
    WHERE product_id IN (
      SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
    )
    OR origin_product_id IN (
      SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
    )
  `);
  await db
    .delete(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.tenantId, TEST_TENANT_ID));
  await db.execute(sql`
    DELETE FROM catalog_pricing_current
    WHERE product_id IN (
      SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
    )
  `);
  await db.execute(sql`
    DELETE FROM catalog_inventory_current
    WHERE product_id IN (
      SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
    )
  `);
  await db.execute(
    sql`DELETE FROM catalog_events WHERE tenant_id = ${TEST_TENANT_ID}`
  );
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`
  );
  await db
    .delete(schema.catalogProductRevisions)
    .where(eq(schema.catalogProductRevisions.tenantId, TEST_TENANT_ID));
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`
  );
  await db
    .update(schema.catalogProducts)
    .set({ parentProductId: null, mergedIntoProductId: null })
    .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
}

describe("mergeProducts + unmergeProduct (plan §3.8, spec §18.1)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await ensureTestInventoryLocation(db);
    await cleanup(db);
    await seedRules(db);
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  test("1. simple merge happy path: observations move, loser tombstoned, revision + lineage + event", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-1-winner",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("shopify:connector", "Winner Title", "winner-rec-1")]
          }
        }
      }
    });
    const loserId = await seedProduct(db, {
      primaryIdentifier: "merge-1-loser",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("ebay:connector", "Loser Title", "loser-rec-1")]
          }
        }
      }
    });

    const result = await mergeProducts({
      db,
      tenantId: TENANT,
      winnerId,
      loserIds: [loserId],
      actor: "test:steward",
      rationale: "duplicate gtin"
    });

    expect(result.winnerId).toBe(winnerId);
    expect(result.losers).toEqual([loserId]);
    expect(result.observationsMoved).toBe(1);
    expect(result.lineageIds.length).toBe(1);

    const winnerRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId));
    const winner = winnerRows[0]!;
    const winnerValues = winner.values as Record<string, any>;
    const titleLeaf = winnerValues.title["shopify-au"].en_AU as StoredObservation[];
    expect(titleLeaf.length).toBe(2);
    expect(titleLeaf.map((o) => o.value)).toContain("Winner Title");
    expect(titleLeaf.map((o) => o.value)).toContain("Loser Title");
    const movedIn = titleLeaf.find((o) => o.value === "Loser Title")!;
    expect(movedIn.source).toBe("ebay:connector");
    expect(movedIn.source_record_id).toBe("loser-rec-1");

    const loserRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, loserId));
    const loser = loserRows[0]!;
    expect(loser.status).toBe("merged_into");
    expect(loser.mergedIntoProductId).toBe(winnerId);

    const revs = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(
        and(
          eq(schema.catalogProductRevisions.productId, winnerId),
          eq(schema.catalogProductRevisions.revisionReason, "manual_merge")
        )
      );
    expect(revs.length).toBe(1);
    const rev = revs[0]!;
    const diff = rev.diff as Record<string, any>;
    expect(diff.operation).toBe("merge");
    expect(diff.winnerId).toBe(winnerId);
    expect(diff.losers).toBeInstanceOf(Array);
    expect(diff.losers.length).toBe(1);
    expect(diff.losers[0].loserId).toBe(loserId);
    expect(diff.losers[0].observationsMoved).toBeInstanceOf(Array);
    expect(diff.losers[0].observationsMoved.length).toBe(1);
    expect(diff.losers[0].priorStatus).toBe("active");
    expect(diff.rationale).toBe("duplicate gtin");
    expect(diff.actor).toBe("test:steward");
    expect(rev.actor).toBe("test:steward");
    expect(rev.revisionId).toBe(result.revisionId);

    const lineage = await db
      .select()
      .from(schema.productLineage)
      .where(eq(schema.productLineage.productId, winnerId));
    const mergeRow = lineage.find((l) => l.originProductId === loserId);
    expect(mergeRow).toBeDefined();
    expect(mergeRow!.operation).toBe("merge");
    expect(mergeRow!.rationale).toBe("duplicate gtin");
    expect(mergeRow!.actor).toBe("test:steward");

    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(eq(schema.catalogEvents.eventId, result.eventId));
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.eventType).toBe("catalog.product.merged");
    expect(ev.productId).toBe(winnerId);
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.winnerId).toBe(winnerId);
    expect(payload.losers).toEqual([loserId]);
    expect(payload.actor).toBe("test:steward");
    expect(payload.rationale).toBe("duplicate gtin");
    expect(payload.revisionId).toBe(result.revisionId);
  });

  test("2. variant re-parenting: loser's variant child re-parents to winner", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-2-winner",
      values: {}
    });
    const loserId = await seedProduct(db, {
      primaryIdentifier: "merge-2-loser",
      values: {}
    });
    const winnerVariantId = await seedProduct(db, {
      primaryIdentifier: "merge-2-winner-variant",
      values: {},
      parentProductId: winnerId
    });
    const loserVariantId = await seedProduct(db, {
      primaryIdentifier: "merge-2-loser-variant",
      values: {},
      parentProductId: loserId
    });

    const result = await mergeProducts({
      db,
      tenantId: TENANT,
      winnerId,
      loserIds: [loserId],
      actor: TEST_ACTOR,
      rationale: "variant test"
    });

    expect(result.variantsReparented).toBe(1);

    const variants = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.parentProductId, winnerId));
    const variantIds = variants.map((v) => v.productId).sort();
    expect(variantIds).toEqual([winnerVariantId, loserVariantId].sort());
  });

  test("3. side-table rows move with merged_from_product_id set", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-3-winner",
      values: {}
    });
    const loserId = await seedProduct(db, {
      primaryIdentifier: "merge-3-loser",
      values: {}
    });

    await db.insert(schema.catalogPricingObservations).values({
      productId: loserId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locale: "en_AU",
      source: "shopify:connector",
      sourceRecordId: "merge-3-pricing-rec",
      currency: "AUD",
      tiers: [{ kind: "list", amount: 19.99 }],
      observedAt: new Date("2026-05-21T10:00:00Z")
    });
    await db.insert(schema.catalogInventoryObservations).values({
      productId: loserId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locationId: TEST_LOCATION_ID,
      qty: 17,
      source: "shopify:connector",
      sourceRecordId: "merge-3-inv-rec",
      observedAt: new Date("2026-05-21T10:00:00Z")
    });

    const result = await mergeProducts({
      db,
      tenantId: TENANT,
      winnerId,
      loserIds: [loserId],
      actor: TEST_ACTOR,
      rationale: "side-table"
    });

    expect(result.pricingObservationsMoved).toBe(1);
    expect(result.inventoryObservationsMoved).toBe(1);

    const pricing = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, winnerId));
    expect(pricing.length).toBe(1);
    expect(pricing[0]!.mergedFromProductId).toBe(loserId);

    const inv = await db
      .select()
      .from(schema.catalogInventoryObservations)
      .where(eq(schema.catalogInventoryObservations.productId, winnerId));
    expect(inv.length).toBe(1);
    expect(inv[0]!.mergedFromProductId).toBe(loserId);

    const leftOverPricing = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, loserId));
    expect(leftOverPricing.length).toBe(0);
  });

  test("4. winner.winning_values recomputed after merge (loser's higher-priority source wins)", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-4-winner",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("default:connector", "Default Title", "merge-4-w-1")]
          }
        }
      }
    });
    const loserId = await seedProduct(db, {
      primaryIdentifier: "merge-4-loser",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("premium:connector", "Premium Title", "merge-4-l-1")]
          }
        }
      }
    });

    await mergeProducts({
      db,
      tenantId: TENANT,
      winnerId,
      loserIds: [loserId],
      actor: TEST_ACTOR,
      rationale: "priority test"
    });

    const winnerRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId));
    const winningValues = winnerRows[0]!.winningValues as Record<string, any>;
    expect(winningValues.title["shopify-au"].en_AU).toBe("Premium Title");
  });

  test("5. multiple losers in one call — two lineage rows, both tombstoned", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-5-winner",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("a:c", "W", "merge-5-w-1")]
          }
        }
      }
    });
    const loser1Id = await seedProduct(db, {
      primaryIdentifier: "merge-5-loser1",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("a:c", "L1", "merge-5-l1-1")]
          }
        }
      }
    });
    const loser2Id = await seedProduct(db, {
      primaryIdentifier: "merge-5-loser2",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("a:c", "L2", "merge-5-l2-1")]
          }
        }
      }
    });

    const result = await mergeProducts({
      db,
      tenantId: TENANT,
      winnerId,
      loserIds: [loser1Id, loser2Id],
      actor: TEST_ACTOR,
      rationale: "n-way"
    });

    expect(result.lineageIds.length).toBe(2);
    expect(result.observationsMoved).toBe(2);

    const winnerRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId));
    const titleLeaf = (winnerRows[0]!.values as Record<string, any>).title[
      "shopify-au"
    ].en_AU as StoredObservation[];
    expect(titleLeaf.length).toBe(3);

    const loser1 = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, loser1Id));
    const loser2 = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, loser2Id));
    expect(loser1[0]!.status).toBe("merged_into");
    expect(loser1[0]!.mergedIntoProductId).toBe(winnerId);
    expect(loser2[0]!.status).toBe("merged_into");
    expect(loser2[0]!.mergedIntoProductId).toBe(winnerId);
  });

  test("6. cross-tenant guard: winner in tenant A, loser in tenant B → throws", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-6-winner",
      values: {}
    });

    const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";
    await db.execute(sql`
      INSERT INTO tenants (id, name)
      VALUES (${OTHER_TENANT}::uuid, 'Other Tenant Merge Test')
      ON CONFLICT (id) DO NOTHING
    `);
    const OTHER_MERCHANT = "00000000-0000-0000-0000-0000000000fe";
    await db.execute(sql`
      INSERT INTO merchants (id, tenant_id, email, password_hash, display_name)
      VALUES (${OTHER_MERCHANT}::uuid, ${OTHER_TENANT}::uuid, 'mt-merge@test.invalid', 'x', 'Other Merchant MT')
      ON CONFLICT (id) DO NOTHING
    `);
    const otherTenantLoser = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: OTHER_TENANT,
        merchantId: OTHER_MERCHANT,
        primaryIdentifier: "merge-6-other-loser",
        identity: {},
        status: "active",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const otherLoserId = otherTenantLoser[0]!.productId;

    let threw = false;
    try {
      await mergeProducts({
        db,
        tenantId: TENANT,
        winnerId,
        loserIds: [otherLoserId],
        actor: TEST_ACTOR,
        rationale: "should fail"
      });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/tenant/i);
    }
    expect(threw).toBe(true);

    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, otherLoserId));
    await db.execute(
      sql`DELETE FROM merchants WHERE id = ${OTHER_MERCHANT}::uuid`
    );
    await db.execute(
      sql`DELETE FROM tenants WHERE id = ${OTHER_TENANT}::uuid`
    );
  });

  test("7. already-merged guard: chained merges blocked", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-7-winner",
      values: {}
    });
    const loserId = await seedProduct(db, {
      primaryIdentifier: "merge-7-loser",
      status: "merged_into",
      values: {}
    });

    let threw = false;
    try {
      await mergeProducts({
        db,
        tenantId: TENANT,
        winnerId,
        loserIds: [loserId],
        actor: TEST_ACTOR,
        rationale: "chained"
      });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/already.*merged/i);
    }
    expect(threw).toBe(true);
  });

  test("8. unmerge happy path: restores loser, moves side-tables back, removes obs from winner, emits event", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-8-winner",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("shopify:connector", "Winner", "merge-8-w-1")]
          }
        }
      }
    });
    const loserId = await seedProduct(db, {
      primaryIdentifier: "merge-8-loser",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("ebay:connector", "Loser", "merge-8-l-1")]
          }
        }
      }
    });
    await db.insert(schema.catalogPricingObservations).values({
      productId: loserId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locale: "en_AU",
      source: "shopify:connector",
      sourceRecordId: "merge-8-pricing-rec",
      currency: "AUD",
      tiers: [{ kind: "list", amount: 19.99 }],
      observedAt: new Date("2026-05-21T10:00:00Z")
    });

    const mergeResult = await mergeProducts({
      db,
      tenantId: TENANT,
      winnerId,
      loserIds: [loserId],
      actor: TEST_ACTOR,
      rationale: "to-be-undone"
    });

    const unmergeResult = await unmergeProduct({
      db,
      tenantId: TENANT,
      mergeRevisionId: mergeResult.revisionId,
      actor: "test:undoer"
    });

    expect(unmergeResult.winnerId).toBe(winnerId);
    expect(unmergeResult.restoredLosers).toEqual([loserId]);
    expect(unmergeResult.observationsRemoved).toBe(1);
    expect(unmergeResult.pricingObservationsRestored).toBe(1);

    const loserRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, loserId));
    expect(loserRows[0]!.status).toBe("active");
    expect(loserRows[0]!.mergedIntoProductId).toBeNull();

    const winnerRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId));
    const titleLeaf = (winnerRows[0]!.values as Record<string, any>).title[
      "shopify-au"
    ].en_AU as StoredObservation[];
    expect(titleLeaf.length).toBe(1);
    expect(titleLeaf[0]!.value).toBe("Winner");

    const pricing = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, loserId));
    expect(pricing.length).toBe(1);
    expect(pricing[0]!.mergedFromProductId).toBeNull();

    const lineage = await db
      .select()
      .from(schema.productLineage)
      .where(eq(schema.productLineage.productId, loserId));
    const unmergeLineage = lineage.find((l) => l.operation === "unmerge");
    expect(unmergeLineage).toBeDefined();

    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(eq(schema.catalogEvents.eventId, unmergeResult.eventId));
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.eventType).toBe("catalog.product.unmerged");
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.winnerId).toBe(winnerId);
    expect(payload.restoredLosers).toEqual([loserId]);
    expect(payload.mergeRevisionId).toBe(mergeResult.revisionId);
  });

  test("9. idempotent unmerge: second call detects already-unmerged + short-circuits", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-9-winner",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("shopify:connector", "Winner", "merge-9-w-1")]
          }
        }
      }
    });
    const loserId = await seedProduct(db, {
      primaryIdentifier: "merge-9-loser",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("ebay:connector", "Loser", "merge-9-l-1")]
          }
        }
      }
    });

    const mergeResult = await mergeProducts({
      db,
      tenantId: TENANT,
      winnerId,
      loserIds: [loserId],
      actor: TEST_ACTOR,
      rationale: "idempotent test"
    });

    await unmergeProduct({
      db,
      tenantId: TENANT,
      mergeRevisionId: mergeResult.revisionId,
      actor: "test:undoer"
    });

    const eventsBefore = await db.execute(sql`
      SELECT count(*)::int AS c FROM catalog_events
      WHERE product_id = ${winnerId}::uuid
        AND event_type = 'catalog.product.unmerged'
    `);
    const eventsBeforeCount = (eventsBefore.rows[0] as { c: number }).c;
    const revsBefore = await db.execute(sql`
      SELECT count(*)::int AS c FROM catalog_product_revisions
      WHERE product_id = ${winnerId}::uuid
        AND revision_reason = 'manual_unmerge'
    `);
    const revsBeforeCount = (revsBefore.rows[0] as { c: number }).c;

    const second = await unmergeProduct({
      db,
      tenantId: TENANT,
      mergeRevisionId: mergeResult.revisionId,
      actor: "test:undoer"
    });

    expect(second.restoredLosers).toEqual([]);
    expect(second.observationsRemoved).toBe(0);
    expect(second.pricingObservationsRestored).toBe(0);
    expect(second.inventoryObservationsRestored).toBe(0);
    expect(second.eventId).toBe(0);
    expect(second.unmergeRevisionId).toBe(0);

    const eventsAfter = await db.execute(sql`
      SELECT count(*)::int AS c FROM catalog_events
      WHERE product_id = ${winnerId}::uuid
        AND event_type = 'catalog.product.unmerged'
    `);
    expect((eventsAfter.rows[0] as { c: number }).c).toBe(eventsBeforeCount);
    const revsAfter = await db.execute(sql`
      SELECT count(*)::int AS c FROM catalog_product_revisions
      WHERE product_id = ${winnerId}::uuid
        AND revision_reason = 'manual_unmerge'
    `);
    expect((revsAfter.rows[0] as { c: number }).c).toBe(revsBeforeCount);
  });

  test("10. unmerge restores winning_values (no longer reflects loser observations)", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-10-winner",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("default:connector", "Default", "merge-10-w-1")]
          }
        }
      }
    });
    const loserId = await seedProduct(db, {
      primaryIdentifier: "merge-10-loser",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("premium:connector", "Premium", "merge-10-l-1")]
          }
        }
      }
    });

    const mergeResult = await mergeProducts({
      db,
      tenantId: TENANT,
      winnerId,
      loserIds: [loserId],
      actor: TEST_ACTOR,
      rationale: "wv test"
    });

    const winnerMid = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId));
    expect(
      (winnerMid[0]!.winningValues as Record<string, any>).title["shopify-au"].en_AU
    ).toBe("Premium");

    await unmergeProduct({
      db,
      tenantId: TENANT,
      mergeRevisionId: mergeResult.revisionId,
      actor: "test:undoer"
    });

    const winnerAfter = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId));
    const wv = winnerAfter[0]!.winningValues as Record<string, any>;
    expect(wv.title["shopify-au"].en_AU).toBe("Default");
  });

  test("11. unmerge over-removal guard: winner and loser share (source, sourceRecordId) but differ in (value, observedAt) — only the moved-in row is peeled off", async () => {
    const T1 = "2026-05-21T10:00:00.000Z";
    const T2 = "2026-05-21T11:00:00.000Z";
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-11-winner",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("ebay:c", "A", "r1", T1)]
          }
        }
      }
    });
    const loserId = await seedProduct(db, {
      primaryIdentifier: "merge-11-loser",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("ebay:c", "B", "r1", T2)]
          }
        }
      }
    });

    const mergeResult = await mergeProducts({
      db,
      tenantId: TENANT,
      winnerId,
      loserIds: [loserId],
      actor: TEST_ACTOR,
      rationale: "collision test"
    });
    expect(mergeResult.observationsMoved).toBe(1);

    const winnerMid = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId));
    const midLeaf = (winnerMid[0]!.values as Record<string, any>).title[
      "shopify-au"
    ].en_AU as StoredObservation[];
    expect(midLeaf.length).toBe(2);

    const revs = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.revisionId, mergeResult.revisionId));
    const diff = revs[0]!.diff as Record<string, any>;
    expect(diff.losers[0].observationsMoved[0].observedAt).toBe(T2);

    const unmergeResult = await unmergeProduct({
      db,
      tenantId: TENANT,
      mergeRevisionId: mergeResult.revisionId,
      actor: "test:undoer"
    });
    expect(unmergeResult.observationsRemoved).toBe(1);

    const winnerAfter = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId));
    const leaf = (winnerAfter[0]!.values as Record<string, any>).title[
      "shopify-au"
    ].en_AU as StoredObservation[];
    expect(leaf.length).toBe(1);
    expect(leaf[0]!.value).toBe("A");
    expect(leaf[0]!.observed_at).toBe(T1);
    expect(leaf[0]!.source).toBe("ebay:c");
    expect(leaf[0]!.source_record_id).toBe("r1");
  });

  test("12. merge deletes loser's _current rows (orphan prevention, decision 11)", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-12-winner",
      values: {}
    });
    const loserId = await seedProduct(db, {
      primaryIdentifier: "merge-12-loser",
      values: {}
    });

    await db.insert(schema.catalogPricingCurrent).values({
      productId: loserId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locale: "en_AU",
      source: "shopify:connector",
      currency: "AUD",
      tiers: [{ kind: "list", amount: 9.99 }],
      primaryAmount: "9.99",
      observedAt: new Date("2026-05-21T10:00:00Z")
    });
    await db.insert(schema.catalogInventoryCurrent).values({
      productId: loserId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locationId: TEST_LOCATION_ID,
      qty: 7,
      source: "shopify:connector",
      observedAt: new Date("2026-05-21T10:00:00Z")
    });

    await mergeProducts({
      db,
      tenantId: TENANT,
      winnerId,
      loserIds: [loserId],
      actor: TEST_ACTOR,
      rationale: "current cleanup"
    });

    const pricingCurrent = await db
      .select()
      .from(schema.catalogPricingCurrent)
      .where(eq(schema.catalogPricingCurrent.productId, loserId));
    expect(pricingCurrent.length).toBe(0);
    const inventoryCurrent = await db
      .select()
      .from(schema.catalogInventoryCurrent)
      .where(eq(schema.catalogInventoryCurrent.productId, loserId));
    expect(inventoryCurrent.length).toBe(0);
  });

  test("13. frozen loser: status='frozen_pending_review' is captured in undo recipe and restored on unmerge", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-13-winner",
      values: {}
    });
    const loserId = await seedProduct(db, {
      primaryIdentifier: "merge-13-loser",
      status: "frozen_pending_review",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("ebay:c", "Frozen Loser", "merge-13-l-1")]
          }
        }
      }
    });

    const mergeResult = await mergeProducts({
      db,
      tenantId: TENANT,
      winnerId,
      loserIds: [loserId],
      actor: TEST_ACTOR,
      rationale: "frozen merge"
    });

    const midLoser = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, loserId));
    expect(midLoser[0]!.status).toBe("merged_into");

    const revs = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.revisionId, mergeResult.revisionId));
    const diff = revs[0]!.diff as Record<string, any>;
    expect(diff.losers[0].priorStatus).toBe("frozen_pending_review");

    await unmergeProduct({
      db,
      tenantId: TENANT,
      mergeRevisionId: mergeResult.revisionId,
      actor: "test:undoer"
    });
    const afterLoser = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, loserId));
    expect(afterLoser[0]!.status).toBe("frozen_pending_review");
    expect(afterLoser[0]!.mergedIntoProductId).toBeNull();
  });

  test("14. boundary guards: winnerId===loserIds[0] throws; empty loserIds throws", async () => {
    const winnerId = await seedProduct(db, {
      primaryIdentifier: "merge-14-winner",
      values: {}
    });

    let threwSelf = false;
    try {
      await mergeProducts({
        db,
        tenantId: TENANT,
        winnerId,
        loserIds: [winnerId],
        actor: TEST_ACTOR,
        rationale: "self-merge"
      });
    } catch (e) {
      threwSelf = true;
      expect((e as Error).message).toMatch(/cannot also be a loser/i);
    }
    expect(threwSelf).toBe(true);

    let threwEmpty = false;
    try {
      await mergeProducts({
        db,
        tenantId: TENANT,
        winnerId,
        loserIds: [],
        actor: TEST_ACTOR,
        rationale: "empty"
      });
    } catch (e) {
      threwEmpty = true;
      expect((e as Error).message).toMatch(/non-empty/i);
    }
    expect(threwEmpty).toBe(true);
  });
});

describe("splitProduct", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await ensureTestInventoryLocation(db);
    await cleanup(db);
    await seedRules(db);
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  test("S1. simple source-based split: observations move, side-tables move, lineage + revisions + event", async () => {
    const sourceId = await seedProduct(db, {
      primaryIdentifier: "split-1-source",
      values: {
        title: {
          "shopify-au": {
            en_AU: [
              obsRow("flipkart:link", "Flipkart Title", "fk-rec-1"),
              obsRow("amazon:link", "Amazon Title", "az-rec-1")
            ]
          }
        }
      }
    });

    await db.insert(schema.catalogPricingObservations).values([
      {
        productId: sourceId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "amazon:link",
        sourceRecordId: "az-pricing-1",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 19.99 }],
        observedAt: new Date("2026-05-21T10:00:00Z")
      },
      {
        productId: sourceId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "flipkart:link",
        sourceRecordId: "fk-pricing-1",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 17.99 }],
        observedAt: new Date("2026-05-21T10:00:00Z")
      }
    ]);
    await db.insert(schema.catalogInventoryObservations).values({
      productId: sourceId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locationId: TEST_LOCATION_ID,
      qty: 5,
      source: "amazon:link",
      sourceRecordId: "az-inv-1",
      observedAt: new Date("2026-05-21T10:00:00Z")
    });

    const sourceRevsBefore = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, sourceId));
    const sourceRevsBeforeCount = sourceRevsBefore.length;

    const result = await splitProduct({
      db,
      tenantId: TENANT,
      sourceProductId: sourceId,
      observationFilter: { sources: ["amazon:link"] },
      newIdentity: {
        primaryIdentifier: "split-1-new",
        identity: { brand: "AmazonSpinoff" },
        status: "draft"
      },
      actor: "test:steward",
      rationale: "amazon variant should be its own product"
    });

    expect(result.sourceProductId).toBe(sourceId);
    expect(result.newProductId).not.toBe(sourceId);
    expect(result.observationsMoved).toBe(1);
    expect(result.pricingObservationsMoved).toBe(1);
    expect(result.inventoryObservationsMoved).toBe(1);

    const sourceRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, sourceId));
    const sourceLeaf = (sourceRows[0]!.values as Record<string, any>).title["shopify-au"]
      .en_AU as StoredObservation[];
    expect(sourceLeaf.length).toBe(1);
    expect(sourceLeaf[0]!.source).toBe("flipkart:link");

    const newRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.newProductId));
    expect(newRows.length).toBe(1);
    const newRow = newRows[0]!;
    expect(newRow.primaryIdentifier).toBe("split-1-new");
    expect(newRow.tenantId).toBe(TEST_TENANT_ID);
    expect(newRow.merchantId).toBe(TEST_MERCHANT_ID);
    expect(newRow.status).toBe("draft");
    const newLeaf = (newRow.values as Record<string, any>).title["shopify-au"]
      .en_AU as StoredObservation[];
    expect(newLeaf.length).toBe(1);
    expect(newLeaf[0]!.source).toBe("amazon:link");
    expect(newLeaf[0]!.source_record_id).toBe("az-rec-1");

    const newPricing = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, result.newProductId));
    expect(newPricing.length).toBe(1);
    expect(newPricing[0]!.source).toBe("amazon:link");
    expect(newPricing[0]!.mergedFromProductId).toBeNull();

    const remainingPricing = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, sourceId));
    expect(remainingPricing.length).toBe(1);
    expect(remainingPricing[0]!.source).toBe("flipkart:link");

    const newInv = await db
      .select()
      .from(schema.catalogInventoryObservations)
      .where(eq(schema.catalogInventoryObservations.productId, result.newProductId));
    expect(newInv.length).toBe(1);

    const lineage = await db
      .select()
      .from(schema.productLineage)
      .where(eq(schema.productLineage.lineageId, result.lineageId));
    expect(lineage.length).toBe(1);
    expect(lineage[0]!.operation).toBe("split");
    expect(lineage[0]!.productId).toBe(result.newProductId);
    expect(lineage[0]!.originProductId).toBe(sourceId);
    expect(lineage[0]!.splitFilter).toEqual({ sources: ["amazon:link"] });
    expect(lineage[0]!.rationale).toBe("amazon variant should be its own product");
    expect(lineage[0]!.actor).toBe("test:steward");

    const sourceRevsAfter = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, sourceId));
    expect(sourceRevsAfter.length).toBe(sourceRevsBeforeCount + 1);
    const sourceSplitRev = sourceRevsAfter.find(
      (r) => r.revisionReason === "manual_split"
    );
    expect(sourceSplitRev).toBeDefined();
    const sourceDiff = sourceSplitRev!.diff as Record<string, any>;
    expect(sourceDiff.operation).toBe("split");
    expect(sourceDiff.new_product_id).toBe(result.newProductId);
    expect(sourceDiff.split_filter).toEqual({ sources: ["amazon:link"] });
    expect(sourceDiff.actor).toBe("test:steward");
    expect(sourceDiff.rationale).toBe("amazon variant should be its own product");

    const newRevs = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, result.newProductId));
    expect(newRevs.length).toBe(1);
    const newRev = newRevs[0]!;
    expect(newRev.revisionReason).toBe("manual_split");
    const newDiff = newRev.diff as Record<string, any>;
    expect(newDiff.operation).toBe("split");
    expect(newDiff.origin).toBe(sourceId);
    expect(newDiff.split_filter).toEqual({ sources: ["amazon:link"] });
    expect(newDiff.lineage_pointer).toBeDefined();
    expect(newDiff.lineage_pointer.source_revision).toBe(result.splitRevisionIds.source);

    expect(result.splitRevisionIds.source).toBe(sourceSplitRev!.revisionId);
    expect(result.splitRevisionIds.new).toBe(newRev.revisionId);

    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(eq(schema.catalogEvents.eventId, result.eventId));
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("catalog.product.split");
    expect(events[0]!.productId).toBe(result.newProductId);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.sourceProductId).toBe(sourceId);
    expect(payload.newProductId).toBe(result.newProductId);
    expect(payload.splitFilter).toEqual({ sources: ["amazon:link"] });
    expect(payload.actor).toBe("test:steward");
    expect(payload.lineageId).toBe(result.lineageId);
  });

  test("S2. sourceRecordIds filter: only matching record observations move", async () => {
    const sourceId = await seedProduct(db, {
      primaryIdentifier: "split-2-source",
      values: {
        title: {
          "shopify-au": {
            en_AU: [
              obsRow("amazon:link", "Amazon A", "sku-A"),
              obsRow("amazon:link", "Amazon B", "sku-B")
            ]
          }
        }
      }
    });

    const result = await splitProduct({
      db,
      tenantId: TENANT,
      sourceProductId: sourceId,
      observationFilter: { sourceRecordIds: ["sku-A"] },
      newIdentity: {
        primaryIdentifier: "split-2-new",
        identity: { brand: "Spinoff" }
      },
      actor: TEST_ACTOR,
      rationale: "sku-A should split"
    });

    expect(result.observationsMoved).toBe(1);

    const sourceRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, sourceId));
    const sourceLeaf = (sourceRows[0]!.values as Record<string, any>).title["shopify-au"]
      .en_AU as StoredObservation[];
    expect(sourceLeaf.length).toBe(1);
    expect(sourceLeaf[0]!.source_record_id).toBe("sku-B");

    const newRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.newProductId));
    const newLeaf = (newRows[0]!.values as Record<string, any>).title["shopify-au"]
      .en_AU as StoredObservation[];
    expect(newLeaf.length).toBe(1);
    expect(newLeaf[0]!.source_record_id).toBe("sku-A");
  });

  test("S3. attributeCodes filter: only that attribute moves; pricing/inventory NOT moved (per design)", async () => {
    const sourceId = await seedProduct(db, {
      primaryIdentifier: "split-3-source",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("amazon:link", "Title Obs", "sku-1")]
          }
        },
        brand: {
          "shopify-au": {
            en_AU: [obsRow("amazon:link", "Brand Obs", "sku-1")]
          }
        }
      }
    });

    await db.insert(schema.catalogPricingObservations).values({
      productId: sourceId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locale: "en_AU",
      source: "amazon:link",
      sourceRecordId: "sku-1",
      currency: "AUD",
      tiers: [{ kind: "list", amount: 9.99 }],
      observedAt: new Date("2026-05-21T10:00:00Z")
    });

    const result = await splitProduct({
      db,
      tenantId: TENANT,
      sourceProductId: sourceId,
      observationFilter: { attributeCodes: ["title"] },
      newIdentity: {
        primaryIdentifier: "split-3-new",
        identity: { brand: "Spinoff" }
      },
      actor: TEST_ACTOR,
      rationale: "only title attribute"
    });

    expect(result.observationsMoved).toBe(1);
    expect(result.pricingObservationsMoved).toBe(0);
    expect(result.inventoryObservationsMoved).toBe(0);

    const sourceRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, sourceId));
    const sourceValues = sourceRows[0]!.values as Record<string, any>;
    const titleLeaf = sourceValues.title?.["shopify-au"]?.en_AU as StoredObservation[] | undefined;
    expect(titleLeaf == null || titleLeaf.length === 0).toBe(true);
    expect(sourceValues.brand["shopify-au"].en_AU.length).toBe(1);

    const newRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.newProductId));
    const newValues = newRows[0]!.values as Record<string, any>;
    expect(newValues.title["shopify-au"].en_AU.length).toBe(1);
    expect(newValues.brand).toBeUndefined();

    const pricing = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, sourceId));
    expect(pricing.length).toBe(1);
  });

  test("S4. combined filter (sources AND channelCodes): only matching observations move", async () => {
    const sourceId = await seedProduct(db, {
      primaryIdentifier: "split-4-source",
      values: {
        title: {
          "shopify-au": {
            en_AU: [
              obsRow("amazon:link", "Amazon-AU", "az-au-1"),
              obsRow("flipkart:link", "Flipkart-AU", "fk-au-1")
            ]
          },
          "amazon-us": {
            en_US: [obsRow("amazon:link", "Amazon-US", "az-us-1")]
          }
        }
      }
    });

    const result = await splitProduct({
      db,
      tenantId: TENANT,
      sourceProductId: sourceId,
      observationFilter: {
        sources: ["amazon:link"],
        channelCodes: ["amazon-us"]
      },
      newIdentity: {
        primaryIdentifier: "split-4-new",
        identity: { brand: "Spinoff" }
      },
      actor: TEST_ACTOR,
      rationale: "amazon-us only"
    });

    expect(result.observationsMoved).toBe(1);

    const sourceRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, sourceId));
    const sourceValues = sourceRows[0]!.values as Record<string, any>;
    expect(sourceValues.title["shopify-au"].en_AU.length).toBe(2);
    const usLeaf = sourceValues.title?.["amazon-us"]?.en_US as StoredObservation[] | undefined;
    expect(usLeaf == null || usLeaf.length === 0).toBe(true);

    const newRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.newProductId));
    const newValues = newRows[0]!.values as Record<string, any>;
    expect(newValues.title["amazon-us"].en_US.length).toBe(1);
  });

  test("S5. empty filter throws clear error", async () => {
    const sourceId = await seedProduct(db, {
      primaryIdentifier: "split-5-source",
      values: {
        title: {
          "shopify-au": { en_AU: [obsRow("amazon:link", "X", "x")] }
        }
      }
    });

    let threw = false;
    try {
      await splitProduct({
        db,
        tenantId: TENANT,
        sourceProductId: sourceId,
        observationFilter: {},
        newIdentity: {
          primaryIdentifier: "split-5-new",
          identity: {}
        },
        actor: TEST_ACTOR,
        rationale: "empty filter"
      });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/empty.*filter|filter.*empty|no filter/i);
    }
    expect(threw).toBe(true);
  });

  test("S6. cross-tenant guard: sourceProductId in tenant A; calling with tenant B throws", async () => {
    const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ee";
    const OTHER_MERCHANT = "00000000-0000-0000-0000-0000000000ed";
    await db.execute(sql`
      INSERT INTO tenants (id, name)
      VALUES (${OTHER_TENANT}::uuid, 'Other Tenant Split Test')
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO merchants (id, tenant_id, email, password_hash, display_name)
      VALUES (${OTHER_MERCHANT}::uuid, ${OTHER_TENANT}::uuid, 'mt-split@test.invalid', 'x', 'Other Merchant ST')
      ON CONFLICT (id) DO NOTHING
    `);
    const otherSource = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: OTHER_TENANT,
        merchantId: OTHER_MERCHANT,
        primaryIdentifier: "split-6-other-source",
        identity: {},
        status: "active",
        values: {
          title: {
            "shopify-au": { en_AU: [obsRow("amazon:link", "X", "x")] }
          }
        }
      })
      .returning({ productId: schema.catalogProducts.productId });
    const otherSourceId = otherSource[0]!.productId;

    let threw = false;
    try {
      await splitProduct({
        db,
        tenantId: TENANT,
        sourceProductId: otherSourceId,
        observationFilter: { sources: ["amazon:link"] },
        newIdentity: {
          primaryIdentifier: "split-6-new",
          identity: {}
        },
        actor: TEST_ACTOR,
        rationale: "cross-tenant"
      });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/tenant/i);
    }
    expect(threw).toBe(true);

    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, otherSourceId));
    await db.execute(
      sql`DELETE FROM merchants WHERE id = ${OTHER_MERCHANT}::uuid`
    );
    await db.execute(
      sql`DELETE FROM tenants WHERE id = ${OTHER_TENANT}::uuid`
    );
  });

  test("S7. revisions stay attached to source — only a new manual_split row is added (no physical moves)", async () => {
    const sourceId = await seedProduct(db, {
      primaryIdentifier: "split-7-source",
      values: {
        title: {
          "shopify-au": {
            en_AU: [
              obsRow("amazon:link", "Amazon", "az-1"),
              obsRow("flipkart:link", "Flipkart", "fk-1")
            ]
          }
        }
      }
    });

    const ingestRev1 = await db
      .insert(schema.catalogProductRevisions)
      .values({
        productId: sourceId,
        tenantId: TEST_TENANT_ID,
        valuesSnapshot: {},
        winningSnapshot: null,
        diff: { kind: "synthetic-ingest-1" },
        revisionReason: "ingest_observation",
        sourceKind: "adapter",
        sourceRecordId: "az-1",
        rawPayload: null,
        observedAt: new Date("2026-05-19T10:00:00Z"),
        actor: TEST_ACTOR
      })
      .returning({ revisionId: schema.catalogProductRevisions.revisionId });
    const ingestRev2 = await db
      .insert(schema.catalogProductRevisions)
      .values({
        productId: sourceId,
        tenantId: TEST_TENANT_ID,
        valuesSnapshot: {},
        winningSnapshot: null,
        diff: { kind: "synthetic-ingest-2" },
        revisionReason: "ingest_observation",
        sourceKind: "adapter",
        sourceRecordId: "fk-1",
        rawPayload: null,
        observedAt: new Date("2026-05-19T10:00:00Z"),
        actor: TEST_ACTOR
      })
      .returning({ revisionId: schema.catalogProductRevisions.revisionId });

    const preSplitSourceRevIds = new Set([
      ingestRev1[0]!.revisionId,
      ingestRev2[0]!.revisionId
    ]);

    const result = await splitProduct({
      db,
      tenantId: TENANT,
      sourceProductId: sourceId,
      observationFilter: { sources: ["amazon:link"] },
      newIdentity: {
        primaryIdentifier: "split-7-new",
        identity: { brand: "Amazon Spinoff" }
      },
      actor: TEST_ACTOR,
      rationale: "history preservation test"
    });

    const sourceRevsAfter = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, sourceId));
    const sourceRevIds = new Set(sourceRevsAfter.map((r) => r.revisionId));
    for (const id of preSplitSourceRevIds) {
      expect(sourceRevIds.has(id)).toBe(true);
    }
    const newRevs = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, result.newProductId));
    expect(newRevs.length).toBe(1);
    expect(preSplitSourceRevIds.has(newRevs[0]!.revisionId)).toBe(false);
  });

  test("S8. full-history union query: revisions for new ∪ revisions on source (matching filter at the source-of-truth level)", async () => {
    const sourceId = await seedProduct(db, {
      primaryIdentifier: "split-8-source",
      values: {
        title: {
          "shopify-au": {
            en_AU: [
              obsRow("amazon:link", "Amazon", "az-1"),
              obsRow("flipkart:link", "Flipkart", "fk-1")
            ]
          }
        }
      }
    });
    await db.insert(schema.catalogProductRevisions).values({
      productId: sourceId,
      tenantId: TEST_TENANT_ID,
      valuesSnapshot: {},
      diff: { kind: "synthetic" },
      revisionReason: "ingest_observation",
      sourceKind: "adapter",
      sourceRecordId: "az-1",
      observedAt: new Date("2026-05-19T10:00:00Z"),
      actor: TEST_ACTOR
    });

    const result = await splitProduct({
      db,
      tenantId: TENANT,
      sourceProductId: sourceId,
      observationFilter: { sources: ["amazon:link"] },
      newIdentity: {
        primaryIdentifier: "split-8-new",
        identity: {}
      },
      actor: TEST_ACTOR,
      rationale: "union query test"
    });

    const fullHistory = await db.execute(sql`
      SELECT revision_id, product_id, revision_reason
      FROM catalog_product_revisions
      WHERE product_id = ${result.newProductId}::uuid
      UNION ALL
      SELECT revision_id, product_id, revision_reason
      FROM catalog_product_revisions
      WHERE product_id = ${sourceId}::uuid
      ORDER BY revision_id
    `);

    expect(fullHistory.rows.length).toBe(3);
    const reasons = (fullHistory.rows as Array<{ revision_reason: string }>).map(
      (r) => r.revision_reason
    );
    expect(reasons.filter((r) => r === "manual_split").length).toBe(2);
    expect(reasons.filter((r) => r === "ingest_observation").length).toBe(1);
  });

  test("S9. _current rows cleared on source after split (async reconciler rebuilds)", async () => {
    const sourceId = await seedProduct(db, {
      primaryIdentifier: "split-9-source",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("amazon:link", "A", "az-1")]
          }
        }
      }
    });

    await db.insert(schema.catalogPricingObservations).values({
      productId: sourceId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locale: "en_AU",
      source: "amazon:link",
      sourceRecordId: "az-1",
      currency: "AUD",
      tiers: [{ kind: "list", amount: 9.99 }],
      observedAt: new Date("2026-05-21T10:00:00Z")
    });
    await db.insert(schema.catalogPricingCurrent).values({
      productId: sourceId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locale: "en_AU",
      source: "amazon:link",
      currency: "AUD",
      tiers: [{ kind: "list", amount: 9.99 }],
      primaryAmount: "9.99",
      observedAt: new Date("2026-05-21T10:00:00Z")
    });
    await db.insert(schema.catalogInventoryCurrent).values({
      productId: sourceId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locationId: TEST_LOCATION_ID,
      qty: 4,
      source: "amazon:link",
      observedAt: new Date("2026-05-21T10:00:00Z")
    });

    await splitProduct({
      db,
      tenantId: TENANT,
      sourceProductId: sourceId,
      observationFilter: { sources: ["amazon:link"] },
      newIdentity: {
        primaryIdentifier: "split-9-new",
        identity: {}
      },
      actor: TEST_ACTOR,
      rationale: "current cleanup"
    });

    const sourcePricingCurrent = await db
      .select()
      .from(schema.catalogPricingCurrent)
      .where(eq(schema.catalogPricingCurrent.productId, sourceId));
    expect(sourcePricingCurrent.length).toBe(0);
    const sourceInvCurrent = await db
      .select()
      .from(schema.catalogInventoryCurrent)
      .where(eq(schema.catalogInventoryCurrent.productId, sourceId));
    expect(sourceInvCurrent.length).toBe(0);
  });

  test("S10. winning_values recomputed on both products after split (premium winner moves with observation)", async () => {
    const sourceId = await seedProduct(db, {
      primaryIdentifier: "split-10-source",
      values: {
        title: {
          "shopify-au": {
            en_AU: [
              obsRow("default:connector", "Default Title", "d-1"),
              obsRow("premium:connector", "Premium Title", "p-1")
            ]
          }
        }
      }
    });

    const result = await splitProduct({
      db,
      tenantId: TENANT,
      sourceProductId: sourceId,
      observationFilter: { sources: ["premium:connector"] },
      newIdentity: {
        primaryIdentifier: "split-10-new",
        identity: {}
      },
      actor: TEST_ACTOR,
      rationale: "wv recompute test"
    });

    const sourceRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, sourceId));
    expect(
      (sourceRows[0]!.winningValues as Record<string, any>).title["shopify-au"].en_AU
    ).toBe("Default Title");

    const newRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.newProductId));
    expect(
      (newRows[0]!.winningValues as Record<string, any>).title["shopify-au"].en_AU
    ).toBe("Premium Title");
  });

  test("S11. valueEquals filter: object key-order independent (deepEqual, not JSON.stringify)", async () => {
    const sourceId = await seedProduct(db, {
      primaryIdentifier: "split-11-source",
      values: {
        attrs: {
          "shopify-au": {
            en_AU: [
              obsRow("amazon:link", { size: "L", color: "red" }, "rec-1"),
              obsRow("amazon:link", { size: "M", color: "blue" }, "rec-2")
            ]
          }
        }
      }
    });

    const result = await splitProduct({
      db,
      tenantId: TENANT,
      sourceProductId: sourceId,
      observationFilter: {
        valueEquals: { color: "red", size: "L" }
      },
      newIdentity: {
        primaryIdentifier: "split-11-new",
        identity: {}
      },
      actor: TEST_ACTOR,
      rationale: "object key-order independent match"
    });

    expect(result.observationsMoved).toBe(1);

    const sourceRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, sourceId));
    const sourceLeaf = (sourceRows[0]!.values as Record<string, any>).attrs[
      "shopify-au"
    ].en_AU as StoredObservation[];
    expect(sourceLeaf.length).toBe(1);
    expect(sourceLeaf[0]!.value).toEqual({ size: "M", color: "blue" });

    const newRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.newProductId));
    const newLeaf = (newRows[0]!.values as Record<string, any>).attrs[
      "shopify-au"
    ].en_AU as StoredObservation[];
    expect(newLeaf.length).toBe(1);
    expect(newLeaf[0]!.value).toEqual({ size: "L", color: "red" });
  });

  test("S12. zero-match guard: filter matches nothing → throws and writes no rows", async () => {
    const sourceId = await seedProduct(db, {
      primaryIdentifier: "split-12-source",
      values: {
        title: {
          "shopify-au": {
            en_AU: [obsRow("flipkart:link", "Flipkart Title", "fk-1")]
          }
        }
      }
    });

    const countProducts = async (): Promise<number> => {
      const rows = await db.execute(
        sql`SELECT count(*)::int AS c FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}::uuid`
      );
      return (rows.rows[0] as { c: number }).c;
    };
    const countEvents = async (): Promise<number> => {
      const rows = await db.execute(
        sql`SELECT count(*)::int AS c FROM catalog_events WHERE tenant_id = ${TEST_TENANT_ID}::uuid`
      );
      return (rows.rows[0] as { c: number }).c;
    };
    const countLineage = async (): Promise<number> => {
      const rows = await db.execute(sql`
        SELECT count(*)::int AS c FROM product_lineage
        WHERE product_id IN (SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}::uuid)
           OR origin_product_id IN (SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}::uuid)
      `);
      return (rows.rows[0] as { c: number }).c;
    };
    const countRevisions = async (): Promise<number> => {
      const rows = await db.execute(
        sql`SELECT count(*)::int AS c FROM catalog_product_revisions WHERE tenant_id = ${TEST_TENANT_ID}::uuid`
      );
      return (rows.rows[0] as { c: number }).c;
    };

    const productsBefore = await countProducts();
    const eventsBefore = await countEvents();
    const lineageBefore = await countLineage();
    const revisionsBefore = await countRevisions();

    let threw = false;
    try {
      await splitProduct({
        db,
        tenantId: TENANT,
        sourceProductId: sourceId,
        observationFilter: { sources: ["amazon:link"] },
        newIdentity: {
          primaryIdentifier: "split-12-new",
          identity: {}
        },
        actor: TEST_ACTOR,
        rationale: "zero-match guard test"
      });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/zero observations|phantom/i);
    }
    expect(threw).toBe(true);

    expect(await countProducts()).toBe(productsBefore);
    expect(await countEvents()).toBe(eventsBefore);
    expect(await countLineage()).toBe(lineageBefore);
    expect(await countRevisions()).toBe(revisionsBefore);
  });
});
