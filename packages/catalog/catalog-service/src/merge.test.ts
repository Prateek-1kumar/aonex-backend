// Tests for mergeProducts + unmergeProduct (plan §3.8, spec §18.1).
//
// Runs against the real dev DB. Each test seeds two-or-more catalog_products
// rows scoped to TEST_TENANT_ID with synthetic observations, then exercises
// `mergeProducts` / `unmergeProduct` and asserts the spec §18.1 invariants:
//   - observations moved into winner.values (preserving source + sourceRecordId)
//   - variants re-parented onto winner
//   - side-table rows moved with merged_from_product_id set
//   - loser tombstoned (status='merged_into') — never deleted
//   - revision row on winner carries the full undo recipe in diff
//   - product_lineage row per loser
//   - catalog.product.merged / catalog.product.unmerged outbox event
//   - unmerge restores everything and is idempotent on re-call

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
import { mergeProducts, unmergeProduct } from "./merge.js";

const TENANT = TEST_TENANT_ID as unknown as TenantId;
const TEST_ACTOR = "test:catalog-merge";

// ---- Helpers ---------------------------------------------------------------

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
  // Order matters: lineage / events / observations / revisions before products.
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
  // Clear self-references (parent_product_id, merged_into_product_id) before deleting products.
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

    // Winner now carries both observations on the title leaf.
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
    // source + source_record_id preserved on the moved-in observation.
    const movedIn = titleLeaf.find((o) => o.value === "Loser Title")!;
    expect(movedIn.source).toBe("ebay:connector");
    expect(movedIn.source_record_id).toBe("loser-rec-1");

    // Loser tombstoned, not deleted.
    const loserRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, loserId));
    const loser = loserRows[0]!;
    expect(loser.status).toBe("merged_into");
    expect(loser.mergedIntoProductId).toBe(winnerId);

    // Revision row on winner with reason='manual_merge' + diff containing undo recipe.
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

    // product_lineage row.
    const lineage = await db
      .select()
      .from(schema.productLineage)
      .where(eq(schema.productLineage.productId, winnerId));
    const mergeRow = lineage.find((l) => l.originProductId === loserId);
    expect(mergeRow).toBeDefined();
    expect(mergeRow!.operation).toBe("merge");
    expect(mergeRow!.rationale).toBe("duplicate gtin");
    expect(mergeRow!.actor).toBe("test:steward");

    // outbox event.
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

    // None left under the loser.
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

    // Use a synthetic UUID for the cross-tenant guard. We don't actually need
    // a real second-tenant product — we patch the winner row's tenantId
    // mismatch on a freshly seeded "loser" via raw SQL since FK constraints
    // require tenantId to be valid. So instead: seed a loser, then update
    // its tenantId to a sentinel that exists (we'll create one).
    const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";
    await db.execute(sql`
      INSERT INTO tenants (id, name)
      VALUES (${OTHER_TENANT}::uuid, 'Other Tenant Merge Test')
      ON CONFLICT (id) DO NOTHING
    `);
    // Need a merchant for the FK too.
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

    // Cleanup: delete the other-tenant product row so afterAll cleanup doesn't fall over.
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

    // Loser back to active, merged_into cleared.
    const loserRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, loserId));
    expect(loserRows[0]!.status).toBe("active");
    expect(loserRows[0]!.mergedIntoProductId).toBeNull();

    // Winner's values no longer contain loser's observation.
    const winnerRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId));
    const titleLeaf = (winnerRows[0]!.values as Record<string, any>).title[
      "shopify-au"
    ].en_AU as StoredObservation[];
    expect(titleLeaf.length).toBe(1);
    expect(titleLeaf[0]!.value).toBe("Winner");

    // Pricing observation moved back to loser, merged_from cleared.
    const pricing = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, loserId));
    expect(pricing.length).toBe(1);
    expect(pricing[0]!.mergedFromProductId).toBeNull();

    // Unmerge lineage row.
    const lineage = await db
      .select()
      .from(schema.productLineage)
      .where(eq(schema.productLineage.productId, loserId));
    const unmergeLineage = lineage.find((l) => l.operation === "unmerge");
    expect(unmergeLineage).toBeDefined();

    // Outbox event.
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

    // Verify merge produced premium as the winning value.
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
});
