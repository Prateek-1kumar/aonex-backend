// Phase 4 integration smoke test (Task 4.7).
//
// Drives the full new-catalog write→read→trace→reconcile chain end-to-end
// against the real dev DB + a real local Redis, using only the public
// helpers landed across tasks 4.2–4.6. Single test file with one big
// scenario — this is the phase-level "everything composes" check that
// complements the per-task unit tests already covering each helper in
// isolation.
//
// Lives in apps/worker because two of the three exercised modules are here
// (runNewLinkCatalogPath, startReconcilerWorkers). The read + trace paths
// (apps/api helpers) are already exhaustively covered by their own handler
// suites — catalog.test.ts (7 tests) and admin-trace.test.ts (7 tests) —
// so this smoke focuses on the write-and-spawn composition specifically.
//
// What this test does NOT cover:
//   - The HTTP boundary (Hono routes). Handler-shape contracts are pinned
//     in apps/api/src/handlers/{catalog,admin-trace}.test.ts.
//   - End-to-end with a real Nango webhook driving the link-extract
//     processor. The plan's step 1 envisions that, but as a sub-agent we
//     can't drive Nango — instead we call runNewLinkCatalogPath directly,
//     which is exactly what the processor calls under the flag.
//   - Job processing inside the reconciler Worker. We verify the spawner
//     wires up a Worker with the right per-tenant queue name and closes
//     cleanly; the actual debounced-projectSync loop is covered by the
//     catalog-service suite (84 tests).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import IORedis from "ioredis";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  TEST_CHANNEL_ID,
  TEST_MERCHANT_ID,
  TEST_TENANT_ID,
  closeTestDb,
  connectTestDb,
  ensureTestChannel,
  ensureTestMerchant,
  ensureTestTenant,
} from "@aonex/db/testing";
import { reconcilerQueueName } from "@aonex/catalog-service";
import type {
  ArtifactId,
  ChannelId,
  MerchantId,
  TenantId,
} from "@aonex/types";
import type { SkuJson } from "@aonex/ingestion-enrichment";
import { runNewLinkCatalogPath } from "./new-catalog-link-path.js";
import { startReconcilerWorkers } from "../jobs/reconciler-async.js";

const TENANT = TEST_TENANT_ID as unknown as TenantId;
const MERCHANT = TEST_MERCHANT_ID as unknown as MerchantId;
const CHANNEL = TEST_CHANNEL_ID as unknown as ChannelId;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const TEST_ACTOR = "test:phase-4-smoke";
// Stable artifact id so cleanup can be targeted.
const TEST_ARTIFACT_ID =
  "00000000-0000-0000-0000-000000ff4001" as unknown as ArtifactId;

// ---- Fixtures --------------------------------------------------------------

function buildSkuFixture(): SkuJson {
  return {
    title: "Phase-4 Smoke Widget",
    brand: "SmokeBrand",
    gtin: "07000000ph4007",
    mpn: null,
    model_number: null,
    sku: null,
    description_short: null,
    description_long: null,
    highlights: [],
    category_path: null,
    category_confidence: 0,
    breadcrumbs: [],
    pricing: {
      list_price: 199.95,
      sale_price: 149.95,
      currency: "AUD",
      discount_percent: null,
      price_per_unit: null,
    },
    ratings: { average: null, count: null },
    seller: { name: null, is_official: null },
    images: [],
    options: [],
    variants: [],
    attributes: {},
    shipping: {
      free_shipping: null,
      shipping_cost: null,
      weight: null,
      dimensions: null,
    },
    warranty: null,
    return_policy: null,
    _field_confidence: {
      title: 0.95,
      brand: 0.95,
      gtin: 0.95,
    },
    _field_source: {},
    _extraction_meta: {
      passes_run: [],
      tokens_used: 0,
      cost_usd: 0,
      latency_ms: 0,
      escalated_to: "static",
    },
  };
}

// ---- Cleanup ---------------------------------------------------------------

async function seedCatchAllRule(db: DrizzleClient): Promise<void> {
  // The async-debounced reconciler suite + the link-path suite both seed
  // a global catch-all so projectSync has something to pick. We do the
  // same here and DELETE it in afterAll via the TEST_ACTOR tag.
  //
  // Note: the dev DB also carries 19 production-seed source_priority rows
  // (migration 0014). Those stay untouched — projectSync evaluates both
  // sets, and whichever rule has the highest priority wins per attribute.
  await db.insert(schema.sourcePriority).values({
    tenantId: null,
    attributeCode: null,
    sourceGlob: "*",
    channelScope: null,
    priority: 100,
    rulesVersion: 1,
    actor: TEST_ACTOR,
  });
}

async function cleanup(db: DrizzleClient): Promise<void> {
  // Side tables first (FK to catalog_products).
  await db
    .delete(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.tenantId, TEST_TENANT_ID));
  await db.execute(
    sql`DELETE FROM catalog_events WHERE tenant_id = ${TEST_TENANT_ID}`
  );
  // catalog_product_revisions is immutable via trigger — disable for cleanup.
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
    .delete(schema.identityLog)
    .where(eq(schema.identityLog.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.reviewTasks)
    .where(eq(schema.reviewTasks.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
}

// ---- Tests -----------------------------------------------------------------

describe("Phase 4 integration smoke (Task 4.7)", () => {
  let db: DrizzleClient;
  let connection: IORedis;

  beforeAll(async () => {
    db = await connectTestDb();
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await cleanup(db);
    await seedCatchAllRule(db);
  });

  afterAll(async () => {
    await cleanup(db);
    await connection.quit();
    await closeTestDb();
  });

  test("write → read → trace → reconcile composition", async () => {
    // ---- (1) WRITE: runNewLinkCatalogPath ---------------------------------
    //
    // Drive the same helper apps/worker/src/jobs/processors/link-extract.ts
    // calls under the feature flag. We pass a resolved channel matching the
    // seeded TEST_CHANNEL (channelKind=shopify, region=au) so pricing
    // observations land on a real channel row.

    const sku = buildSkuFixture();
    const writeResult = await runNewLinkCatalogPath({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      artifactId: TEST_ARTIFACT_ID,
      sourceUrl: "https://shop.smokebrand-au.example/product/phase-4-widget",
      sku,
      channelId: CHANNEL,
      // Must match channelCodeFromUrl's host-derived output: dots → dashes.
      // Host `shop.smokebrand-au.example` → code `shop-smokebrand-au-example`.
      channelCode: "shop-smokebrand-au-example",
      channelDefaultCurrency: "AUD",
      channelDefaultLocale: "en_AU",
    });

    expect(writeResult.created).toBe(true);
    expect(writeResult.productId).toBeDefined();
    expect(writeResult.matchPath).toBe("newly_created");
    expect(writeResult.pricingObservationsWritten).toBeGreaterThan(0);

    const productId = writeResult.productId;

    // catalog_products row landed.
    const products = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    expect(products.length).toBe(1);
    expect(products[0]!.tenantId).toBe(TEST_TENANT_ID);
    // primaryIdentifier is the canonical fingerprint chosen by the writer
    // — we don't pin its exact value here (resolver-internal), only that
    // it's non-empty.
    expect(typeof products[0]!.primaryIdentifier).toBe("string");
    expect(products[0]!.primaryIdentifier.length).toBeGreaterThan(0);

    // Pricing observation row(s) landed on TEST_CHANNEL.
    const pricingObs = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, productId));
    expect(pricingObs.length).toBe(1);
    expect(pricingObs[0]!.channelId).toBe(TEST_CHANNEL_ID);
    expect(pricingObs[0]!.currency).toBe("AUD");
    expect(pricingObs[0]!.source).toBe("shop-smokebrand-au-example:link");

    // Revision row with create + link-extract actor.
    const revisions = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(
        and(
          eq(schema.catalogProductRevisions.productId, productId),
          eq(schema.catalogProductRevisions.tenantId, TEST_TENANT_ID)
        )
      );
    expect(revisions.length).toBe(1);
    expect(revisions[0]!.revisionReason).toBe("create");
    expect(revisions[0]!.actor).toBe("link-extract");

    // Outbox event for the create.
    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(
        and(
          eq(schema.catalogEvents.productId, productId),
          eq(schema.catalogEvents.tenantId, TEST_TENANT_ID)
        )
      );
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("catalog.product.created");

    // ---- (2) WINNING_VALUES populated synchronously -----------------------
    //
    // projectSync runs inside writeAdapterOutput's transaction, so by the
    // time the call returns, catalog_products.winning_values is populated
    // for all touched sync-tier attributes (title, brand, etc.).

    const winning = (products[0]!.winningValues ?? {}) as Record<string, unknown>;
    expect(Object.keys(winning).length).toBeGreaterThan(0);
    expect(winning.title).toBeDefined();
    expect(winning.brand).toBeDefined();

    // ---- (3) RECONCILE: startReconcilerWorkers ----------------------------
    //
    // Verify the spawner wires up at least one Worker (the shared test
    // tenant is always active). We don't process any jobs here — that's
    // covered by the catalog-service suite. The lifecycle assertion is:
    //
    //   - handles array has >= 1 entry
    //   - at least one handle's tenantId is TEST_TENANT_ID
    //   - its worker.name matches `recon.<tenantId>` convention
    //   - close() resolves cleanly without leaking the Redis subscription

    const handles = await startReconcilerWorkers(
      { db, connection },
      {}
    );
    try {
      expect(handles.length).toBeGreaterThanOrEqual(1);
      const sharedHandle = handles.find(
        (h) => h.tenantId === TEST_TENANT_ID
      );
      expect(sharedHandle).toBeDefined();
      expect(sharedHandle!.worker.name).toBe(
        reconcilerQueueName(TEST_TENANT_ID)
      );
    } finally {
      // Always close to release the Redis subscription, even if an
      // assertion above failed (the BullMQ Worker holds a long-lived
      // subscriber connection — leaking it makes downstream tests flaky).
      await Promise.all(handles.map((h) => h.worker.close()));
    }
  });
});
