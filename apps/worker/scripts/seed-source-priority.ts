#!/usr/bin/env bun
// Run: bun --env-file=../../.env run scripts/seed-source-priority.ts
//
// Phase 1 — Task 1.11 — seed the 19 v1 global default rules into
// `source_priority`. Rules are loaded from
// packages/db/seed/source-priority-defaults.json (ground truth, verbatim from
// spec §13 / plan lines 833-855).
//
// Idempotency strategy (Option B from the task brief):
// We probe for any row matching (tenant_id IS NULL, actor = 'seed',
// rules_version = $rulesVersion, effective_to IS NULL). If at least one such
// row exists, we assume this version of the seed has already been applied and
// exit without inserting anything. This guards against partial re-runs leaving
// the DB in a half-seeded state — either all 19 are present, or none are.
// Note: `source_priority` has no natural unique constraint on
// (tenant_id, attribute_code, source_glob, channel_scope), so plain
// onConflictDoNothing() cannot dedupe; this pre-check is required.
//
// Test cleanup in packages/db/src/schema/source-priority.test.ts targets only
// rows with actor = 'test-global:source-priority' (see TEST_GLOBAL_ACTOR),
// so the seeded rows (actor = 'seed') are untouched by tests.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import { createDb, schema } from "@aonex/db";

type SeedRule = {
  attribute_code: string;
  source_glob: string;
  priority: number;
  channel_scope: string;
  rules_version: number;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_JSON_PATH = resolve(
  __dirname,
  "../../../packages/db/seed/source-priority-defaults.json"
);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const raw = readFileSync(SEED_JSON_PATH, "utf-8");
const rules: SeedRule[] = JSON.parse(raw);

if (!Array.isArray(rules) || rules.length === 0) {
  console.error(`No rules found in ${SEED_JSON_PATH}`);
  process.exit(1);
}

// Sanity: all rules in this file must share the same rules_version, since the
// idempotency probe is keyed on a single rules_version value.
const rulesVersion = rules[0]!.rules_version;
for (const rule of rules) {
  if (rule.rules_version !== rulesVersion) {
    console.error(
      `All seed rules must share a single rules_version; got ${rule.rules_version} != ${rulesVersion}`
    );
    process.exit(1);
  }
}

const { client, close } = createDb(databaseUrl);
try {
  const existing = await client
    .select({ ruleId: schema.sourcePriority.ruleId })
    .from(schema.sourcePriority)
    .where(
      and(
        isNull(schema.sourcePriority.tenantId),
        eq(schema.sourcePriority.actor, "seed"),
        eq(schema.sourcePriority.rulesVersion, rulesVersion),
        isNull(schema.sourcePriority.effectiveTo)
      )!
    )
    .limit(1);

  if (existing.length > 0) {
    console.log(
      `source_priority seed v${rulesVersion} already applied (found existing active row); skipping`
    );
    process.exit(0);
  }

  const inserted = await client
    .insert(schema.sourcePriority)
    .values(
      rules.map((rule) => ({
        tenantId: null,
        attributeCode: rule.attribute_code,
        sourceGlob: rule.source_glob,
        channelScope: rule.channel_scope,
        priority: rule.priority,
        rulesVersion: rule.rules_version,
        actor: "seed"
      }))
    )
    .returning({ ruleId: schema.sourcePriority.ruleId });

  console.log(`Seeded ${inserted.length} source_priority rules`);
} catch (err) {
  console.error("Failed to seed source_priority:", err);
  process.exit(2);
} finally {
  await close();
}
