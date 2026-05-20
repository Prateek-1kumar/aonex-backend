import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "../index.js";
import { connectTestDb, closeTestDb } from "../testing/connect.js";
import { ensureTestTenant, TEST_TENANT_ID } from "../testing/seed-tenant.js";
import type { DrizzleClient } from "../client.js";

// Marker used on any global-default (tenant_id IS NULL) rows this test inserts,
// so cleanup can target only our own rows without disturbing Task 1.11's later
// seed of 19 production global-default rules.
const TEST_GLOBAL_ACTOR = "test-global:source-priority";

describe("source_priority schema", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    // Scoped cleanup — tenant-scoped rows AND any global rows tagged with our marker.
    await db
      .delete(schema.sourcePriority)
      .where(eq(schema.sourcePriority.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.sourcePriority)
      .where(
        and(
          isNull(schema.sourcePriority.tenantId),
          eq(schema.sourcePriority.actor, TEST_GLOBAL_ACTOR)
        )!
      );
  });

  afterAll(async () => {
    await db
      .delete(schema.sourcePriority)
      .where(eq(schema.sourcePriority.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.sourcePriority)
      .where(
        and(
          isNull(schema.sourcePriority.tenantId),
          eq(schema.sourcePriority.actor, TEST_GLOBAL_ACTOR)
        )!
      );
    await closeTestDb();
  });

  test("inserts an active rule (effective_to IS NULL) for a tenant", async () => {
    const rows = await db
      .insert(schema.sourcePriority)
      .values({
        tenantId: TEST_TENANT_ID,
        attributeCode: "title",
        sourceGlob: "shopify:*",
        channelScope: "web",
        priority: 100,
        rulesVersion: 1,
        actor: "test"
      })
      .returning();
    const row = rows[0]!;

    expect(row.ruleId).toBeGreaterThan(0);
    expect(row.tenantId).toBe(TEST_TENANT_ID);
    expect(row.attributeCode).toBe("title");
    expect(row.sourceGlob).toBe("shopify:*");
    expect(row.channelScope).toBe("web");
    expect(row.priority).toBe(100);
    expect(row.rulesVersion).toBe(1);
    expect(row.effectiveFrom).toBeInstanceOf(Date);
    expect(row.effectiveTo).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  test("inserts a global-default rule (tenant_id IS NULL)", async () => {
    const rows = await db
      .insert(schema.sourcePriority)
      .values({
        tenantId: null,
        // attribute_code NULL = applies to all attributes
        attributeCode: null,
        sourceGlob: "akeneo:*",
        channelScope: null,
        priority: 50,
        rulesVersion: 1,
        actor: TEST_GLOBAL_ACTOR
      })
      .returning();
    const row = rows[0]!;

    expect(row.tenantId).toBeNull();
    expect(row.attributeCode).toBeNull();
    expect(row.channelScope).toBeNull();
    expect(row.sourceGlob).toBe("akeneo:*");
    expect(row.priority).toBe(50);
    expect(row.effectiveTo).toBeNull();
  });

  test("tombstoning a rule (effective_to = now()) removes it from current-rules queries", async () => {
    const insert = await db
      .insert(schema.sourcePriority)
      .values({
        tenantId: TEST_TENANT_ID,
        attributeCode: "description",
        sourceGlob: "salsify:*",
        channelScope: "web",
        priority: 75,
        rulesVersion: 1,
        actor: "test"
      })
      .returning();
    const ruleId = insert[0]!.ruleId;

    // Before tombstoning — present in current rules.
    const beforeTombstone = await db
      .select()
      .from(schema.sourcePriority)
      .where(
        and(
          eq(schema.sourcePriority.tenantId, TEST_TENANT_ID),
          eq(schema.sourcePriority.ruleId, ruleId),
          isNull(schema.sourcePriority.effectiveTo)
        )!
      );
    expect(beforeTombstone.length).toBe(1);

    // Tombstone: set effective_to = now().
    await db
      .update(schema.sourcePriority)
      .set({ effectiveTo: new Date() })
      .where(eq(schema.sourcePriority.ruleId, ruleId));

    // After tombstoning — absent from current rules.
    const afterTombstone = await db
      .select()
      .from(schema.sourcePriority)
      .where(
        and(
          eq(schema.sourcePriority.tenantId, TEST_TENANT_ID),
          eq(schema.sourcePriority.ruleId, ruleId),
          isNull(schema.sourcePriority.effectiveTo)
        )!
      );
    expect(afterTombstone.length).toBe(0);

    // Still visible if we ignore the effective_to predicate (sanity).
    const ignoringEffectiveTo = await db
      .select()
      .from(schema.sourcePriority)
      .where(eq(schema.sourcePriority.ruleId, ruleId));
    expect(ignoringEffectiveTo.length).toBe(1);
    expect(ignoringEffectiveTo[0]!.effectiveTo).toBeInstanceOf(Date);
  });

  test("idx_source_priority_lookup partial index is used for current-rule lookups", async () => {
    // Seed ~50 rules: 30 active + 20 tombstoned, spread across attribute codes
    // so the planner sees real cardinality.
    const tombstoneTs = new Date("2026-04-01T00:00:00Z");
    const bulk: Array<typeof schema.sourcePriority.$inferInsert> = [];
    for (let i = 0; i < 30; i += 1) {
      bulk.push({
        tenantId: TEST_TENANT_ID,
        attributeCode: `attr_${i % 5}`,
        sourceGlob: `src_${i % 7}:*`,
        channelScope: i % 2 === 0 ? "web" : "amazon",
        priority: 50 + i,
        rulesVersion: 1,
        actor: "test"
      });
    }
    for (let i = 0; i < 20; i += 1) {
      bulk.push({
        tenantId: TEST_TENANT_ID,
        attributeCode: `attr_${i % 5}`,
        sourceGlob: `src_${i % 7}:*`,
        channelScope: i % 2 === 0 ? "web" : "amazon",
        priority: 200 + i,
        rulesVersion: 1,
        effectiveTo: tombstoneTs,
        actor: "test"
      });
    }
    await db.insert(schema.sourcePriority).values(bulk).execute();

    await db.execute(sql`ANALYZE source_priority`);
    await db.execute(sql`SET enable_seqscan = OFF`);

    const plan = await db.execute(
      sql`EXPLAIN (FORMAT JSON)
          SELECT * FROM source_priority
          WHERE effective_to IS NULL
            AND tenant_id = ${TEST_TENANT_ID}
            AND attribute_code = 'attr_0'
            AND source_glob = 'src_0:*'
            AND channel_scope = 'web'`
    );

    await db.execute(sql`SET enable_seqscan = ON`);

    const planJson = JSON.stringify(plan.rows);
    // The migration names the partial index explicitly; assert it by name.
    expect(planJson).toMatch(/idx_source_priority_lookup/);
  });

  test("priority NOT NULL constraint rejects insert without a priority", async () => {
    await expect(
      (async () => {
        await db.execute(sql`
          INSERT INTO source_priority (tenant_id, source_glob, rules_version, actor)
          VALUES (${TEST_TENANT_ID}, 'shopify:*', 1, 'test')
        `);
      })()
    ).rejects.toThrow(/null value in column "priority"|not-null/i);
  });
});
