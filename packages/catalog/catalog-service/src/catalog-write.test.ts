// Tests for the catalog write service (plan §3.5, spec §13).
//
// Runs against the real dev DB. Each test builds a small synthetic
// AdapterOutput inline (no Phase-2 fixtures) so failures point straight at
// the write-service algorithm, not at adapter input quirks.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
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
  ensureTestTenant
} from "@aonex/db/testing";
import type {
  ChannelId,
  MerchantId,
  TenantId
} from "@aonex/types";
import type {
  AdapterOutput,
  CanonicalObservation,
  PricingObservation
} from "@aonex/catalog-source-adapters";
import { writeAdapterOutput, DEFAULT_OBSERVATION_CAP } from "./catalog-write.js";
import { reconcilerQueueName, reconcilerJobId, processReconcilerJob } from "./reconciler/async-debounced.js";
import type { ReconcilerJobData } from "./reconciler/async-debounced.js";
import type { Queue } from "bullmq";

const TENANT = TEST_TENANT_ID as unknown as TenantId;
const MERCHANT = TEST_MERCHANT_ID as unknown as MerchantId;
const CHANNEL = TEST_CHANNEL_ID as unknown as ChannelId;

const TEST_ACTOR = "test:catalog-write";

// ---- Helpers ---------------------------------------------------------------

function obs(overrides: Partial<CanonicalObservation> = {}): CanonicalObservation {
  return {
    attributeCode: "title",
    target: "parent",
    channelCode: "shopify-au",
    localeCode: "en_AU",
    source: "shopify:connector",
    sourceRecordId: "gid://shopify/Product/1",
    value: "Default Title",
    confidence: 0.95,
    observedAt: new Date("2026-05-21T10:00:00Z"),
    ...overrides
  };
}

function pricingObs(overrides: Partial<PricingObservation> = {}): PricingObservation {
  return {
    productHint: "p1",
    channelCode: "shopify-au",
    locale: "en_AU",
    source: "shopify:connector",
    sourceRecordId: "gid://shopify/ProductVariant/1",
    currency: "AUD",
    tiers: [{ kind: "list", amount: 99.95 }],
    observedAt: new Date("2026-05-21T10:00:00Z"),
    ...overrides
  };
}

function adapterOutput(parts: Partial<AdapterOutput> = {}): AdapterOutput {
  return {
    observations: [],
    pricingObservations: [],
    inventoryObservations: [],
    identityHint: { targetIsVariant: false },
    rawPayload: { src: "test" },
    ...parts
  };
}

async function seedRules(db: DrizzleClient): Promise<void> {
  // Minimal default catch-all so projectSync has something to pick.
  await db.insert(schema.sourcePriority).values({
    tenantId: null,
    attributeCode: null,
    sourceGlob: "*",
    channelScope: null,
    priority: 100,
    rulesVersion: 1,
    actor: TEST_ACTOR
  });
}

async function cleanup(db: DrizzleClient): Promise<void> {
  // Side tables and revisions must be cleared before catalog_products due
  // to logical referential ordering (no DB-level FK on revisions/events,
  // but pricing/inventory observations carry product_id we want to scrub).
  await db
    .delete(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.tenantId, TEST_TENANT_ID));
  await db.execute(
    sql`DELETE FROM catalog_events WHERE tenant_id = ${TEST_TENANT_ID}`
  );
  // catalog_product_revisions has an immutability trigger; disable around
  // the test-tenant scrub then re-enable.
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`
  );
  await db
    .delete(schema.catalogProductRevisions)
    .where(eq(schema.catalogProductRevisions.tenantId, TEST_TENANT_ID));
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`
  );
  // Identity-policy side-effects must be cleared before catalog_products
  // (identity_log has FK to catalog_products.product_id).
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

describe("writeAdapterOutput (plan §3.5, spec §13)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await cleanup(db);
    await seedRules(db);
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  test("1. creates a new product on first ingest", async () => {
    const out = adapterOutput({
      observations: [
        obs({
          attributeCode: "title",
          value: "Acme Widget",
          sourceRecordId: "gid://shopify/Product/T1"
        })
      ],
      identityHint: {
        gtin: "01000000000001",
        brand: "Acme",
        targetIsVariant: false
      },
      rawPayload: { hello: "world" }
    });

    const result = await writeAdapterOutput({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: out,
      actor: "shopify:connector"
    });

    expect(result.created).toBe(true);
    expect(result.productId).toBeDefined();
    expect(result.matchPath).toBe("newly_created");
    expect(result.identityStrength).toBe(0);
    expect(result.observationsWritten).toBe(1);
    expect(result.overflowEvictions).toBe(0);
    expect(result.syncReconcilerResult).not.toBeNull();
    expect(result.syncReconcilerResult!.attributesProjected).toContain("title");

    const rows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.productId));
    const row = rows[0]!;
    expect(row.tenantId).toBe(TEST_TENANT_ID);
    expect(row.merchantId).toBe(TEST_MERCHANT_ID);
    const values = row.values as Record<string, any>;
    expect(Array.isArray(values?.title?.["shopify-au"]?.en_AU)).toBe(true);
    expect(values.title["shopify-au"].en_AU.length).toBe(1);
    expect(values.title["shopify-au"].en_AU[0].value).toBe("Acme Widget");

    const revisions = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(
        and(
          eq(schema.catalogProductRevisions.productId, result.productId),
          eq(schema.catalogProductRevisions.tenantId, TEST_TENANT_ID)
        )
      );
    expect(revisions.length).toBe(1);

    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(
        and(
          eq(schema.catalogEvents.productId, result.productId),
          eq(schema.catalogEvents.tenantId, TEST_TENANT_ID)
        )
      );
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("catalog.product.created");
  });

  test("2. attaches to existing product via GTIN match (no new row)", async () => {
    const gtin = "02000000000002";
    const seed = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: `seed:${gtin}`,
        identity: { gtin, identity_strength: 1.0 },
        status: "active",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const seededId = seed[0]!.productId;

    const before = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    const beforeCount = Number(before[0]!.count);

    const result = await writeAdapterOutput({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: adapterOutput({
        observations: [
          obs({
            attributeCode: "title",
            value: "Attached via GTIN",
            sourceRecordId: "gid://shopify/Product/T2"
          })
        ],
        identityHint: { gtin, targetIsVariant: false }
      }),
      actor: "shopify:connector"
    });

    expect(result.created).toBe(false);
    expect(result.matchPath).toBe("gtin");
    expect(result.identityStrength).toBe(1.0);
    expect(result.productId).toBe(seededId);

    const after = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    const afterCount = Number(after[0]!.count);
    expect(afterCount).toBe(beforeCount);

    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(eq(schema.catalogEvents.productId, seededId));
    expect(events.some((e) => e.eventType === "catalog.product.updated")).toBe(
      true
    );
  });

  test("3. pricing observations land in side table (not values JSONB)", async () => {
    const result = await writeAdapterOutput({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: adapterOutput({
        observations: [],
        pricingObservations: [
          pricingObs({
            sourceRecordId: "p3-a",
            tiers: [{ kind: "list", amount: 19.99 }]
          }),
          pricingObs({
            sourceRecordId: "p3-b",
            tiers: [{ kind: "sale", amount: 14.99 }]
          })
        ],
        identityHint: {
          gtin: "03000000000003",
          brand: "Acme",
          targetIsVariant: false
        }
      }),
      channelCodeToId: { "shopify-au": CHANNEL },
      actor: "shopify:connector"
    });

    expect(result.pricingObservationsWritten).toBe(2);

    const pricingRows = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, result.productId));
    expect(pricingRows.length).toBe(2);

    const productRow = await db
      .select({ values: schema.catalogProducts.values })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.productId));
    const values = productRow[0]!.values as Record<string, unknown>;
    expect(values.pricing).toBeUndefined();
  });

  test("4. dedup hint: same (source, sourceRecordId, value) is skipped", async () => {
    // Seed a product with an existing title observation.
    const existing = {
      source: "shopify:connector",
      source_record_id: "gid://shopify/Product/T4",
      value: "Dedup Title",
      confidence: 0.95,
      observed_at: "2026-05-21T09:00:00Z"
    };
    const seed = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "seed:dedup-04",
        identity: { gtin: "04000000000004", identity_strength: 1.0 },
        status: "active",
        values: {
          title: { "shopify-au": { en_AU: [existing] } }
        }
      })
      .returning({ productId: schema.catalogProducts.productId });
    const seededId = seed[0]!.productId;

    const result = await writeAdapterOutput({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: adapterOutput({
        observations: [
          obs({
            sourceRecordId: existing.source_record_id,
            value: existing.value,
            observedAt: new Date("2026-05-21T11:00:00Z")
          })
        ],
        identityHint: { gtin: "04000000000004", targetIsVariant: false }
      }),
      actor: "shopify:connector"
    });

    expect(result.productId).toBe(seededId);
    expect(result.observationsWritten).toBe(0);
    expect(result.overflowEvictions).toBe(0);

    const row = await db
      .select({ values: schema.catalogProducts.values })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, seededId));
    const values = row[0]!.values as Record<string, any>;
    expect(values.title["shopify-au"].en_AU.length).toBe(1);
  });

  test("5. N=20 observation cap overflows oldest to revision diff", async () => {
    // Pre-seed values with 20 title observations across distinct sourceRecordId
    // / observed_at pairs so the dedup hint does not trigger.
    const twentyObservations = Array.from({ length: 20 }, (_, i) => ({
      source: `src-${i}`,
      source_record_id: `rec-${i}`,
      value: `v-${i}`,
      confidence: 0.9,
      observed_at: new Date(
        Date.parse("2026-05-01T00:00:00Z") + i * 60_000
      ).toISOString()
    }));
    const seed = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "seed:overflow-05",
        identity: { gtin: "05000000000005", identity_strength: 1.0 },
        status: "active",
        values: {
          title: { "shopify-au": { en_AU: twentyObservations } }
        }
      })
      .returning({ productId: schema.catalogProducts.productId });
    const seededId = seed[0]!.productId;

    const result = await writeAdapterOutput({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: adapterOutput({
        observations: [
          obs({
            source: "src-new",
            sourceRecordId: "rec-new",
            value: "v-new",
            observedAt: new Date("2026-05-21T12:00:00Z")
          })
        ],
        identityHint: { gtin: "05000000000005", targetIsVariant: false }
      }),
      actor: "shopify:connector"
    });

    expect(result.overflowEvictions).toBe(1);

    const row = await db
      .select({ values: schema.catalogProducts.values })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, seededId));
    const values = row[0]!.values as Record<string, any>;
    expect(values.title["shopify-au"].en_AU.length).toBe(20);
    // The oldest observation (i=0, observed_at ~2026-05-01T00:00Z) should
    // have been popped.
    const remainingIds: string[] = values.title["shopify-au"].en_AU.map(
      (o: any) => o.source_record_id as string
    );
    expect(remainingIds).not.toContain("rec-0");
    expect(remainingIds).toContain("rec-new");

    const revRows = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, seededId));
    const lastRev = revRows[revRows.length - 1]!;
    const diff = lastRev.diff as { overflow_eviction?: unknown[] } | null;
    expect(diff).not.toBeNull();
    expect(Array.isArray(diff!.overflow_eviction)).toBe(true);
    expect(diff!.overflow_eviction!.length).toBe(1);
  });

  test("6. revision row carries raw_payload deep-equals input", async () => {
    const payload = { nested: { v: 42 }, arr: [1, 2, 3] };
    const result = await writeAdapterOutput({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: adapterOutput({
        observations: [
          obs({
            sourceRecordId: "gid://shopify/Product/T6",
            value: "Payload Test"
          })
        ],
        identityHint: {
          gtin: "06000000000006",
          targetIsVariant: false
        },
        rawPayload: payload
      }),
      actor: "shopify:connector"
    });

    const revs = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, result.productId));
    expect(revs.length).toBeGreaterThan(0);
    const lastRev = revs[revs.length - 1]!;
    expect(lastRev.rawPayload).toEqual(payload);
    expect(lastRev.actor).toBe("shopify:connector");
    expect(lastRev.revisionReason).toBe("create");
    expect(lastRev.sourceKind).toBe("shopify");
  });

  test("7. outbox event carries productId and matchPath in payload", async () => {
    const result = await writeAdapterOutput({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: adapterOutput({
        observations: [
          obs({
            sourceRecordId: "gid://shopify/Product/T7",
            value: "Event Test"
          })
        ],
        identityHint: {
          gtin: "07000000000007",
          targetIsVariant: false
        }
      }),
      actor: "shopify:connector"
    });

    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(eq(schema.catalogEvents.eventId, result.eventId));
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.eventType).toBe("catalog.product.created");
    expect(ev.productId).toBe(result.productId);
    expect(ev.tenantId).toBe(TEST_TENANT_ID);
    expect(ev.publishedAt).toBeNull();
    expect(ev.publishAttempts).toBe(0);
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.productId).toBe(result.productId);
    expect(payload.matchPath).toBe("newly_created");
  });

  test("8. attach branch consults identity-policy gate (smoke)", async () => {
    // Seed a priority-1 rule for shopify:* so the policy gate accepts a
    // single-source gtin update. This rule is scoped to TEST_ACTOR (cleaned
    // up in afterAll) and lives alongside the default catch-all.
    await db.insert(schema.sourcePriority).values({
      tenantId: null,
      attributeCode: null,
      sourceGlob: "shopify:*",
      channelScope: null,
      priority: 1,
      rulesVersion: 1,
      actor: TEST_ACTOR
    });

    // Seed an existing product without a gtin so the attach path applies a
    // new identity value via the policy gate.
    const seedGtin = "08000000000008";
    const seed = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: `seed:wiring-08`,
        identity: { mpn: "MPN-08", brand: "Acme", identity_strength: 0.9 },
        status: "active",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const seededId = seed[0]!.productId;

    const result = await writeAdapterOutput({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: adapterOutput({
        observations: [
          obs({
            sourceRecordId: "gid://shopify/Product/T8",
            value: "Wiring Smoke"
          })
        ],
        // mpn+brand match the seeded product → attach path. gtin is new →
        // policy gate applies the update.
        identityHint: {
          gtin: seedGtin,
          mpn: "MPN-08",
          brand: "Acme",
          targetIsVariant: false
        }
      }),
      actor: "shopify:connector"
    });

    expect(result.created).toBe(false);
    expect(result.productId).toBe(seededId);

    // The policy gate must have left a footprint: an identity_log row for
    // the gtin update (deep behaviour is covered in identity-policy.test.ts;
    // this just verifies the wiring is reached).
    const logs = await db
      .select()
      .from(schema.identityLog)
      .where(
        and(
          eq(schema.identityLog.productId, seededId),
          eq(schema.identityLog.identityField, "gtin")
        )
      );
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]!.newValue).toBe(seedGtin);
  });

  test("9. new product gets family='smartphone' when classified", async () => {
    const gtin = `t10:${Date.now()}`;
    const out = adapterOutput({
      observations: [
        obs({
          attributeCode: "title",
          value: "Google Pixel 10 5G",
          sourceRecordId: "gid://shopify/Product/T10"
        }),
        obs({
          attributeCode: "category_path",
          value: "mobile_phones",
          sourceRecordId: "gid://shopify/Product/T10"
        })
      ],
      pricingObservations: [
        pricingObs({
          sourceRecordId: "p10",
          tiers: [{ kind: "list", amount: 1499.0 }]
        })
      ],
      identityHint: { gtin, brand: "Google", targetIsVariant: false }
    });

    const result = await writeAdapterOutput({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: out,
      actor: "shopify:connector",
      channelCodeToId: { "shopify-au": CHANNEL }
    });

    expect(result.created).toBe(true);

    const rows = await db
      .select({ family: schema.catalogProducts.family })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.productId));
    expect(rows[0]?.family).toBe("smartphone");
  });

  test("7. enqueues pricing + inventory reconcile jobs after commit", async () => {
    const added: Array<{ name: string; data: ReconcilerJobData; opts: any }> = [];
    const stubQueue = {
      name: reconcilerQueueName(TEST_TENANT_ID),
      add: async (name: string, data: unknown, opts: unknown) => {
        added.push({ name, data, opts });
        return {} as never;
      },
    } as unknown as Queue;

    const observedAt = new Date("2026-05-30T00:00:00Z");
    const result = await writeAdapterOutput({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      actor: "test",
      reconcilerQueue: stubQueue,
      channelCodeToId: { "shopify-au": CHANNEL },
      adapterOutput: {
        observations: [
          {
            attributeCode: "title", target: "parent",
            channelCode: "shopify-au", localeCode: "en_AU",
            source: "test:link", sourceRecordId: "rec-7",
            value: "Priced Widget", confidence: 0.9, observedAt,
          },
        ],
        pricingObservations: [
          {
            productHint: "rec-7", channelCode: "shopify-au", locale: "en_AU",
            source: "test:link", sourceRecordId: "rec-7",
            currency: "AUD", tiers: [{ kind: "list", amount: 54.82 }], observedAt,
          },
        ],
        inventoryObservations: [
          {
            productHint: "rec-7", channelCode: "shopify-au",
            qty: 7, source: "test:link", sourceRecordId: "rec-7", observedAt,
          },
        ],
        identityHint: { titleForFuzzy: "Priced Widget", targetIsVariant: false },
        rawPayload: { sku: "rec-7" },
      },
    });

    const jobIds = added.map((a) => a.opts.jobId).sort();
    expect(jobIds).toEqual(
      [reconcilerJobId(result.productId, "inventory"), reconcilerJobId(result.productId, "pricing")].sort()
    );
    const attrs = added.map((a) => a.data.attributeCode).sort();
    expect(attrs).toEqual(["inventory", "pricing"]);
    for (const a of added) {
      expect(a.data.tenantId).toBe(TEST_TENANT_ID);
      expect(a.data.productId).toBe(result.productId);
    }
  });

  test("I3. no reconcile jobs enqueued when reconcilerQueue provided but no pricing/inventory observations", async () => {
    // Guard: the length-guards inside writeAdapterOutput must prevent any
    // enqueue call even when a reconcilerQueue is supplied. This pins the
    // regression so a future refactor cannot accidentally drop the guards.
    const added: Array<{ name: string; data: ReconcilerJobData; opts: any }> = [];
    const stubQueue = {
      name: reconcilerQueueName(TEST_TENANT_ID),
      add: async (name: string, data: unknown, opts: unknown) => {
        added.push({ name, data: data as ReconcilerJobData, opts });
        return {} as never;
      },
    } as unknown as Queue;

    await writeAdapterOutput({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      actor: "test",
      reconcilerQueue: stubQueue,
      // No channelCodeToId needed — no side-table observations.
      adapterOutput: adapterOutput({
        observations: [
          obs({
            attributeCode: "title",
            value: "Observations-Only Widget",
            sourceRecordId: `i3-obs-${Date.now()}`
          })
        ],
        pricingObservations: [],
        inventoryObservations: [],
        identityHint: { titleForFuzzy: "Observations-Only Widget", targetIsVariant: false }
      }),
    });

    expect(added.length).toBe(0);
  });

  test("observation cap is 20 and newest wins on overflow", async () => {
    // Pins both (a) the public cap constant and (b) newest-wins eviction
    // behaviour: 21 distinct observations on the same leaf must collapse to
    // 20, with the oldest (iter-0) evicted and iter-1..iter-20 surviving.
    expect(DEFAULT_OBSERVATION_CAP).toBe(20);

    const baseAt = Date.parse("2026-01-01T00:00:00Z");
    const gtin = `12000000000${Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, "0")}`;

    let lastProductId: string | null = null;
    for (let i = 0; i < 21; i++) {
      const result = await writeAdapterOutput({
        db,
        tenantId: TENANT,
        merchantId: MERCHANT,
        adapterOutput: adapterOutput({
          observations: [
            obs({
              attributeCode: "title",
              value: `iter-${i}`,
              // Each one strictly newer than the previous so the oldest-by-
              // observed_at eviction targets iter-0 unambiguously.
              observedAt: new Date(baseAt + i * 1000),
              sourceRecordId: `t12-r-${i}`
            })
          ],
          identityHint: { gtin, brand: "Acme", targetIsVariant: false }
        }),
        actor: "shopify:connector"
      });
      lastProductId = result.productId;
    }

    expect(lastProductId).not.toBeNull();
    const rows = await db
      .select({ values: schema.catalogProducts.values })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, lastProductId!));
    expect(rows.length).toBe(1);

    // values shape: { title: { "shopify-au": { en_AU: StoredObservation[] } } }
    const leaf = (rows[0]!.values as Record<string, any>).title["shopify-au"]
      .en_AU as Array<{ value: string }>;

    expect(leaf.length).toBe(20); // cap holds
    const surviving = leaf.map((o) => o.value);
    expect(surviving).not.toContain("iter-0");
    expect(surviving).toContain("iter-1");
    expect(surviving).toContain("iter-20");
  });

  test("8. pricing/inventory observations project to _current + winning_values after reconcile", async () => {
    const observedAt = new Date("2026-05-30T01:00:00Z");
    const result = await writeAdapterOutput({
      db,
      tenantId: TEST_TENANT_ID,
      merchantId: TEST_MERCHANT_ID,
      actor: "test",
      channelCodeToId: { "shopify-au": TEST_CHANNEL_ID },
      adapterOutput: {
        observations: [{
          attributeCode: "title", target: "parent",
          channelCode: "shopify-au", localeCode: "en_AU",
          source: "test:link", sourceRecordId: "rec-8",
          value: "Projected Widget", confidence: 0.9, observedAt,
        }],
        pricingObservations: [{
          productHint: "rec-8", channelCode: "shopify-au", locale: "en_AU",
          source: "test:link", sourceRecordId: "rec-8",
          currency: "AUD", tiers: [{ kind: "list", amount: 54.82 }], observedAt,
        }],
        inventoryObservations: [{
          productHint: "rec-8", channelCode: "shopify-au",
          qty: 7, source: "test:link", sourceRecordId: "rec-8", observedAt,
        }],
        identityHint: { titleForFuzzy: "Projected Widget", targetIsVariant: false },
        rawPayload: { sku: "rec-8" },
      },
    });

    const deps = { db, connection: {} as never };
    await processReconcilerJob(deps, { tenantId: TEST_TENANT_ID, productId: result.productId, attributeCode: "pricing", rulesVersion: 1 });
    await processReconcilerJob(deps, { tenantId: TEST_TENANT_ID, productId: result.productId, attributeCode: "inventory", rulesVersion: 1 });

    const priceRows = await db.select()
      .from(schema.catalogPricingCurrent)
      .where(eq(schema.catalogPricingCurrent.productId, result.productId));
    expect(priceRows.length).toBe(1);
    expect(priceRows[0]!.currency).toBe("AUD");
    expect(Number(priceRows[0]!.primaryAmount)).toBe(54.82);

    const invRows = await db.select()
      .from(schema.catalogInventoryCurrent)
      .where(eq(schema.catalogInventoryCurrent.productId, result.productId));
    expect(invRows.length).toBe(1);
    expect(invRows[0]!.qty).toBe(7);

    const rows = await db.select({ wv: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.productId));
    const wv = rows[0]!.wv as Record<string, unknown>;
    expect(wv.pricing).toBeDefined();
    expect(wv.inventory).toBeDefined();
  });
});
