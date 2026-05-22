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
import { mergeProducts, splitProduct, unmergeProduct } from "./merge.js";

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
  // _current rows have no tenant column — scope by product_id via subselect.
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

    // Snapshot post-first-unmerge counts of events + unmerge revisions on the
    // winner so we can prove the second call writes nothing further.
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

    // No additional event/revision row written by the short-circuit path.
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

  test("11. unmerge over-removal guard: winner and loser share (source, sourceRecordId) but differ in (value, observedAt) — only the moved-in row is peeled off", async () => {
    // Winner already has an obs `{source:"ebay:c", sourceRecordId:"r1",
    // value:"A", observed_at:T1}`. Loser has `{source:"ebay:c",
    // sourceRecordId:"r1", value:"B", observed_at:T2}` on the same leaf
    // coordinates. Merging puts both on the winner; unmerge must remove ONLY
    // the loser's row (matched on the full triple including observedAt).
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

    // Sanity: winner leaf now carries both rows post-merge.
    const winnerMid = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, winnerId));
    const midLeaf = (winnerMid[0]!.values as Record<string, any>).title[
      "shopify-au"
    ].en_AU as StoredObservation[];
    expect(midLeaf.length).toBe(2);

    // Undo recipe must carry observedAt so unmerge can disambiguate.
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

    // Winner's original obs (A, T1) is intact; the moved-in (B, T2) is gone.
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

    // Seed pricing and inventory _current rows attached to the loser.
    await db.insert(schema.catalogPricingCurrent).values({
      productId: loserId,
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

    // Loser is now tombstoned.
    const midLoser = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, loserId));
    expect(midLoser[0]!.status).toBe("merged_into");

    // Undo recipe captures the prior 'frozen_pending_review' status.
    const revs = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.revisionId, mergeResult.revisionId));
    const diff = revs[0]!.diff as Record<string, any>;
    expect(diff.losers[0].priorStatus).toBe("frozen_pending_review");

    // Unmerge restores the freeze.
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

// =============================================================================
// splitProduct tests (plan §3.9, spec §18.2)
// =============================================================================
//
// Splits create a NEW product row and MOVE observations matching a typed
// filter from source → new. Crucially, the source's revisions are NEVER moved
// (per spec §18.2 — moving revisions would corrupt the immutability guarantee).
// "Full history" of the new product is a UNION of (revisions WHERE product_id
// = new) ∪ (revisions WHERE product_id = source AND matches(filter)) — but
// since a revision row has no per-observation breakdown, the filter only
// distinguishes at the source-of-truth level. See test 8 for the union query.

describe("splitProduct (plan §3.9, spec §18.2)", () => {
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

    // Seed pricing/inventory side-table rows attached to source. Two rows: one
    // from amazon:link (should move with the split) + one from flipkart:link
    // (should stay).
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

    // Pre-split revision count on source — must be unchanged after split
    // (except for the +1 manual_split revision).
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

    // Source.values: only flipkart observation left.
    const sourceRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, sourceId));
    const sourceLeaf = (sourceRows[0]!.values as Record<string, any>).title["shopify-au"]
      .en_AU as StoredObservation[];
    expect(sourceLeaf.length).toBe(1);
    expect(sourceLeaf[0]!.source).toBe("flipkart:link");

    // New product exists with the amazon observation.
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

    // Side-table rows: amazon moved, flipkart stays.
    const newPricing = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, result.newProductId));
    expect(newPricing.length).toBe(1);
    expect(newPricing[0]!.source).toBe("amazon:link");
    // mergedFromProductId stays null on split (it's merge-specific).
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

    // product_lineage row: operation='split', productId=new, origin=source.
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

    // Revision rows: one on source (manual_split), one on new (manual_split with lineage_pointer).
    const sourceRevsAfter = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, sourceId));
    // Exactly one new revision added (the manual_split one).
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
    // lineage_pointer: spec §18.2 requires "first revision carries lineage_pointer to source".
    expect(newDiff.lineage_pointer).toBeDefined();
    expect(newDiff.lineage_pointer.source_revision).toBe(result.splitRevisionIds.source);

    expect(result.splitRevisionIds.source).toBe(sourceSplitRev!.revisionId);
    expect(result.splitRevisionIds.new).toBe(newRev.revisionId);

    // Outbox event.
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
    // When attributeCodes is set, the filter is jsonb-content-specific; the
    // side-tables don't carry attribute_code, so we cannot meaningfully apply
    // the filter to them. We therefore leave side-table rows in place. This
    // tests the documented design decision.
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
    // Pricing NOT moved — attributeCodes filter is jsonb-content-specific
    // and side-tables have no attribute_code column to filter on.
    expect(result.pricingObservationsMoved).toBe(0);
    expect(result.inventoryObservationsMoved).toBe(0);

    const sourceRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, sourceId));
    const sourceValues = sourceRows[0]!.values as Record<string, any>;
    // title leaf empty/removed; brand still present.
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

    // Pricing stays on source.
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
    // Source keeps both AU observations.
    expect(sourceValues.title["shopify-au"].en_AU.length).toBe(2);
    // amazon-us leaf is now empty/missing on source.
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
    // Re-use the synthetic OTHER_TENANT pattern from test 6 in the merge suite.
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
        tenantId: TENANT, // wrong tenant
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

    // Cleanup.
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
    // Seed a source product with a couple of existing ingest revisions, then
    // split. Assert that pre-existing revisions are still attached to the
    // source (NOT moved to the new product). Only delta: +1 manual_split
    // revision on source, +1 manual_split revision on new.
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

    // Manually insert a couple of "ingest" revision rows that pre-date the
    // split. These should NEVER be moved.
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

    // The pre-existing revisions are still on the source — they were NOT
    // physically moved to the new product.
    const sourceRevsAfter = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, sourceId));
    const sourceRevIds = new Set(sourceRevsAfter.map((r) => r.revisionId));
    for (const id of preSplitSourceRevIds) {
      expect(sourceRevIds.has(id)).toBe(true);
    }
    // New product has only its own manual_split revision (not the ingest rows).
    const newRevs = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, result.newProductId));
    expect(newRevs.length).toBe(1);
    expect(preSplitSourceRevIds.has(newRevs[0]!.revisionId)).toBe(false);
  });

  test("S8. full-history union query: revisions for new ∪ revisions on source (matching filter at the source-of-truth level)", async () => {
    // The spec defines "full history" of the new product as the union of:
    //   - revisions WHERE product_id = new (forward history from split point)
    //   - revisions WHERE product_id = source AND matches(split_filter)
    //     (history that logically belongs to new but stays attached to origin)
    //
    // v1 limitation: a revision row has no per-observation breakdown, so the
    // filter cannot truly distinguish at the revision level. The union query
    // we ship returns ALL revisions of source + all revisions of new and lets
    // the consumer decide. We exercise the union query here.
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

    // "Full history" union — see the runbook for the canonical query.
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

    // Expected: 1 synthetic ingest on source + 1 manual_split on source + 1 manual_split on new = 3.
    expect(fullHistory.rows.length).toBe(3);
    const reasons = (fullHistory.rows as Array<{ revision_reason: string }>).map(
      (r) => r.revision_reason
    );
    expect(reasons.filter((r) => r === "manual_split").length).toBe(2);
    expect(reasons.filter((r) => r === "ingest_observation").length).toBe(1);
  });

  test("S9. _current rows cleared on source after split (async reconciler rebuilds)", async () => {
    // Per design decision 7: rather than filter-aware deletion of _current rows
    // (which is complex), we delete ALL of source's pricing/inventory _current
    // rows. The async-debounced reconciler rebuilds from observations.
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
    // Source has two title observations:
    //   - default:connector "Default Title" (low priority — wins absent better)
    //   - premium:connector "Premium Title" (high priority — currently winner)
    // We split out the premium observation. After split:
    //   - source.winning_values.title should equal "Default Title".
    //   - new.winning_values.title should equal "Premium Title".
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
    // jsonb does not preserve object key order on round-trip, so a stored
    // observation value `{size:"L", color:"red"}` must still match a
    // caller-supplied `{color:"red", size:"L"}`. Regression guard for the
    // previous JSON.stringify-based comparison.
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
        // Different key order than stored — must still match via deepEqual.
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

    // Source keeps only the {size:"M", color:"blue"} row.
    const sourceRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, sourceId));
    const sourceLeaf = (sourceRows[0]!.values as Record<string, any>).attrs[
      "shopify-au"
    ].en_AU as StoredObservation[];
    expect(sourceLeaf.length).toBe(1);
    expect(sourceLeaf[0]!.value).toEqual({ size: "M", color: "blue" });

    // New product carries the red-L row.
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
    // Seed source with observations from flipkart:link, then call splitProduct
    // with a filter that targets amazon:link (matches nothing). Must throw
    // BEFORE creating a phantom new product / lineage / event / revision.
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

    // Snapshot tenant-scoped table counts before the call.
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
        observationFilter: { sources: ["amazon:link"] }, // matches nothing
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

    // No phantom rows.
    expect(await countProducts()).toBe(productsBefore);
    expect(await countEvents()).toBe(eventsBefore);
    expect(await countLineage()).toBe(lineageBefore);
    expect(await countRevisions()).toBe(revisionsBefore);
  });
});
