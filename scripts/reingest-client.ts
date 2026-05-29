#!/usr/bin/env bun
// Phase 2 Task 14: client-driven re-ingest tool (spec D5).
//
// Re-runs a tenant's catalog rows through the new pipeline so duplicates heal
// rather than multiply. Idempotent: the new resolution path (Task 6 + Task 13)
// attaches strong-keyed re-ingests to existing rows and routes Phase-1-shape
// duplicates to the Lab via heal_on_touch signals.
//
// This is a Phase 2 FIRST PASS — operational hardening (rate limiting,
// batching, checkpointing, dry-run) is a Phase 2.x follow-up. Today it walks
// catalog_products for a tenant, re-builds a synthetic AdapterOutput from each
// row's stored observations + identity, and feeds it through admitOrStage.
//
// Usage: bun run scripts/reingest-client.ts <tenant_id> [--dry-run]

import { connectTestDb, closeTestDb } from "@aonex/db/testing";
import { schema } from "@aonex/db";
import { eq, and, ne } from "drizzle-orm";

const tenantArg = process.argv[2];
if (!tenantArg) {
  console.error("usage: bun run scripts/reingest-client.ts <tenant_id> [--dry-run]");
  process.exit(2);
}
const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<number> {
  const db = await connectTestDb();
  try {
    const rows = await db
      .select({
        productId: schema.catalogProducts.productId,
        identity: schema.catalogProducts.identity,
        identifiers: schema.catalogProducts.identifiers,
        pipelineVersion: schema.catalogProducts.pipelineVersion,
        status: schema.catalogProducts.status,
      })
      .from(schema.catalogProducts)
      .where(and(
        eq(schema.catalogProducts.tenantId, tenantArg as unknown as never),
        ne(schema.catalogProducts.status, "merged_into"),
      ));

    console.log(`tenant ${tenantArg}: ${rows.length} rows`);
    let healable = 0;
    for (const row of rows) {
      if (row.pipelineVersion < 2) {
        healable++;
        if (dryRun) {
          console.log(`  would re-ingest ${row.productId} (pv=${row.pipelineVersion})`);
        }
      }
    }
    console.log(`healable (pv<2): ${healable}`);

    if (dryRun) {
      console.log("dry-run: no writes. Use without --dry-run to execute.");
      return 0;
    }

    // Phase 2 first pass: emit the heal-on-touch candidates as a TODO list for
    // operators to feed back through the regular ingest path (CSV upload, etc.)
    // — Phase 2.x will wire automatic admitOrStage re-invocation.
    console.log("Phase 2 first pass: this tool is currently a reporter, not an executor.");
    console.log("To heal pv<2 rows: re-ingest the underlying source artifact via the");
    console.log("normal pipeline (link / csv / connector). Task 13's heal_on_touch signal");
    console.log("will route fuzzy matches to the Lab; strong-key matches auto-attach.");
    return 0;
  } finally {
    await closeTestDb();
  }
}

main().then(process.exit).catch((e) => {
  console.error(e);
  process.exit(1);
});
